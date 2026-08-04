from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.config import Settings
from app.db.retry import retry_database_read
from app.modules.audit.models import CreateAuditRunRequest
from app.modules.audit.service import AuditRunNotFoundError, AuditService
from app.modules.projects.schemas import UpdateBusinessProfileRequest
from app.modules.projects.service import ProjectService
from app.modules.agent.schemas import MemoryCategory, UpdateProjectMemoryArgs


class EmptyArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AuditStatusArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str = Field(min_length=1, max_length=100)


class AuditIssuesArgs(AuditStatusArgs):
    severity: Literal["error", "warning", "notice"] | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=20)


class AuditPagesArgs(AuditStatusArgs):
    search: str = Field(default="", max_length=500)
    status_code: int | None = Field(default=None, ge=100, le=599)
    status_family: Literal["2xx", "3xx", "4xx", "5xx", "unknown"] | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=20)


class SearchProjectMemoryArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(default="", max_length=200)
    category: MemoryCategory | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=5, ge=1, le=5)

    @model_validator(mode="after")
    def require_filter(self) -> "SearchProjectMemoryArgs":
        self.query = self.query.strip()
        if not self.query and self.category is None:
            raise ValueError("必须提供记忆关键词或分类")
        return self


class UpdateProfileChanges(BaseModel):
    model_config = ConfigDict(extra="forbid")
    business_name: str | None = Field(default=None, min_length=1, max_length=200)
    business_type: str | None = Field(default=None, min_length=1, max_length=200)
    business_summary: str | None = Field(default=None, max_length=10_000)
    target_audiences: list[str] | None = Field(default=None, max_length=100)
    products_services: list[str] | None = Field(default=None, max_length=100)
    value_propositions: list[str] | None = Field(default=None, max_length=100)
    ai_content_rules: str | None = Field(default=None, max_length=10_000)


class UpdateProfileArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    changes: UpdateProfileChanges


class StartAuditArgs(CreateAuditRunRequest):
    model_config = ConfigDict(extra="forbid")


READ_MODELS: dict[str, type[BaseModel]] = {
    "get_project_profile": EmptyArgs,
    "search_project_memory": SearchProjectMemoryArgs,
    "get_latest_audit": EmptyArgs,
    "get_audit_status": AuditStatusArgs,
    "get_audit_issues": AuditIssuesArgs,
    "get_audit_pages": AuditPagesArgs,
}
WRITE_MODELS: dict[str, type[BaseModel]] = {
    "update_business_profile": UpdateProfileArgs,
    "refresh_business_profile": EmptyArgs,
    "start_technical_audit": StartAuditArgs,
}
MEMORY_MODELS: dict[str, type[BaseModel]] = {
    "update_project_memory": UpdateProjectMemoryArgs,
}
@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    model: type[BaseModel]
    modifies_data: bool = False
    calls_external_service: bool = False
    retryable: bool = True
    estimated_cost: float = 0.0
    invalidates_remaining_calls: bool = False


TOOL_DEFINITIONS: dict[str, ToolDefinition] = {
    "get_project_profile": ToolDefinition(
        "get_project_profile", "读取当前项目的网站和业务资料。", EmptyArgs
    ),
    "search_project_memory": ToolDefinition(
        "search_project_memory",
        "按关键词或分类检索当前项目的全部长期记忆，返回可用于精确修改或删除的 fact_id。",
        SearchProjectMemoryArgs,
    ),
    "get_latest_audit": ToolDefinition(
        "get_latest_audit",
        "读取当前项目最近一次技术审核、run_id，以及最严重的问题和受影响页面 URL。",
        EmptyArgs,
    ),
    "get_audit_status": ToolDefinition(
        "get_audit_status", "读取当前项目指定技术审核的状态。", AuditStatusArgs
    ),
    "get_audit_issues": ToolDefinition(
        "get_audit_issues",
        "按 run_id 分页读取审核问题、严重级别和受影响页面 URL。",
        AuditIssuesArgs,
    ),
    "get_audit_pages": ToolDefinition(
        "get_audit_pages", "分页读取当前项目指定审核的页面。", AuditPagesArgs
    ),
    "update_business_profile": ToolDefinition(
        "update_business_profile",
        "直接修改当前项目已识别的业务资料；用户要求修改时调用，无需审批。",
        UpdateProfileArgs,
        modifies_data=True,
        invalidates_remaining_calls=True,
    ),
    "refresh_business_profile": ToolDefinition(
        "refresh_business_profile", "启动当前项目的新一轮网站业务识别。", EmptyArgs,
        modifies_data=True, calls_external_service=True,
        invalidates_remaining_calls=True,
    ),
    "start_technical_audit": ToolDefinition(
        "start_technical_audit", "按平台允许的参数启动当前项目技术审核。", StartAuditArgs,
        modifies_data=True, calls_external_service=True,
        invalidates_remaining_calls=True,
    ),
    "update_project_memory": ToolDefinition(
        "update_project_memory",
        "保存当前项目的长期事实。新增使用 add；修改或删除必须使用当前记忆中的 fact_id。",
        UpdateProjectMemoryArgs,
        modifies_data=True,
        invalidates_remaining_calls=True,
    ),
}


@dataclass(frozen=True)
class PreparedWrite:
    arguments: dict
    before: dict
    parameters_hash: str
    estimated_cost: float


class ToolRegistry:
    def __init__(self, settings: Settings, projects: ProjectService, audits: AuditService) -> None:
        self.settings, self.projects, self.audits = settings, projects, audits

    @retry_database_read
    async def execute_read(self, project_id: str, name: str, arguments: dict) -> dict:
        model = READ_MODELS.get(name)
        if model is None:
            raise ValueError("不允许调用这个只读工具")
        args = model.model_validate(arguments)
        if name == "get_project_profile":
            project = await self.projects.get(project_id)
            if project is None:
                raise LookupError("项目不存在")
            return project.model_dump(mode="json")
        if name == "search_project_memory":
            raise ValueError("项目记忆检索必须由 Agent 仓库执行")
        if name == "get_latest_audit":
            runs = await self.audits.list_runs(project_id, page=1, page_size=1)
            if not runs.items:
                return {
                    "audit": None,
                    "top_issues": {"items": [], "total": 0, "page": 1, "page_size": 10},
                }
            audit = runs.items[0].model_dump(mode="json")
            issues = await self.audits.issues(
                project_id,
                audit["run_id"],
                1,
                100,
                None,
                "",
            )
            issue_payload = issues.model_dump(mode="json")
            severity_order = {"error": 0, "warning": 1, "notice": 2}
            ranked_items = sorted(
                issue_payload["items"],
                key=lambda item: (
                    severity_order.get(item.get("severity"), 3),
                    -int(item.get("affected_count", 0)),
                    item.get("title", ""),
                    item.get("code", ""),
                ),
            )[:10]
            for item in ranked_items:
                item["urls"] = item.get("urls", [])[:10]
            top_issues = {
                "items": ranked_items,
                "total": issue_payload["total"],
                "page": 1,
                "page_size": 10,
            }
            return {"audit": audit, "top_issues": top_issues}
        if name == "get_audit_status":
            return (await self.audits.get_run(project_id, args.run_id)).model_dump(mode="json")
        if name == "get_audit_issues":
            result = await self.audits.issues(project_id, args.run_id, args.page, args.page_size, args.severity, "")
            payload = result.model_dump(mode="json")
            for item in payload["items"]:
                item["urls"] = item.get("urls", [])[:10]
            return payload
        if name == "get_audit_pages":
            return (await self.audits.pages(
                project_id, args.run_id, args.page, args.page_size, args.search,
                args.status_code, args.status_family,
            )).model_dump(mode="json")
        raise ValueError("未知工具")

    @retry_database_read
    async def prepare_write(
        self, project_id: str, name: str, arguments: dict, operation_id: str
    ) -> PreparedWrite:
        model = WRITE_MODELS.get(name)
        if model is None:
            raise ValueError("不允许调用这个写工具")
        parsed = model.model_validate(arguments)
        validated = parsed.model_dump(mode="json")
        project = await self.projects.get(project_id)
        if project is None:
            raise LookupError("项目不存在")
        if name == "update_business_profile":
            if project.site_profile is None:
                raise ValueError("网站业务识别尚未完成")
            assert isinstance(parsed, UpdateProfileArgs)
            changes = parsed.changes.model_dump(mode="json", exclude_unset=True)
            if not changes:
                raise ValueError("业务资料修改字段无效")
            current = profile_input(project.site_profile.model_dump(mode="json"))
            merged = {**current, **changes}
            request = UpdateBusinessProfileRequest.model_validate(merged)
            normalized_changes = {key: request.model_dump(mode="json")[key] for key in changes}
            before = {key: current[key] for key in normalized_changes}
            validated = {"changes": normalized_changes, "operation_id": operation_id}
        elif name == "refresh_business_profile":
            before = {"understanding_run_id": project.understanding_run_id, "understanding_status": project.understanding_status}
            validated = {"operation_id": operation_id}
        else:
            before = {"audit_run_id": project.audit_run_id, "audit_status": project.audit_status}
            validated["operation_id"] = operation_id
        parameters_hash = action_hash(name, validated, before)
        return PreparedWrite(
            validated, before, parameters_hash,
            TOOL_DEFINITIONS[name].estimated_cost,
        )

    async def execute_write(self, project_id: str, name: str, arguments: dict, before: dict, expected_hash: str) -> dict:
        current = await self._get_project(project_id)
        if current is None:
            raise LookupError("项目不存在")
        if name == "update_business_profile":
            current_profile = profile_input(current.site_profile.model_dump(mode="json")) if current.site_profile else {}
            current_before = {key: current_profile.get(key) for key in arguments["changes"]}
        elif name == "refresh_business_profile":
            existing = await self._get_business_profile_run(
                project_id, arguments["operation_id"]
            )
            if existing is not None:
                return {
                    "operation_id": arguments["operation_id"],
                    "verified": True,
                    "run_id": existing.run_id,
                    "status": existing.status,
                    "already_completed": True,
                }
            current_before = {"understanding_run_id": current.understanding_run_id, "understanding_status": current.understanding_status}
        else:
            try:
                existing = await self._get_audit_run(
                    project_id, arguments["operation_id"]
                )
            except AuditRunNotFoundError:
                existing = None
            if existing is not None:
                return {
                    "operation_id": arguments["operation_id"],
                    "verified": True,
                    "run_id": existing.run_id,
                    "status": existing.status,
                    "already_completed": True,
                }
            current_before = {"audit_run_id": current.audit_run_id, "audit_status": current.audit_status}
        if (
            name != "update_business_profile"
            and action_hash(name, arguments, current_before) != expected_hash
        ):
            raise RuntimeError("项目状态已经变化，请重新发起操作")
        if name == "update_business_profile":
            merged = {**profile_input(current.site_profile.model_dump(mode="json")), **arguments["changes"]}
            updated, already_completed = await self.projects.update_business_profile_once(
                project_id,
                UpdateBusinessProfileRequest.model_validate(merged),
                arguments["operation_id"],
                expected_hash,
                before,
            )
            if already_completed:
                return {
                    "operation_id": arguments["operation_id"],
                    "verified": True,
                    "changes": arguments["changes"],
                    "already_completed": True,
                }
            actual = profile_input(updated.site_profile.model_dump(mode="json")) if updated.site_profile else {}
            if any(actual.get(key) != value for key, value in arguments["changes"].items()):
                raise RuntimeError("业务资料修改后的校验失败")
            return {
                "operation_id": arguments["operation_id"],
                "verified": True,
                "changes": arguments["changes"],
            }
        if name == "refresh_business_profile":
            result = await self.projects.refresh_business_profile(project_id, arguments["operation_id"])
            return {
                "operation_id": arguments["operation_id"],
                "verified": result.understanding_run_id == arguments["operation_id"],
                "run_id": result.understanding_run_id,
                "status": result.understanding_status,
            }
        payload = {key: value for key, value in arguments.items() if key != "operation_id"}
        result = await self.audits.create_run(project_id, CreateAuditRunRequest.model_validate(payload), arguments["operation_id"])
        verified = await self._get_audit_run(project_id, arguments["operation_id"])
        return {
            "operation_id": arguments["operation_id"],
            "verified": verified.run_id == result.run_id,
            "run_id": result.run_id,
            "status": verified.status,
        }

    @retry_database_read
    async def _get_project(self, project_id: str) -> Any:
        return await self.projects.get(project_id)

    @retry_database_read
    async def _get_business_profile_run(
        self, project_id: str, run_id: str
    ) -> Any:
        return await self.projects.get_business_profile_run(project_id, run_id)

    @retry_database_read
    async def _get_audit_run(self, project_id: str, run_id: str) -> Any:
        return await self.audits.get_run(project_id, run_id)


def profile_input(profile: dict) -> dict:
    return {
        "business_name": profile.get("business_name", ""),
        "business_type": profile.get("business_type", ""),
        "business_summary": profile.get("business_summary", ""),
        "target_audiences": profile.get("target_audiences", []),
        "products_services": profile.get("products_services", []),
        "value_propositions": profile.get("value_propositions", []),
        "ai_content_rules": profile.get("ai_content_rules", ""),
    }


def action_hash(name: str, arguments: dict, before: dict) -> str:
    raw = json.dumps({"tool": name, "arguments": arguments, "before": before}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def tool_catalog_payload() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": definition.name,
                "description": definition.description,
                "parameters": definition.model.model_json_schema(),
            },
        }
        for definition in TOOL_DEFINITIONS.values()
    ]
