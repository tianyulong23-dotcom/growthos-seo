from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from fastapi.encoders import jsonable_encoder

from app.core.config import Settings
from app.db.retry import retry_database_read
from app.modules.agent.backlinks_read import (
    BACKLINK_READ_DESCRIPTIONS,
    BACKLINK_READ_MODELS,
    BacklinksReader,
)
from app.modules.agent.backlinks_drafts import (
    BacklinksDrafts, CreateDraftArgs, DRAFT_READ_MODELS, DRAFT_READ_DESCRIPTIONS,
)
from app.modules.agent.delegation import resolve_delegation
from app.modules.agent.backlinks_initialization import BacklinksInitialization
from app.modules.projects.readiness import build_project_outreach_readiness_service
from app.modules.agent.backlinks_preflight import PreflightArgs, preflight
from app.modules.agent.backlinks_send import (
    BacklinksSender, SendArgs, SendConfirmationSource, confirmation_fingerprint,
)
from app.modules.agent.backlinks_pipeline import (
    BacklinksPipeline, PIPELINE_WRITE_MODELS, PIPELINE_DESCRIPTIONS,
)
from app.modules.agent.backlinks_campaign import CampaignStatusArgs, StartCampaignArgs
from app.modules.agent.backlinks_chat_send import BacklinksChatSend, ChatSendArgs
from app.modules.agent.schemas import MemoryCategory, UpdateProjectMemoryArgs
from app.modules.audit.models import CreateAuditRunRequest
from app.modules.audit.service import AuditRunNotFoundError, AuditService
from app.modules.content.schemas import CreateArticleRequest
from app.modules.onboarding.service import OnboardingNotFoundError
from app.modules.projects.schemas import UpdateBusinessProfileRequest
from app.modules.projects.service import ProjectService
from app.modules.agent.task_tools import TaskArgs, cancel_task, read_tasks, task_context


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


class ContentPlanStatusArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    batch_id: str = Field(min_length=1, max_length=200)


class StartArticlesArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    batch_id: str = Field(min_length=1, max_length=200)
    count: int = Field(default=2, ge=1, le=2)


class ArticleGenerationStatusArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    article_ids: list[str] = Field(default_factory=list, max_length=2)
    search: str | None = Field(default=None, max_length=200)


class ListKeywordsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    search: str | None = Field(default=None, max_length=200)
    intent: str | None = Field(default=None, max_length=100)
    source: str | None = Field(default=None, max_length=100)
    metrics_status: Literal["pending", "fresh", "stale", "failed"] | None = None
    min_volume: int | None = Field(default=None, ge=0)
    max_difficulty: int | None = Field(default=None, ge=0, le=100)
    sort: Literal[
        "keyword", "search_volume", "difficulty", "priority", "updated_at"
    ] = "priority"
    order: Literal["asc", "desc"] = "desc"
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=10, ge=1, le=20)


class KeywordOpportunitiesArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    search: str = Field(default="", max_length=200)
    competitor_domain: str = Field(default="", max_length=253)
    intent: str = Field(default="", max_length=100)
    opportunity_status: Literal["new", "accepted", "dismissed", "all"] = "new"
    min_volume: int | None = Field(default=None, ge=0)
    max_difficulty: int | None = Field(default=None, ge=0, le=100)
    in_library: bool | None = None
    sort: Literal[
        "keyword", "opportunity_score", "search_volume", "difficulty",
        "best_rank", "competitor_count", "updated_at",
    ] = "opportunity_score"
    order: Literal["asc", "desc"] = "desc"
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=10, ge=1, le=20)


class PerformanceArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days: Literal[7, 28, 90] = 28


class ArticlePerformanceArgs(PerformanceArgs):
    article_id: str = Field(min_length=1, max_length=100)


READ_MODELS: dict[str, type[BaseModel]] = {
    "get_backlink_readiness": EmptyArgs,
    "list_project_tasks": EmptyArgs,
    "get_project_task": TaskArgs,
    "get_backlink_campaign": CampaignStatusArgs,
    **DRAFT_READ_MODELS,
    **BACKLINK_READ_MODELS,
    "get_project_profile": EmptyArgs,
    "search_project_memory": SearchProjectMemoryArgs,
    "get_latest_audit": EmptyArgs,
    "get_audit_status": AuditStatusArgs,
    "get_audit_issues": AuditIssuesArgs,
    "get_audit_pages": AuditPagesArgs,
    "get_keyword_library_status": EmptyArgs,
    "get_content_plan_status": ContentPlanStatusArgs,
    "get_article_generation_status": ArticleGenerationStatusArgs,
    "list_keywords": ListKeywordsArgs,
    "get_keyword_competitors": EmptyArgs,
    "get_keyword_opportunities": KeywordOpportunitiesArgs,
    "get_search_performance": PerformanceArgs,
    "get_article_performance": ArticlePerformanceArgs,
}
WRITE_MODELS: dict[str, type[BaseModel]] = {
    "initialize_backlink_project": EmptyArgs,
    "cancel_project_task": TaskArgs,
    "send_backlink_drafts": ChatSendArgs,
    "start_backlink_campaign": StartCampaignArgs,
    **PIPELINE_WRITE_MODELS,
    "submit_backlink_email": SendArgs,
    "preflight_backlink_email": PreflightArgs,
    "create_backlink_draft": CreateDraftArgs,
    "update_business_profile": UpdateProfileArgs,
    "refresh_business_profile": EmptyArgs,
    "start_technical_audit": StartAuditArgs,
    "start_keyword_library": EmptyArgs,
    "start_content_plan": EmptyArgs,
    "start_articles": StartArticlesArgs,
    "create_article": CreateArticleRequest,
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
    parallel_write_group: str | None = None


TOOL_DEFINITIONS: dict[str, ToolDefinition] = {
    "get_backlink_readiness": ToolDefinition(
        "get_backlink_readiness",
        "Read authoritative project prerequisites before the recommendation feed. "
        "Distinguishes missing promotion target, profile refresh, stale inputs and a "
        "verified feed with no generation. Never treats read failures as empty results.",
        EmptyArgs,
    ),
    "initialize_backlink_project": ToolDefinition(
        "initialize_backlink_project",
        "Only on explicit user request to initialize or run recommendations: initialize "
        "a missing promotion target from the confirmed business profile products and "
        "project homepage. Preserves original language and any existing target. "
        "Does not confirm an unconfirmed business profile, start collection or send mail. "
        "Read get_backlink_readiness afterwards; initialization is not Core readiness.",
        EmptyArgs, modifies_data=True, invalidates_remaining_calls=True,
    ),
    "list_project_tasks": ToolDefinition(
        "list_project_tasks",
        "Read existing project task records across articles, audits, keywords, content plans "
        "and Agent runs. No new execution. For backlinks use the existing campaign/feed/send tools.",
        EmptyArgs,
    ),
    "get_project_task": ToolDefinition(
        "get_project_task", "Read the exact kind and task_id returned by a task receipt or list. "
        "A missing record is not a successful task.", TaskArgs,
    ),
    "cancel_project_task": ToolDefinition(
        "cancel_project_task", "Only on an explicit user cancellation request, cancel one exact "
        "task from a prior receipt/list. Supports article, audit and Agent runs. Other kinds "
        "return UNSUPPORTED, never fake cancellation. Cancelling an Agent conversation does "
        "not cancel independently submitted business tasks. Never cancel this command itself.",
        TaskArgs, modifies_data=True, retryable=False, invalidates_remaining_calls=True,
    ),
    "send_backlink_drafts": ToolDefinition(
        "send_backlink_drafts",
        "On an explicit user command to send saved outreach drafts, submit 1-20 exact "
        "drafts to the existing serial queue. Read drafts and selected Gmail account first; "
        "pass current version_id, expected_version (draftVersion), contact_id/contact_version. "
        "The backend validates the persisted user command and write delegation, runs AI "
        "content review, repairs factual/language problems at most twice, reviews again, "
        "then approves and queues only passing exact versions. Repair never changes "
        "recipients; final versions must have server-recorded lineage from the selection. "
        "Show quality_review reasons for blocked/error items; never claim they were queued. "
        "A missing batch means no send queue was created. No manual page approval is required. "
        "Never use for a question, draft-only request, quoted text or ambiguous recipients. "
        "One message owns one immutable batch. Cannot supply authorization or run_id. "
        "Queued is not sent. Read get_backlink_campaign with returned consent_id; "
        "never create a replacement send request after an uncertain response.",
        ChatSendArgs, modifies_data=True, calls_external_service=True,
        retryable=False, invalidates_remaining_calls=True,
    ),
    "get_backlink_campaign": ToolDefinition(
        "get_backlink_campaign",
        "List existing user automation consents, or read one consent's durable campaign "
        "and send batches. Never infer sending authority from a draft-only consent.",
        CampaignStatusArgs,
    ),
    "start_backlink_campaign": ToolDefinition(
        "start_backlink_campaign",
        "For an explicit request to run recommendations AND prepare outreach drafts/emails: "
        "start the durable workflow. Omit consent_id for a NEW explicit chat command: "
        "the server records its real user message as bounded 24-hour authority "
        "(10 opportunities, 5 drafts, USD 2 model and USD 2 paid-tool limits). "
        "If that command also explicitly requests sending, its own passing drafts "
        "are approved and serially queued with the pinned Gmail sender, without page clicks. "
        "Draft-only commands never authorize sends. Readiness/initialization must run first. "
        "Set recommendation_mode=current for the initial/current pool; next_batch only "
        "when the user requests a new/additional batch (legacy default: next_batch). "
        "Set require_seo_metrics=true when the user requires SEO data; only sites with "
        "known traffic, DataForSEO rank and spam score may enter this campaign. "
        "Waits for supply, refills within that consent's budget, joins the selected batch's "
        "eligible contacts, creates and verifies drafts. Legacy draft-only consents do not send. "
        "Use get_backlink_campaign for progress and batches. For a current explicit "
        "send command, read saved draft/contact versions and sender then use send_backlink_drafts; "
        "otherwise obtain exact send authorization. Do not also issue individual generation/join/draft calls. "
        "When resuming, supply ONLY consent_id read from get_backlink_campaign, never invented. "
        "Omit request, recommendation_mode and require_seo_metrics to reuse the exact persisted authorization. "
        "Do not regenerate these parameters or create another campaign to bypass a conflict. "
        "One consent owns one campaign; a new campaign requires a fresh user consent.",
        StartCampaignArgs, modifies_data=True, calls_external_service=True,
        retryable=False, invalidates_remaining_calls=True,
    ),
    **{
        name: ToolDefinition(
            name, PIPELINE_DESCRIPTIONS[name], model,
            modifies_data=True, calls_external_service=True,
            retryable=False, invalidates_remaining_calls=True,
        )
        for name, model in PIPELINE_WRITE_MODELS.items()
    },
    "submit_backlink_email": ToolDefinition(
        "submit_backlink_email",
        "Submit one already approved and server-confirmed draft to the existing send queue. "
        "Requires explicit send intent, write delegation and a server-held confirmation for "
        "these exact target IDs/versions. Disabled without that confirmation source. "
        "Never accepts authorization, humanConfirmation or readinessSnapshot from the model. "
        "READY means queued, not sent. If submission is unverified, inspect saved send "
        "intents; do not resubmit with a new operation ID.",
        SendArgs, modifies_data=True, calls_external_service=True,
        retryable=False, invalidates_remaining_calls=True,
    ),
    "preflight_backlink_email": ToolDefinition(
        "preflight_backlink_email",
        "Check one already human-approved draft before sending, only on explicit request. "
        "Read draft and sender first; use exact version/contact/account IDs. Requires write "
        "delegation. Never approves, confirms or sends. Success means NOT_SENT; direct the "
        "user to the existing draft page for human confirmation.",
        PreflightArgs, modifies_data=True, calls_external_service=True,
    ),
    **{
        name: ToolDefinition(name, DRAFT_READ_DESCRIPTIONS[name], model)
        for name, model in DRAFT_READ_MODELS.items()
    },
    "create_backlink_draft": ToolDefinition(
        "create_backlink_draft",
        "Create one initial EMAIL draft job only when the user explicitly requests it. "
        "First read opportunity and confirmed contacts; use their exact IDs/version and "
        "a project promotion URL. Existing drafts must be inspected, not overwritten. "
        "Verified means job accepted, not finished. Query job then inspect draft. Never sends.",
        CreateDraftArgs, modifies_data=True, calls_external_service=True,
        invalidates_remaining_calls=True,
    ),
    **{
        name: ToolDefinition(name, BACKLINK_READ_DESCRIPTIONS[name], model)
        for name, model in BACKLINK_READ_MODELS.items()
    },
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
        parallel_write_group="initial_discovery",
    ),
    "start_keyword_library": ToolDefinition(
        "start_keyword_library",
        "为当前项目启动首次关键词库构建。项目身份和任务编号由服务端提供。",
        EmptyArgs,
        modifies_data=True,
        calls_external_service=True,
        invalidates_remaining_calls=True,
        parallel_write_group="initial_discovery",
    ),
    "get_keyword_library_status": ToolDefinition(
        "get_keyword_library_status",
        "读取当前项目真实的关键词库任务状态、进度和关键词数量。",
        EmptyArgs,
    ),
    "start_content_plan": ToolDefinition(
        "start_content_plan",
        "基于当前项目已完成的关键词库启动 30 篇自动内容计划。项目身份由服务端提供。",
        EmptyArgs,
        modifies_data=True,
        calls_external_service=True,
        invalidates_remaining_calls=True,
    ),
    "get_content_plan_status": ToolDefinition(
        "get_content_plan_status",
        "按启动工具返回的 batch_id 读取 30 篇内容计划的真实状态和进度。",
        ContentPlanStatusArgs,
    ),
    "start_articles": ToolDefinition(
        "start_articles",
        "从当前项目内容计划中启动前 1 至 2 篇文章。计划项和版本由服务端选择。",
        StartArticlesArgs,
        modifies_data=True,
        calls_external_service=True,
        invalidates_remaining_calls=True,
    ),
    "get_article_generation_status": ToolDefinition(
        "get_article_generation_status",
        "读取文章生成的真实状态和进度。可按 article_ids 精确读取，或用 search 按主关键词或标题查找；两者都不提供时读取首次生成记录，若没有则读取最近两篇文章。",
        ArticleGenerationStatusArgs,
    ),
    "list_keywords": ToolDefinition(
        "list_keywords",
        "查询当前项目已经保存的关键词库。可按关键词、意图、来源、搜索量和难度筛选；不会发起新的付费研究。",
        ListKeywordsArgs,
    ),
    "get_keyword_competitors": ToolDefinition(
        "get_keyword_competitors",
        "读取当前项目已经完成的关键词竞品分析结果；不会启动新的竞品分析。",
        EmptyArgs,
    ),
    "get_keyword_opportunities": ToolDefinition(
        "get_keyword_opportunities",
        "查询当前项目已有的竞品关键词机会，可按竞品、意图、搜索量和难度筛选；不会启动新的付费分析。",
        KeywordOpportunitiesArgs,
    ),
    "get_search_performance": ToolDefinition(
        "get_search_performance",
        "读取当前项目已经同步的 7、28 或 90 天搜索表现，包括点击、曝光、CTR、平均排名和文章变化。不会主动同步数据。",
        PerformanceArgs,
    ),
    "get_article_performance": ToolDefinition(
        "get_article_performance",
        "读取当前项目指定文章的搜索表现、查询词、趋势和优化信号。article_id 必须来自当前项目。",
        ArticlePerformanceArgs,
    ),
    "create_article": ToolDefinition(
        "create_article",
        "根据用户指定的关键词直接为当前项目创建并启动一篇文章，不依赖内容计划。可选标题、次要关键词、文章类型、写作方向和语言。",
        CreateArticleRequest,
        modifies_data=True,
        calls_external_service=True,
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
    def __init__(
        self,
        settings: Settings,
        projects: ProjectService,
        audits: AuditService,
        *,
        keywords: Any | None = None,
        content_plans: Any | None = None,
        content: Any | None = None,
        performance: Any | None = None,
        onboarding: Any | None = None,
        backlinks: BacklinksReader | None = None,
        send_confirmations: SendConfirmationSource | None = None,
        outreach_readiness: Any | None = None,
    ) -> None:
        self.settings, self.projects, self.audits = settings, projects, audits
        self.keywords = keywords
        self.content_plans = content_plans
        self.content = content
        self.performance = performance
        self.onboarding = onboarding
        self.backlinks = backlinks
        self.send_confirmations = send_confirmations
        self.outreach_readiness = outreach_readiness or build_project_outreach_readiness_service()

    @retry_database_read
    async def execute_read(
        self, project_id: str, name: str, arguments: dict, *, organization_id: str = "",
        delegation: dict | None = None,
    ) -> dict:
        model = READ_MODELS.get(name)
        if model is None:
            raise ValueError("不允许调用这个只读工具")
        args = model.model_validate(arguments)
        if name == "get_backlink_readiness":
            return await BacklinksInitialization(self).read(
                project_id, organization_id, delegation,
            )
        if name in {"list_project_tasks", "get_project_task"}:
            return await read_tasks(self, project_id, organization_id, delegation, arguments)
        if name == "get_backlink_campaign":
            self._require_service(self.backlinks, name)
            from app.db.session import session_factory
            from app.modules.agent.backlinks_campaign import BacklinksCampaign
            return jsonable_encoder(await BacklinksCampaign(self.backlinks, session_factory, {}).status(
                project_id, organization_id, delegation, args.consent_id,
            ))
        if name in DRAFT_READ_MODELS:
            self._require_service(self.backlinks, name)
            return await BacklinksDrafts(self.backlinks).read(
                project_id, organization_id, delegation, name, arguments,
            )
        if name in BACKLINK_READ_MODELS:
            self._require_service(self.backlinks, name)
            return await self.backlinks.read(
                project_id, organization_id, name, args.model_dump(mode="json", exclude_none=True),
                **({"delegation": delegation} if delegation is not None else {}),
            )
        if name == "get_project_profile":
            scope = {"organization_id": organization_id} if organization_id else {}
            if delegation is not None:
                self._require_service(self.backlinks, name)
                resolved = await resolve_delegation(
                    self.settings, self.backlinks.projects, delegation,
                    project_id, organization_id,
                )
                scope["workspace_id"] = resolved.tenant.workspace_id
            project = await self.projects.get(
                project_id, **scope,
            )
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
        if name == "get_keyword_library_status":
            self._require_service(self.keywords, name)
            payload = (await self.keywords.status(project_id)).model_dump(mode="json")
            billing = await self.keywords.keyword_library_billing(project_id)
            payload["billing"] = {
                "source": "keyword_external_requests",
                "reference_id": str(billing.get("run_id") or ""),
                "reported_cost_usd": max(
                    float(billing.get("reported_cost_usd") or 0), 0
                ),
                "complete": billing.get("complete") is True,
            }
            return payload
        if name == "get_content_plan_status":
            self._require_service(self.content_plans, name)
            payload = (
                await self.content_plans.get_batch(
                    self.settings.default_organization_id,
                    project_id,
                    args.batch_id,
                )
            ).model_dump(mode="json")
            payload["billing"] = {
                "source": "content_plan_external_requests",
                "reference_id": str(payload.get("batch_id") or args.batch_id),
                "reported_cost_usd": max(
                    float(payload.get("total_cost_usd") or 0), 0
                ),
                "complete": payload.get("status") in {"completed", "cancelled"},
            }
            return payload
        if name == "get_article_generation_status":
            self._require_service(self.content, name)
            article_ids = list(args.article_ids)
            if not article_ids and args.search:
                matches = await self.content.list_articles(
                    project_id,
                    1,
                    2,
                    None,
                    args.search,
                    organization_id=self.settings.default_organization_id,
                )
                article_ids = [item.id for item in matches.items]
            if not article_ids and not args.search:
                self._require_service(self.onboarding, name)
                article_ids = await self.onboarding.article_ids_for_initial_generation(
                    self.settings.default_organization_id,
                    project_id,
                )
                if not article_ids:
                    recent = await self.content.list_articles(
                        project_id,
                        1,
                        2,
                        None,
                        None,
                        organization_id=self.settings.default_organization_id,
                    )
                    article_ids = [item.id for item in recent.items]
            articles = []
            reported_cost = 0.0
            estimated_cost = 0.0
            billing_complete = True
            for article_id in article_ids:
                article = await self.content.get_article_generation_snapshot(
                    project_id,
                    article_id,
                    organization_id=self.settings.default_organization_id,
                )
                billing = article.get("billing")
                billing = billing if isinstance(billing, dict) else {}
                reported = billing.get("reported_cost")
                estimated = billing.get("estimated_cost")
                if isinstance(reported, (int, float)) and not isinstance(reported, bool):
                    reported_cost += max(float(reported), 0)
                if isinstance(estimated, (int, float)) and not isinstance(estimated, bool):
                    estimated_cost += max(float(estimated), 0)
                if billing.get("complete") is not True:
                    billing_complete = False
                articles.append({
                    "article_id": article["article_id"],
                    "primary_keyword": article.get("primary_keyword"),
                    "title": article.get("title"),
                    "run_id": article.get("run_id"),
                    "status": article.get("status"),
                    "stage": article.get("stage"),
                    "progress": article.get("progress"),
                    "warnings": article.get("warnings", []),
                    "error_code": article.get("error_code"),
                    "error_detail": article.get("error_detail"),
                })
            return {
                "articles": articles,
                "billing": {
                    "source": "article_run_steps",
                    "reference_id": ",".join(sorted({
                        str(item.get("run_id"))
                        for item in articles
                        if item.get("run_id")
                    })),
                    "reported_cost_usd": round(reported_cost, 8),
                    "estimated_cost_usd": round(estimated_cost, 8),
                    "complete": billing_complete,
                },
            }
        if name == "list_keywords":
            self._require_service(self.keywords, name)
            payload = await self.keywords.list_keywords(
                project_id,
                **args.model_dump(mode="json"),
                status="active",
                seed_id=None,
            )
            return payload.model_dump(mode="json")
        if name == "get_keyword_competitors":
            self._require_service(self.keywords, name)
            payload = await self.keywords.list_competitors(
                project_id, include_evidence=False
            )
            return payload.model_dump(mode="json")
        if name == "get_keyword_opportunities":
            self._require_service(self.keywords, name)
            payload = await self.keywords.list_competitor_opportunities(
                project_id, **args.model_dump(mode="json")
            )
            return payload.model_dump(mode="json")
        if name == "get_search_performance":
            self._require_service(self.performance, name)
            payload = await self.performance.overview(project_id, args.days)
            return payload.model_dump(mode="json")
        if name == "get_article_performance":
            self._require_service(self.performance, name)
            payload = await self.performance.article_detail(
                project_id, args.article_id, args.days
            )
            result = payload.model_dump(mode="json")
            result["queries"] = result.get("queries", [])[:20]
            result["trend"] = result.get("trend", [])[-90:]
            return result
        raise ValueError("未知工具")

    @retry_database_read
    async def prepare_write(
        self, project_id: str, name: str, arguments: dict, operation_id: str,
        *, organization_id: str = "", delegation: dict | None = None,
        run_id: str | None = None,
    ) -> PreparedWrite:
        model = WRITE_MODELS.get(name)
        if model is None:
            raise ValueError("不允许调用这个写工具")
        parsed = model.model_validate(arguments)
        validated = parsed.model_dump(mode="json")
        if name == "initialize_backlink_project":
            before = await BacklinksInitialization(self).prepare(
                project_id, organization_id, delegation,
            )
            validated["operation_id"] = operation_id
            return PreparedWrite(validated, before, action_hash(name, validated, before), 0.0)
        if name == "cancel_project_task":
            permission = {"article": "content:write", "audit": "projects:write", "agent": "backlinks:write"}.get(validated["kind"])
            if permission is None:
                raise ValueError("TASK_CANCELLATION_UNSUPPORTED")
            await task_context(self, project_id, organization_id, delegation, permission)
            await read_tasks(self, project_id, organization_id, delegation, validated)
            validated["operation_id"] = operation_id
            return PreparedWrite(validated, {}, action_hash(name, validated, {}), 0.0)
        if name == "send_backlink_drafts":
            self._require_service(self.backlinks, name)
            from app.db.session import session_factory
            await BacklinksChatSend(self.backlinks, session_factory, {}).authorize(
                project_id, organization_id, delegation, run_id,
            )
            validated["operation_id"] = operation_id
            before = {"source_run_id": run_id}
            return PreparedWrite(validated, before, action_hash(name, validated, before), 0.0)
        if name == "start_backlink_campaign":
            self._require_service(self.backlinks, name)
            await self.backlinks.resolve_write_context(
                project_id, organization_id, delegation, write=True,
            )
            validated["operation_id"] = operation_id
            before = {}
            if validated.get("consent_id") is None:
                from app.db.session import session_factory
                from app.modules.agent.backlinks_chat_campaign import explicit_campaign
                await BacklinksChatSend(self.backlinks, session_factory, {}).authorize(
                    project_id, organization_id, delegation, run_id, command_check=explicit_campaign,
                )
                before = {"source_run_id": run_id}
            return PreparedWrite(validated, before, action_hash(name, validated, before), 0.0)
        if name in PIPELINE_WRITE_MODELS:
            self._require_service(self.backlinks, name)
            await resolve_delegation(
                self.settings, self.backlinks.projects, delegation,
                project_id, organization_id, write=True,
            )
            if name == "start_backlink_recommendations" and validated["mode"] == "initial":
                feed = await self.backlinks.read(
                    project_id, organization_id, "list_backlink_recommendations",
                    {"limit": 1}, delegation=delegation,
                )
                if feed["data"].get("latestGeneration") is not None:
                    raise ValueError("BACKLINKS_GENERATION_EXISTS: inspect the existing generation")
            validated["operation_id"] = operation_id
            return PreparedWrite(validated, {}, action_hash(name, validated, {}), 0.0)
        if name == "submit_backlink_email":
            self._require_service(self.backlinks, name)
            command = await BacklinksSender(
                BacklinksDrafts(self.backlinks), self.send_confirmations,
            ).authorized_command(
                project_id, organization_id, delegation, validated, operation_id,
            )
            validated["operation_id"] = operation_id
            before = {"confirmation_hash": confirmation_fingerprint(command)}
            return PreparedWrite(validated, before, action_hash(name, validated, before), 0.0)
        if name == "preflight_backlink_email":
            self._require_service(self.backlinks, name)
            await resolve_delegation(
                self.settings, self.backlinks.projects, delegation,
                project_id, organization_id, write=True,
            )
            validated["operation_id"] = operation_id
            return PreparedWrite(validated, {}, action_hash(name, validated, {}), 0.0)
        if name == "create_backlink_draft":
            self._require_service(self.backlinks, name)
            await resolve_delegation(
                self.settings, self.backlinks.projects, delegation,
                project_id, organization_id, write=True,
            )
            detail = await self.backlinks.read(
                project_id, organization_id, "get_backlink_opportunity",
                {"opportunityId": validated["opportunityId"]}, delegation=delegation,
            )
            item = detail["data"]["item"]
            action = item.get("primaryNextAction") or {}
            if (
                item.get("draftId") is not None
                or action.get("kind") != "CREATE_EMAIL_DRAFT"
                or action.get("enabled") is not True
            ):
                raise ValueError("BACKLINKS_DRAFT_NOT_READY: inspect existing draft or blockers")
            validated["operation_id"] = operation_id
            return PreparedWrite(validated, {}, action_hash(name, validated, {}), 0.0)
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
        elif name == "start_technical_audit":
            before = {"audit_run_id": project.audit_run_id, "audit_status": project.audit_status}
            validated["operation_id"] = operation_id
        else:
            before = {}
            validated["operation_id"] = operation_id
        parameters_hash = action_hash(name, validated, before)
        return PreparedWrite(
            validated, before, parameters_hash,
            TOOL_DEFINITIONS[name].estimated_cost,
        )

    async def execute_write(
        self, project_id: str, name: str, arguments: dict, before: dict, expected_hash: str,
        *, organization_id: str = "", delegation: dict | None = None,
        run_id: str | None = None,
    ) -> dict:
        if name == "initialize_backlink_project":
            if action_hash(name, arguments, before) != expected_hash:
                raise ValueError("BACKLINKS_INITIALIZATION_PARAMETERS_CHANGED")
            return await BacklinksInitialization(self).execute(
                project_id, organization_id, delegation, before,
            )
        if name == "cancel_project_task":
            if action_hash(name, arguments, before) != expected_hash:
                raise ValueError("TASK_PARAMETERS_CHANGED")
            return await cancel_task(
                self, project_id, organization_id, delegation, arguments, run_id,
            )
        if name == "send_backlink_drafts":
            self._require_service(self.backlinks, name)
            if (
                not run_id or before.get("source_run_id") != run_id
                or action_hash(name, arguments, before) != expected_hash
            ):
                raise ValueError("BACKLINKS_CHAT_SEND_PARAMETERS_CHANGED")
            from app.db.session import session_factory
            from app.modules.agent.service import build_agent_service
            return await BacklinksChatSend(
                self.backlinks, session_factory, build_agent_service().limits,
            ).submit(project_id, organization_id, delegation, run_id, {
                key: value for key, value in arguments.items() if key != "operation_id"
            })
        if name == "start_backlink_campaign":
            self._require_service(self.backlinks, name)
            if action_hash(name, arguments, before) != expected_hash:
                raise ValueError("BACKLINKS_CAMPAIGN_PARAMETERS_CHANGED")
            if arguments.get("consent_id") is None and (
                not run_id or before.get("source_run_id") != run_id
            ):
                raise ValueError("BACKLINKS_CAMPAIGN_SOURCE_CHANGED")
            from app.db.session import session_factory
            from app.modules.agent.backlinks_campaign import BacklinksCampaign
            from app.modules.agent.service import build_agent_service
            return await BacklinksCampaign(
                self.backlinks, session_factory, build_agent_service().limits,
            ).start(project_id, organization_id, delegation, {
                key: value for key, value in arguments.items() if key != "operation_id"
            }, **({"run_id": run_id} if arguments.get("consent_id") is None else {}))
        if name in PIPELINE_WRITE_MODELS:
            self._require_service(self.backlinks, name)
            if action_hash(name, arguments, before) != expected_hash:
                raise ValueError("BACKLINKS_PIPELINE_PARAMETERS_CHANGED")
            return await BacklinksPipeline(BacklinksDrafts(self.backlinks)).execute(
                project_id, organization_id, delegation, name, arguments,
            )
        if name == "submit_backlink_email":
            self._require_service(self.backlinks, name)
            if action_hash(name, arguments, before) != expected_hash:
                raise ValueError("BACKLINKS_SEND_PARAMETERS_CHANGED")
            return await BacklinksSender(
                BacklinksDrafts(self.backlinks), self.send_confirmations,
            ).submit(
                project_id, organization_id, delegation, arguments, before["confirmation_hash"],
            )
        if name == "preflight_backlink_email":
            self._require_service(self.backlinks, name)
            if action_hash(name, arguments, before) != expected_hash:
                raise ValueError("BACKLINKS_PREFLIGHT_PARAMETERS_CHANGED")
            return await preflight(
                BacklinksDrafts(self.backlinks), project_id, organization_id, delegation, arguments,
            )
        if name == "create_backlink_draft":
            self._require_service(self.backlinks, name)
            if action_hash(name, arguments, before) != expected_hash:
                raise ValueError("BACKLINKS_DRAFT_PARAMETERS_CHANGED")
            return await BacklinksDrafts(self.backlinks).create(
                project_id, organization_id, delegation, arguments,
            )
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
        elif name == "start_technical_audit":
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
        else:
            current_before = {}
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
        if name == "start_technical_audit":
            payload = {key: value for key, value in arguments.items() if key != "operation_id"}
            result = await self.audits.create_run(project_id, CreateAuditRunRequest.model_validate(payload), arguments["operation_id"])
            verified = await self._get_audit_run(project_id, arguments["operation_id"])
            await self._observe_started_step(project_id, "technical_audit", result.run_id)
            return {
                "operation_id": arguments["operation_id"],
                "verified": verified.run_id == result.run_id,
                "run_id": result.run_id,
                "status": verified.status,
            }
        if name == "start_keyword_library":
            self._require_service(self.keywords, name)
            result = await self.keywords.start_initial_build(
                project_id, arguments["operation_id"]
            )
            await self._observe_started_step(project_id, "keyword_library", result.run_id)
            return {
                "operation_id": arguments["operation_id"],
                "verified": True,
                "run_id": result.run_id,
                "status": result.status,
            }
        if name == "start_content_plan":
            self._require_service(self.content_plans, name)
            self._require_service(self.keywords, name)
            keyword_state = await self.keywords.status(project_id)
            if (
                keyword_state.run is None
                or keyword_state.run.status not in {"partial", "completed"}
            ):
                raise RuntimeError("keyword_library_not_ready")
            result = await self.content_plans.create_automatic(
                self.settings.default_organization_id,
                project_id,
                idempotency_key=f"agent:{arguments['operation_id']}:content-plan",
            )
            await self._observe_started_step(project_id, "content_plan", result.batch_id)
            return {
                "operation_id": arguments["operation_id"],
                "verified": True,
                "batch_id": result.batch_id,
                "status": "queued",
            }
        if name == "start_articles":
            self._require_service(self.content, name)
            self._require_service(self.content_plans, name)
            batch = await self.content_plans.get_batch(
                self.settings.default_organization_id,
                project_id,
                arguments["batch_id"],
            )
            if (
                batch.source != "automatic"
                or batch.status != "completed"
                or batch.target_count != 30
                or batch.plan_item_count != 30
            ):
                raise RuntimeError("content_plan_not_ready")
            results = await self.content.generate_next_planned_articles(
                project_id,
                arguments["count"],
                organization_id=self.settings.default_organization_id,
                batch_id=arguments["batch_id"],
            )
            articles = []
            for index, result in enumerate(results):
                if result.run is None:
                    raise RuntimeError("article_run_missing")
                await self._observe_started_step(
                    project_id,
                    "first_article" if index == 0 else "second_article",
                    result.run.id,
                )
                articles.append(
                    {
                        "article_id": result.id,
                        "run_id": result.run.id,
                        "title": result.title,
                        "status": result.run.status,
                    }
                )
            return {
                "operation_id": arguments["operation_id"],
                "verified": len(articles) == arguments["count"],
                "article_ids": [item["article_id"] for item in articles],
                "articles": articles,
            }
        if name == "create_article":
            self._require_service(self.content, name)
            payload = {
                key: value for key, value in arguments.items() if key != "operation_id"
            }
            article = await self.content.create_article(
                project_id,
                CreateArticleRequest.model_validate(payload),
                idempotency_key=f"agent:{arguments['operation_id']}:article",
                organization_id=self.settings.default_organization_id,
            )
            if article.run is None:
                raise RuntimeError("article_run_missing")
            return {
                "operation_id": arguments["operation_id"],
                "verified": True,
                "article_id": article.id,
                "run_id": article.run.id,
                "primary_keyword": article.primary_keyword,
                "title": article.title,
                "status": article.run.status,
                "stage": article.run.stage,
                "progress": article.run.progress,
            }
        raise ValueError("unsupported write tool")

    @staticmethod
    def _require_service(service: Any | None, name: str) -> None:
        if service is None:
            raise RuntimeError(f"tool_service_not_configured:{name}")

    async def _observe_started_step(
        self, project_id: str, step_key: str, external_run_id: str
    ) -> None:
        if self.onboarding is None:
            return
        try:
            await self.onboarding.observe_started_step(
                self.settings.default_organization_id,
                project_id,
                step_key,
                external_run_id,
            )
        except OnboardingNotFoundError:
            return

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
