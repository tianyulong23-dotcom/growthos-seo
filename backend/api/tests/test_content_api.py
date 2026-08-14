import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

from httpx import ASGITransport, AsyncClient

from app.api.routes.content import get_content_service
from app.core.backlinks_gateway import PlatformContextResolver
from app.core.config import Settings
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.main import app
from app.modules.content.document import (
    CURRENT_SCHEMA_VERSION,
    document_content_hash,
    document_to_html,
    document_to_markdown,
    extract_asset_manifest,
    normalize_document,
)
from app.modules.content.article_diff import build_article_diff
from app.modules.content.models import (
    Article,
    ArticleAutosave,
    ArticlePublication,
    ArticleRun,
    ArticleSource,
    ArticleVersion,
)
from app.modules.content.publication import (
    WordPressPublishError,
    WordPressPublishResult,
)
from app.modules.content.repository import (
    ArticleIdempotencyConflictError,
    advanced_seo_changed,
    article_metadata_snapshot,
    autosave_request_hash,
    publication_status_for_artifact,
)
from app.modules.content.schemas import CreateArticleRequest
from app.modules.content.service import ContentService
from app.modules.content.service import ContentNotFoundError
from app.modules.settings.service import (
    AIProviderNotConfiguredError,
    AIProviderSettingsRecord,
)
from app.modules.settings.service_connections import WordPressConnectionRecord


NOW = datetime(2026, 7, 28, 8, 0, tzinfo=UTC)
EDIT_LOCK_HEADERS = {
    "X-Article-Lock-Token": "test-article-edit-lock-token-000000000000000000000000",
    "X-Article-Lock-Fence": "1",
}


def approved_version(
    article: Article,
    run: ArticleRun,
    *,
    version_number: int,
    review_version: int,
) -> ArticleVersion:
    document = normalize_document(
        article.document_json
        or {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": article.title or ""}],
                }
            ],
        }
    )
    metadata = article_metadata_snapshot(article)
    return ArticleVersion(
        id=str(uuid4()),
        article_id=article.id,
        run_id=run.id,
        version_number=version_number,
        version_type="review_decision",
        review_version=review_version,
        outline_json=deepcopy(article.outline_json or {}),
        quality_json={},
        content_json={
            **metadata,
            "document": document,
            "markdown": article.markdown,
            "html": article.html,
        },
        schema_version=CURRENT_SCHEMA_VERSION,
        document_snapshot=deepcopy(document),
        metadata_snapshot=deepcopy(metadata),
        asset_manifest=extract_asset_manifest(document),
        content_hash=document_content_hash(document, metadata),
        parent_version_number=version_number - 1 or None,
        created_by="reviewer-from-token",
        retention_protected=True,
        created_at=NOW,
    )


class FakeContentRepository:
    def __init__(self) -> None:
        self.projects = {"project-a", "project-b"}
        self.articles: dict[str, Article] = {}
        self.runs: dict[str, ArticleRun] = {}
        self.idempotency: dict[tuple[str, str, str], tuple[str, str]] = {}
        self.sources: dict[str, list[ArticleSource]] = {}
        self.versions: dict[str, list[ArticleVersion]] = {}
        self.autosaves: dict[str, ArticleAutosave] = {}
        self.reviewed_by: list[str] = []
        self.publications: dict[str, ArticlePublication] = {}

    async def claim_due_plan_items(self, *, now: datetime, limit: int = 20) -> list:
        del now, limit
        return []

    async def release_plan_trigger(
        self, plan_item_id: str, *, error_code: str, error_detail: str
    ) -> None:
        del plan_item_id, error_code, error_detail

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "test-org" and project_id in self.projects

    async def create_article(
        self,
        organization_id: str,
        project_id: str,
        request_snapshot: dict[str, Any],
        idempotency_key: str,
        request_hash: str,
        model_snapshot: dict[str, Any] | None = None,
    ) -> tuple[Article, ArticleRun]:
        scope = (organization_id, project_id, idempotency_key)
        existing = self.idempotency.get(scope)
        if existing is not None:
            existing_hash, article_id = existing
            if existing_hash != request_hash:
                raise ArticleIdempotencyConflictError
            article = self.articles[article_id]
            return article, self.runs[article.current_run_id]

        article_id, run_id = str(uuid4()), str(uuid4())
        article = Article(
            id=article_id,
            organization_id=organization_id,
            project_id=project_id,
            primary_keyword=str(request_snapshot["primary_keyword"]),
            title=None,
            slug=None,
            meta_title=None,
            meta_description=None,
            focus_keyword=str(request_snapshot["primary_keyword"]),
            secondary_keywords_json=[],
            canonical_url=None,
            indexing="index",
            seo_field_states_json={},
            outline_json={},
            markdown=None,
            html=None,
            status="queued",
            publication_status="complete_draft",
            approved_version_number=None,
            current_run_id=run_id,
            warning_count=0,
            created_at=NOW,
            updated_at=NOW,
        )
        run = ArticleRun(
            id=run_id,
            article_id=article_id,
            organization_id=organization_id,
            project_id=project_id,
            workflow_id=f"article-generation:{run_id}",
            status="queued",
            stage="queued",
            progress=0,
            plan_input_snapshot_json=dict(request_snapshot),
            project_snapshot_json={
                "organization_id": organization_id,
                "project_id": project_id,
                "domain": f"{project_id}.example.com",
                "country": "US",
                "language": request_snapshot.get("language") or "en",
                "profile": {},
                "profile_status": "incomplete",
            },
            model_snapshot_json=model_snapshot or {},
            trigger_type="initial",
            request_hash=request_hash,
            started_at=None,
            soft_deadline_at=None,
            hard_deadline_at=None,
            finished_at=None,
            warnings_json=[],
            metrics_json={},
            created_at=NOW,
            updated_at=NOW,
        )
        self.articles[article_id] = article
        self.runs[run_id] = run
        self.idempotency[scope] = (request_hash, article_id)
        return article, run

    async def create_followup_run(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        trigger_type: str,
        idempotency_key: str,
        request_hash: str,
        model_snapshot: dict[str, Any] | None,
    ) -> tuple[Article, ArticleRun]:
        scope = (organization_id, project_id, f"{article_id}:{trigger_type}:{idempotency_key}")
        existing = self.idempotency.get(scope)
        if existing is not None:
            existing_hash, run_id = existing
            if existing_hash != request_hash:
                raise ArticleIdempotencyConflictError
            return self.articles[article_id], self.runs[run_id]
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            raise LookupError("article_not_found")
        article, parent = result
        if parent is None:
            raise ValueError("article_run_missing")
        if parent.status in {"queued", "running"}:
            raise ValueError("article_run_active")
        if trigger_type == "retry" and not (
            parent.status == "failed" and parent.retryable is True
        ):
            raise ValueError("article_run_not_retryable")
        if trigger_type == "regeneration" and parent.status not in {
            "completed",
            "completed_with_warnings",
            "failed",
            "cancelled",
        }:
            raise ValueError("article_run_not_regenerable")
        run_id = str(uuid4())
        run = ArticleRun(
            id=run_id,
            article_id=article.id,
            organization_id=organization_id,
            project_id=project_id,
            workflow_id=f"article-generation:{run_id}",
            trigger_type=trigger_type,
            parent_run_id=parent.id,
            request_hash=request_hash,
            status="queued",
            stage="queued",
            progress=0,
            plan_input_snapshot_json=dict(parent.plan_input_snapshot_json or {}),
            project_snapshot_json=dict(parent.project_snapshot_json or {}),
            model_snapshot_json=(
                dict(parent.model_snapshot_json or {})
                if trigger_type == "retry"
                else dict(model_snapshot or {})
            ),
            warnings_json=[],
            metrics_json={},
            created_at=NOW,
            updated_at=NOW,
        )
        self.runs[run_id] = run
        self.sources[run_id] = [deepcopy(source) for source in self.sources.get(parent.id, [])]
        for source in self.sources[run_id]:
            source.id = str(uuid4())
            source.run_id = run_id
        article.current_run_id = run_id
        article.status = "queued"
        article.review_status = None
        article.review_note = None
        article.reviewed_at = None
        article.reviewed_by = None
        article.publication_blocked_reason = "awaiting_review"
        self.idempotency[scope] = (request_hash, run_id)
        return article, run

    async def queued_runs(self, limit: int = 20) -> list[ArticleRun]:
        return [run for run in self.runs.values() if run.status == "queued"][:limit]

    async def active_runs(self, limit: int = 100) -> list[ArticleRun]:
        return [
            run for run in self.runs.values() if run.status in {"queued", "running"}
        ][:limit]

    async def fail_run(
        self,
        run_id: str,
        *,
        error_code: str,
        error_detail: str,
        failed_stage: str,
        retryable: bool,
    ) -> None:
        run = self.runs[run_id]
        if run.status not in {"queued", "running"}:
            return
        run.status = "failed"
        run.stage = "failed"
        run.error_code = error_code
        run.error_detail = error_detail
        run.failed_stage = failed_stage
        run.retryable = retryable
        run.finished_at = NOW
        article = self.articles[run.article_id]
        if article.current_run_id == run.id:
            article.status = "failed"

    async def list_articles(
        self,
        organization_id: str,
        project_id: str,
        page: int,
        page_size: int,
        article_status: str | None,
        search: str | None,
    ) -> tuple[list[tuple[Article, ArticleRun | None]], int]:
        rows = [
            article
            for article in self.articles.values()
            if article.organization_id == organization_id
            and article.project_id == project_id
            and (article_status is None or article.status == article_status)
            and (
                search is None
                or search.casefold() in article.primary_keyword.casefold()
                or search.casefold() in (article.title or "").casefold()
            )
        ]
        rows.sort(key=lambda item: item.updated_at, reverse=True)
        start = (page - 1) * page_size
        selected = rows[start : start + page_size]
        return [
            (article, self.runs.get(article.current_run_id or ""))
            for article in selected
        ], len(rows)

    async def get_article(
        self, organization_id: str, project_id: str, article_id: str
    ) -> tuple[Article, ArticleRun | None] | None:
        article = self.articles.get(article_id)
        if (
            article is None
            or article.organization_id != organization_id
            or article.project_id != project_id
        ):
            return None
        return article, self.runs.get(article.current_run_id or "")

    async def get_run(
        self, organization_id: str, project_id: str, article_id: str
    ) -> ArticleRun | None:
        result = await self.get_article(organization_id, project_id, article_id)
        return result[1] if result else None

    async def list_article_sources(self, run_id: str) -> list[ArticleSource]:
        return self.sources.get(run_id, [])

    async def cancel_article(
        self, organization_id: str, project_id: str, article_id: str
    ) -> tuple[Article, ArticleRun | None] | None:
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            return None
        article, run = result
        if article.status in {"queued", "running"}:
            article.status = "cancelled"
            article.updated_at = NOW
            if run is not None and run.status in {"queued", "running"}:
                run.status = "cancelled"
                run.stage = "cancelled"
                run.finished_at = NOW
                run.updated_at = NOW
        return article, run

    async def review_article(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        decision: str,
        review_note: str | None,
        expected_version: int,
        reviewed_by: str,
    ) -> tuple[Article, ArticleRun | None]:
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            raise LookupError("article_not_found")
        article, run = result
        if article.review_version != expected_version or article.reviewed_at is not None:
            raise ValueError("stale_review_version")
        if decision == "changes_requested" and not review_note:
            raise ValueError("review_note_required")
        article.review_status = decision
        article.review_note = review_note
        article.reviewed_by = reviewed_by
        article.reviewed_at = NOW
        if decision == "approved":
            reviewed_version = next(
                (
                    version
                    for version in self.versions.get(article.id, [])
                    if version.review_version == expected_version
                ),
                None,
            )
            if reviewed_version is not None:
                article.approved_version_number = reviewed_version.version_number
        self.reviewed_by.append(reviewed_by)
        return article, run

    async def update_article_document(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        document: dict[str, Any],
        markdown: str,
        html: str,
        metadata: dict[str, Any] | None,
        content_hash: str | None,
        expected_review_version: int,
        expected_version_number: int | None,
        autosave_id: str | None,
        reason: str | None,
        edited_by: str,
        can_manage_seo_advanced: bool = False,
        lock_token: str | None = None,
        lock_fence: int | None = None,
        audit: object | None = None,
    ) -> tuple[Article, ArticleRun]:
        del lock_token, lock_fence, audit
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            raise LookupError("article_not_found")
        article, run = result
        if run is None or run.status not in {"completed", "completed_with_warnings"}:
            raise ValueError("article_not_editable")
        if article.review_version != expected_review_version:
            raise ValueError(f"stale_review_version:{article.review_version}")
        if (
            expected_version_number is not None
            and article.current_version_number != expected_version_number
        ):
            raise ValueError(f"stale_version_number:{article.current_version_number}")
        normalized_metadata = article_metadata_snapshot(article, metadata)
        if advanced_seo_changed(article, normalized_metadata) and not can_manage_seo_advanced:
            raise PermissionError("content:manage_seo_advanced")
        expected_hash = document_content_hash(document, normalized_metadata)
        if content_hash is not None and content_hash != expected_hash:
            raise ValueError("article_content_hash_mismatch")
        if article.current_content_hash == expected_hash:
            return article, run
        versions = self.versions.setdefault(article.id, [])
        next_version = max(
            (version.version_number for version in versions),
            default=article.current_version_number or 0,
        ) + 1
        versions.append(
            ArticleVersion(
                id=str(uuid4()),
                article_id=article.id,
                run_id=run.id,
                version_number=next_version,
                version_type="manual_edit",
                review_version=expected_review_version + 1,
                outline_json=dict(article.outline_json or {}),
                quality_json={},
                content_json={
                    **normalized_metadata,
                    "document": deepcopy(document),
                    "markdown": markdown,
                    "html": html,
                },
                schema_version=CURRENT_SCHEMA_VERSION,
                document_snapshot=deepcopy(document),
                metadata_snapshot=deepcopy(normalized_metadata),
                asset_manifest=extract_asset_manifest(document),
                content_hash=expected_hash,
                parent_version_number=article.current_version_number or None,
                reason=reason,
                created_by=edited_by,
                created_at=NOW,
            )
        )
        article.document_json = deepcopy(document)
        article.document_schema_version = CURRENT_SCHEMA_VERSION
        article.current_content_hash = expected_hash
        article.current_version_number = next_version
        article.markdown = markdown
        article.html = html
        article.title = normalized_metadata["title"]
        article.slug = normalized_metadata["slug"]
        article.meta_title = normalized_metadata["meta_title"]
        article.meta_description = normalized_metadata["meta_description"]
        article.focus_keyword = normalized_metadata["focus_keyword"]
        article.secondary_keywords_json = normalized_metadata["secondary_keywords"]
        article.canonical_url = normalized_metadata["canonical_url"]
        article.indexing = normalized_metadata["indexing"]
        article.seo_field_states_json = normalized_metadata["field_states"]
        article.publication_status = normalized_metadata["publication_status"]
        article.review_version += 1
        article.review_status = "pending_review"
        article.review_note = None
        article.reviewed_at = None
        article.reviewed_by = None
        article.publication_blocked_reason = "awaiting_review"
        if autosave_id is not None:
            autosave = self.autosaves.get(autosave_id)
            if autosave is None or autosave.user_id != edited_by:
                raise ValueError("autosave_not_found")
            if autosave.content_hash != expected_hash:
                raise ValueError("autosave_content_mismatch")
            autosave.promoted_version_number = next_version
        return article, run

    async def save_article_autosave(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        user_id: str,
        client_id: str,
        sequence: int,
        base_version_number: int,
        base_review_version: int,
        document: dict[str, Any],
        metadata: dict[str, Any],
        content_hash: str,
        idempotency_key: str,
        can_manage_seo_advanced: bool = False,
        lock_token: str | None = None,
        lock_fence: int | None = None,
    ) -> ArticleAutosave:
        del lock_token, lock_fence
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            raise LookupError("article_not_found")
        article, _ = result
        metadata = article_metadata_snapshot(article, metadata)
        if advanced_seo_changed(article, metadata) and not can_manage_seo_advanced:
            raise PermissionError("content:manage_seo_advanced")
        request_hash = autosave_request_hash(
            client_id=client_id,
            sequence=sequence,
            base_version_number=base_version_number,
            base_review_version=base_review_version,
            document=document,
            metadata=metadata,
            content_hash=content_hash,
        )
        existing = next(
            (
                item
                for item in self.autosaves.values()
                if item.article_id == article_id
                and item.user_id == user_id
                and item.idempotency_key == idempotency_key
            ),
            None,
        )
        if existing is not None:
            if existing.request_hash != request_hash:
                raise ValueError("idempotency_key_conflict")
            return existing
        if (
            article.current_version_number != base_version_number
            or article.review_version != base_review_version
        ):
            raise ValueError(
                f"version_conflict:{article.review_version}:{article.current_version_number}"
            )
        latest_sequence = max(
            (
                item.sequence
                for item in self.autosaves.values()
                if item.article_id == article_id
                and item.user_id == user_id
                and item.client_id == client_id
            ),
            default=0,
        )
        if sequence <= latest_sequence:
            raise ValueError(f"autosave_stale:{latest_sequence}")
        if document_content_hash(document, metadata) != content_hash:
            raise ValueError("article_content_hash_mismatch")
        autosave = ArticleAutosave(
            id=str(uuid4()),
            article_id=article.id,
            user_id=user_id,
            client_id=client_id,
            sequence=sequence,
            base_version_number=base_version_number,
            base_review_version=base_review_version,
            schema_version=CURRENT_SCHEMA_VERSION,
            document_snapshot=deepcopy(document),
            metadata_snapshot=deepcopy(metadata),
            content_hash=content_hash,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            created_at=NOW,
            expires_at=NOW.replace(year=NOW.year + 1),
            promoted_version_number=None,
        )
        self.autosaves[autosave.id] = autosave
        owned = sorted(
            (
                item
                for item in self.autosaves.values()
                if item.article_id == article_id
                and item.user_id == user_id
                and item.client_id == client_id
            ),
            key=lambda item: item.sequence,
            reverse=True,
        )
        for stale in owned[5:]:
            self.autosaves.pop(stale.id, None)
        return autosave

    async def latest_article_autosave(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        user_id: str,
        client_id: str | None = None,
    ) -> ArticleAutosave | None:
        if await self.get_article(organization_id, project_id, article_id) is None:
            raise LookupError("article_not_found")
        items = [
            item
            for item in self.autosaves.values()
            if item.article_id == article_id
            and item.user_id == user_id
            and (client_id is None or item.client_id == client_id)
        ]
        return max(items, key=lambda item: (item.created_at, item.sequence), default=None)

    async def promote_article_autosave(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        autosave_id: str,
        *,
        user_id: str,
        base_version_number: int,
        base_review_version: int,
        reason: str | None,
        can_manage_seo_advanced: bool = False,
        lock_token: str | None = None,
        lock_fence: int | None = None,
        audit: object | None = None,
    ) -> tuple[Article, ArticleRun]:
        autosave = self.autosaves.get(autosave_id)
        if autosave is None or autosave.user_id != user_id:
            raise LookupError("autosave_not_found")
        return await self.update_article_document(
            organization_id,
            project_id,
            article_id,
            document=deepcopy(autosave.document_snapshot),
            markdown=document_to_markdown(autosave.document_snapshot),
            html=document_to_html(autosave.document_snapshot),
            metadata=deepcopy(autosave.metadata_snapshot),
            content_hash=autosave.content_hash,
            expected_review_version=base_review_version,
            expected_version_number=base_version_number,
            autosave_id=autosave.id,
            reason=reason or "promoted_autosave",
            edited_by=user_id,
            can_manage_seo_advanced=can_manage_seo_advanced,
            lock_token=lock_token,
            lock_fence=lock_fence,
            audit=audit,
        )

    async def delete_article_autosave(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        autosave_id: str,
        *,
        user_id: str,
    ) -> None:
        if await self.get_article(organization_id, project_id, article_id) is None:
            raise LookupError("article_not_found")
        autosave = self.autosaves.get(autosave_id)
        if autosave is None or autosave.user_id != user_id:
            raise LookupError("autosave_not_found")
        self.autosaves.pop(autosave_id)

    async def list_article_versions(
        self, organization_id: str, project_id: str, article_id: str
    ) -> list[ArticleVersion]:
        if await self.get_article(organization_id, project_id, article_id) is None:
            raise LookupError("article_not_found")
        return sorted(
            self.versions.get(article_id, []),
            key=lambda version: version.version_number,
            reverse=True,
        )

    async def get_article_version(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        version_number: int,
    ) -> ArticleVersion | None:
        if await self.get_article(organization_id, project_id, article_id) is None:
            return None
        return next(
            (
                version
                for version in self.versions.get(article_id, [])
                if version.version_number == version_number
            ),
            None,
        )

    async def compare_article_versions(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        from_version: int,
        to_version: int,
    ) -> tuple[ArticleVersion, ArticleVersion, dict[str, Any]]:
        before = await self.get_article_version(
            organization_id, project_id, article_id, from_version
        )
        after = await self.get_article_version(
            organization_id, project_id, article_id, to_version
        )
        if before is None or after is None:
            raise LookupError("article_version_not_found")
        before_content = dict(before.content_json or {})
        after_content = dict(after.content_json or {})
        typed = build_article_diff(
            before.document_snapshot or before_content.get("document") or {},
            after.document_snapshot or after_content.get("document") or {},
            before.metadata_snapshot or before_content,
            after.metadata_snapshot or after_content,
        )
        return before, after, typed

    async def restore_article_version(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        version_number: int,
        *,
        expected_version: int,
        restored_by: str,
        can_manage_seo_advanced: bool = False,
        lock_token: str | None = None,
        lock_fence: int | None = None,
        audit: object | None = None,
    ) -> tuple[Article, ArticleRun, ArticleVersion]:
        del lock_token, lock_fence, audit
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            raise LookupError("article_not_found")
        article, run = result
        if run is None or run.status not in {"completed", "completed_with_warnings"}:
            raise ValueError("article_not_editable")
        if article.review_version != expected_version:
            raise ValueError(f"stale_review_version:{article.review_version}")
        source = await self.get_article_version(
            organization_id, project_id, article_id, version_number
        )
        if source is None:
            raise LookupError("article_version_not_found")
        snapshot = dict(source.content_json or {})
        source_document = snapshot.get("document")
        if not (
            isinstance(source_document, dict)
            and source_document.get("type") == "doc"
            and isinstance(source_document.get("content"), list)
        ):
            raise ValueError("article_version_not_restorable")
        document = normalize_document(source_document)
        markdown = document_to_markdown(document)
        html = document_to_html(document)
        versions = self.versions.setdefault(article.id, [])
        metadata = article_metadata_snapshot(
            article,
            {**snapshot, **dict(source.metadata_snapshot or {})},
        )
        if advanced_seo_changed(article, metadata) and not can_manage_seo_advanced:
            raise PermissionError("content:manage_seo_advanced")
        publication_status = metadata["publication_status"]
        restored = ArticleVersion(
            id=str(uuid4()),
            article_id=article.id,
            run_id=run.id,
            version_number=max(
                (version.version_number for version in versions), default=0
            )
            + 1,
            version_type="restored",
            review_version=article.review_version + 1,
            outline_json=deepcopy(source.outline_json or {}),
            quality_json=deepcopy(source.quality_json or {}),
            content_json={
                **metadata,
                "document": document,
                "markdown": markdown,
                "html": html,
            },
            schema_version=CURRENT_SCHEMA_VERSION,
            document_snapshot=deepcopy(document),
            metadata_snapshot=deepcopy(metadata),
            asset_manifest=extract_asset_manifest(document),
            content_hash=document_content_hash(document, metadata),
            created_by=restored_by,
            restored_from_version_id=source.id,
            created_at=NOW,
        )
        versions.append(restored)
        article.title = metadata["title"]
        article.slug = metadata["slug"]
        article.meta_title = metadata["meta_title"]
        article.meta_description = metadata["meta_description"]
        article.focus_keyword = metadata["focus_keyword"]
        article.secondary_keywords_json = metadata["secondary_keywords"]
        article.canonical_url = metadata["canonical_url"]
        article.indexing = metadata["indexing"]
        article.seo_field_states_json = metadata["field_states"]
        article.outline_json = deepcopy(source.outline_json or {})
        article.document_json = document
        article.markdown = markdown
        article.html = html
        article.publication_status = publication_status
        article.review_version += 1
        article.review_status = "pending_review"
        article.review_note = None
        article.reviewed_at = None
        article.reviewed_by = None
        article.publication_blocked_reason = "awaiting_review"
        return article, run, restored

    async def latest_publications(
        self, article_ids: list[str]
    ) -> dict[str, ArticlePublication]:
        result: dict[str, ArticlePublication] = {}
        for publication in self.publications.values():
            if publication.article_id not in article_ids:
                continue
            current = result.get(publication.article_id)
            if current is None or publication.attempt > current.attempt:
                result[publication.article_id] = publication
        return result

    async def claim_publication(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        idempotency_key: str,
        request_hash: str,
        approved_version_number: int,
    ) -> tuple[Article, ArticleRun, ArticleVersion, ArticlePublication, bool]:
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            raise LookupError("article_not_found")
        article, run = result
        if run is None or run.status not in {"completed", "completed_with_warnings"}:
            raise ValueError("article_not_publishable")
        if article.approved_version_number != approved_version_number:
            raise ValueError(
                f"approved_version_mismatch:{article.approved_version_number or 0}"
            )
        approved_version = await self.get_article_version(
            organization_id,
            project_id,
            article_id,
            approved_version_number,
        )
        if approved_version is None:
            raise ValueError("approved_version_not_found")
        snapshot = {
            **dict(approved_version.content_json or {}),
            **dict(approved_version.metadata_snapshot or {}),
        }
        if snapshot.get("publication_status") != "publish_ready":
            raise ValueError("quality_not_ready")
        for publication in self.publications.values():
            if (
                publication.organization_id == organization_id
                and publication.project_id == project_id
                and publication.idempotency_key == idempotency_key
            ):
                if publication.request_hash != request_hash:
                    raise ArticleIdempotencyConflictError
                return article, run, approved_version, publication, False
        latest = (await self.latest_publications([article.id])).get(article.id)
        if latest is not None and latest.status in {"submitting", "uncertain"}:
            raise ValueError(f"article_publication_{latest.status}")
        published = [
            item
            for item in self.publications.values()
            if item.article_id == article.id and item.status == "published"
        ]
        previous = max(published, key=lambda item: item.attempt) if published else None
        publication = ArticlePublication(
            id=str(uuid4()),
            article_id=article.id,
            organization_id=organization_id,
            project_id=project_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            status="submitting",
            attempt=len(
                [item for item in self.publications.values() if item.article_id == article.id]
            )
            + 1,
            wordpress_post_id=previous.wordpress_post_id if previous else None,
            wordpress_url=previous.wordpress_url if previous else None,
            request_summary_json={"approved_version_number": approved_version_number},
            response_summary_json={},
            created_at=NOW,
            updated_at=NOW,
        )
        self.publications[publication.id] = publication
        return article, run, approved_version, publication, True

    async def complete_publication(
        self,
        publication_id: str,
        *,
        wordpress_post_id: int,
        wordpress_url: str,
        response_summary: dict[str, Any],
    ) -> ArticlePublication:
        publication = self.publications[publication_id]
        publication.status = "published"
        publication.wordpress_post_id = wordpress_post_id
        publication.wordpress_url = wordpress_url
        publication.response_summary_json = response_summary
        publication.published_at = NOW
        return publication

    async def fail_publication(
        self,
        publication_id: str,
        *,
        error_code: str,
        error_detail: str,
        uncertain: bool,
    ) -> ArticlePublication:
        publication = self.publications[publication_id]
        publication.status = "uncertain" if uncertain else "failed"
        publication.error_code = error_code
        publication.error_detail = error_detail
        return publication


class FakeAISettings:
    def __init__(self, configured: bool = True) -> None:
        self.configured = configured

    async def effective_record(self) -> AIProviderSettingsRecord:
        if not self.configured:
            raise AIProviderNotConfiguredError("请先在设置中配置可用的 AI 模型")
        return AIProviderSettingsRecord(
            base_url="https://models.example/v1",
            api_key="secret-not-in-snapshot",
            model="writing-model",
            request_timeout_seconds=30,
            max_retries=1,
            updated_at=NOW,
        )


class FakeWorkflowController:
    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.started: list[str] = []
        self.cancelled: list[str] = []
        self.states: dict[str, str] = {}

    async def start(self, run_id: str) -> None:
        if not self.available:
            raise RuntimeError("Temporal unavailable")
        self.started.append(run_id)

    async def cancel(self, workflow_id: str) -> None:
        self.cancelled.append(workflow_id)

    async def status(self, workflow_id: str) -> str:
        return self.states.get(workflow_id, "running")


class FakeServiceConnections:
    def __init__(self, *, configured: bool = True) -> None:
        self.configured = configured

    async def get_wordpress(
        self, project_id: str, encryption_key: str | None
    ) -> WordPressConnectionRecord | None:
        assert project_id == "project-a"
        assert encryption_key == "test-encryption-key"
        if not self.configured:
            return None
        return WordPressConnectionRecord(
            site_url="https://wordpress.example",
            username="publisher",
            application_password="not-sent-to-a-real-site",
            verified_user="Publisher",
            verified_at=NOW,
        )


class FakeWordPressTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[dict[str, object], int | None]] = []
        self.error: WordPressPublishError | None = None

    async def publish(
        self,
        connection: WordPressConnectionRecord,
        payload: dict[str, object],
        *,
        post_id: int | None,
    ) -> WordPressPublishResult:
        assert connection.site_url == "https://wordpress.example"
        self.calls.append((payload, post_id))
        if self.error is not None:
            raise self.error
        remote_id = post_id or 321
        return WordPressPublishResult(
            post_id=remote_id,
            url=f"https://wordpress.example/?p={remote_id}",
            status="publish",
        )


class ContentResolver(PlatformContextResolver):
    def __init__(
        self,
        user_id: str = "reviewer-from-token",
        permissions: tuple[str, ...] = (
            "content:read",
            "content:write",
            "content:edit",
            "content:submit_review",
            "content:review",
            "content:publish",
            "content:manage_assets",
            "content:ai_edit",
        ),
    ) -> None:
        self.calls: list[tuple[str, str | None]] = []
        self.user_id = user_id
        self.permissions = permissions

    async def resolve(
        self,
        *,
        request: object,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del request
        self.calls.append((website_project_key, required_permission))
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id=self.user_id,
                session_id="content-session",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id="test-org",
                workspace_id="content-workspace",
            ),
            project=PlatformProject(
                website_project_id=website_project_key,
                website_project_key=website_project_key,
            ),
            permissions=self.permissions,
            correlation_id="content-request",
        )


def build_service(
    *, configured: bool = True, controller_available: bool = True
) -> tuple[ContentService, FakeContentRepository, FakeWorkflowController]:
    repository = FakeContentRepository()
    controller = FakeWorkflowController(controller_available)
    service = ContentService(
        Settings(default_organization_id="test-org"),
        repository,
        ai_settings=FakeAISettings(configured),
        controller=controller,
    )
    return service, repository, controller


async def request_scenario() -> dict[str, Any]:
    service, repository, controller = build_service()
    resolver = ContentResolver()
    previous_resolver = app.state.platform_context_resolver
    app.state.platform_context_resolver = resolver
    app.dependency_overrides[get_content_service] = lambda: service
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            headers = {"Idempotency-Key": "request-1"}
            first = await client.post(
                "/api/v1/projects/project-a/articles",
                headers=headers,
                json={"primary_keyword": "  solar battery payback  "},
            )
            repeated = await client.post(
                "/api/v1/projects/project-a/articles",
                headers=headers,
                json={"primary_keyword": "solar battery payback"},
            )
            conflict = await client.post(
                "/api/v1/projects/project-a/articles",
                headers=headers,
                json={"primary_keyword": "different keyword"},
            )
            article_id = first.json()["id"]
            article = repository.articles[article_id]
            run_id = article.current_run_id or ""
            external_url = "https://authority.example/payback"
            internal_url = "https://example.com/solar-financing"
            article.title = "Solar battery payback"
            article.slug = "solar-battery-payback"
            article.meta_title = "Solar battery payback guide"
            article.meta_description = "A practical payback guide."
            article.outline_json = {
                "sections": [
                    {
                        "section_id": "section-1",
                        "heading": "Payback factors",
                        "internal_urls": [internal_url],
                    }
                ]
            }
            article.document_schema_version = CURRENT_SCHEMA_VERSION
            article.document_json = {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": "Legacy body"}],
                    }
                ],
            }
            article.markdown = (
                f"# Solar battery payback\n\n[Source]({external_url})\n\n"
                f"Review [solar financing]({internal_url}) before comparing payback."
            )
            article.html = "<h1>Solar battery payback</h1>"
            repository.sources[run_id] = [
                ArticleSource(
                    id="source-external",
                    run_id=run_id,
                    source_type="authority",
                    url=external_url,
                    normalized_url=external_url,
                    title="Payback facts",
                    domain="authority.example",
                    status="available",
                    claims_json=[{"claim_id": "claim-1"}],
                    section_ids_json=["section-1"],
                    summary_json={},
                    metadata_json={},
                ),
                ArticleSource(
                    id="source-internal",
                    run_id=run_id,
                    source_type="internal",
                    url=internal_url,
                    normalized_url=internal_url,
                    title="Solar financing",
                    domain="example.com",
                    status="available",
                    claims_json=[],
                    section_ids_json=[],
                    summary_json={},
                    metadata_json={},
                ),
                ArticleSource(
                    id="source-failed-audit",
                    run_id=run_id,
                    source_type="authority",
                    url="https://authority.example/rejected-claim",
                    normalized_url="https://authority.example/rejected-claim",
                    title="Rejected claim",
                    domain="authority.example",
                    status="failed",
                    claims_json=[{"claim_id": "rejected-claim"}],
                    section_ids_json=["section-1"],
                    summary_json={},
                    metadata_json={"verification_status": "not_found"},
                ),
            ]
            listed = await client.get(
                "/api/v1/projects/project-a/articles",
                params={"page": 1, "page_size": 25, "search": "BATTERY"},
            )
            detail = await client.get(
                f"/api/v1/projects/project-a/articles/{article_id}"
            )
            run = await client.get(
                f"/api/v1/projects/project-a/articles/{article_id}/run"
            )
            cross_project_detail = await client.get(
                f"/api/v1/projects/project-b/articles/{article_id}"
            )
            cross_project_run = await client.get(
                f"/api/v1/projects/project-b/articles/{article_id}/run"
            )
            cancelled = await client.post(
                f"/api/v1/projects/project-a/articles/{article_id}/cancel"
            )
            cancelled_again = await client.post(
                f"/api/v1/projects/project-a/articles/{article_id}/cancel"
            )
            missing_project = await client.post(
                "/api/v1/projects/project-missing/articles",
                headers={"Idempotency-Key": "request-2"},
                json={"primary_keyword": "valid keyword"},
            )
            return {
                "first": first,
                "repeated": repeated,
                "conflict": conflict,
                "listed": listed,
                "detail": detail,
                "run": run,
                "cross_project_detail": cross_project_detail,
                "cross_project_run": cross_project_run,
                "cancelled": cancelled,
                "cancelled_again": cancelled_again,
                "missing_project": missing_project,
                "repository": repository,
                "controller": controller,
                "resolver": resolver,
            }
    finally:
        app.dependency_overrides.clear()
        app.state.platform_context_resolver = previous_resolver


def test_content_api_is_idempotent_scoped_listed_and_cancellable() -> None:
    result = asyncio.run(request_scenario())

    assert result["first"].status_code == 202
    assert result["first"].json() == result["repeated"].json()
    assert result["first"].json()["primary_keyword"] == "solar battery payback"
    assert result["first"].json()["status"] == "queued"
    assert result["first"].json()["publication_status"] == "complete_draft"
    assert result["first"].json()["run"]["stage"] == "queued"
    assert result["first"].json()["run"]["progress"] == 0
    assert len(result["repository"].articles) == 1
    assert len(result["repository"].runs) == 1
    run = next(iter(result["repository"].runs.values()))
    assert run.model_snapshot_json == {
        "base_url": "https://models.example/v1",
        "provider": "openai",
        "api_protocol": "chat_completions",
        "model": "writing-model",
        "reasoning_effort": "medium",
        "request_timeout_seconds": 30,
        "max_retries": 1,
        "updated_at": NOW.isoformat(),
    }
    assert "secret-not-in-snapshot" not in str(run.model_snapshot_json)

    assert result["conflict"].status_code == 409
    assert "幂等键" in result["conflict"].json()["detail"]
    assert result["listed"].status_code == 200
    assert result["listed"].json()["total"] == 1
    assert result["detail"].status_code == 200
    assert result["detail"].json()["markdown"].startswith("# Solar battery")
    assert result["detail"].json()["document"]["schema_version"] == 2
    assert result["detail"].json()["document"]["content"][0]["attrs"][
        "node_id"
    ].startswith("blk_")
    assert result["detail"].json()["outline"]["sections"][0]["heading"] == (
        "Payback factors"
    )
    assert result["detail"].json()["external_sources"][0]["url"] == (
        "https://authority.example/payback"
    )
    assert result["detail"].json()["internal_links"][0]["url"] == (
        "https://example.com/solar-financing"
    )
    assert result["run"].status_code == 200
    assert result["cross_project_detail"].status_code == 404
    assert result["cross_project_run"].status_code == 404
    assert result["missing_project"].status_code == 404

    assert result["cancelled"].status_code == 200
    assert result["cancelled"].json()["status"] == "cancelled"
    assert result["cancelled"].json()["run"]["status"] == "cancelled"
    assert result["cancelled_again"].json() == result["cancelled"].json()
    assert result["controller"].cancelled == [run.workflow_id, run.workflow_id]
    assert ("project-a", "content:read") in result["resolver"].calls
    assert ("project-a", "content:write") in result["resolver"].calls


def test_article_detail_hides_failed_source_audit_records() -> None:
    result = asyncio.run(request_scenario())

    assert [
        item["url"] for item in result["detail"].json()["external_sources"]
    ] == ["https://authority.example/payback"]


def test_publication_status_is_independent_from_runtime_warnings() -> None:
    publishable = {
        "quality": {"passed": True, "evidence_issue_count": 0, "issues": []},
        "sections": [{"section_id": "section-1", "summary": "complete"}],
        "degraded_section_ids": [],
    }
    evidence_gap = deepcopy(publishable)
    evidence_gap["quality"] = {
        "passed": True,
        "evidence_issue_count": 1,
        "issues": [{"category": "evidence"}],
    }
    fallback = deepcopy(publishable)
    fallback["degraded_section_ids"] = ["section-1"]

    assert publication_status_for_artifact(publishable) == "publish_ready"
    assert publication_status_for_artifact(evidence_gap) == "complete_draft"
    assert publication_status_for_artifact(fallback) == "complete_draft"
    assert publication_status_for_artifact({"quality": {"passed": False}}) == (
        "complete_draft"
    )


async def validation_scenario() -> list[int]:
    service, _, _ = build_service()
    previous_resolver = app.state.platform_context_resolver
    app.state.platform_context_resolver = ContentResolver()
    app.dependency_overrides[get_content_service] = lambda: service
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            responses = [
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    json={"primary_keyword": "valid"},
                ),
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "blank-keyword"},
                    json={"primary_keyword": "   "},
                ),
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "long-keyword"},
                    json={"primary_keyword": "x" * 201},
                ),
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "extra-field"},
                    json={"primary_keyword": "valid", "organization_id": "other-org"},
                ),
            ]
            invalid_status = await client.get(
                "/api/v1/projects/project-a/articles", params={"status": "failed"}
            )
            return [response.status_code for response in responses] + [
                invalid_status.status_code
            ]
    finally:
        app.dependency_overrides.clear()
        app.state.platform_context_resolver = previous_resolver


def test_content_api_validates_creation_input_and_accepts_failed_filter() -> None:
    assert asyncio.run(validation_scenario()) == [422, 422, 422, 422, 200]


def test_content_api_rejects_creation_without_writing_model() -> None:
    async def scenario() -> int:
        service, _, _ = build_service(configured=False)
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        app.dependency_overrides[get_content_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "missing-model"},
                    json={"primary_keyword": "solar battery payback"},
                )
                return response.status_code
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    assert asyncio.run(scenario()) == 422


def test_temporal_outage_keeps_run_queued_for_background_dispatch() -> None:
    async def scenario() -> tuple[str, int]:
        service, repository, controller = build_service(controller_available=False)
        response = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="solar battery payback"),
            "temporal-outage",
        )
        controller.available = True
        dispatched = await service.dispatch_queued()
        run = repository.runs[response.run.id]
        return run.status, dispatched

    assert asyncio.run(scenario()) == ("queued", 1)


def test_reconcile_marks_closed_active_run_failed_but_keeps_missing_queue_dispatchable() -> None:
    async def scenario() -> tuple[int, str, str, str | None]:
        service, repository, controller = build_service()
        closed = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="closed workflow"),
            "closed-workflow",
        )
        queued = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="missing queued workflow"),
            "missing-workflow",
        )
        closed_run = repository.runs[closed.run.id]
        closed_run.status = "running"
        repository.articles[closed.id].status = "running"
        controller.states[closed_run.workflow_id] = "closed"
        controller.states[repository.runs[queued.run.id].workflow_id] = "not_found"

        reconciled = await service.reconcile_active_runs()

        return (
            reconciled,
            repository.runs[closed.run.id].status,
            repository.runs[queued.run.id].status,
            repository.runs[closed.run.id].error_code,
        )

    assert asyncio.run(scenario()) == (
        1,
        "failed",
        "queued",
        "article_workflow_closed",
    )


def test_reconcile_does_not_fail_run_when_closed_status_is_transient() -> None:
    class TransientClosedController(FakeWorkflowController):
        def __init__(self) -> None:
            super().__init__()
            self.status_calls = 0

        async def status(self, workflow_id: str) -> str:
            del workflow_id
            self.status_calls += 1
            return "closed" if self.status_calls == 1 else "running"

    async def scenario() -> tuple[int, str, str | None, int]:
        controller = TransientClosedController()
        service, repository, _ = build_service()
        service.controller = controller
        response = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="transient workflow status"),
            "transient-workflow-status",
        )
        run = repository.runs[response.run.id]
        run.status = "running"
        repository.articles[response.id].status = "running"

        reconciled = await service.reconcile_active_runs()

        return reconciled, run.status, run.error_code, controller.status_calls

    assert asyncio.run(scenario()) == (0, "running", None, 2)


def test_due_plan_temporal_failure_retries_the_same_article_and_run() -> None:
    class PlanDispatchRepository(FakeContentRepository):
        def __init__(self) -> None:
            super().__init__()
            self.item = SimpleNamespace(
                id="plan-item-1",
                project_id="project-a",
                version=1,
                status="scheduled",
                article_id=None,
                trigger_lease_until=None,
                error_code=None,
                error_detail=None,
            )
            self.create_calls = 0
            self.release_calls = 0

        async def claim_due_plan_items(self, *, now: datetime, limit: int = 20) -> list:
            del now, limit
            if self.item.article_id is not None:
                return []
            self.item.status = "triggering"
            return [(self.item, "test-org")]

        async def create_article_from_plan(self, *_: Any, **__: Any) -> tuple[Article, ArticleRun]:
            self.create_calls += 1
            article, run = await self.create_article(
                "test-org",
                "project-a",
                {"primary_keyword": "content planning", "language": "en"},
                "content-plan:plan-item-1:article",
                "plan-item-1",
                {},
            )
            article.plan_item_id = self.item.id
            self.item.article_id = article.id
            self.item.status = "generating"
            return article, run

        async def release_plan_trigger(
            self, plan_item_id: str, *, error_code: str, error_detail: str
        ) -> None:
            del error_code, error_detail
            assert plan_item_id == self.item.id
            self.release_calls += 1
            if self.item.article_id is None:
                self.item.status = "scheduled"

    async def scenario() -> tuple[int, int, int, int, int]:
        repository = PlanDispatchRepository()
        controller = FakeWorkflowController(available=False)
        service = ContentService(
            Settings(default_organization_id="test-org"),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=controller,
        )

        first = await service.dispatch_queued()
        controller.available = True
        second = await service.dispatch_queued()

        return (
            first,
            second,
            repository.create_calls,
            len(repository.articles),
            len(repository.runs),
        )

    assert asyncio.run(scenario()) == (0, 1, 1, 1, 1)


def test_due_plan_failure_before_article_creation_restores_schedule() -> None:
    class FailingPlanRepository(FakeContentRepository):
        def __init__(self) -> None:
            super().__init__()
            self.item = SimpleNamespace(
                id="plan-item-before-create",
                project_id="project-a",
                version=1,
                status="triggering",
                article_id=None,
                trigger_lease_until=NOW,
                error_code=None,
                error_detail=None,
            )

        async def claim_due_plan_items(self, *, now: datetime, limit: int = 20) -> list:
            del now, limit
            return [(self.item, "test-org")]

        async def create_article_from_plan(self, *_: Any, **__: Any) -> tuple[Article, ArticleRun]:
            raise RuntimeError("database unavailable before article creation")

        async def release_plan_trigger(
            self, plan_item_id: str, *, error_code: str, error_detail: str
        ) -> None:
            assert plan_item_id == self.item.id
            self.item.status = "scheduled"
            self.item.trigger_lease_until = None
            self.item.error_code = error_code
            self.item.error_detail = error_detail

    async def scenario() -> tuple[int, str, Any, str, str]:
        repository = FailingPlanRepository()
        service = ContentService(
            Settings(default_organization_id="test-org"),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=FakeWorkflowController(),
        )
        dispatched = await service.dispatch_queued()
        return (
            dispatched,
            repository.item.status,
            repository.item.trigger_lease_until,
            repository.item.error_code,
            repository.item.error_detail,
        )

    assert asyncio.run(scenario()) == (
        0,
        "scheduled",
        None,
        "plan_trigger_failed",
        "database unavailable before article creation",
    )


def test_request_hash_is_based_on_the_normalized_creation_request() -> None:
    service, _, _ = build_service()
    request = CreateArticleRequest(primary_keyword=" solar battery payback ")

    assert service.request_hash(request) == sha256(
        b'{"article_type":null,"language":null,"primary_keyword":"solar battery payback",'
        b'"secondary_keywords":[],"title":null,"writing_direction":null}'
    ).hexdigest()


def test_article_cannot_be_read_from_another_organization() -> None:
    async def scenario() -> None:
        service, repository, controller = build_service()
        created = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="solar battery payback"),
            "cross-organization",
        )
        other_organization = ContentService(
            Settings(default_organization_id="other-org"),
            repository,
            ai_settings=FakeAISettings(),
            controller=controller,
        )

        try:
            await other_organization.get_article("project-a", created.id)
        except ContentNotFoundError:
            pass
        else:
            raise AssertionError("cross-organization article read was allowed")

    asyncio.run(scenario())


def test_plan_generation_not_found_does_not_start_workflow() -> None:
    class MissingPlanRepository(FakeContentRepository):
        def __init__(self) -> None:
            super().__init__()
            self.plan_create_calls = 0

        async def create_article_from_plan(
            self, *_: Any, **__: Any
        ) -> tuple[Article, ArticleRun]:
            self.plan_create_calls += 1
            raise LookupError("content_plan_item_not_found")

    async def scenario() -> tuple[int, int, int, int]:
        repository = MissingPlanRepository()
        controller = FakeWorkflowController()
        service = ContentService(
            Settings(default_organization_id="test-org"),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=controller,
        )

        try:
            await service.generate_plan_item_now(
                "project-b",
                "plan-item-from-project-a",
                expected_version=1,
            )
        except ContentNotFoundError:
            pass
        else:
            raise AssertionError("cross-project plan generation was allowed")

        return (
            repository.plan_create_calls,
            len(repository.articles),
            len(repository.runs),
            len(controller.started),
        )

    assert asyncio.run(scenario()) == (1, 0, 0, 0)


def test_legacy_review_endpoint_is_closed_after_task_migration() -> None:
    async def scenario() -> tuple[int, dict, list[str]]:
        service, repository, _controller = build_service()
        created = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="content workflow"),
            "review-contract",
        )
        article = repository.articles[created.id]
        run = repository.runs[article.current_run_id or ""]
        article.status = "completed"
        article.review_status = "pending_review"
        article.review_version = 1
        run.status = "completed"
        app.dependency_overrides[get_content_service] = lambda: service
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                migrated = await client.patch(
                    f"/api/v1/projects/project-a/articles/{article.id}/review",
                    json={"review_status": "approved", "review_version": 1},
                )
                return (
                    migrated.status_code,
                    migrated.json(),
                    repository.reviewed_by,
                )
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    status_code, payload, reviewed_by = asyncio.run(scenario())
    assert status_code == 409
    assert payload["error"] == {
        "code": "article_review_endpoint_migrated",
        "message": "请使用审核任务接口完成提交、领取和审核决定",
        "retryable": False,
    }
    assert reviewed_by == []


def test_document_save_derives_formats_and_returns_current_version_on_conflict() -> None:
    async def scenario() -> tuple[dict, dict]:
        service, repository, _controller = build_service()
        created = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="content workflow"),
            "document-contract",
        )
        article = repository.articles[created.id]
        run = repository.runs[article.current_run_id or ""]
        article.status = "completed"
        article.review_status = "approved"
        article.review_version = 1
        article.reviewed_at = NOW
        article.reviewed_by = "prior-reviewer"
        article.publication_blocked_reason = None
        run.status = "completed"
        app.dependency_overrides[get_content_service] = lambda: service
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        document = {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 1},
                    "content": [{"type": "text", "text": "Updated article"}],
                },
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "Reviewed "},
                        {
                            "type": "text",
                            "text": "source",
                            "marks": [
                                {
                                    "type": "link",
                                    "attrs": {"href": "https://example.com/source"},
                                }
                            ],
                        },
                    ],
                },
            ],
        }
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                saved = await client.put(
                    f"/api/v1/projects/project-a/articles/{article.id}/document",
                    headers=EDIT_LOCK_HEADERS,
                    json={"document": document, "review_version": 1},
                )
                stale = await client.put(
                    f"/api/v1/projects/project-a/articles/{article.id}/document",
                    headers=EDIT_LOCK_HEADERS,
                    json={"document": document, "review_version": 1},
                )
                return saved.json(), stale.json()
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    saved, stale = asyncio.run(scenario())
    assert saved["review_version"] == 2
    assert saved["review_status"] == "pending_review"
    assert saved["publication_blocked_reason"] == "awaiting_review"
    assert saved["markdown"] == (
        "## Updated article\n\nReviewed [source](https://example.com/source)\n"
    )
    assert saved["html"] == (
        '<h2>Updated article</h2><p>Reviewed '
        '<a href="https://example.com/source">source</a></p>'
    )
    assert stale["error"]["code"] == "stale_review_version"
    assert stale["error"]["current_version"] == 2


def test_article_autosave_contract_is_isolated_idempotent_and_durable_only_on_promote() -> None:
    async def scenario() -> dict[str, Any]:
        service, repository, _controller = build_service()
        service.settings.asset_management_enabled = True
        created = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="reliable article editing"),
            "autosave-contract",
        )
        article = repository.articles[created.id]
        run = repository.runs[article.current_run_id or ""]
        article.status = "completed"
        article.review_status = "approved"
        article.review_version = 1
        article.reviewed_at = NOW
        article.reviewed_by = "reviewer-from-token"
        article.publication_blocked_reason = None
        article.current_version_number = 0
        run.status = "completed"
        document = normalize_document(
            {
                "type": "doc",
                "schema_version": 2,
                "content": [
                    {
                        "type": "paragraph",
                        "attrs": {"node_id": "blk_autosave_contract"},
                        "content": [{"type": "text", "text": "Protected draft"}],
                    }
                ],
            }
        )
        metadata = {
            "title": None,
            "slug": None,
            "meta_title": None,
            "meta_description": None,
            "focus_keyword": article.primary_keyword,
            "secondary_keywords": [],
            "canonical_url": None,
            "indexing": "index/follow",
            "field_states": {
                "title": "generated",
                "slug": "generated",
                "focus_keyword": "generated",
                "secondary_keywords": "generated",
                "meta_title": "generated",
                "meta_description": "generated",
                "canonical_url": "generated",
                "indexing": "generated",
            },
            "publication_status": "complete_draft",
        }
        content_hash = document_content_hash(document, metadata)
        payload = {
            "client_id": "tab-a",
            "sequence": 1,
            "base_version_number": 0,
            "base_review_version": 1,
            "document": document,
            "metadata": metadata,
            "content_hash": content_hash,
            "idempotency_key": "autosave-1",
        }
        app.dependency_overrides[get_content_service] = lambda: service
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        base = f"/api/v1/projects/project-a/articles/{article.id}"
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                capabilities = await client.get(f"{base}/document-capabilities")
                app.state.platform_context_resolver = ContentResolver(
                    permissions=(
                        "content:read",
                        "content:edit",
                        "content:manage_seo_advanced",
                    )
                )
                advanced_capabilities = await client.get(
                    f"{base}/document-capabilities"
                )
                app.state.platform_context_resolver = ContentResolver()
                saved = await client.put(
                    f"{base}/autosave", headers=EDIT_LOCK_HEADERS, json=payload
                )
                replay = await client.put(
                    f"{base}/autosave", headers=EDIT_LOCK_HEADERS, json=payload
                )
                idempotency_conflict = await client.put(
                    f"{base}/autosave",
                    headers=EDIT_LOCK_HEADERS,
                    json={**payload, "sequence": 2},
                )
                stale = await client.put(
                    f"{base}/autosave",
                    headers=EDIT_LOCK_HEADERS,
                    json={
                        **payload,
                        "idempotency_key": "autosave-stale",
                    },
                )
                latest = await client.get(f"{base}/autosaves/latest?client_id=tab-a")

                article.current_version_number = 1
                conflict = await client.put(
                    f"{base}/autosave",
                    headers=EDIT_LOCK_HEADERS,
                    json={
                        **payload,
                        "sequence": 2,
                        "idempotency_key": "autosave-conflict",
                    },
                )
                article.current_version_number = 0

                app.state.platform_context_resolver = ContentResolver("other-user")
                isolated_latest = await client.get(f"{base}/autosaves/latest")
                isolated_delete = await client.delete(
                    f"{base}/autosaves/{saved.json()['id']}"
                )

                app.state.platform_context_resolver = ContentResolver()
                promoted = await client.post(
                    f"{base}/autosaves/{saved.json()['id']}/promote",
                    headers=EDIT_LOCK_HEADERS,
                    json={
                        "base_version_number": 0,
                        "base_review_version": 1,
                        "reason": "browser_recovery",
                    },
                )
                versions = await client.get(f"{base}/versions")
                no_op = await client.put(
                    f"{base}/document",
                    headers=EDIT_LOCK_HEADERS,
                    json={
                        "document": document,
                        "metadata": metadata,
                        "content_hash": content_hash,
                        "base_version_number": 1,
                        "base_review_version": 2,
                    },
                )
                deleted = await client.delete(
                    f"{base}/autosaves/{saved.json()['id']}"
                )
                return {
                    "capabilities": capabilities,
                    "advanced_capabilities": advanced_capabilities,
                    "saved": saved,
                    "replay": replay,
                    "idempotency_conflict": idempotency_conflict,
                    "stale": stale,
                    "latest": latest,
                    "conflict": conflict,
                    "isolated_latest": isolated_latest,
                    "isolated_delete": isolated_delete,
                    "promoted": promoted,
                    "versions": versions,
                    "no_op": no_op,
                    "deleted": deleted,
                    "article": article,
                }
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    result = asyncio.run(scenario())
    capabilities = result["capabilities"]
    assert capabilities.status_code == 200
    assert capabilities.json()["schema_version"] == 2
    assert len(capabilities.json()["recovery_scope"]) == 24
    assert capabilities.json()["can_manage_seo_advanced"] is False
    assert capabilities.json()["media_upload_enabled"] is True
    assert result["advanced_capabilities"].status_code == 200
    assert result["advanced_capabilities"].json()["can_manage_seo_advanced"] is True
    assert result["advanced_capabilities"].json()["media_upload_enabled"] is False
    saved = result["saved"]
    assert saved.status_code == 200
    assert saved.json()["accepted_sequence"] == 1
    assert saved.json()["base_review_version"] == 1
    assert result["replay"].json()["id"] == saved.json()["id"]
    assert result["idempotency_conflict"].status_code == 409
    assert result["idempotency_conflict"].json()["error"]["code"] == (
        "idempotency_key_conflict"
    )
    assert result["stale"].status_code == 409
    assert result["stale"].json()["error"]["accepted_sequence"] == 1
    assert result["latest"].json()["id"] == saved.json()["id"]

    conflict_error = result["conflict"].json()["error"]
    assert result["conflict"].status_code == 409
    assert conflict_error["code"] == "version_conflict"
    assert conflict_error["server_review_version"] == 1
    assert conflict_error["server_version_number"] == 1
    assert conflict_error["client_review_version"] == 1
    assert conflict_error["client_version_number"] == 0
    assert conflict_error["recoverable_autosave"]["id"] == saved.json()["id"]

    assert result["isolated_latest"].json() is None
    assert result["isolated_delete"].status_code == 404
    assert result["promoted"].status_code == 200
    assert result["promoted"].json()["review_version"] == 2
    assert result["promoted"].json()["current_version_number"] == 1
    assert result["versions"].json()["items"] == [
        {
            **result["versions"].json()["items"][0],
            "version_number": 1,
            "version_type": "manual_edit",
            "review_version": 2,
        }
    ]
    assert result["no_op"].status_code == 200
    assert result["no_op"].json()["review_version"] == 2
    assert result["no_op"].json()["current_version_number"] == 1
    assert result["deleted"].status_code == 204
    assert result["article"].review_status == "pending_review"


def test_article_versions_are_scoped_compared_and_restored_as_a_new_version() -> None:
    async def scenario() -> dict[str, Any]:
        service, repository, _controller = build_service()
        created = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="version governance"),
            "version-governance",
        )
        article = repository.articles[created.id]
        run = repository.runs[article.current_run_id or ""]
        old_document = {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 1},
                    "content": [{"type": "text", "text": "Original title"}],
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Original body"}],
                },
            ],
        }
        current_document = {
            "type": "doc",
            "content": [
                {
                    "type": "heading",
                    "attrs": {"level": 1},
                    "content": [{"type": "text", "text": "Current title"}],
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Current body"}],
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "Added line"}],
                },
            ],
        }
        article.title = "Current title"
        article.slug = "current-title"
        article.meta_title = "Current meta"
        article.meta_description = "Current description"
        article.document_json = current_document
        article.markdown = "# Current title\n\nCurrent body\n\nAdded line\n"
        article.html = "<h1>Current title</h1><p>Current body</p><p>Added line</p>"
        article.status = "completed"
        article.publication_status = "publish_ready"
        article.review_status = "approved"
        article.review_version = 3
        article.reviewed_at = NOW
        article.reviewed_by = "prior-reviewer"
        article.publication_blocked_reason = None
        run.status = "completed"
        run.stage = "completed"
        run.progress = 100
        original = ArticleVersion(
            id="version-original",
            article_id=article.id,
            run_id=run.id,
            version_number=1,
            version_type="final",
            review_version=1,
            outline_json={"sections": [{"heading": "Original section"}]},
            quality_json={"passed": True},
                content_json={
                    "title": "Original title",
                    "slug": "original-title",
                    "meta_title": "Original meta",
                    "meta_description": "Original description",
                    "focus_keyword": "原始关键词",
                    "secondary_keywords": ["原始次关键词"],
                    "canonical_url": "https://example.com/original",
                    "indexing": "noindex",
                    "field_states": {"title": "confirmed"},
                    "publication_status": "complete_draft",
                "document": old_document,
                "markdown": "# Original title\n\nOriginal body\n",
                "html": "<h1>Original title</h1><p>Original body</p>",
            },
            created_by="system",
            created_at=NOW,
        )
        stage_only = ArticleVersion(
            id="version-stage-only",
            article_id=article.id,
            run_id=run.id,
            version_number=2,
            version_type="draft",
            review_version=None,
            outline_json={},
            quality_json={},
            content_json={},
            content_ref="s3://bucket/run/writing.json",
            created_by="system",
            created_at=NOW,
        )
        current = ArticleVersion(
            id="version-current",
            article_id=article.id,
            run_id=run.id,
            version_number=3,
            version_type="manual_edit",
            review_version=3,
            outline_json={"sections": [{"heading": "Current section"}]},
            quality_json={"passed": True},
                content_json={
                    "title": article.title,
                    "slug": article.slug,
                    "meta_title": article.meta_title,
                    "meta_description": article.meta_description,
                    "focus_keyword": "当前关键词",
                    "secondary_keywords": ["当前次关键词"],
                    "canonical_url": "https://example.com/current",
                    "indexing": "index",
                    "field_states": {"title": "modified"},
                    "publication_status": article.publication_status,
                "document": current_document,
                "markdown": article.markdown,
                "html": article.html,
            },
            created_by="editor-a",
            created_at=NOW,
        )
        repository.versions[article.id] = [original, stage_only, current]
        app.dependency_overrides[get_content_service] = lambda: service
        previous_resolver = app.state.platform_context_resolver
        resolver = ContentResolver(
            permissions=(
                "content:read",
                "content:edit",
                "content:manage_seo_advanced",
            )
        )
        app.state.platform_context_resolver = resolver
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                base = f"/api/v1/projects/project-a/articles/{article.id}/versions"
                listed = await client.get(base)
                detail = await client.get(f"{base}/1")
                compared = await client.get(
                    f"{base}/compare",
                    params={"from_version": 1, "to_version": 3},
                )
                cross_project = await client.get(
                    f"/api/v1/projects/project-b/articles/{article.id}/versions"
                )
                missing = await client.get(f"{base}/99")
                stage_restore = await client.post(
                    f"{base}/2/restore",
                    headers=EDIT_LOCK_HEADERS,
                    json={"review_version": 3},
                )
                stale_restore = await client.post(
                    f"{base}/1/restore",
                    headers=EDIT_LOCK_HEADERS,
                    json={"review_version": 2},
                )
                restored = await client.post(
                    f"{base}/1/restore",
                    headers=EDIT_LOCK_HEADERS,
                    json={"review_version": 3},
                )
                versions_after = await client.get(base)
                return {
                    "listed": listed,
                    "detail": detail,
                    "compared": compared,
                    "cross_project": cross_project,
                    "missing": missing,
                    "stage_restore": stage_restore,
                    "stale_restore": stale_restore,
                    "restored": restored,
                    "versions_after": versions_after,
                    "resolver": resolver,
                    "repository": repository,
                    "article_id": article.id,
                }
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    result = asyncio.run(scenario())
    listed = result["listed"].json()
    assert result["listed"].status_code == 200
    assert [item["version_number"] for item in listed["items"]] == [3, 2, 1]
    assert listed["items"][1]["restorable"] is False
    assert result["detail"].json()["document"]["type"] == "doc"
    assert result["cross_project"].status_code == 404
    assert result["missing"].status_code == 404

    compared = result["compared"].json()
    assert result["compared"].status_code == 200
    assert compared["added_lines"] == 4
    assert compared["removed_lines"] == 2
    assert {change["field"] for change in compared["metadata_changes"]} == {
        "title",
        "slug",
        "meta_title",
        "meta_description",
        "focus_keyword",
        "secondary_keywords",
        "canonical_url",
        "indexing",
        "field_states",
        "publication_status",
    }
    assert {line["kind"] for line in compared["lines"]} == {
        "context",
        "added",
        "removed",
    }

    assert result["stage_restore"].status_code == 409
    assert result["stage_restore"].json()["error"]["code"] == (
        "article_version_not_restorable"
    )
    assert result["stale_restore"].status_code == 409
    assert result["stale_restore"].json()["error"]["current_version"] == 3
    restored = result["restored"].json()
    assert result["restored"].status_code == 200
    assert restored["title"] == "Original title"
    assert restored["review_version"] == 4
    assert restored["review_status"] == "pending_review"
    assert restored["publication_blocked_reason"] == "awaiting_review"
    assert restored["markdown"] == "## Original title\n\nOriginal body\n"

    restored_version = result["repository"].versions[result["article_id"]][-1]
    assert restored_version.version_number == 4
    assert restored_version.version_type == "restored"
    assert restored_version.restored_from_version_id == "version-original"
    assert restored_version.created_by == "reviewer-from-token"
    assert result["versions_after"].json()["items"][0]["version_number"] == 4
    assert ("project-a", "content:read") in result["resolver"].calls
    assert ("project-a", "content:edit") in result["resolver"].calls


def test_publish_is_idempotent_and_updates_the_existing_wordpress_post() -> None:
    async def scenario() -> tuple[int, dict, dict, dict, list[tuple[dict[str, str], int | None]]]:
        repository = FakeContentRepository()
        transport = FakeWordPressTransport()
        service = ContentService(
            Settings(
                default_organization_id="test-org",
                ai_settings_encryption_key="test-encryption-key",
            ),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=FakeWorkflowController(),
            service_connections=FakeServiceConnections(),  # type: ignore[arg-type]
            wordpress_transport=transport,
        )
        created = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="publish workflow"),
            "publish-contract",
        )
        article = repository.articles[created.id]
        run = repository.runs[article.current_run_id or ""]
        article.title = "Publish workflow"
        article.slug = "publish-workflow"
        article.meta_description = "Publishing contract"
        article.html = "<h1>Publish workflow</h1>"
        article.status = "completed"
        article.publication_status = "publish_ready"
        article.review_status = "approved"
        article.review_version = 1
        article.publication_blocked_reason = None
        run.status = "completed"
        article.current_version_number = 1
        article.approved_version_number = 1
        repository.versions[article.id] = [
            approved_version(article, run, version_number=1, review_version=1)
        ]
        app.dependency_overrides[get_content_service] = lambda: service
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                unapproved = await client.post(
                    f"/api/v1/projects/project-a/articles/{article.id}/publish",
                    headers={"Idempotency-Key": "publish-unapproved"},
                    json={"version_number": 2},
                )
                first = await client.post(
                    f"/api/v1/projects/project-a/articles/{article.id}/publish",
                    headers={"Idempotency-Key": "publish-1"},
                    json={"version_number": 1},
                )
                repeated = await client.post(
                    f"/api/v1/projects/project-a/articles/{article.id}/publish",
                    headers={"Idempotency-Key": "publish-1"},
                    json={"version_number": 1},
                )
                article.review_version = 2
                article.review_status = "approved"
                article.publication_blocked_reason = None
                article.current_version_number = 2
                article.approved_version_number = 2
                repository.versions[article.id].append(
                    approved_version(article, run, version_number=2, review_version=2)
                )
                updated = await client.post(
                    f"/api/v1/projects/project-a/articles/{article.id}/publish",
                    headers={"Idempotency-Key": "publish-2"},
                    json={"version_number": 2},
                )
                return (
                    unapproved.status_code,
                    first.json(),
                    repeated.json(),
                    updated.json(),
                    transport.calls,
                )
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    unapproved_status, first, repeated, updated, calls = asyncio.run(scenario())
    assert unapproved_status == 409
    assert first["cms_publication_status"] == "published"
    assert first["wordpress_post_id"] == 321
    assert repeated == first
    assert updated["wordpress_post_id"] == 321
    assert len(calls) == 2
    assert calls[0][1] is None
    assert calls[1][1] == 321
    assert calls[0][0] == {
        "title": "Publish workflow",
        "content": "<h1>Publish workflow</h1>",
        "status": "publish",
        "slug": "publish-workflow",
        "excerpt": "Publishing contract",
        "meta": {
            "growthos_meta_title": None,
            "growthos_meta_description": "Publishing contract",
            "growthos_focus_keyword": "publish workflow",
            "growthos_secondary_keywords": [],
            "growthos_canonical_url": None,
            "growthos_indexing": "index/follow",
            "growthos_seo_field_states": {
                "title": "generated",
                "slug": "generated",
                "focus_keyword": "generated",
                "secondary_keywords": "generated",
                "meta_title": "generated",
                "meta_description": "generated",
                "canonical_url": "generated",
                "indexing": "generated",
            },
        },
    }


def test_article_governance_permissions_are_enforced_by_the_api() -> None:
    class GovernanceService:
        def __init__(self) -> None:
            self.force_release_calls: list[dict[str, Any]] = []

        async def list_article_review_tasks(self, *args, **kwargs):
            del args, kwargs
            return {"items": []}

        async def force_release_article_lock(self, *args, **kwargs):
            self.force_release_calls.append({"args": args, "kwargs": kwargs})
            return {
                "id": "lock-api-permission",
                "article_id": "article-api-permission",
                "lock_type": "edit_lock",
                "version_number": 1,
                "owner_id": "editor-api-permission",
                "reason": "editing",
                "fence": 1,
                "acquired_at": NOW,
                "renewed_at": NOW,
                "expires_at": NOW,
                "released_at": NOW,
                "token": None,
            }

    async def scenario() -> dict[str, Any]:
        service = GovernanceService()
        previous_resolver = app.state.platform_context_resolver
        app.dependency_overrides[get_content_service] = lambda: service
        transport = ASGITransport(app=app)
        base = "/api/v1/projects/project-a"
        article = f"{base}/articles/article-api-permission"
        task = f"{base}/review-tasks/task-api-permission"
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                app.state.platform_context_resolver = ContentResolver(
                    "editor", permissions=("content:read", "content:edit")
                )
                editor_review = await client.get(
                    f"{base}/review-tasks"
                )
                editor_publish = await client.post(
                    f"{article}/publish",
                    headers={"Idempotency-Key": "editor-cannot-publish"},
                    json={"version_number": 1},
                )

                app.state.platform_context_resolver = ContentResolver(
                    "reviewer", permissions=("content:read", "content:review")
                )
                reviewer_edit = await client.put(
                    f"{article}/document",
                    headers=EDIT_LOCK_HEADERS,
                    json={
                        "document": {
                            "type": "doc",
                            "schema_version": 2,
                            "content": [],
                        },
                        "base_review_version": 1,
                        "base_version_number": 1,
                    },
                )
                reviewer_force_release = await client.post(
                    f"{article}/locks/lock-api-permission/force-release",
                    json={"reason": "reviewers are not lock administrators"},
                )

                app.state.platform_context_resolver = ContentResolver(
                    "submitter",
                    permissions=("content:read", "content:submit_review"),
                )
                submitter_decision = await client.post(
                    f"{task}/decision",
                    headers={"Idempotency-Key": "submitter-cannot-decide"},
                    json={"decision": "approved"},
                )

                revoked = ContentResolver(
                    "revoked-reviewer", permissions=("content:read", "content:review")
                )
                app.state.platform_context_resolver = revoked
                before_revocation = await client.get(
                    f"{base}/review-tasks"
                )
                revoked.permissions = ("content:read",)
                after_revocation = await client.get(
                    f"{base}/review-tasks"
                )

                app.state.platform_context_resolver = ContentResolver(
                    "lock-admin",
                    permissions=("content:read", "content:manage_locks"),
                )
                manager_force_release = await client.post(
                    f"{article}/locks/lock-api-permission/force-release",
                    json={"reason": "recover abandoned editor session"},
                )
                return {
                    "editor_review": editor_review,
                    "editor_publish": editor_publish,
                    "reviewer_edit": reviewer_edit,
                    "reviewer_force_release": reviewer_force_release,
                    "submitter_decision": submitter_decision,
                    "before_revocation": before_revocation,
                    "after_revocation": after_revocation,
                    "manager_force_release": manager_force_release,
                    "force_release_calls": service.force_release_calls,
                }
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    result = asyncio.run(scenario())
    for key in (
        "editor_review",
        "editor_publish",
        "reviewer_edit",
        "reviewer_force_release",
        "submitter_decision",
        "after_revocation",
    ):
        assert result[key].status_code == 403, key
        assert result[key].json()["error"]["code"] == "PLATFORM_PERMISSION_DENIED"
    assert result["before_revocation"].status_code != 403
    assert result["manager_force_release"].status_code == 200
    assert len(result["force_release_calls"]) == 1
    assert result["force_release_calls"][0]["kwargs"]["released_by"] == "lock-admin"


def test_article_lock_api_only_accepts_edit_locks() -> None:
    async def scenario() -> list[int]:
        previous_resolver = app.state.platform_context_resolver
        transport = ASGITransport(app=app)
        article = "/api/v1/projects/project-a/articles/article-lock-types"
        try:
            app.state.platform_context_resolver = ContentResolver(
                "editor", permissions=("content:read", "content:edit")
            )
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                review_lock = await client.post(
                    f"{article}/locks",
                    json={"lock_type": "review_lock"},
                )
                scheduled_publish_lock = await client.post(
                    f"{article}/locks",
                    json={"lock_type": "scheduled_publish_lock"},
                )
                active_review_lock = await client.get(
                    f"{article}/locks/active",
                    params={"lock_type": "review_lock"},
                )
                return [
                    review_lock.status_code,
                    scheduled_publish_lock.status_code,
                    active_review_lock.status_code,
                ]
        finally:
            app.state.platform_context_resolver = previous_resolver

    assert asyncio.run(scenario()) == [422, 422, 422]


def test_review_task_cancel_allows_submitter_or_reviewer_only() -> None:
    class CancelService:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        async def cancel_article_review_task(self, *args, **kwargs):
            self.calls.append({"args": args, "kwargs": kwargs})
            return {
                "id": "task-cancel-permission",
                "article_id": "article-cancel-permission",
                "project_id": "project-a",
                "version_id": "version-cancel-permission",
                "version_number": 1,
                "status": "cancelled",
                "assigned_to": None,
                "assigned_group": None,
                "submitted_by": "submitter",
                "submitted_at": NOW,
                "claimed_by": None,
                "claimed_at": None,
                "decided_by": None,
                "decided_at": None,
                "decision_comment": None,
                "policy_version": "article-review-policy.v1",
                "comments": [],
            }

    async def scenario() -> tuple[list[int], list[dict[str, Any]]]:
        service = CancelService()
        previous_resolver = app.state.platform_context_resolver
        app.dependency_overrides[get_content_service] = lambda: service
        url = "/api/v1/projects/project-a/review-tasks/task-cancel-permission/cancel"
        statuses: list[int] = []
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                for actor, permissions in (
                    ("submitter", ("content:read", "content:submit_review")),
                    ("reviewer", ("content:read", "content:review")),
                    ("reader", ("content:read",)),
                ):
                    app.state.platform_context_resolver = ContentResolver(
                        actor, permissions=permissions
                    )
                    response = await client.post(
                        url, json={"reason": f"cancelled by {actor}"}
                    )
                    statuses.append(response.status_code)
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver
        return statuses, service.calls

    statuses, calls = asyncio.run(scenario())
    assert statuses == [200, 200, 403]
    assert [call["kwargs"]["cancelled_by"] for call in calls] == [
        "submitter",
        "reviewer",
    ]
    assert [call["kwargs"]["can_review"] for call in calls] == [False, True]


def test_uncertain_publish_blocks_blind_retry_with_a_new_key() -> None:
    async def scenario() -> tuple[dict, int, dict, int]:
        repository = FakeContentRepository()
        transport = FakeWordPressTransport()
        transport.error = WordPressPublishError(
            "wordpress_publish_uncertain",
            "network result unknown",
            uncertain=True,
        )
        service = ContentService(
            Settings(
                default_organization_id="test-org",
                ai_settings_encryption_key="test-encryption-key",
            ),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=FakeWorkflowController(),
            service_connections=FakeServiceConnections(),  # type: ignore[arg-type]
            wordpress_transport=transport,
        )
        created = await service.create_article(
            "project-a",
            CreateArticleRequest(primary_keyword="uncertain publish"),
            "uncertain-contract",
        )
        article = repository.articles[created.id]
        run = repository.runs[article.current_run_id or ""]
        article.title = "Uncertain publish"
        article.html = "<h1>Uncertain publish</h1>"
        article.status = "completed"
        article.publication_status = "publish_ready"
        article.review_status = "approved"
        article.review_version = 1
        article.publication_blocked_reason = None
        run.status = "completed"
        article.current_version_number = 1
        article.approved_version_number = 1
        repository.versions[article.id] = [
            approved_version(article, run, version_number=1, review_version=1)
        ]
        app.dependency_overrides[get_content_service] = lambda: service
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                first = await client.post(
                    f"/api/v1/projects/project-a/articles/{article.id}/publish",
                    headers={"Idempotency-Key": "uncertain-1"},
                    json={"version_number": 1},
                )
                blocked = await client.post(
                    f"/api/v1/projects/project-a/articles/{article.id}/publish",
                    headers={"Idempotency-Key": "uncertain-2"},
                    json={"version_number": 1},
                )
                return (
                    first.json(),
                    blocked.status_code,
                    blocked.json(),
                    len(transport.calls),
                )
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    first, blocked_status, blocked, call_count = asyncio.run(scenario())
    assert first["cms_publication_status"] == "uncertain"
    assert first["cms_publication_error"] == "wordpress_publish_uncertain"
    assert blocked_status == 409
    assert blocked["error"]["code"] == "article_publication_uncertain"
    assert call_count == 1
