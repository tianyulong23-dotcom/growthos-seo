from __future__ import annotations

import asyncio
import json
import re
from base64 import urlsafe_b64decode, urlsafe_b64encode
from difflib import SequenceMatcher
from datetime import UTC, datetime
from enum import StrEnum
from hashlib import sha256
from typing import Protocol

from temporalio.client import WorkflowExecutionStatus
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.content.models import (
    Article,
    ArticleAutosave,
    ArticleLock,
    ArticlePublication,
    ArticleLinkAnalysis,
    ArticleReviewComment,
    ArticleReviewTask,
    ArticleRun,
    ArticleSeoAnalysis,
    ArticleSource,
    ArticleVersion,
)
from app.modules.content.asset_security import SecureUrlImporter
from app.modules.content.enhanced_cards import resolve_bookmark, resolve_embed
from app.modules.content.link_analysis import (
    LINK_RULESET_VERSION,
    absolute_link,
    analyze_links,
    extract_links,
    normalize_domain,
)
from app.modules.content.document import (
    ArticleDocumentError,
    document_capabilities,
    document_content_hash,
    document_to_html,
    document_to_markdown,
    normalize_document,
)
from app.modules.content.repository import (
    ArticleIdempotencyConflictError,
    ArticleLockConflictError,
    ContentAuditContext,
    ContentRepository,
    article_metadata_snapshot,
    normalize_source_url,
    normalize_article_indexing,
)
from app.modules.content.seo_analysis import (
    RULESET_VERSION,
    analyze_seo,
    document_hash as seo_document_hash,
    metadata_hash as seo_metadata_hash,
    normalize_locale,
)
from app.modules.content.publication import (
    LiveWordPressTransport,
    WordPressPublishError,
    WordPressTransport,
)
from app.modules.content.publication_service import PublicationService
from app.modules.content.schemas import (
    ArticleAutosaveRequest,
    ArticleAutosaveResponse,
    ArticleAutosaveSnapshot,
    ArticleCollection,
    ArticleDetailResponse,
    ArticleDocumentCapabilities,
    ArticleResponse,
    ArticleRunResponse,
    ArticleSeoAnalysisRequest,
    ArticleSeoAnalysisResponse,
    ArticleLinkAnalysisRequest,
    ArticleLinkAnalysisResponse,
    BookmarkResolveRequest,
    BookmarkResolveResponse,
    EmbedResolveRequest,
    EmbedResolveResponse,
    FactSourceCandidate,
    FactSourceCandidateCollection,
    InternalLinkCandidate,
    InternalLinkCandidateCollection,
    ArticleSourceResponse,
    ArticleVersionCollection,
    ArticleVersionDetail,
    ArticleVersionDiff,
    ArticleVersionDiffLine,
    ArticleVersionMetadataChange,
    ArticleVersionSummary,
    AddArticleReviewCommentRequest,
    AcquireArticleLockRequest,
    ArticleLockResponse,
    ArticleReviewCommentResponse,
    ArticleReviewSnapshotResponse,
    ArticleReviewTaskCollection,
    ArticleReviewTaskResponse,
    CancelArticleReviewRequest,
    CreateArticleRequest,
    DecideArticleReviewRequest,
    ForceReleaseArticleLockRequest,
    PublishArticleRequest,
    PromoteArticleAutosaveRequest,
    ReleaseArticleLockRequest,
    RenewArticleLockRequest,
    RestoreArticleVersionRequest,
    SubmitArticleReviewRequest,
    UpdateArticleDocumentRequest,
)
from app.modules.settings.service_connections import (
    SQLAlchemyServiceConnectionRepository,
    ServiceConnectionEncryptionUnavailableError,
    ServiceConnectionRepository,
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
    def __init__(
        self,
        message: str,
        *,
        current_version: int | None = None,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.current_version = current_version
        self.details = details or {}


class ContentConfigurationError(ValueError):
    pass


class ContentPermissionError(Exception):
    pass


class ContentWorkflowState(StrEnum):
    RUNNING = "running"
    CLOSED = "closed"
    NOT_FOUND = "not_found"


class ContentWorkflowController(Protocol):
    async def start(self, run_id: str) -> None: ...

    async def cancel(self, workflow_id: str) -> None: ...

    async def status(self, workflow_id: str) -> ContentWorkflowState: ...


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

    async def status(self, workflow_id: str) -> ContentWorkflowState:
        client = await connect_temporal()
        try:
            description = await client.get_workflow_handle(workflow_id).describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return ContentWorkflowState.NOT_FOUND
            raise
        return (
            ContentWorkflowState.RUNNING
            if description.status == WorkflowExecutionStatus.RUNNING
            else ContentWorkflowState.CLOSED
        )


class ContentService:
    def __init__(
        self,
        settings: Settings,
        repository: ContentRepository,
        ai_settings: ContentAISettings | None = None,
        controller: ContentWorkflowController | None = None,
        service_connections: ServiceConnectionRepository | None = None,
        wordpress_transport: WordPressTransport | None = None,
        url_importer: SecureUrlImporter | None = None,
        publication_service: PublicationService | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.ai_settings = ai_settings or build_ai_settings_service()
        self.controller = controller or TemporalContentWorkflowController(
            settings.content_task_queue
        )
        self.service_connections = service_connections or SQLAlchemyServiceConnectionRepository(
            session_factory
        )
        self.wordpress_transport = wordpress_transport or LiveWordPressTransport()
        self.url_importer = url_importer or SecureUrlImporter(settings)
        self.publication_service = publication_service

    def request_hash(self, request: CreateArticleRequest) -> str:
        payload = json.dumps(
            request.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        return sha256(payload.encode("utf-8")).hexdigest()

    @staticmethod
    def governance_request_hash(payload: object) -> str:
        serialized = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        return sha256(serialized.encode("utf-8")).hexdigest()

    @staticmethod
    def command_hash(article_id: str, trigger_type: str) -> str:
        payload = json.dumps(
            {"article_id": article_id, "trigger_type": trigger_type},
            sort_keys=True,
            separators=(",", ":"),
        )
        return sha256(payload.encode()).hexdigest()

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
                manual_input_snapshot(request),
                normalized_key,
                self.request_hash(request),
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

    async def create_followup_run(
        self,
        project_id: str,
        article_id: str,
        trigger_type: str,
        idempotency_key: str,
        *,
        organization_id: str | None = None,
    ) -> ArticleResponse:
        organization_id = organization_id or self.settings.default_organization_id
        normalized_key = idempotency_key.strip()
        if not normalized_key or len(normalized_key) > 200:
            raise ValueError("Idempotency-Key 长度必须为 1-200")
        model: AIProviderSettingsRecord | None = None
        if trigger_type == "regeneration":
            try:
                model = await self._effective_model(organization_id)
            except AIProviderNotConfiguredError as exc:
                raise ContentConfigurationError(str(exc)) from exc
        try:
            article, run = await self.repository.create_followup_run(
                organization_id,
                project_id,
                article_id,
                trigger_type=trigger_type,
                idempotency_key=normalized_key,
                request_hash=self.command_hash(article_id, trigger_type),
                model_snapshot=model_snapshot(model) if model else None,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except ArticleIdempotencyConflictError as exc:
            raise ContentConflictError("同一幂等键不能用于不同的文章命令") from exc
        except ValueError as exc:
            raise ContentConflictError(str(exc)) from exc
        try:
            await self.controller.start(run.id)
        except Exception:
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
        publications = await self.repository.latest_publications(
            [article.id for article, _run in rows]
        )
        return ArticleCollection(
            items=[
                article_response(article, run, publications.get(article.id))
                for article, run in rows
            ],
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
        publication = (await self.repository.latest_publications([article.id])).get(
            article.id
        )
        return article_detail_response(article, run, sources, publication)

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

    async def get_article_generation_snapshot(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str | None = None,
    ) -> dict[str, object]:
        organization_id = organization_id or self.settings.default_organization_id
        result = await self.repository.get_article(
            organization_id, project_id, article_id
        )
        if result is None:
            raise ContentNotFoundError
        article, run = result
        metrics = dict(run.metrics_json or {}) if run else {}
        reported_cost = metrics.get("reported_cost")
        return {
            "article_id": article.id,
            "primary_keyword": article.primary_keyword,
            "title": article.title,
            "run_id": run.id if run else None,
            "status": run.status if run else article.status,
            "stage": run.stage if run else None,
            "progress": run.progress if run else None,
            "warnings": list(run.warnings_json or []) if run else [],
            "error_code": run.error_code if run else None,
            "error_detail": run.error_detail if run else None,
            "billing": {
                "reported_cost": reported_cost,
                "estimated_cost": metrics.get("estimated_cost"),
                "complete": bool(
                    run
                    and run.status
                    in {"completed", "completed_with_warnings", "failed", "cancelled"}
                    and reported_cost is not None
                ),
            },
        }

    async def analyze_article_seo(
        self,
        project_id: str,
        article_id: str,
        request: ArticleSeoAnalysisRequest,
        *,
        organization_id: str | None = None,
    ) -> ArticleSeoAnalysisResponse:
        organization_id = organization_id or self.settings.default_organization_id
        result = await self.repository.get_article(organization_id, project_id, article_id)
        if result is None:
            raise ContentNotFoundError
        article, _run = result
        ruleset = request.ruleset_version or RULESET_VERSION
        if ruleset != RULESET_VERSION:
            raise ValueError("seo_ruleset_unsupported")
        document = normalize_document(dict(article.document_json or {}))
        metadata = article_metadata_snapshot(article)
        context = await self._current_seo_context(
            organization_id, project_id, article_id, metadata
        )
        current_document_hash = seo_document_hash(document)
        current_metadata_hash = seo_metadata_hash(metadata)
        if (
            request.document_hash != current_document_hash
            or request.metadata_hash != current_metadata_hash
        ):
            raise ContentConflictError(
                "seo_analysis_input_stale",
                details={
                    "document_hash": current_document_hash,
                    "metadata_hash": current_metadata_hash,
                },
            )
        cached = await self.repository.get_cached_seo_analysis(
            article.id, current_document_hash, current_metadata_hash, ruleset
        )
        cached_context = (
            dict(cached.input_snapshot or {}).get("context") if cached else None
        )
        if cached is not None and cached_context == context:
            return article_seo_analysis_response(
                cached,
                current_document_hash=current_document_hash,
                current_metadata_hash=current_metadata_hash,
            )
        previous = await self.repository.latest_seo_analysis(
            article.id, ruleset_version=ruleset, completed_only=True
        )
        changed_fields = self._seo_changed_fields(
            previous, document, metadata, context, set(request.changed_fields)
        )
        try:
            analysis = analyze_seo(
                document,
                metadata,
                context=context,
                changed_fields=changed_fields if previous is not None else None,
                previous_results=dict(previous.results or {}) if previous else None,
            )
            saved = await self.repository.save_seo_analysis(
                article_id=article.id,
                version_number=article.current_version_number or None,
                document_hash=current_document_hash,
                metadata_hash=current_metadata_hash,
                ruleset_version=ruleset,
                input_snapshot={
                    "document": document,
                    "metadata": metadata,
                    "context": context,
                },
                results=analysis,
                score=int(analysis["score"]),
                max_score=int(analysis["max_score"]),
                status="completed",
            )
            return article_seo_analysis_response(
                saved,
                current_document_hash=current_document_hash,
                current_metadata_hash=current_metadata_hash,
            )
        except Exception as exc:
            if cached is None:
                await self.repository.save_seo_analysis(
                    article_id=article.id,
                    version_number=article.current_version_number or None,
                    document_hash=current_document_hash,
                    metadata_hash=current_metadata_hash,
                    ruleset_version=ruleset,
                    input_snapshot={
                        "document": document,
                        "metadata": metadata,
                        "context": context,
                    },
                    results={},
                    score=0,
                    max_score=100,
                    status="failed",
                    error_code="seo_analysis_failed",
                    error_detail=str(exc)[:2000],
                )
            if previous is not None:
                return article_seo_analysis_response(
                    previous,
                    current_document_hash=current_document_hash,
                    current_metadata_hash=current_metadata_hash,
                    status="failed",
                    error_code="seo_analysis_failed",
                    error_detail=str(exc)[:2000],
                )
            return ArticleSeoAnalysisResponse(
                analysis_id=None,
                article_version=article.current_version_number or None,
                document_hash=current_document_hash,
                metadata_hash=current_metadata_hash,
                ruleset_version=ruleset,
                score=0,
                max_score=100,
                is_stale=True,
                status="failed",
                error_code="seo_analysis_failed",
                error_detail=str(exc)[:2000],
                analyzed_at=None,
                groups=[],
            )

    async def latest_article_seo_analysis(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str | None = None,
    ) -> ArticleSeoAnalysisResponse:
        organization_id = organization_id or self.settings.default_organization_id
        result = await self.repository.get_article(organization_id, project_id, article_id)
        if result is None:
            raise ContentNotFoundError
        article, _run = result
        document = normalize_document(dict(article.document_json or {}))
        metadata = article_metadata_snapshot(article)
        current_document_hash = seo_document_hash(document)
        current_metadata_hash = seo_metadata_hash(metadata)
        current_context = await self._current_seo_context(
            organization_id, project_id, article_id, metadata
        )
        latest_success = await self.repository.latest_seo_analysis(
            article.id, ruleset_version=RULESET_VERSION, completed_only=True
        )
        latest_attempt = await self.repository.latest_seo_analysis(
            article.id, ruleset_version=RULESET_VERSION
        )
        if latest_success is None:
            return ArticleSeoAnalysisResponse(
                analysis_id=None,
                article_version=article.current_version_number or None,
                document_hash=current_document_hash,
                metadata_hash=current_metadata_hash,
                ruleset_version=RULESET_VERSION,
                score=0,
                max_score=100,
                is_stale=True,
                status="failed" if latest_attempt and latest_attempt.status == "failed" else "unavailable",
                error_code=latest_attempt.error_code if latest_attempt else None,
                error_detail=latest_attempt.error_detail if latest_attempt else None,
                analyzed_at=latest_attempt.created_at if latest_attempt else None,
                groups=[],
            )
        failed_after_success = (
            latest_attempt is not None
            and latest_attempt.status == "failed"
            and latest_attempt.created_at >= latest_success.created_at
        )
        saved_context = dict(latest_success.input_snapshot or {}).get("context")
        return article_seo_analysis_response(
            latest_success,
            current_document_hash=current_document_hash,
            current_metadata_hash=current_metadata_hash,
            context_stale=saved_context != current_context,
            status="failed" if failed_after_success else None,
            error_code=latest_attempt.error_code if failed_after_success else None,
            error_detail=latest_attempt.error_detail if failed_after_success else None,
        )

    async def queue_article_link_analysis(
        self,
        project_id: str,
        article_id: str,
        request: ArticleLinkAnalysisRequest,
        *,
        organization_id: str | None = None,
    ) -> ArticleLinkAnalysisResponse:
        organization_id = organization_id or self.settings.default_organization_id
        context = await self.repository.get_project_link_context(
            organization_id, project_id, article_id
        )
        if context is None:
            raise ContentNotFoundError
        article = context["article"]
        document = normalize_document(dict(article.document_json or {}))
        current_hash = seo_document_hash(document)
        if request.document_hash != current_hash:
            raise ContentConflictError(
                "link_analysis_input_stale",
                details={"document_hash": current_hash},
            )
        project = context["project"]
        options_hash = f"check_external={int(request.check_external)}"
        row = await self.repository.create_link_analysis_job(
            article_id=article.id,
            version_number=article.current_version_number or None,
            document_hash=current_hash,
            ruleset_version=LINK_RULESET_VERSION,
            options_hash=options_hash,
            input_snapshot={
                "document": document,
                "project": {
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "domain": project.domain,
                    "competitor_domain": project.competitor_domain,
                },
                "check_external": request.check_external,
            },
        )
        return article_link_analysis_response(row, current_document_hash=current_hash)

    async def latest_article_link_analysis(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str | None = None,
    ) -> ArticleLinkAnalysisResponse:
        organization_id = organization_id or self.settings.default_organization_id
        result = await self.repository.get_article(organization_id, project_id, article_id)
        if result is None:
            raise ContentNotFoundError
        article, _run = result
        current_hash = seo_document_hash(
            normalize_document(dict(article.document_json or {}))
        )
        latest_attempt = await self.repository.latest_link_analysis(article.id)
        latest_success = await self.repository.latest_link_analysis(
            article.id, completed_only=True
        )
        if latest_attempt is None:
            return ArticleLinkAnalysisResponse(
                analysis_id=None,
                article_version=article.current_version_number or None,
                document_hash=current_hash,
                ruleset_version=LINK_RULESET_VERSION,
                status="unavailable",
                is_stale=True,
                error_code=None,
                created_at=None,
                completed_at=None,
                checked_at=None,
                summary={},
                links=[],
            )
        if latest_attempt.status in {"queued", "running"} and latest_success is not None:
            return article_link_analysis_response(
                latest_success,
                current_document_hash=current_hash,
                status=latest_attempt.status,
                pending_analysis_id=latest_attempt.id,
            )
        if latest_attempt.status in {"queued", "running"}:
            return article_link_analysis_response(
                latest_attempt, current_document_hash=current_hash
            )
        if latest_attempt.status == "failed" and latest_success is not None:
            return article_link_analysis_response(
                latest_success,
                current_document_hash=current_hash,
                status="failed",
                pending_analysis_id=latest_attempt.id,
                error_code=latest_attempt.error_code,
                error_detail=latest_attempt.error_detail,
            )
        return article_link_analysis_response(
            latest_attempt, current_document_hash=current_hash
        )

    async def internal_link_candidates(
        self,
        project_id: str,
        article_id: str,
        query: str,
        *,
        cursor: str | None = None,
        limit: int = 20,
        organization_id: str | None = None,
    ) -> InternalLinkCandidateCollection:
        organization_id = organization_id or self.settings.default_organization_id
        context = await self.repository.get_project_link_context(
            organization_id, project_id, article_id
        )
        if context is None or context["run"] is None:
            raise ContentNotFoundError
        article = context["article"]
        project = context["project"]
        profile = context["profile"]
        candidates = await self.repository.list_internal_link_candidates(
            context["run"].id,
            query or article.focus_keyword or article.primary_keyword,
            list(profile.get("key_pages") or []),
            limit=50,
        )
        existing_urls = {
            normalize_source_url(absolute_link(link.href, project.domain))
            for link in extract_links(dict(article.document_json or {}))
            if link.href
        }
        offset = decode_candidate_cursor(cursor)
        page = candidates[offset : offset + limit]
        items = [
            InternalLinkCandidate(
                title=str(item["title"]),
                url=str(item["url"]),
                suggested_anchor=(
                    str((item.get("anchor_texts") or [""])[0]).strip()
                    or str(item["title"])
                ),
                target_section=find_target_section(
                    dict(article.document_json or {}), query
                ),
                duplicate_status=(
                    "already_linked"
                    if normalize_source_url(str(item["url"])) in existing_urls
                    else "new"
                ),
                candidate_kind=str(item["candidate_kind"]),
                selection_reason=str(item["selection_reason"]),
            )
            for item in page
        ]
        next_offset = offset + len(page)
        return InternalLinkCandidateCollection(
            items=items,
            next_cursor=(
                encode_candidate_cursor(next_offset)
                if next_offset < len(candidates)
                else None
            ),
        )

    async def fact_source_candidates(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str | None = None,
    ) -> FactSourceCandidateCollection:
        organization_id = organization_id or self.settings.default_organization_id
        context = await self.repository.get_project_link_context(
            organization_id, project_id, article_id
        )
        if context is None:
            raise ContentNotFoundError
        sources = await self.repository.list_fact_source_candidates(
            organization_id, project_id, article_id
        )
        competitor = normalize_domain(context["project"].competitor_domain)
        return FactSourceCandidateCollection(
            items=[
                FactSourceCandidate(
                    source_id=source.id,
                    source_type=source.source_type,
                    title=source.title,
                    url=source.url,
                    domain=source.domain,
                    status=source.status,
                    claims=list(source.claims_json or []),
                    section_ids=[str(item) for item in source.section_ids_json or []],
                    domain_risk=(
                        "competitor"
                        if competitor
                        and is_same_or_subdomain(
                            normalize_domain(source.domain or source.url), competitor
                        )
                        else "normal"
                    ),
                )
                for source in sources
            ]
        )

    async def resolve_article_bookmark(
        self,
        project_id: str,
        article_id: str,
        request: BookmarkResolveRequest,
        *,
        organization_id: str | None = None,
    ) -> BookmarkResolveResponse:
        await self._require_article(project_id, article_id, organization_id)
        return BookmarkResolveResponse(
            **await resolve_bookmark(request.url, self.url_importer)
        )

    async def resolve_article_embed(
        self,
        project_id: str,
        article_id: str,
        request: EmbedResolveRequest,
        *,
        organization_id: str | None = None,
    ) -> EmbedResolveResponse:
        await self._require_article(project_id, article_id, organization_id)
        return EmbedResolveResponse(**resolve_embed(request.url))

    async def _require_article(
        self, project_id: str, article_id: str, organization_id: str | None
    ) -> None:
        organization_id = organization_id or self.settings.default_organization_id
        if await self.repository.get_article(organization_id, project_id, article_id) is None:
            raise ContentNotFoundError

    async def _current_seo_context(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        metadata: dict,
    ) -> dict[str, object]:
        link_context = await self.repository.get_project_link_context(
            organization_id, project_id, article_id
        )
        project = link_context.get("project") if link_context else None
        domain = str(getattr(project, "domain", "") or "").strip()
        slug = str(metadata.get("slug") or "").strip().lstrip("/")
        canonical_url = str(metadata.get("canonical_url") or "").strip()
        full_url = (
            canonical_url
            or (f"https://{domain.rstrip('/')}/{slug}" if domain and slug else slug)
        )
        return {
            "locale": normalize_locale(getattr(project, "language", "en")),
            "full_url": full_url,
            "site_host": domain,
            "keyword_is_new": await self.repository.is_article_focus_keyword_new(
                organization_id,
                project_id,
                article_id,
                str(metadata.get("focus_keyword") or ""),
            ),
            "content_ai_used": False,
        }

    @staticmethod
    def _seo_changed_fields(
        previous: ArticleSeoAnalysis | None,
        document: dict,
        metadata: dict,
        context: dict,
        requested: set[str],
    ) -> set[str]:
        if previous is None:
            return {"document", *metadata.keys(), *context.keys()}
        prior_input = dict(previous.input_snapshot or {})
        actual = set(requested)
        if prior_input.get("document") != document:
            actual.add("document")
        prior_metadata = prior_input.get("metadata")
        if not isinstance(prior_metadata, dict):
            return {"document", *metadata.keys(), *context.keys()}
        actual.update(
            key for key in set(prior_metadata) | set(metadata)
            if prior_metadata.get(key) != metadata.get(key)
        )
        prior_context = prior_input.get("context")
        if not isinstance(prior_context, dict):
            actual.update(context)
        else:
            actual.update(
                key for key in set(prior_context) | set(context)
                if prior_context.get(key) != context.get(key)
            )
        return actual

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
        claim_link_jobs = getattr(self.repository, "claim_link_analysis_jobs", None)
        if claim_link_jobs is not None:
            claimed = await claim_link_jobs(limit=limit)
            for analysis_id, lease_token in claimed:
                try:
                    row = await self.repository.get_claimed_link_analysis(
                        analysis_id, lease_token
                    )
                    if row is None:
                        continue
                    snapshot = dict(row.input_snapshot or {})
                    project = dict(snapshot.get("project") or {})
                    results = await analyze_links(
                        dict(snapshot.get("document") or {}),
                        project_domain=str(project.get("domain") or ""),
                        competitor_domain=project.get("competitor_domain"),
                        importer=self.url_importer,
                        check_external=bool(snapshot.get("check_external", True)),
                    )
                    await self.repository.complete_link_analysis(
                        analysis_id, lease_token, results
                    )
                except Exception as exc:
                    await self.repository.fail_link_analysis(
                        analysis_id,
                        lease_token,
                        error_code="link_analysis_failed",
                        error_detail=str(exc),
                    )
                dispatched += 1
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

    async def reconcile_active_runs(self, limit: int = 100) -> int:
        reconciled = 0
        for run in await self.repository.active_runs(limit):
            state = await self.controller.status(run.workflow_id)
            if state == ContentWorkflowState.RUNNING:
                continue
            if state == ContentWorkflowState.NOT_FOUND and run.status == "queued":
                continue
            confirmed_state = await self.controller.status(run.workflow_id)
            if confirmed_state == ContentWorkflowState.RUNNING:
                continue
            if confirmed_state == ContentWorkflowState.NOT_FOUND and run.status == "queued":
                continue
            await self.repository.fail_run(
                run.id,
                error_code="article_workflow_closed",
                error_detail="Temporal workflow closed without a database terminal state",
                failed_stage=run.stage,
                retryable=True,
            )
            reconciled += 1
        return reconciled

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

    async def generate_next_planned_articles(
        self,
        project_id: str,
        count: int,
        *,
        organization_id: str | None = None,
        batch_id: str,
    ) -> list[ArticleResponse]:
        organization_id = organization_id or self.settings.default_organization_id
        if count not in {1, 2}:
            raise ValueError("article_count_must_be_one_or_two")
        items = await self.repository.initial_plan_items(
            organization_id,
            project_id,
            count,
            batch_id=batch_id,
        )
        if len(items) < count:
            raise ContentConflictError("scheduled_content_plan_items_insufficient")
        return list(
            await asyncio.gather(
                *(
                    self.generate_plan_item_now(
                        project_id,
                        item.id,
                        expected_version=item.version,
                        organization_id=organization_id,
                    )
                    for item in items
                )
            )
        )

    async def _effective_model(
        self, organization_id: str
    ) -> AIProviderSettingsRecord:
        organization_lookup = getattr(
            self.ai_settings, "effective_record_for_organization", None
        )
        if organization_lookup is not None:
            record = await organization_lookup(organization_id)
        else:
            record = await self.ai_settings.effective_record()
        return record.for_task("content")

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

    async def update_article_document(
        self,
        project_id: str,
        article_id: str,
        request: UpdateArticleDocumentRequest,
        *,
        organization_id: str,
        edited_by: str,
        can_manage_seo_advanced: bool = False,
        lock_token: str,
        lock_fence: int,
        audit: ContentAuditContext,
    ) -> ArticleDetailResponse:
        try:
            document = normalize_document(request.document)
            markdown = document_to_markdown(document)
            html = document_to_html(document)
            article, run = await self.repository.update_article_document(
                organization_id,
                project_id,
                article_id,
                document=document,
                markdown=markdown,
                html=html,
                metadata=(request.metadata.model_dump() if request.metadata else None),
                content_hash=request.content_hash,
                expected_review_version=request.expected_review_version,
                expected_version_number=request.base_version_number,
                autosave_id=request.autosave_id,
                reason=request.reason,
                edited_by=edited_by,
                can_manage_seo_advanced=can_manage_seo_advanced,
                lock_token=lock_token,
                lock_fence=lock_fence,
                audit=audit,
            )
        except ArticleDocumentError:
            raise
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ArticleLockConflictError as exc:
            raise ContentConflictError(str(exc)) from exc
        except ValueError as exc:
            code, _, version = str(exc).partition(":")
            if code == "stale_review_version":
                raise ContentConflictError(
                    code, current_version=int(version) if version else None
                ) from exc
            raise ContentConflictError(code) from exc
        sources = await self.repository.list_article_sources(run.id)
        return article_detail_response(article, run, sources)

    async def article_document_capabilities(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str,
        user_id: str,
        can_manage_seo_advanced: bool = False,
        can_manage_locks: bool = False,
        can_manage_assets: bool = False,
    ) -> ArticleDocumentCapabilities:
        if await self.repository.get_article(organization_id, project_id, article_id) is None:
            raise ContentNotFoundError
        capabilities = document_capabilities(
            media_upload_enabled=(
                self.settings.asset_management_enabled and can_manage_assets
            )
        )
        capabilities["recovery_scope"] = sha256(
            f"{organization_id}:{user_id}".encode()
        ).hexdigest()[:24]
        capabilities["can_manage_seo_advanced"] = can_manage_seo_advanced
        capabilities["can_manage_locks"] = can_manage_locks
        return ArticleDocumentCapabilities.model_validate(capabilities)

    async def save_article_autosave(
        self,
        project_id: str,
        article_id: str,
        request: ArticleAutosaveRequest,
        *,
        organization_id: str,
        user_id: str,
        can_manage_seo_advanced: bool = False,
        lock_token: str,
        lock_fence: int,
    ) -> ArticleAutosaveResponse:
        try:
            document = normalize_document(request.document)
            metadata = request.metadata.model_dump()
            expected_hash = document_content_hash(document, metadata)
            if expected_hash != request.content_hash:
                raise ValueError("article_content_hash_mismatch")
            autosave = await self.repository.save_article_autosave(
                organization_id,
                project_id,
                article_id,
                user_id=user_id,
                client_id=request.client_id,
                sequence=request.sequence,
                base_version_number=request.base_version_number,
                base_review_version=request.base_review_version,
                document=document,
                metadata=metadata,
                content_hash=expected_hash,
                idempotency_key=request.idempotency_key,
                can_manage_seo_advanced=can_manage_seo_advanced,
                lock_token=lock_token,
                lock_fence=lock_fence,
            )
        except ArticleDocumentError:
            raise
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ArticleLockConflictError as exc:
            raise ContentConflictError(str(exc)) from exc
        except ValueError as exc:
            code = str(exc).partition(":")[0]
            if code == "version_conflict":
                latest = await self.repository.latest_article_autosave(
                    organization_id,
                    project_id,
                    article_id,
                    user_id=user_id,
                    client_id=request.client_id,
                )
                self._raise_save_conflict(
                    exc,
                    client_review_version=request.base_review_version,
                    client_version_number=request.base_version_number,
                    recoverable_autosave=latest,
                )
            self._raise_save_conflict(exc)
        snapshot = article_autosave_snapshot(autosave)
        return ArticleAutosaveResponse(
            **snapshot.model_dump(),
            accepted_sequence=autosave.sequence,
            server_time=datetime.now(UTC),
        )

    async def latest_article_autosave(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str,
        user_id: str,
        client_id: str | None,
    ) -> ArticleAutosaveSnapshot | None:
        try:
            autosave = await self.repository.latest_article_autosave(
                organization_id,
                project_id,
                article_id,
                user_id=user_id,
                client_id=client_id,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        return article_autosave_snapshot(autosave) if autosave else None

    async def promote_article_autosave(
        self,
        project_id: str,
        article_id: str,
        autosave_id: str,
        request: PromoteArticleAutosaveRequest,
        *,
        organization_id: str,
        user_id: str,
        can_manage_seo_advanced: bool = False,
        lock_token: str,
        lock_fence: int,
        audit: ContentAuditContext,
    ) -> ArticleDetailResponse:
        try:
            article, run = await self.repository.promote_article_autosave(
                organization_id,
                project_id,
                article_id,
                autosave_id,
                user_id=user_id,
                base_version_number=request.base_version_number,
                base_review_version=request.base_review_version,
                reason=request.reason,
                can_manage_seo_advanced=can_manage_seo_advanced,
                lock_token=lock_token,
                lock_fence=lock_fence,
                audit=audit,
            )
        except LookupError as exc:
            if str(exc) == "autosave_not_found":
                raise ContentNotFoundError("autosave_not_found") from exc
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ArticleLockConflictError as exc:
            raise ContentConflictError(str(exc)) from exc
        except ValueError as exc:
            self._raise_save_conflict(exc)
        sources = await self.repository.list_article_sources(run.id)
        return article_detail_response(article, run, sources)

    async def delete_article_autosave(
        self,
        project_id: str,
        article_id: str,
        autosave_id: str,
        *,
        organization_id: str,
        user_id: str,
    ) -> None:
        try:
            await self.repository.delete_article_autosave(
                organization_id,
                project_id,
                article_id,
                autosave_id,
                user_id=user_id,
            )
        except LookupError as exc:
            raise ContentNotFoundError("autosave_not_found") from exc

    @staticmethod
    def _raise_save_conflict(
        exc: ValueError,
        *,
        client_review_version: int | None = None,
        client_version_number: int | None = None,
        recoverable_autosave: ArticleAutosave | None = None,
    ) -> None:
        code, _, payload = str(exc).partition(":")
        if code in {"stale_review_version", "stale_version_number"}:
            current = int(payload) if payload else None
            raise ContentConflictError(code, current_version=current) from exc
        if code == "version_conflict":
            review, _, version = payload.partition(":")
            details: dict[str, object] = {}
            if review:
                details["server_review_version"] = int(review)
            if version:
                details["server_version_number"] = int(version)
            if client_review_version is not None:
                details["client_review_version"] = client_review_version
            if client_version_number is not None:
                details["client_version_number"] = client_version_number
            if recoverable_autosave is not None:
                details["recoverable_autosave"] = {
                    "id": recoverable_autosave.id,
                    "client_id": recoverable_autosave.client_id,
                    "sequence": recoverable_autosave.sequence,
                    "content_hash": recoverable_autosave.content_hash,
                    "created_at": recoverable_autosave.created_at.isoformat(),
                }
            raise ContentConflictError(code, details=details) from exc
        if code == "autosave_stale":
            raise ContentConflictError(
                code,
                details={"accepted_sequence": int(payload)} if payload else {},
            ) from exc
        if code in {"idempotency_key_conflict", "autosave_content_mismatch"}:
            raise ContentConflictError(code) from exc
        raise exc

    async def list_article_versions(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str,
    ) -> ArticleVersionCollection:
        try:
            versions = await self.repository.list_article_versions(
                organization_id, project_id, article_id
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        return ArticleVersionCollection(
            items=[article_version_summary(version) for version in versions]
        )

    async def get_article_version(
        self,
        project_id: str,
        article_id: str,
        version_number: int,
        *,
        organization_id: str,
    ) -> ArticleVersionDetail:
        version = await self.repository.get_article_version(
            organization_id, project_id, article_id, version_number
        )
        if version is None:
            raise ContentNotFoundError
        return article_version_detail(version)

    async def compare_article_versions(
        self,
        project_id: str,
        article_id: str,
        from_version: int,
        to_version: int,
        *,
        organization_id: str,
    ) -> ArticleVersionDiff:
        try:
            before, after, typed = await self.repository.compare_article_versions(
                organization_id,
                project_id,
                article_id,
                from_version,
                to_version,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        return article_version_diff(before, after, typed)

    async def restore_article_version(
        self,
        project_id: str,
        article_id: str,
        version_number: int,
        request: RestoreArticleVersionRequest,
        *,
        organization_id: str,
        restored_by: str,
        can_manage_seo_advanced: bool = False,
        lock_token: str,
        lock_fence: int,
        audit: ContentAuditContext,
    ) -> ArticleDetailResponse:
        try:
            article, run, _version = await self.repository.restore_article_version(
                organization_id,
                project_id,
                article_id,
                version_number,
                expected_version=request.review_version,
                restored_by=restored_by,
                can_manage_seo_advanced=can_manage_seo_advanced,
                lock_token=lock_token,
                lock_fence=lock_fence,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ArticleLockConflictError as exc:
            raise ContentConflictError(str(exc)) from exc
        except ValueError as exc:
            code, _, version = str(exc).partition(":")
            if code == "stale_review_version":
                raise ContentConflictError(
                    code, current_version=int(version) if version else None
                ) from exc
            raise ContentConflictError(code) from exc
        sources = await self.repository.list_article_sources(run.id)
        publication = (await self.repository.latest_publications([article.id])).get(
            article.id
        )
        return article_detail_response(article, run, sources, publication)

    async def submit_article_review(
        self,
        project_id: str,
        article_id: str,
        request: SubmitArticleReviewRequest,
        idempotency_key: str,
        *,
        organization_id: str,
        submitted_by: str,
        audit: ContentAuditContext,
    ) -> ArticleReviewTaskResponse:
        request_hash = self.governance_request_hash(request.model_dump(mode="json"))
        try:
            task = await self.repository.submit_article_review(
                organization_id,
                project_id,
                article_id,
                version_number=request.version_number,
                assigned_to=request.assigned_to,
                assigned_group=request.assigned_group,
                submitted_by=submitted_by,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ValueError as exc:
            raise ContentConflictError(str(exc).partition(":")[0]) from exc
        return article_review_task_response(task)

    async def list_article_review_tasks(
        self,
        project_id: str,
        *,
        organization_id: str,
        article_id: str | None = None,
        statuses: set[str] | None = None,
    ) -> ArticleReviewTaskCollection:
        tasks = await self.repository.list_article_review_tasks(
            organization_id,
            project_id,
            article_id=article_id,
            statuses=statuses,
        )
        return ArticleReviewTaskCollection(
            items=[article_review_task_response(task) for task in tasks]
        )

    async def get_article_review_task(
        self,
        project_id: str,
        task_id: str,
        *,
        organization_id: str,
    ) -> ArticleReviewTaskResponse:
        result = await self.repository.get_article_review_task(
            organization_id, project_id, task_id
        )
        if result is None:
            raise ContentNotFoundError
        task, comments = result
        return article_review_task_response(task, comments)

    async def claim_article_review_task(
        self,
        project_id: str,
        task_id: str,
        *,
        organization_id: str,
        reviewer_id: str,
        reviewer_groups: set[str],
        audit: ContentAuditContext,
    ) -> ArticleReviewTaskResponse:
        try:
            task = await self.repository.claim_article_review_task(
                organization_id,
                project_id,
                task_id,
                reviewer_id=reviewer_id,
                reviewer_groups=reviewer_groups,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ValueError as exc:
            raise ContentConflictError(str(exc)) from exc
        return article_review_task_response(task)

    async def add_article_review_comment(
        self,
        project_id: str,
        task_id: str,
        request: AddArticleReviewCommentRequest,
        *,
        organization_id: str,
        author_id: str,
        audit: ContentAuditContext,
    ) -> ArticleReviewCommentResponse:
        try:
            comment = await self.repository.add_article_review_comment(
                organization_id,
                project_id,
                task_id,
                author_id=author_id,
                body=request.body,
                node_id=request.node_id,
                position=request.position,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except ValueError as exc:
            raise ContentConflictError(str(exc)) from exc
        return article_review_comment_response(comment)

    async def decide_article_review_task(
        self,
        project_id: str,
        task_id: str,
        request: DecideArticleReviewRequest,
        idempotency_key: str,
        *,
        organization_id: str,
        reviewer_id: str,
        audit: ContentAuditContext,
    ) -> ArticleReviewTaskResponse:
        request_hash = self.governance_request_hash(request.model_dump(mode="json"))
        try:
            task, _article = await self.repository.decide_article_review_task(
                organization_id,
                project_id,
                task_id,
                reviewer_id=reviewer_id,
                decision=request.decision,
                comment=request.comment,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ValueError as exc:
            raise ContentConflictError(str(exc)) from exc
        return article_review_task_response(task)

    async def cancel_article_review_task(
        self,
        project_id: str,
        task_id: str,
        request: CancelArticleReviewRequest,
        *,
        organization_id: str,
        cancelled_by: str,
        can_review: bool,
        audit: ContentAuditContext,
    ) -> ArticleReviewTaskResponse:
        try:
            task = await self.repository.cancel_article_review_task(
                organization_id,
                project_id,
                task_id,
                cancelled_by=cancelled_by,
                can_review=can_review,
                reason=request.reason,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except PermissionError as exc:
            raise ContentPermissionError(str(exc)) from exc
        except ValueError as exc:
            raise ContentConflictError(str(exc)) from exc
        return article_review_task_response(task)

    async def get_article_review_snapshot(
        self,
        project_id: str,
        task_id: str,
        *,
        organization_id: str,
    ) -> ArticleReviewSnapshotResponse:
        result = await self.repository.get_article_review_snapshot(
            organization_id, project_id, task_id
        )
        if result is None:
            raise ContentNotFoundError
        task, comments, version, baseline, article = result
        diff = None
        if baseline is not None:
            before, after, typed = await self.repository.compare_article_versions(
                organization_id,
                project_id,
                article.id,
                baseline.version_number,
                version.version_number,
            )
            diff = article_version_diff(before, after, typed)
        return ArticleReviewSnapshotResponse(
            task=article_review_task_response(task, comments),
            version=article_version_detail(version),
            baseline_version_number=baseline.version_number if baseline else None,
            diff=diff,
            current_draft_version_number=article.current_version_number,
            approved_version_number=article.approved_version_number,
        )

    async def acquire_article_lock(
        self,
        project_id: str,
        article_id: str,
        request: AcquireArticleLockRequest,
        *,
        organization_id: str,
        owner_id: str,
        audit: ContentAuditContext,
    ) -> ArticleLockResponse:
        try:
            lock, token = await self.repository.acquire_article_lock(
                organization_id,
                project_id,
                article_id,
                lock_type=request.lock_type,
                version_number=request.version_number,
                owner_id=owner_id,
                reason=request.reason,
                lease_seconds=request.lease_seconds,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except ArticleLockConflictError as exc:
            raise ContentConflictError(str(exc)) from exc
        return article_lock_response(lock, token=token)

    async def get_active_article_lock(
        self,
        project_id: str,
        article_id: str,
        *,
        organization_id: str,
        lock_type: str = "edit_lock",
    ) -> ArticleLockResponse | None:
        try:
            lock = await self.repository.get_active_article_lock(
                organization_id, project_id, article_id, lock_type=lock_type
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        return article_lock_response(lock) if lock else None

    async def renew_article_lock(
        self,
        project_id: str,
        article_id: str,
        lock_id: str,
        request: RenewArticleLockRequest,
        *,
        organization_id: str,
        owner_id: str,
        audit: ContentAuditContext,
    ) -> ArticleLockResponse:
        try:
            lock = await self.repository.renew_article_lock(
                organization_id,
                project_id,
                article_id,
                lock_id,
                owner_id=owner_id,
                lock_type=request.lock_type,
                token=request.token,
                fence=request.fence,
                lease_seconds=request.lease_seconds,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except ArticleLockConflictError as exc:
            raise ContentConflictError(str(exc)) from exc
        return article_lock_response(lock)

    async def release_article_lock(
        self,
        project_id: str,
        article_id: str,
        lock_id: str,
        request: ReleaseArticleLockRequest,
        *,
        organization_id: str,
        owner_id: str,
        audit: ContentAuditContext,
    ) -> ArticleLockResponse:
        try:
            lock = await self.repository.release_article_lock(
                organization_id,
                project_id,
                article_id,
                lock_id,
                owner_id=owner_id,
                lock_type=request.lock_type,
                token=request.token,
                fence=request.fence,
                reason=request.reason,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except ArticleLockConflictError as exc:
            raise ContentConflictError(str(exc)) from exc
        return article_lock_response(lock)

    async def force_release_article_lock(
        self,
        project_id: str,
        article_id: str,
        lock_id: str,
        request: ForceReleaseArticleLockRequest,
        *,
        organization_id: str,
        released_by: str,
        audit: ContentAuditContext,
    ) -> ArticleLockResponse:
        try:
            lock = await self.repository.force_release_article_lock(
                organization_id,
                project_id,
                article_id,
                lock_id,
                released_by=released_by,
                reason=request.reason,
                audit=audit,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        return article_lock_response(lock)

    async def publish_article(
        self,
        project_id: str,
        article_id: str,
        request: PublishArticleRequest,
        idempotency_key: str,
        *,
        organization_id: str,
        created_by: str = "system",
        audit: ContentAuditContext | None = None,
    ) -> ArticleResponse:
        normalized_key = idempotency_key.strip()
        if not normalized_key or len(normalized_key) > 200:
            raise ValueError("Idempotency-Key length must be 1-200")
        if self.publication_service is not None:
            from app.modules.content.schemas import CreateArticlePublicationRequest

            targets = await self.publication_service.list_targets(
                organization_id, project_id
            )
            target = next(
                (item for item in targets.items if item.status == "verified"), None
            )
            if target is None:
                raise ContentConfigurationError("wordpress_connection_not_verified")
            try:
                await self.publication_service.create_publication(
                    organization_id,
                    project_id,
                    article_id,
                    CreateArticlePublicationRequest(
                        version_number=request.version_number,
                        target_id=target.id,
                    ),
                    normalized_key,
                    created_by=created_by,
                    audit=audit
                    or ContentAuditContext(
                        actor_id=created_by,
                        effective_role="publisher",
                        request_id=None,
                        correlation_id=None,
                    ),
                )
            except LookupError as exc:
                raise ContentNotFoundError from exc
            except ValueError as exc:
                code, _, version = str(exc).partition(":")
                raise ContentConflictError(
                    code, current_version=int(version) if version else None
                ) from exc
            return await self.get_article(
                project_id, article_id, organization_id=organization_id
            )
        encryption_key = (self.settings.ai_settings_encryption_key or "").strip() or None
        try:
            connection = await self.service_connections.get_wordpress(
                project_id, encryption_key
            )
        except ServiceConnectionEncryptionUnavailableError as exc:
            raise ContentConfigurationError(
                "service_connection_encryption_unavailable"
            ) from exc
        if connection is None or connection.verified_at is None:
            raise ContentConfigurationError("wordpress_connection_not_verified")
        request_hash = self.publication_hash(article_id, request.version_number)
        try:
            article, run, approved_version, publication, claimed = await self.repository.claim_publication(
                organization_id,
                project_id,
                article_id,
                idempotency_key=normalized_key,
                request_hash=request_hash,
                approved_version_number=request.version_number,
            )
        except LookupError as exc:
            raise ContentNotFoundError from exc
        except ArticleIdempotencyConflictError as exc:
            raise ContentConflictError("idempotency_key_conflict") from exc
        except ValueError as exc:
            code, _, version = str(exc).partition(":")
            if code == "approved_version_mismatch":
                raise ContentConflictError(
                    code, current_version=int(version) if version else None
                ) from exc
            raise ContentConflictError(code) from exc
        if not claimed:
            return article_response(article, run, publication)
        snapshot = {
            **dict(approved_version.content_json or {}),
            **dict(approved_version.metadata_snapshot or {}),
        }
        payload: dict[str, object] = {
            "title": snapshot.get("title") or article.primary_keyword,
            "content": snapshot.get("html") or "",
            "status": "publish",
            "meta": {
                "growthos_meta_title": snapshot.get("meta_title"),
                "growthos_meta_description": snapshot.get("meta_description"),
                "growthos_focus_keyword": snapshot.get("focus_keyword"),
                "growthos_secondary_keywords": list(snapshot.get("secondary_keywords") or []),
                "growthos_canonical_url": snapshot.get("canonical_url"),
                "growthos_indexing": normalize_article_indexing(
                    snapshot.get("indexing") or "index/follow"
                ),
                "growthos_seo_field_states": dict(snapshot.get("field_states") or {}),
            },
        }
        if snapshot.get("slug"):
            payload["slug"] = snapshot["slug"]
        if snapshot.get("meta_description"):
            payload["excerpt"] = snapshot["meta_description"]
        try:
            result = await self.wordpress_transport.publish(
                connection,
                payload,
                post_id=publication.wordpress_post_id,
            )
            publication = await self.repository.complete_publication(
                publication.id,
                wordpress_post_id=result.post_id,
                wordpress_url=result.url,
                response_summary={"status": result.status},
            )
        except WordPressPublishError as exc:
            publication = await self.repository.fail_publication(
                publication.id,
                error_code=exc.code,
                error_detail=exc.detail,
                uncertain=exc.uncertain,
            )
        except Exception as exc:
            publication = await self.repository.fail_publication(
                publication.id,
                error_code="wordpress_publish_uncertain",
                error_detail=str(exc),
                uncertain=True,
            )
        return article_response(article, run, publication)

    @staticmethod
    def publication_hash(article_id: str, version_number: int) -> str:
        payload = json.dumps(
            {"article_id": article_id, "version_number": version_number},
            sort_keys=True,
            separators=(",", ":"),
        )
        return sha256(payload.encode()).hexdigest()

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
        error_code=row.error_code,
        error_detail=row.error_detail,
        failed_stage=row.failed_stage,
        retryable=row.retryable,
        trigger_type=row.trigger_type or "initial",
        parent_run_id=row.parent_run_id,
        started_at=row.started_at,
        soft_deadline_at=row.soft_deadline_at,
        hard_deadline_at=row.hard_deadline_at,
        finished_at=row.finished_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def article_response(
    row: Article,
    run: ArticleRun | None,
    publication: ArticlePublication | None = None,
) -> ArticleResponse:
    return ArticleResponse(
        id=row.id,
        project_id=row.project_id,
        primary_keyword=row.primary_keyword,
        title=row.title,
        slug=row.slug,
        meta_title=row.meta_title,
        meta_description=row.meta_description,
        focus_keyword=row.focus_keyword or row.primary_keyword,
        secondary_keywords=list(row.secondary_keywords_json or []),
        canonical_url=row.canonical_url,
        indexing=normalize_article_indexing(row.indexing or "index/follow"),
        field_states=dict(row.seo_field_states_json or {}),
        status=row.status,
        publication_status=row.publication_status,
        review_status=row.review_status,
        review_version=row.review_version or 0,
        document_schema_version=row.document_schema_version or 1,
        current_content_hash=row.current_content_hash or "",
        current_version_number=row.current_version_number or 0,
        approved_version_number=row.approved_version_number,
        publication_blocked_reason=row.publication_blocked_reason,
        wordpress_post_id=publication.wordpress_post_id if publication else None,
        wordpress_url=publication.wordpress_url if publication else None,
        cms_publication_status=publication.status if publication else None,
        cms_publication_error=publication.error_code if publication else None,
        warning_count=row.warning_count,
        run=run_response(run) if run else None,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def article_detail_response(
    row: Article,
    run: ArticleRun | None,
    sources: list[ArticleSource],
    publication: ArticlePublication | None = None,
) -> ArticleDetailResponse:
    summary = article_response(row, run, publication)
    raw_document = dict(row.document_json or {})
    try:
        response_document = normalize_document(raw_document)
    except ArticleDocumentError:
        # Preserve unsupported future documents verbatim so capable clients can
        # render them read-only without losing data.
        response_document = raw_document
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
        document=response_document,
        markdown=row.markdown,
        html=row.html,
        external_sources=external_sources,
        internal_links=internal_links,
    )


def article_autosave_snapshot(row: ArticleAutosave) -> ArticleAutosaveSnapshot:
    return ArticleAutosaveSnapshot(
        id=row.id,
        article_id=row.article_id,
        client_id=row.client_id,
        sequence=row.sequence,
        base_version_number=row.base_version_number,
        base_review_version=row.base_review_version,
        schema_version=row.schema_version,
        document=dict(row.document_snapshot or {}),
        metadata=dict(row.metadata_snapshot or {}),
        content_hash=row.content_hash,
        created_at=row.created_at,
        expires_at=row.expires_at,
        promoted_version_number=row.promoted_version_number,
    )


def article_seo_analysis_response(
    row: ArticleSeoAnalysis,
    *,
    current_document_hash: str,
    current_metadata_hash: str,
    context_stale: bool = False,
    status: str | None = None,
    error_code: str | None = None,
    error_detail: str | None = None,
) -> ArticleSeoAnalysisResponse:
    result = dict(row.results or {})
    return ArticleSeoAnalysisResponse(
        analysis_id=row.id,
        article_version=row.version_number,
        document_hash=row.document_hash,
        metadata_hash=row.metadata_hash,
        ruleset_version=row.ruleset_version,
        score=row.score,
        max_score=row.max_score,
        is_stale=(
            row.document_hash != current_document_hash
            or row.metadata_hash != current_metadata_hash
            or context_stale
            or status == "failed"
        ),
        status=status or row.status,
        error_code=error_code or row.error_code,
        error_detail=error_detail or row.error_detail,
        analyzed_at=row.created_at,
        groups=list(result.get("groups") or []),
    )


def article_link_analysis_response(
    row: ArticleLinkAnalysis,
    *,
    current_document_hash: str,
    status: str | None = None,
    pending_analysis_id: str | None = None,
    error_code: str | None = None,
    error_detail: str | None = None,
) -> ArticleLinkAnalysisResponse:
    result = dict(row.results or {})
    return ArticleLinkAnalysisResponse(
        analysis_id=row.id,
        article_version=row.version_number,
        document_hash=row.document_hash,
        ruleset_version=row.ruleset_version,
        status=status or row.status,
        pending_analysis_id=pending_analysis_id,
        is_stale=(
            row.document_hash != current_document_hash
            or status in {"queued", "running", "failed"}
        ),
        error_code=error_code or row.error_code,
        error_detail=error_detail or row.error_detail,
        created_at=row.created_at,
        completed_at=row.completed_at,
        checked_at=result.get("checked_at"),
        summary=dict(result.get("summary") or {}),
        links=list(result.get("links") or []),
    )


def encode_candidate_cursor(offset: int) -> str:
    return urlsafe_b64encode(f"v1:{offset}".encode()).decode().rstrip("=")


def decode_candidate_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        version, raw_offset = urlsafe_b64decode(padded).decode().split(":", 1)
        offset = int(raw_offset)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("internal_link_cursor_invalid") from exc
    if version != "v1" or offset < 0:
        raise ValueError("internal_link_cursor_invalid")
    return offset


def find_target_section(document: dict, query: str) -> str | None:
    terms = {item for item in re.findall(r"[\w\u4e00-\u9fff]+", query.casefold()) if item}
    best: tuple[int, str] | None = None
    for node in normalize_document(document).get("content", []):
        if node.get("type") != "heading":
            continue
        text = "".join(
            str(child.get("text") or "")
            for child in node.get("content", [])
            if child.get("type") == "text"
        ).strip()
        if not text:
            continue
        score = sum(term in text.casefold() for term in terms)
        node_id = (node.get("attrs") or {}).get("node_id")
        if not isinstance(node_id, str) or not node_id:
            continue
        candidate = (score, node_id)
        if best is None or candidate[0] > best[0]:
            best = candidate
    return best[1] if best is not None and best[0] > 0 else None


def is_same_or_subdomain(hostname: str, domain: str) -> bool:
    return hostname == domain or hostname.endswith(f".{domain}")


def article_version_summary(row: ArticleVersion) -> ArticleVersionSummary:
    content = dict(row.content_json or {})
    document = content.get("document")
    return ArticleVersionSummary(
        id=row.id,
        run_id=row.run_id,
        version_number=row.version_number,
        version_type=row.version_type,
        review_version=row.review_version,
        created_by=row.created_by or "system",
        restored_from_version_id=row.restored_from_version_id,
        restorable=(
            isinstance(document, dict)
            and document.get("type") == "doc"
            and isinstance(document.get("content"), list)
        ),
        created_at=row.created_at,
    )


def article_version_detail(row: ArticleVersion) -> ArticleVersionDetail:
    summary = article_version_summary(row)
    content = dict(row.content_json or {})
    publication_status = content.get("publication_status")
    if publication_status not in {"publish_ready", "complete_draft"}:
        publication_status = None
    return ArticleVersionDetail(
        **summary.model_dump(),
        title=content.get("title"),
        slug=content.get("slug"),
        meta_title=content.get("meta_title"),
        meta_description=content.get("meta_description"),
        focus_keyword=content.get("focus_keyword"),
        secondary_keywords=list(content.get("secondary_keywords") or []),
        canonical_url=content.get("canonical_url"),
        indexing=(
            normalize_article_indexing(content.get("indexing"))
            if content.get("indexing") is not None
            else None
        ),
        field_states=dict(content.get("field_states") or {}),
        publication_status=publication_status,
        outline=dict(row.outline_json or {}),
        quality=dict(row.quality_json or {}),
        document=dict(content.get("document") or {}),
        markdown=content.get("markdown"),
        html=content.get("html"),
    )


def article_version_diff(
    before: ArticleVersion,
    after: ArticleVersion,
    typed: dict[str, object] | None = None,
) -> ArticleVersionDiff:
    before_content = dict(before.content_json or {})
    after_content = dict(after.content_json or {})
    before_lines = str(before_content.get("markdown") or "").splitlines()
    after_lines = str(after_content.get("markdown") or "").splitlines()
    matcher = SequenceMatcher(a=before_lines, b=after_lines, autojunk=False)
    added_lines = 0
    removed_lines = 0
    output: list[ArticleVersionDiffLine] = []
    limit = 2_000
    truncated = False
    for group in matcher.get_grouped_opcodes(n=3):
        for tag, old_start, old_end, new_start, new_end in group:
            removed_lines += old_end - old_start if tag in {"delete", "replace"} else 0
            added_lines += new_end - new_start if tag in {"insert", "replace"} else 0
            if len(output) >= limit:
                truncated = True
                continue
            if tag == "equal":
                for offset, content in enumerate(before_lines[old_start:old_end]):
                    output.append(
                        ArticleVersionDiffLine(
                            kind="context",
                            content=content,
                            old_line_number=old_start + offset + 1,
                            new_line_number=new_start + offset + 1,
                        )
                    )
            else:
                if tag in {"delete", "replace"}:
                    for offset, content in enumerate(before_lines[old_start:old_end]):
                        output.append(
                            ArticleVersionDiffLine(
                                kind="removed",
                                content=content,
                                old_line_number=old_start + offset + 1,
                                new_line_number=None,
                            )
                        )
                if tag in {"insert", "replace"}:
                    for offset, content in enumerate(after_lines[new_start:new_end]):
                        output.append(
                            ArticleVersionDiffLine(
                                kind="added",
                                content=content,
                                old_line_number=None,
                                new_line_number=new_start + offset + 1,
                            )
                        )
            if len(output) > limit:
                output = output[:limit]
                truncated = True
    if typed is None:
        from app.modules.content.article_diff import build_article_diff

        typed = build_article_diff(
            before.document_snapshot or before_content.get("document") or {},
            after.document_snapshot or after_content.get("document") or {},
            before.metadata_snapshot or before_content,
            after.metadata_snapshot or after_content,
        )
    metadata_changes = [
        ArticleVersionMetadataChange.model_validate(change)
        for change in typed.get("metadata_changes", [])
    ]
    return ArticleVersionDiff(
        from_version=article_version_summary(before),
        to_version=article_version_summary(after),
        algorithm_version=str(typed["algorithm_version"]),
        summary=typed["summary"],
        block_changes=typed.get("block_changes", []),
        inline_changes=typed.get("inline_changes", []),
        media_changes=typed.get("media_changes", []),
        table_changes=typed.get("table_changes", []),
        added_lines=added_lines,
        removed_lines=removed_lines,
        truncated=truncated,
        metadata_changes=metadata_changes,
        lines=output,
    )


def article_review_comment_response(
    row: ArticleReviewComment,
) -> ArticleReviewCommentResponse:
    return ArticleReviewCommentResponse(
        id=row.id,
        task_id=row.task_id,
        author_id=row.author_id,
        body=row.body,
        node_id=row.node_id,
        position=dict(row.position_json) if row.position_json else None,
        created_at=row.created_at,
    )


def article_review_task_response(
    row: ArticleReviewTask,
    comments: list[ArticleReviewComment] | None = None,
) -> ArticleReviewTaskResponse:
    return ArticleReviewTaskResponse(
        id=row.id,
        article_id=row.article_id,
        project_id=row.project_id,
        version_number=row.version_number,
        status=row.status,
        assigned_to=row.assigned_to,
        assigned_group=row.assigned_group,
        submitted_by=row.submitted_by,
        submitted_at=row.submitted_at,
        claimed_by=row.claimed_by,
        claimed_at=row.claimed_at,
        decided_by=row.decided_by,
        decided_at=row.decided_at,
        decision_comment=row.decision_comment,
        policy_version=row.policy_version,
        comments=[article_review_comment_response(comment) for comment in comments or []],
    )


def article_lock_response(
    row: ArticleLock,
    *,
    token: str | None = None,
) -> ArticleLockResponse:
    return ArticleLockResponse(
        id=row.id,
        article_id=row.article_id,
        lock_type=row.lock_type,
        version_number=row.version_number,
        owner_id=row.owner_id,
        reason=row.reason,
        fence=row.fence,
        acquired_at=row.acquired_at,
        renewed_at=row.renewed_at,
        expires_at=row.expires_at,
        released_at=row.released_at,
        token=token,
    )


def model_snapshot(record: AIProviderSettingsRecord) -> dict[str, object]:
    return {
        "provider": record.provider,
        "api_protocol": record.api_protocol,
        "base_url": record.base_url,
        "model": record.model,
        "reasoning_effort": record.reasoning_effort,
        "request_timeout_seconds": record.request_timeout_seconds,
        "max_retries": record.max_retries,
        "updated_at": record.updated_at.isoformat() if record.updated_at else None,
    }


def manual_input_snapshot(request: CreateArticleRequest) -> dict[str, object]:
    snapshot: dict[str, object] = {
        "primary_keyword": request.primary_keyword,
        "secondary_keywords": [
            {"keyword": keyword, "type": "unknown"}
            for keyword in request.secondary_keywords
        ],
        "language": request.language,
    }
    for field in ("article_type", "title", "writing_direction"):
        value = getattr(request, field)
        if value:
            snapshot[field] = {"value": value, "policy": "locked"}
    return snapshot


def build_content_service() -> ContentService:
    from app.modules.content.publication_service import build_publication_service

    return ContentService(
        get_settings(),
        ContentRepository(session_factory),
        publication_service=build_publication_service(),
    )
