import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from app.db import retry
from app.core.config import Settings
from app.modules.audit.service import AuditRunNotFoundError
from app.modules.agent.tools import (
    READ_MODELS,
    TOOL_DEFINITIONS,
    WRITE_MODELS,
    ToolRegistry,
    tool_catalog_payload,
)


PROFILE = {
    "business_name": "Example",
    "business_type": "Software",
    "business_summary": "SEO software",
    "target_audiences": ["Marketing teams"],
    "products_services": ["SEO audit"],
    "value_propositions": ["Clear evidence"],
    "ai_content_rules": "",
}


class Dumpable:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def model_dump(self, mode: str = "python") -> dict[str, Any]:
        return dict(self.value)

    def __getattr__(self, name: str) -> Any:
        try:
            return self.value[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


class Project:
    def __init__(self) -> None:
        self.site_profile = Dumpable(PROFILE)
        self.understanding_run_id = None
        self.understanding_status = "completed"
        self.audit_run_id = None
        self.audit_status = "never_started"

    def model_dump(self, mode: str = "python") -> dict[str, Any]:
        return dict(PROFILE)


class FakeProjects:
    def __init__(self) -> None:
        self.project = Project()
        self.update_calls = 0
        self.refresh_calls = 0
        self.operations: dict[str, tuple[str, Project]] = {}
        self.understanding_runs: dict[str, Dumpable] = {}
        self.transient_read_failures = 0

    async def get(self, project_id: str) -> Project:
        assert project_id == "project-1"
        if self.transient_read_failures:
            self.transient_read_failures -= 1
            error = ConnectionError("database connection closed")
            error.code = "08006"  # type: ignore[attr-defined]
            raise error
        return self.project

    async def update_business_profile(self, project_id: str, request: Any) -> Project:
        self.update_calls += 1
        self.project.site_profile = Dumpable(request.model_dump(mode="json"))
        return self.project

    async def update_business_profile_once(
        self,
        project_id: str,
        request: Any,
        operation_id: str,
        parameters_hash: str,
        expected_before: dict[str, Any],
    ) -> tuple[Project, bool]:
        existing = self.operations.get(operation_id)
        if existing is not None:
            if existing[0] != parameters_hash:
                raise RuntimeError("操作编号与原始参数不一致")
            return existing[1], True
        current = self.project.site_profile.model_dump(mode="json")
        if any(current.get(key) != value for key, value in expected_before.items()):
            raise RuntimeError("项目状态已经变化，请重新发起操作")
        self.update_calls += 1
        self.project.site_profile = Dumpable(request.model_dump(mode="json"))
        self.operations[operation_id] = (parameters_hash, self.project)
        return self.project, False

    async def refresh_business_profile(
        self, project_id: str, operation_id: str
    ) -> Project:
        assert project_id == "project-1"
        self.refresh_calls += 1
        self.project.understanding_run_id = operation_id
        self.project.understanding_status = "queued"
        self.understanding_runs[operation_id] = Dumpable(
            {"run_id": operation_id, "status": "queued"}
        )
        return self.project

    async def get_business_profile_run(
        self, project_id: str, run_id: str
    ) -> Dumpable | None:
        assert project_id == "project-1"
        return self.understanding_runs.get(run_id)


class FakeAudits:
    def __init__(self) -> None:
        self.issue_calls: list[tuple[Any, ...]] = []
        self.create_calls = 0
        self.runs: dict[str, Dumpable] = {}

    async def list_runs(self, project_id: str, page: int, page_size: int) -> Dumpable:
        assert (project_id, page, page_size) == ("project-1", 1, 1)
        return DumpableCollection(
            [Dumpable({"run_id": "audit-1", "status": "completed"})]
        )

    async def issues(
        self,
        project_id: str,
        run_id: str,
        page: int,
        page_size: int,
        severity: str | None,
        search: str,
    ) -> Dumpable:
        self.issue_calls.append(
            (project_id, run_id, page, page_size, severity, search)
        )
        return Dumpable(
            {
                "items": [
                    {
                        "title": "Minor warning",
                        "code": "minor_warning",
                        "severity": "warning",
                        "affected_count": 100,
                        "recommendation": "Review it",
                        "urls": ["https://example.com/warning"],
                    },
                    {
                        "title": "Broken links",
                        "code": "broken_links",
                        "severity": "error",
                        "affected_count": 12,
                        "recommendation": "Fix the links",
                        "urls": [f"https://example.com/{index}" for index in range(12)],
                    },
                    {
                        "title": "Missing titles",
                        "code": "missing_titles",
                        "severity": "error",
                        "affected_count": 3,
                        "recommendation": "Add titles",
                        "urls": ["https://example.com/title"],
                    }
                ],
                "total": 3,
                "page": 1,
                "page_size": 100,
            }
        )

    async def get_run(self, project_id: str, run_id: str) -> Dumpable:
        assert project_id == "project-1"
        try:
            return self.runs[run_id]
        except KeyError as exc:
            raise AuditRunNotFoundError from exc

    async def create_run(
        self, project_id: str, request: Any, operation_id: str
    ) -> Dumpable:
        assert project_id == "project-1"
        request.model_dump(mode="json")
        self.create_calls += 1
        run = Dumpable({"run_id": operation_id, "status": "queued"})
        self.runs[operation_id] = run
        return run


class DumpableCollection:
    def __init__(self, items: list[Dumpable]) -> None:
        self.items = items


def build_registry() -> tuple[ToolRegistry, FakeProjects]:
    projects = FakeProjects()
    return ToolRegistry(Settings(), projects, FakeAudits()), projects


def test_tool_models_reject_project_identity_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        READ_MODELS["get_latest_audit"].model_validate({"project_id": "other-project"})
    with pytest.raises(ValidationError):
        WRITE_MODELS["update_business_profile"].model_validate(
            {"changes": {"project_id": "other-project"}}
        )


def test_memory_search_requires_a_keyword_or_category() -> None:
    with pytest.raises(ValidationError, match="必须提供"):
        READ_MODELS["search_project_memory"].model_validate({})

    parsed = READ_MODELS["search_project_memory"].model_validate({
        "query": " 跨境卖家 ",
    })

    assert parsed.query == "跨境卖家"


def test_update_profile_catalog_exposes_allowed_change_fields() -> None:
    definition = next(
        item for item in tool_catalog_payload()
        if item["function"]["name"] == "update_business_profile"
    )
    schema = definition["function"]["parameters"]
    changes_ref = schema["properties"]["changes"]["$ref"].rsplit("/", 1)[-1]
    change_fields = set(schema["$defs"][changes_ref]["properties"])

    assert change_fields == {
        "business_name",
        "business_type",
        "business_summary",
        "target_audiences",
        "products_services",
        "value_propositions",
        "ai_content_rules",
    }


def test_audit_catalog_explains_the_latest_audit_dependency() -> None:
    definitions = {
        item["function"]["name"]: item["function"] for item in tool_catalog_payload()
    }

    assert "run_id" in definitions["get_latest_audit"]["description"]
    assert "受影响页面 URL" in definitions["get_audit_issues"]["description"]
    assert "fact_id" in definitions["search_project_memory"]["description"]


def test_state_changing_tools_invalidate_remaining_calls() -> None:
    invalidating = {
        name
        for name, definition in TOOL_DEFINITIONS.items()
        if definition.invalidates_remaining_calls
    }

    assert invalidating == {
        "update_business_profile",
        "refresh_business_profile",
        "start_technical_audit",
        "update_project_memory",
    }
    assert all(
        not TOOL_DEFINITIONS[name].invalidates_remaining_calls
        for name in READ_MODELS
    )


def test_latest_audit_includes_ranked_issue_details() -> None:
    registry, _ = build_registry()

    result = asyncio.run(registry.execute_read("project-1", "get_latest_audit", {}))

    assert result["audit"]["run_id"] == "audit-1"
    assert result["top_issues"]["items"][0]["title"] == "Broken links"
    assert result["top_issues"]["items"][1]["title"] == "Missing titles"
    assert result["top_issues"]["items"][2]["title"] == "Minor warning"
    assert len(result["top_issues"]["items"][0]["urls"]) == 10
    assert registry.audits.issue_calls == [
        ("project-1", "audit-1", 1, 100, None, "")
    ]


def test_read_tool_retries_a_transient_database_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry, projects = build_registry()
    projects.transient_read_failures = 1

    async def sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(retry.asyncio, "sleep", sleep)

    result = asyncio.run(
        registry.execute_read("project-1", "get_project_profile", {})
    )

    assert result["business_name"] == "Example"
    assert projects.transient_read_failures == 0


def test_unknown_tool_is_never_executed() -> None:
    registry, _ = build_registry()

    with pytest.raises(ValueError, match="不允许"):
        asyncio.run(registry.execute_read("project-1", "run_python", {}))


def test_write_tool_is_validated_and_idempotent() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "update_business_profile",
            {"changes": {"target_audiences": ["跨境电商卖家"]}},
            "operation-1",
        )
    )

    assert projects.update_calls == 0
    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    second = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first["verified"] is True
    assert first["operation_id"] == "operation-1"
    assert second["already_completed"] is True
    assert second["operation_id"] == "operation-1"
    assert projects.update_calls == 1


def test_refresh_business_profile_replay_reuses_the_same_run() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "refresh_business_profile",
            {},
            "understanding-operation-1",
        )
    )

    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first == {
        "operation_id": "understanding-operation-1",
        "verified": True,
        "run_id": "understanding-operation-1",
        "status": "queued",
    }
    assert repeated["already_completed"] is True
    assert repeated["run_id"] == "understanding-operation-1"
    assert projects.refresh_calls == 1


def test_refresh_retry_finds_original_run_after_a_newer_refresh() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "refresh_business_profile",
            {},
            "understanding-operation-1",
        )
    )
    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    asyncio.run(
        projects.refresh_business_profile(
            "project-1", "understanding-operation-2"
        )
    )

    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "refresh_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first["run_id"] == "understanding-operation-1"
    assert repeated == {
        "operation_id": "understanding-operation-1",
        "verified": True,
        "run_id": "understanding-operation-1",
        "status": "queued",
        "already_completed": True,
    }
    assert projects.refresh_calls == 2


def test_start_technical_audit_replay_reuses_the_same_run() -> None:
    registry, _ = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "start_technical_audit",
            {},
            "audit-operation-1",
        )
    )

    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first == {
        "operation_id": "audit-operation-1",
        "verified": True,
        "run_id": "audit-operation-1",
        "status": "queued",
    }
    assert repeated["already_completed"] is True
    assert repeated["run_id"] == "audit-operation-1"
    assert registry.audits.create_calls == 1


def test_start_technical_audit_replay_treats_a_later_audit_failure_as_created() -> None:
    registry, _ = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "start_technical_audit",
            {},
            "audit-operation-1",
        )
    )
    asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    registry.audits.runs["audit-operation-1"] = Dumpable(
        {"run_id": "audit-operation-1", "status": "failed"}
    )

    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "start_technical_audit",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert repeated == {
        "operation_id": "audit-operation-1",
        "verified": True,
        "run_id": "audit-operation-1",
        "status": "failed",
        "already_completed": True,
    }
    assert registry.audits.create_calls == 1


def test_profile_retry_uses_operation_record_after_intervening_change() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "update_business_profile",
            {"changes": {"target_audiences": ["跨境电商卖家"]}},
            "operation-1",
        )
    )
    first = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )
    projects.project.site_profile = Dumpable(
        {**PROFILE, "target_audiences": ["后来人工修改的客户"]}
    )

    repeated = asyncio.run(
        registry.execute_write(
            "project-1",
            "update_business_profile",
            prepared.arguments,
            prepared.before,
            prepared.parameters_hash,
        )
    )

    assert first["verified"] is True
    assert repeated["already_completed"] is True
    assert projects.update_calls == 1


def test_changed_precondition_rejects_stale_approval() -> None:
    registry, projects = build_registry()
    prepared = asyncio.run(
        registry.prepare_write(
            "project-1",
            "update_business_profile",
            {"changes": {"target_audiences": ["跨境电商卖家"]}},
            "operation-1",
        )
    )
    changed = {**PROFILE, "target_audiences": ["Enterprise"]}
    projects.project.site_profile = Dumpable(changed)

    with pytest.raises(RuntimeError, match="状态已经变化"):
        asyncio.run(
            registry.execute_write(
                "project-1",
                "update_business_profile",
                prepared.arguments,
                prepared.before,
                prepared.parameters_hash,
            )
        )
