"""Read-only projections of existing runs, never a second execution registry."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import case, literal, select, union_all

from app.modules.agent.models import AgentConversation, AgentRun
from app.modules.content.models import ArticleRun
from app.modules.content_plan.models import ContentPlanBatch
from app.modules.crawling.models import CrawlRun
from app.modules.keywords.models import KeywordBuildRun
from app.modules.onboarding.models import OnboardingRun, OnboardingStep
from app.modules.performance.models import PerformanceSyncRun
from app.core.config import get_settings


ACTIVE_TASK_STATUSES = (
    "queued", "running", "executing", "verifying", "waiting", "blocked",
    "waiting_for_confirmation", "awaiting_approval", "stopping", "recalculating",
    "paused",
    "selecting_seeds", "expanding", "building_packs", "supplementing",
    "building_previews", "creating_items", "scheduling", "needs_attention",
)


class ProjectTask(BaseModel):
    id: str
    kind: Literal["article", "content_plan", "audit", "project", "keywords", "agent", "performance", "onboarding"]
    title: str
    status: str
    progress: int | None
    stage: str | None
    updated_at: datetime
    related_id: str | None
    reason_code: str | None = None


class ProjectTasksResponse(BaseModel):
    items: list[ProjectTask]
    has_more: bool


def task_statement(project_id: str, organization_id: str, permissions: tuple[str, ...],
                   *, kind: str | None = None, task_id: str | None = None):
    def scoped(model):
        return (model.project_id == project_id, model.organization_id == organization_id)

    def columns(identifier, kind, title, status, progress, stage, updated, related,
                reason=None):
        return (
            identifier.label("id"), kind.label("kind"), title.label("title"),
            status.label("status"), progress.label("progress"), stage.label("stage"),
            updated.label("updated_at"), related.label("related_id"),
            (reason if reason is not None else literal(None)).label("reason_code"),
        )

    statements = [
        select(*columns(
            CrawlRun.run_id,
            case((CrawlRun.task_type == "technical_audit", "audit"), else_="project"),
            case((CrawlRun.task_type == "technical_audit", "网站审计"), else_="网站资料"),
            CrawlRun.status, literal(None), CrawlRun.stage, CrawlRun.updated_at,
            CrawlRun.run_id,
        )).where(*scoped(CrawlRun), CrawlRun.archived_at.is_(None)),
        select(*columns(
            KeywordBuildRun.id, literal("keywords"), literal("关键词生成"),
            KeywordBuildRun.status, KeywordBuildRun.progress, KeywordBuildRun.stage,
            KeywordBuildRun.updated_at, KeywordBuildRun.id, KeywordBuildRun.error_code,
        )).where(*scoped(KeywordBuildRun)),
    ]
    if "content:read" in permissions:
        statements.append(select(*columns(
            ArticleRun.id, literal("article"), literal("文章生成"), ArticleRun.status,
            ArticleRun.progress, ArticleRun.stage, ArticleRun.updated_at, ArticleRun.article_id,
            ArticleRun.error_code,
        )).where(*scoped(ArticleRun)))
        statements.append(select(*columns(
            ContentPlanBatch.id, literal("content_plan"), literal("内容计划"),
            ContentPlanBatch.status, literal(None), ContentPlanBatch.stage,
            ContentPlanBatch.updated_at, ContentPlanBatch.id, ContentPlanBatch.error_code,
        )).where(*scoped(ContentPlanBatch)))
    if "backlinks:read" in permissions:
        statements.extend([
            select(*columns(
                AgentRun.id, literal("agent"), AgentConversation.title, AgentRun.status,
                literal(None), literal(None), AgentRun.updated_at, AgentRun.conversation_id,
                AgentRun.error_code,
            )).join(AgentConversation, AgentConversation.id == AgentRun.conversation_id)
            .where(*scoped(AgentConversation), AgentConversation.archived_at.is_(None)),
            select(*columns(
                PerformanceSyncRun.id, literal("performance"), literal("效果数据同步"),
                PerformanceSyncRun.status, literal(None), literal(None),
                case(
                    (PerformanceSyncRun.completed_at.is_not(None), PerformanceSyncRun.completed_at),
                    else_=PerformanceSyncRun.started_at,
                ), PerformanceSyncRun.id,
            )).where(*scoped(PerformanceSyncRun)),
            select(*columns(
                OnboardingRun.id, literal("onboarding"), literal("项目初始化"),
                OnboardingRun.status, literal(None), literal(None), OnboardingRun.updated_at,
                OnboardingRun.agent_conversation_id,
                case((select(OnboardingStep.id).where(
                    OnboardingStep.run_id == OnboardingRun.id,
                    OnboardingStep.status == "failed",
                    OnboardingRun.status != "completed",
                ).exists(), "onboarding_step_failed"), else_=None),
            )).where(*scoped(OnboardingRun)),
        ])
    tasks = union_all(*statements).subquery()
    statement = select(tasks)
    if kind is not None:
        statement = statement.where(tasks.c.kind == kind)
    if task_id is not None:
        statement = statement.where(tasks.c.id == task_id)
    return statement.order_by(
        case((tasks.c.status.in_(ACTIVE_TASK_STATUSES), 0), else_=1),
        tasks.c.updated_at.desc(), tasks.c.kind, tasks.c.id,
    ).limit(101)


async def read_project_tasks(sessions, context, *, kind=None, task_id=None) -> ProjectTasksResponse:
    async with sessions() as session:
        result = await session.execute(task_statement(
            context.project.website_project_id,
            context.tenant.organization_id,
            context.permissions,
            kind=kind, task_id=task_id,
        ))
        rows = result.mappings().all()
    items = [ProjectTask.model_validate(dict(row)) for row in rows[:100]]
    settings = get_settings()
    for task in items:
        dispatch_enabled = settings.platform_background_dispatch_enabled or (
            task.kind == "agent" and settings.agent_background_dispatch_enabled
        )
        if task.status == "queued" and not dispatch_enabled and not task.reason_code:
            task.reason_code = "background_dispatch_disabled"
    return ProjectTasksResponse(
        items=items,
        has_more=len(rows) > 100,
    )
