from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from hashlib import sha256
from typing import Protocol

from temporalio.exceptions import WorkflowAlreadyStartedError

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.content.models import Article, ArticleRun, ArticleSource
from app.modules.content.repository import (
    ArticleIdempotencyConflictError,
    ContentRepository,
)
from app.modules.content.schemas import (
    ArticleCollection,
    ArticleDetailResponse,
    ArticleResponse,
    ArticleRunResponse,
    ArticleSourceResponse,
    CreateArticleRequest,
)
from app.modules.settings.service import (
    AIProviderNotConfiguredError,
    AIProviderSettingsRecord,
    build_ai_settings_service,
)
from app.workflows.client import connect_temporal


class ContentNotFoundError(Exception):
    pass


class ContentConflictError(Exception):
    pass


class ContentConfigurationError(ValueError):
    pass


class ContentWorkflowController(Protocol):
    async def start(self, run_id: str) -> None: ...

    async def cancel(self, workflow_id: str) -> None: ...


class ContentAISettings(Protocol):
    async def effective_record(self) -> AIProviderSettingsRecord: ...

    async def effective_record_for_organization(
        self, organization_id: str
    ) -> AIProviderSettingsRecord: ...


class TemporalContentWorkflowController:
    def __init__(self, task_queue: str) -> None:
        self.task_queue = task_queue

    async def start(self, run_id: str) -> None:
        client = await connect_temporal()
        try:
            await client.start_workflow(
                "ArticleGenerationWorkflow",
                {"run_id": run_id},
                id=f"article-generation:{run_id}",
                task_queue=self.task_queue,
            )
        except WorkflowAlreadyStartedError:
            return

    async def cancel(self, workflow_id: str) -> None:
        client = await connect_temporal()
        await client.get_workflow_handle(workflow_id).cancel()


class ContentService:
    def __init__(
        self,
        settings: Settings,
        repository: ContentRepository,
        ai_settings: ContentAISettings | None = None,
        controller: ContentWorkflowController | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.ai_settings = ai_settings or build_ai_settings_service()
        self.controller = controller or TemporalContentWorkflowController(
            settings.content_task_queue
        )

    def request_hash(self, primary_keyword: str) -> str:
        payload = json.dumps(
            {"primary_keyword": primary_keyword}, separators=(",", ":"), ensure_ascii=True
        )
        return sha256(payload.encode("utf-8")).hexdigest()

    async def create_article(
        self,
        project_id: str,
        request: CreateArticleRequest,
        idempotency_key: str,
        *,
        organization_id: str | None = None,
    ) -> ArticleResponse:
        organization_id = organization_id or self.settings.default_organization_id
        await self._ensure_project(project_id, organization_id=organization_id)
        try:
            model = await self._effective_model(organization_id)
        except AIProviderNotConfiguredError as exc:
            raise ContentConfigurationError(str(exc)) from exc
        normalized_key = idempotency_key.strip()
        if not normalized_key or len(normalized_key) > 200:
            raise ValueError("Idempotency-Key 长度必须为 1-200")
        try:
            article, run = await self.repository.create_article(
                organization_id,
                project_id,
                request.primary_keyword,
                normalized_key,
                self.request_hash(request.primary_keyword),
                model_snapshot(model),
            )
        except ArticleIdempotencyConflictError as exc:
            raise ContentConflictError("同一幂等键不能用于不同的文章请求") from exc
        try:
            await self.controller.start(run.id)
        except Exception:
            # queued is the durable dispatch state; the background dispatcher retries it.
            pass
        return article_response(article, run)

    async def list_articles(
        self,
        project_id: str,
        page: int,
        page_size: int,
        article_status: str | None,
        search: str | None,
        *,
        organization_id: str | None = None,
    ) -> ArticleCollection:
        organization_id = organization_id or self.settings.default_organization_id
        await self._ensure_project(project_id, organization_id=organization_id)
        normalized_search = search.strip() if search and search.strip() else None
        rows, total = await self.repository.list_articles(
            organization_id,
            project_id,
            page,
            page_size,
            article_status,
            normalized_search,
        )
        return ArticleCollection(
            items=[article_response(article, run) for article, run in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    async def get_article(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str | None = None,
    ) -> ArticleDetailResponse:
        organization_id = organization_id or self.settings.default_organization_id
        result = await self.repository.get_article(
            organization_id, project_id, article_id
        )
        if result is None:
            raise ContentNotFoundError
        article, run = result
        sources = await self.repository.list_article_sources(run.id) if run else []
        return article_detail_response(article, run, sources)

    async def get_run(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str | None = None,
    ) -> ArticleRunResponse:
        organization_id = organization_id or self.settings.default_organization_id
        run = await self.repository.get_run(
            organization_id, project_id, article_id
        )
        if run is None:
            raise ContentNotFoundError
        return run_response(run)

    async def cancel_article(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str | None = None,
    ) -> ArticleResponse:
        organization_id = organization_id or self.settings.default_organization_id
        result = await self.repository.cancel_article(
            organization_id, project_id, article_id
        )
        if result is None:
            raise ContentNotFoundError
        _, run = result
        if run is not None:
            try:
                await self.controller.cancel(run.workflow_id)
            except Exception:
                pass
        return article_response(*result)

    async def dispatch_queued(self, limit: int = 20) -> int:
        dispatched = 0
        started_run_ids: set[str] = set()
        for item, organization_id in await self.repository.claim_due_plan_items(
            now=datetime.now(UTC), limit=limit
        ):
            try:
                model = await self._effective_model(organization_id)
                _article, run = await self.repository.create_article_from_plan(
                    organization_id,
                    item.project_id,
                    item.id,
                    expected_version=item.version,
                    model_snapshot=model_snapshot(model),
                    now=datetime.now(UTC),
                    explicit=False,
                )
                await self.controller.start(run.id)
                started_run_ids.add(run.id)
            except Exception as exc:
                await self.repository.release_plan_trigger(
                    item.id,
                    error_code="plan_trigger_failed",
                    error_detail=str(exc),
                )
                continue
            dispatched += 1
        for run in await self.repository.queued_runs(limit):
            if run.id in started_run_ids:
                continue
            try:
                await self.controller.start(run.id)
            except Exception:
                continue
            dispatched += 1
        return dispatched

    async def generate_plan_item_now(
        self,
        project_id: str,
        plan_item_id: str,
        *,
        expected_version: int,
        organization_id: str | None = None,
    ) -> ArticleResponse:
        organization_id = organization_id or self.settings.default_organization_id
        await self._ensure_project(project_id, organization_id=organization_id)
        try:
            model = await self._effective_model(organization_id)
            article, run = await self.repository.create_article_from_plan(
                organization_id,
                project_id,
                plan_item_id,
                expected_version=expected_version,
                model_snapshot=model_snapshot(model),
                now=datetime.now(UTC),
                explicit=True,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except AIProviderNotConfiguredError as exc:
            raise ContentConfigurationError(str(exc)) from exc
        if article.project_id != project_id:
            raise ContentNotFoundError
        try:
            await self.controller.start(run.id)
        except Exception:
            pass
        return article_response(article, run)

    async def _effective_model(
        self, organization_id: str
    ) -> AIProviderSettingsRecord:
        organization_lookup = getattr(
            self.ai_settings, "effective_record_for_organization", None
        )
        if organization_lookup is not None:
            return await organization_lookup(organization_id)
        return await self.ai_settings.effective_record()

    async def review_article(
        self,
        project_id: str,
        article_id: str,
        request: object,
        *,
        organization_id: str,
        reviewed_by: str,
    ) -> ArticleResponse:
        try:
            article, run = await self.repository.review_article(
                organization_id,
                project_id,
                article_id,
                decision=request.review_status,
                review_note=request.review_note,
                expected_version=request.review_version,
                reviewed_by=reviewed_by,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except ValueError as exc:
            if str(exc) == "review_note_required":
                raise ValueError(str(exc)) from exc
            raise ContentConflictError(str(exc)) from exc
        return article_response(article, run)

    async def _ensure_project(
        self, project_id: str, *, organization_id: str | None = None
    ) -> None:
        if not await self.repository.project_exists(
            organization_id or self.settings.default_organization_id, project_id
        ):
            raise ContentNotFoundError


def run_response(row: ArticleRun) -> ArticleRunResponse:
    return ArticleRunResponse(
        id=row.id,
        article_id=row.article_id,
        status=row.status,
        stage=row.stage,
        progress=row.progress,
        warnings=list(row.warnings_json),
        started_at=row.started_at,
        soft_deadline_at=row.soft_deadline_at,
        hard_deadline_at=row.hard_deadline_at,
        finished_at=row.finished_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def article_response(row: Article, run: ArticleRun | None) -> ArticleResponse:
    return ArticleResponse(
        id=row.id,
        project_id=row.project_id,
        primary_keyword=row.primary_keyword,
        title=row.title,
        slug=row.slug,
        meta_title=row.meta_title,
        meta_description=row.meta_description,
        status=row.status,
        publication_status=row.publication_status,
        review_status=row.review_status,
        review_version=row.review_version or 0,
        publication_blocked_reason=row.publication_blocked_reason,
        warning_count=row.warning_count,
        run=run_response(run) if run else None,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def article_detail_response(
    row: Article, run: ArticleRun | None, sources: list[ArticleSource]
) -> ArticleDetailResponse:
    summary = article_response(row, run)
    markdown = row.markdown or ""
    markdown_urls = set(
        re.findall(r"\[[^\]]+\]\((https?://[^\s)]+)\)", markdown)
    )
    external_sources: list[ArticleSourceResponse] = []
    internal_links: list[ArticleSourceResponse] = []
    for source in sources:
        if source.status != "available":
            continue
        response = ArticleSourceResponse(
            source_type=source.source_type,
            url=source.url,
            title=source.title,
            domain=source.domain,
        )
        if source.source_type == "internal":
            if source.url in markdown_urls:
                internal_links.append(response)
        elif source.source_type in {"authority", "research", "competitor"}:
            if source.claims_json or source.url in markdown_urls:
                external_sources.append(response)
    return ArticleDetailResponse(
        **summary.model_dump(),
        outline=dict(row.outline_json),
        markdown=row.markdown,
        html=row.html,
        external_sources=external_sources,
        internal_links=internal_links,
    )


def model_snapshot(record: AIProviderSettingsRecord) -> dict[str, object]:
    return {
        "provider": record.provider,
        "base_url": record.base_url,
        "model": record.model,
        "request_timeout_seconds": record.request_timeout_seconds,
        "max_retries": record.max_retries,
        "updated_at": record.updated_at.isoformat() if record.updated_at else None,
    }


def build_content_service() -> ContentService:
    return ContentService(get_settings(), ContentRepository(session_factory))
