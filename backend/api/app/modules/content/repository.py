from __future__ import annotations

import hmac
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from secrets import token_urlsafe
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import Text, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.models import (
    Article,
    ArticleAssetBinding,
    ArticleAutosave,
    ArticleIdempotencyKey,
    ArticleLinkAnalysis,
    ArticlePublication,
    ArticleLock,
    ArticleReviewComment,
    ArticleReviewDecision,
    ArticleReviewPolicy,
    ArticleReviewTask,
    ArticleRun,
    ArticleRunStep,
    ArticleSeoAnalysis,
    ArticleSource,
    ArticleVersion,
    ArticleVersionDiffCache,
    ContentAuditEvent,
    ContentAsset,
)
from app.modules.content.article_diff import (
    ARTICLE_DIFF_ALGORITHM_VERSION,
    build_article_diff,
)
from app.modules.content.document import (
    CURRENT_SCHEMA_VERSION,
    canonical_document_json,
    document_content_hash,
    document_to_html,
    document_to_markdown,
    extract_asset_manifest,
    markdown_to_document,
    normalize_document,
)
from app.modules.content_plan import models as content_plan_models  # noqa: F401
from app.modules.crawling.models import CrawlRun, LinkEdge, Page, PageSnapshot
from app.modules.projects.models import Project, SiteProfile


class ArticleIdempotencyConflictError(Exception):
    pass


class ArticleLockConflictError(ValueError):
    pass


@dataclass(frozen=True)
class ContentAuditContext:
    actor_id: str
    effective_role: str
    request_id: str | None
    correlation_id: str | None
    policy_version: str = "article-review-policy.v1"


AUTOSAVE_TTL_DAYS = 14
AUTOSAVE_KEEP_PER_CLIENT = 5
SEO_FIELD_KEYS = (
    "title",
    "slug",
    "focus_keyword",
    "secondary_keywords",
    "meta_title",
    "meta_description",
    "canonical_url",
    "indexing",
)
ARTICLE_INDEXING_VALUES = {
    "index/follow",
    "noindex/follow",
    "index/nofollow",
    "noindex/nofollow",
}


def normalize_article_indexing(value: Any) -> str:
    normalized = {"index": "index/follow", "noindex": "noindex/follow"}.get(
        value, value
    )
    if normalized not in ARTICLE_INDEXING_VALUES:
        raise ValueError("article_metadata_indexing_invalid")
    return str(normalized)


def article_metadata_snapshot(
    article: Article, overrides: dict[str, Any] | None = None
) -> dict[str, Any]:
    source = overrides or {}
    publication_status = source.get("publication_status", article.publication_status)
    if publication_status not in {"publish_ready", "complete_draft"}:
        raise ValueError("article_metadata_publication_status_invalid")
    indexing = normalize_article_indexing(
        source.get("indexing", article.indexing or "index/follow")
    )
    secondary_keywords = source.get(
        "secondary_keywords", list(article.secondary_keywords_json or [])
    )
    if not isinstance(secondary_keywords, list):
        raise ValueError("article_metadata_secondary_keywords_invalid")
    field_states = source.get("field_states", dict(article.seo_field_states_json or {}))
    if not isinstance(field_states, dict) or set(field_states) - set(SEO_FIELD_KEYS):
        raise ValueError("article_metadata_field_states_invalid")
    if any(
        state not in {"generated", "confirmed", "modified", "stale"}
        for state in field_states.values()
    ):
        raise ValueError("article_metadata_field_states_invalid")
    return {
        "title": source.get("title", article.title),
        "slug": source.get("slug", article.slug),
        "meta_title": source.get("meta_title", article.meta_title),
        "meta_description": source.get("meta_description", article.meta_description),
        "focus_keyword": source.get(
            "focus_keyword", article.focus_keyword or article.primary_keyword
        ),
        "secondary_keywords": list(secondary_keywords),
        "canonical_url": source.get("canonical_url", article.canonical_url),
        "indexing": indexing,
        "field_states": {key: field_states.get(key, "generated") for key in SEO_FIELD_KEYS},
        "publication_status": publication_status,
    }


def advanced_seo_changed(article: Article, metadata: dict[str, Any]) -> bool:
    return (
        metadata["canonical_url"] != article.canonical_url
        or metadata["indexing"]
        != normalize_article_indexing(article.indexing or "index/follow")
    )


def autosave_request_hash(
    *,
    client_id: str,
    sequence: int,
    base_version_number: int,
    base_review_version: int,
    document: dict[str, Any],
    metadata: dict[str, Any],
    content_hash: str,
) -> str:
    payload = {
        "client_id": client_id,
        "sequence": sequence,
        "base_version_number": base_version_number,
        "base_review_version": base_review_version,
        "document": document,
        "metadata": metadata,
        "content_hash": content_hash,
    }
    return sha256(canonical_document_json(payload).encode("utf-8")).hexdigest()


def project_snapshot_warnings(snapshot: dict[str, Any]) -> list[str]:
    status = snapshot.get("profile_status")
    if status == "missing":
        return ["project_profile_missing"]
    if status == "incomplete" or (status is None and not snapshot.get("profile")):
        return ["project_profile_incomplete"]
    return []


def project_profile_is_complete(profile: dict[str, Any]) -> bool:
    for field in ("business_name", "business_type"):
        value = profile.get(field)
        if not isinstance(value, str) or not value.strip():
            return False
    for field in ("products_services", "target_audiences", "value_propositions"):
        values = profile.get(field)
        if not isinstance(values, list) or not any(
            isinstance(value, str) and value.strip() for value in values
        ):
            return False
    return True


_UTILITY_PAGE_PARTS = {
    "account",
    "cart",
    "checkout",
    "cookie-policy",
    "cookies",
    "legal",
    "login",
    "logout",
    "my-account",
    "privacy",
    "privacy-policy",
    "register",
    "search",
    "signin",
    "signup",
    "terms",
    "terms-and-conditions",
}
_ARTICLE_PATH_PARTS = {
    "article",
    "articles",
    "blog",
    "guides",
    "insights",
    "learn",
    "news",
    "resources",
}
_ARTICLE_SCHEMA_TYPES = {"article", "blogposting", "newsarticle"}
_INTERNAL_LINK_SEMANTIC_GROUPS = {
    "comparison": ("compare", "comparison", "versus", "vs", "比较", "对比", "区别"),
    "cost": ("price", "pricing", "cost", "fee", "价格", "成本", "费用"),
    "guide": ("guide", "guidance", "tutorial", "指南", "教程"),
    "implementation": (
        "implement",
        "implementation",
        "deployment",
        "rollout",
        "实施",
        "部署",
        "落地",
    ),
    "setup": ("setup", "configure", "configuration", "设置", "配置"),
}


def _usable_internal_url(url: str, project_domain: str) -> bool:
    parsed = urlsplit(url.strip())
    host = (parsed.hostname or "").casefold().removeprefix("www.")
    expected = urlsplit(
        project_domain if "://" in project_domain else f"https://{project_domain}"
    ).hostname
    expected = (expected or "").casefold().removeprefix("www.")
    if parsed.scheme not in {"http", "https"} or not host or host != expected:
        return False
    parts = {part.casefold() for part in parsed.path.split("/") if part}
    return not parts.intersection(_UTILITY_PAGE_PARTS)


def _schema_types(value: Any) -> set[str]:
    if isinstance(value, dict):
        output: set[str] = set()
        schema_type = value.get("@type")
        if isinstance(schema_type, str):
            output.add(schema_type.casefold())
        elif isinstance(schema_type, list):
            output.update(str(item).casefold() for item in schema_type)
        for item in value.values():
            output.update(_schema_types(item))
        return output
    if isinstance(value, list):
        return {item for value_item in value for item in _schema_types(value_item)}
    return set()


def _looks_like_published_article(page: dict[str, Any]) -> bool:
    path_parts = {
        part.casefold()
        for part in urlsplit(str(page.get("url") or "")).path.split("/")
        if part
    }
    schema_types = _schema_types(
        [page.get("structured_data") or [], page.get("schema_org") or []]
    )
    return bool(path_parts.intersection(_ARTICLE_PATH_PARTS)) or bool(
        schema_types.intersection(_ARTICLE_SCHEMA_TYPES)
    )


def _internal_link_terms(value: str) -> set[str]:
    normalized = value.casefold()
    terms = {
        item
        for item in re.findall(r"[a-z0-9]+", normalized)
        if len(item) > 1 and not item.isdigit()
    }
    for block in re.findall(r"[\u4e00-\u9fff]+", normalized):
        terms.add(block)
        for size in (2, 3):
            terms.update(block[index : index + size] for index in range(len(block) - size + 1))
    latin_tokens = set(re.findall(r"[a-z0-9]+", normalized))
    for concept, aliases in _INTERNAL_LINK_SEMANTIC_GROUPS.items():
        if any(
            alias in latin_tokens
            if re.fullmatch(r"[a-z0-9]+", alias)
            else alias in normalized
            for alias in aliases
        ):
            terms.add(f"concept:{concept}")
    return terms


def _internal_link_query_terms(value: str) -> list[str]:
    normalized = value.casefold()
    terms = [
        item
        for item in re.findall(r"[a-z0-9]+", normalized)
        if len(item) > 1 and not item.isdigit()
    ]
    terms.extend(re.findall(r"[\u4e00-\u9fff]+", normalized))
    latin_tokens = set(re.findall(r"[a-z0-9]+", normalized))
    for aliases in _INTERNAL_LINK_SEMANTIC_GROUPS.values():
        if any(
            alias in latin_tokens
            if re.fullmatch(r"[a-z0-9]+", alias)
            else alias in normalized
            for alias in aliases
        ):
            terms.extend(aliases)
    return list(dict.fromkeys(terms))[:12]


def _internal_link_candidate_score(
    candidate: dict[str, Any], keyword_terms: set[str]
) -> tuple[int, dict[str, int]]:
    overlaps = {
        "title": len(
            keyword_terms.intersection(
                _internal_link_terms(str(candidate.get("title") or ""))
            )
        ),
        "description": len(
            keyword_terms.intersection(
                _internal_link_terms(str(candidate.get("description") or ""))
            )
        ),
        "url": len(
            keyword_terms.intersection(
                _internal_link_terms(str(candidate.get("url") or ""))
            )
        ),
        "headings": len(
            keyword_terms.intersection(
                _internal_link_terms(" ".join(candidate.get("headings") or []))
            )
        ),
        "anchors": len(
            keyword_terms.intersection(
                _internal_link_terms(" ".join(candidate.get("anchor_texts") or []))
            )
        ),
    }
    score = (
        overlaps["title"] * 40
        + overlaps["url"] * 30
        + overlaps["description"] * 20
        + overlaps["headings"] * 15
        + overlaps["anchors"] * 10
    )
    contextual_overlap = (
        overlaps["description"] + overlaps["headings"] + overlaps["anchors"]
    )
    if overlaps["title"] == 0 and overlaps["url"] == 0 and contextual_overlap < 2:
        return 0, overlaps
    return score, overlaps


def _unique_text(values: list[Any]) -> list[str]:
    return list(dict.fromkeys(str(item).strip() for item in values if str(item).strip()))


def merge_project_profile(profile: SiteProfile | None) -> tuple[dict[str, Any], str]:
    if profile is None:
        return {}, "missing"
    merged = dict(profile.profile_json or {})
    merged.update(dict(profile.user_overrides or {}))
    return merged, "available" if project_profile_is_complete(merged) else "incomplete"


def publication_status_for_artifact(artifact: dict[str, Any]) -> str:
    quality = artifact.get("quality")
    if not isinstance(quality, dict) or quality.get("passed") is not True:
        return "complete_draft"
    issues = quality.get("issues") if isinstance(quality.get("issues"), list) else []
    has_evidence_issues = int(quality.get("evidence_issue_count") or 0) > 0 or any(
        isinstance(item, dict) and item.get("category") == "evidence"
        for item in issues
    )
    sections = artifact.get("sections") if isinstance(artifact.get("sections"), list) else []
    has_fallback_sections = bool(artifact.get("degraded_section_ids")) or any(
        isinstance(item, dict)
        and str(item.get("summary") or "").startswith("degraded_fallback:")
        for item in sections
    )
    if has_evidence_issues or has_fallback_sections:
        return "complete_draft"
    return "publish_ready"


class ContentRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def initial_plan_items(
        self,
        organization_id: str,
        project_id: str,
        count: int,
        *,
        batch_id: str,
    ) -> list[Any]:
        from app.modules.content_plan.models import ContentPlanItem

        async with self.sessions() as session:
            project_exists = await session.scalar(
                select(Project.id).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
            )
            if project_exists is None:
                raise LookupError("project_not_found")
            return list(
                (
                    await session.scalars(
                        select(ContentPlanItem)
                        .where(
                            ContentPlanItem.project_id == project_id,
                            ContentPlanItem.batch_id == batch_id,
                            ContentPlanItem.plan_order.is_not(None),
                            ContentPlanItem.plan_order <= count,
                            or_(
                                ContentPlanItem.status == "scheduled",
                                ContentPlanItem.article_id.is_not(None),
                            ),
                        )
                        .order_by(
                            ContentPlanItem.plan_order.asc().nulls_last(),
                            ContentPlanItem.id,
                        )
                    )
                ).all()
            )

    @staticmethod
    def _add_audit_event(
        session: AsyncSession,
        *,
        audit: ContentAuditContext | None,
        project_id: str,
        article_id: str | None,
        action: str,
        target_type: str,
        target_id: str,
        version_number: int | None = None,
        before_state: dict[str, Any] | None = None,
        after_state: dict[str, Any] | None = None,
        reason: str | None = None,
        policy_version: str | None = None,
    ) -> None:
        if audit is None:
            return
        session.add(
            ContentAuditEvent(
                id=str(uuid4()),
                project_id=project_id,
                article_id=article_id,
                actor_id=audit.actor_id,
                effective_role=audit.effective_role,
                action=action,
                target_type=target_type,
                target_id=target_id,
                version_number=version_number,
                before_state=before_state,
                after_state=after_state,
                reason=reason,
                policy_version=policy_version or audit.policy_version,
                request_id=audit.request_id,
                correlation_id=audit.correlation_id,
            )
        )

    @staticmethod
    async def _require_edit_lock(
        session: AsyncSession,
        *,
        article_id: str,
        owner_id: str,
        token: str | None,
        fence: int | None,
    ) -> ArticleLock:
        if not token or fence is None:
            raise ArticleLockConflictError("article_edit_lock_required")
        lock = await session.scalar(
            select(ArticleLock)
            .where(
                ArticleLock.article_id == article_id,
                ArticleLock.lock_type == "edit_lock",
                ArticleLock.released_at.is_(None),
            )
            .with_for_update()
        )
        now = datetime.now(UTC)
        if lock is None:
            raise ArticleLockConflictError("article_edit_lock_not_found")
        if lock.expires_at <= now:
            lock.released_at = now
            lock.released_by = "system"
            lock.release_reason = "lease_expired"
            raise ArticleLockConflictError("article_edit_lock_expired")
        if lock.owner_id != owner_id:
            raise ArticleLockConflictError("article_edit_lock_owned_by_another_user")
        token_hash = sha256(token.encode("utf-8")).hexdigest()
        if lock.fence != fence or not hmac.compare_digest(lock.token_hash, token_hash):
            raise ArticleLockConflictError("article_edit_lock_stale_fence")
        return lock

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        async with self.sessions() as session:
            return await session.scalar(
                select(Project.id).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
            ) is not None

    async def create_article(
        self,
        organization_id: str,
        project_id: str,
        request_snapshot: dict[str, Any],
        idempotency_key: str,
        request_hash: str,
        model_snapshot: dict[str, Any] | None = None,
    ) -> tuple[Article, ArticleRun]:
        try:
            async with self.sessions() as session:
                existing = await self._idempotent_result(
                    session, organization_id, project_id, idempotency_key, request_hash
                )
                if existing is not None:
                    return existing

                project = await session.scalar(
                    select(Project).where(
                        Project.id == project_id,
                        Project.organization_id == organization_id,
                    )
                )
                if project is None:
                    raise LookupError("project_not_found")
                profile = await session.get(SiteProfile, project.id)
                profile_json, profile_status = merge_project_profile(profile)
                project_snapshot = {
                    "organization_id": organization_id,
                    "project_id": project.id,
                    "domain": project.domain,
                    "country": project.country,
                    "language": request_snapshot.get("language") or project.language,
                    "profile": profile_json,
                    "profile_status": profile_status,
                }
                plan_input = {
                    **request_snapshot,
                    "language": project_snapshot["language"],
                }
                article_id, run_id = str(uuid4()), str(uuid4())
                article = Article(
                    id=article_id,
                    organization_id=organization_id,
                    project_id=project_id,
                    primary_keyword=str(request_snapshot["primary_keyword"]),
                    status="queued",
                    current_run_id=run_id,
                )
                run = ArticleRun(
                    id=run_id,
                    article_id=article_id,
                    organization_id=organization_id,
                    project_id=project_id,
                    workflow_id=f"article-generation:{run_id}",
                    trigger_type="initial",
                    run_idempotency_key=(
                        "article-create:"
                        + sha256(
                            f"{organization_id}:{project_id}:{idempotency_key}".encode()
                        ).hexdigest()
                    ),
                    request_hash=request_hash,
                    plan_input_snapshot_json=plan_input,
                    project_snapshot_json=project_snapshot,
                    status="queued",
                    stage="queued",
                    progress=0,
                    model_snapshot_json=model_snapshot or {},
                )
                key = ArticleIdempotencyKey(
                    organization_id=organization_id,
                    project_id=project_id,
                    idempotency_key=idempotency_key,
                    request_hash=request_hash,
                    article_id=article_id,
                )
                session.add_all([article, run, key])
                await session.commit()
                await session.refresh(article)
                await session.refresh(run)
                return article, run
        except IntegrityError:
            # A concurrent request may have committed the same idempotency key first.
            async with self.sessions() as session:
                existing = await self._idempotent_result(
                    session, organization_id, project_id, idempotency_key, request_hash
                )
                if existing is not None:
                    return existing
            raise

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
        if trigger_type not in {"retry", "regeneration"}:
            raise ValueError("article_run_trigger_invalid")
        scoped_key = "article-command:" + sha256(
            (
                f"{organization_id}:{project_id}:{article_id}:"
                f"{trigger_type}:{idempotency_key}"
            ).encode()
        ).hexdigest()
        async with self.sessions() as session:
            existing = await session.scalar(
                select(ArticleRun).where(ArticleRun.run_idempotency_key == scoped_key)
            )
            if existing is not None:
                if existing.request_hash != request_hash:
                    raise ArticleIdempotencyConflictError
                article = await session.get(Article, existing.article_id)
                if article is None:
                    raise ValueError("article_run_integrity_error")
                return article, existing

            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            existing = await session.scalar(
                select(ArticleRun).where(ArticleRun.run_idempotency_key == scoped_key)
            )
            if existing is not None:
                if existing.request_hash != request_hash:
                    raise ArticleIdempotencyConflictError
                return article, existing
            parent = (
                await session.scalar(
                    select(ArticleRun)
                    .where(ArticleRun.id == article.current_run_id)
                    .with_for_update()
                )
                if article.current_run_id
                else None
            )
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
                plan_item_version=parent.plan_item_version,
                run_idempotency_key=scoped_key,
                request_hash=request_hash,
                plan_input_snapshot_json=dict(parent.plan_input_snapshot_json or {}),
                project_snapshot_json=dict(parent.project_snapshot_json or {}),
                model_snapshot_json=(
                    dict(parent.model_snapshot_json or {})
                    if trigger_type == "retry"
                    else dict(model_snapshot or {})
                ),
                status="queued",
                stage="queued",
                progress=0,
            )
            sources = list(
                (
                    await session.scalars(
                        select(ArticleSource).where(ArticleSource.run_id == parent.id)
                    )
                ).all()
            )
            session.add(run)
            for source in sources:
                session.add(
                    ArticleSource(
                        id=str(uuid4()),
                        run_id=run.id,
                        source_type=source.source_type,
                        url=source.url,
                        normalized_url=source.normalized_url,
                        title=source.title,
                        domain=source.domain,
                        published_at=source.published_at,
                        retrieved_at=source.retrieved_at,
                        status=source.status,
                        content_ref=source.content_ref,
                        summary_json=dict(source.summary_json or {}),
                        claims_json=list(source.claims_json or []),
                        section_ids_json=list(source.section_ids_json or []),
                        metadata_json=_copied_source_metadata(
                            source.source_type,
                            dict(source.metadata_json or {}),
                            parent.id,
                        ),
                    )
                )
            article.current_run_id = run.id
            article.status = "queued"
            article.review_status = None
            article.review_note = None
            article.reviewed_at = None
            article.reviewed_by = None
            article.publication_blocked_reason = "awaiting_review"
            await session.commit()
            await session.refresh(article)
            await session.refresh(run)
            return article, run

    async def create_article_from_plan(
        self,
        organization_id: str,
        project_id: str,
        plan_item_id: str,
        *,
        expected_version: int,
        model_snapshot: dict[str, Any],
        now: datetime,
        explicit: bool,
    ) -> tuple[Article, ArticleRun]:
        from app.modules.content_plan.models import (
            ContentPlanItem,
            ContentPlanItemKeyword,
            ContentPlanSerpSnapshot,
            ContentPlanSettings,
        )

        async with self.sessions() as session:
            item = await session.scalar(
                select(ContentPlanItem)
                .where(
                    ContentPlanItem.id == plan_item_id,
                    ContentPlanItem.project_id == project_id,
                )
                .with_for_update()
            )
            if item is None:
                raise LookupError("content_plan_item_not_found")
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
            )
            if project is None:
                raise LookupError("content_plan_item_not_found")
            if item.version != expected_version:
                raise ValueError("stale_plan_item_version")
            if item.article_id:
                article = await session.get(Article, item.article_id)
                run = await session.get(ArticleRun, article.current_run_id) if article else None
                if article is None or run is None:
                    raise ValueError("plan_article_integrity_error")
                return article, run
            settings = await session.get(ContentPlanSettings, item.project_id)
            allowed_status = "scheduled" if explicit else "triggering"
            if (
                item.status != allowed_status
                or item.edit_state != "idle"
                or (not explicit and item.schedule_attention_reason is not None)
                or (not explicit and (item.generation_at is None or item.generation_at > now))
                or (not explicit and (settings is None or settings.paused))
            ):
                raise ValueError("plan_item_not_triggerable")
            if explicit and item.schedule_attention_reason not in {
                None,
                "expired_user_pinned_date",
            }:
                raise ValueError("plan_item_not_triggerable")

            if explicit:
                item.status = "triggering"
                item.trigger_lease_until = now + timedelta(minutes=5)
            keywords = list(
                (
                    await session.scalars(
                        select(ContentPlanItemKeyword)
                        .where(ContentPlanItemKeyword.plan_item_id == item.id)
                        .order_by(ContentPlanItemKeyword.position)
                    )
                ).all()
            )
            serp = await session.get(ContentPlanSerpSnapshot, item.current_serp_snapshot_id)
            if (
                serp is None
                or serp.error_code is not None
                or not item.publish_local_date
                or not item.publish_local_time
                or not item.schedule_timezone
                or not item.publish_at
                or not item.generation_at
                or not item.title.strip()
                or not item.writing_direction.strip()
                or not keywords
                or sum(row.role == "primary" for row in keywords) != 1
            ):
                raise ValueError("plan_input_incomplete")
            profile = await session.get(SiteProfile, project.id)
            profile_json, profile_status = merge_project_profile(profile)
            project_snapshot = {
                "organization_id": organization_id,
                "project_id": project.id,
                "domain": project.domain,
                "country": project.country,
                "language": project.language,
                "profile": profile_json,
                "profile_status": profile_status,
            }
            serp_payload = {
                "keyword": serp.primary_keyword,
                "organic_results": list(serp.organic_summary_json),
                "people_also_ask": [
                    str(row.get("question")) for row in serp.paa_json if row.get("question")
                ],
                "related_searches": [
                    str(row.get("query"))
                    for row in serp.related_searches_json
                    if row.get("query")
                ],
                "features": list(serp.serp_features_json),
                "featured_snippet": serp.featured_snippet_json,
            }
            snapshot = {
                "plan_item_id": item.id,
                "plan_item_version": item.version,
                "primary_keyword": item.primary_keyword,
                "secondary_keywords": [
                    {"keyword": row.keyword, "type": row.keyword_type}
                    for row in keywords
                    if row.role == "secondary"
                ],
                "title": {
                    "value": item.title,
                    "policy": "locked" if item.title_user_edited else "suggested",
                },
                "writing_direction": {
                    "value": item.writing_direction,
                    "policy": "locked" if item.direction_user_edited else "suggested",
                },
                "serp_snapshot": {
                    "id": serp.id,
                    "generated_at": serp.created_at.isoformat(),
                    "evidence": serp_payload,
                },
                "project": project_snapshot,
                "schedule": {
                    "publish_local_date": item.publish_local_date.isoformat(),
                    "publish_local_time": item.publish_local_time.isoformat(),
                    "timezone": item.schedule_timezone,
                    "publish_at": item.publish_at.isoformat(),
                    "generation_at": item.generation_at.isoformat(),
                },
            }
            article_id, run_id = str(uuid4()), str(uuid4())
            article = Article(
                id=article_id,
                organization_id=organization_id,
                project_id=item.project_id,
                plan_item_id=item.id,
                primary_keyword=item.primary_keyword,
                status="queued",
                current_run_id=run_id,
            )
            run = ArticleRun(
                id=run_id,
                article_id=article_id,
                organization_id=organization_id,
                project_id=item.project_id,
                workflow_id=f"article-generation:{run_id}",
                plan_item_version=item.version,
                run_idempotency_key=f"content-plan:{item.id}:v{item.version}:run",
                plan_input_snapshot_json=snapshot,
                project_snapshot_json=project_snapshot,
                model_snapshot_json=model_snapshot,
                status="queued",
                stage="queued",
                progress=0,
            )
            key = ArticleIdempotencyKey(
                organization_id=organization_id,
                project_id=item.project_id,
                idempotency_key=f"content-plan:{item.id}:article",
                request_hash=sha256(item.id.encode()).hexdigest(),
                article_id=article_id,
            )
            source = ArticleSource(
                id=str(uuid4()),
                run_id=run_id,
                source_type="serp",
                url=f"serp://content-plan/{serp.id}",
                normalized_url=f"serp://content-plan/{serp.id}",
                title=item.primary_keyword,
                status="available",
                summary_json=serp_payload,
                metadata_json={
                    "content_plan_serp_snapshot_id": serp.id,
                    "provider_request_id": serp.provider_request_id,
                    "request_cost_usd": 0,
                    "reused": True,
                },
                retrieved_at=now,
            )
            session.add_all([article, run, key, source])
            item.article_id = article_id
            item.status = "generating"
            item.schedule_attention_reason = None
            item.trigger_lease_until = None
            await session.commit()
            await session.refresh(article)
            await session.refresh(run)
            return article, run

    async def claim_due_plan_items(
        self,
        *,
        now: datetime,
        limit: int = 20,
    ) -> list[tuple[Any, str]]:
        from app.modules.content_plan.models import ContentPlanItem, ContentPlanSettings

        lease_until = now + timedelta(minutes=5)
        async with self.sessions() as session:
            rows = list(
                (
                    await session.execute(
                        select(ContentPlanItem, Project.organization_id)
                        .join(Project, Project.id == ContentPlanItem.project_id)
                        .join(
                            ContentPlanSettings,
                            ContentPlanSettings.project_id == ContentPlanItem.project_id,
                        )
                        .where(
                            or_(
                                ContentPlanItem.status == "scheduled",
                                (
                                    (ContentPlanItem.status == "triggering")
                                    & (ContentPlanItem.trigger_lease_until <= now)
                                ),
                            ),
                            ContentPlanItem.edit_state == "idle",
                            ContentPlanItem.schedule_attention_reason.is_(None),
                            ContentPlanItem.article_id.is_(None),
                            ContentPlanItem.generation_at.is_not(None),
                            ContentPlanItem.generation_at <= now,
                            ContentPlanSettings.paused.is_(False),
                        )
                        .order_by(
                            ContentPlanItem.generation_at,
                            ContentPlanItem.id,
                        )
                        .limit(max(1, min(limit, 100)))
                        .with_for_update(skip_locked=True, of=ContentPlanItem)
                    )
                ).all()
            )
            for item, _organization_id in rows:
                item.status = "triggering"
                item.trigger_lease_until = lease_until
                item.error_code = None
                item.error_detail = None
            await session.commit()
            return [(item, str(organization_id)) for item, organization_id in rows]

    async def release_plan_trigger(
        self,
        plan_item_id: str,
        *,
        error_code: str,
        error_detail: str,
    ) -> None:
        from app.modules.content_plan.models import ContentPlanItem

        async with self.sessions() as session:
            item = await session.scalar(
                select(ContentPlanItem)
                .where(ContentPlanItem.id == plan_item_id)
                .with_for_update()
            )
            if item is None or item.article_id is not None or item.status != "triggering":
                return
            item.status = "scheduled"
            item.trigger_lease_until = None
            item.error_code = error_code[:100]
            item.error_detail = error_detail[:2000]
            await session.commit()

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
        from app.modules.content_plan.models import ContentPlanSettings
        from app.modules.content_plan.scheduling import publication_blocked_reason

        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            run = await session.get(ArticleRun, article.current_run_id) if article.current_run_id else None
            if (
                run is None
                or run.status not in {"completed", "completed_with_warnings"}
                or article.review_status is None
            ):
                raise ValueError("article_not_reviewable")
            if article.review_version != expected_version:
                raise ValueError("stale_review_version")
            prior_decision = await session.scalar(
                select(ArticleReviewDecision.id).where(
                    ArticleReviewDecision.article_id == article.id,
                    ArticleReviewDecision.review_version == article.review_version,
                )
            )
            if prior_decision is not None:
                raise ValueError("stale_review_version")
            review_note = review_note.strip() if review_note else None
            if decision == "changes_requested" and not review_note:
                raise ValueError("review_note_required")
            reviewed_version = await self._get_action_version(
                session,
                article,
                version_number=article.current_version_number,
                expected_review_version=article.review_version,
                missing_code="review_version_not_found",
            )
            if decision == "approved":
                await self._validate_version_asset_manifest(
                    session, article.project_id, reviewed_version
                )
            now = datetime.now(UTC)
            settings = await session.get(ContentPlanSettings, project_id)
            article.review_status = decision
            article.review_note = review_note
            article.reviewed_at = now
            article.reviewed_by = reviewed_by
            if decision == "approved":
                article.approved_version_number = reviewed_version.version_number
            article.publication_blocked_reason = publication_blocked_reason(
                review_status=decision,
                publication_status=article.publication_status,
                paused=bool(settings.paused) if settings else False,
            )
            session.add(
                ArticleReviewDecision(
                    article_id=article.id,
                    article_run_id=run.id,
                    review_version=article.review_version,
                    decision=decision,
                    review_note=review_note,
                    reviewed_by=reviewed_by,
                    reviewed_at=now,
                )
            )
            await session.commit()
            await session.refresh(article)
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
        edited_by: str = "system",
        can_manage_seo_advanced: bool = False,
        lock_token: str | None = None,
        lock_fence: int | None = None,
        audit: ContentAuditContext | None = None,
    ) -> tuple[Article, ArticleRun]:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            await self._require_edit_lock(
                session,
                article_id=article.id,
                owner_id=edited_by,
                token=lock_token,
                fence=lock_fence,
            )
            run = (
                await session.get(ArticleRun, article.current_run_id)
                if article.current_run_id
                else None
            )
            if run is None or run.status not in {
                "completed",
                "completed_with_warnings",
            }:
                raise ValueError("article_not_editable")
            if article.review_version < 1:
                raise ValueError("article_not_editable")
            if article.review_version != expected_review_version:
                raise ValueError(f"stale_review_version:{article.review_version}")
            if (
                expected_version_number is not None
                and article.current_version_number != expected_version_number
            ):
                raise ValueError(
                    f"stale_version_number:{article.current_version_number}"
                )
            normalized_metadata = article_metadata_snapshot(article, metadata)
            if advanced_seo_changed(article, normalized_metadata) and not can_manage_seo_advanced:
                raise PermissionError("content:manage_seo_advanced")
            expected_hash = document_content_hash(document, normalized_metadata)
            if content_hash is not None and content_hash != expected_hash:
                raise ValueError("article_content_hash_mismatch")
            content_hash = expected_hash
            if article.current_content_hash == content_hash:
                return article, run
            before_version_number = article.current_version_number
            before_content_hash = article.current_content_hash
            manifest = extract_asset_manifest(document)
            await self._validate_asset_manifest(session, article.project_id, manifest)
            next_version = article.current_version_number + 1
            next_review_version = article.review_version + 1
            version = self._build_permanent_version(
                article=article,
                run=run,
                document=document,
                metadata=normalized_metadata,
                markdown=markdown,
                html=html,
                manifest=manifest,
                content_hash=content_hash,
                version_number=next_version,
                review_version=next_review_version,
                version_type="manual_edit",
                created_by=edited_by,
                reason=reason,
            )
            session.add(version)
            await self._replace_current_asset_bindings(session, article.id, manifest)
            self._add_version_asset_bindings(
                session, article.id, next_version, manifest
            )
            article.document_json = document
            article.document_schema_version = CURRENT_SCHEMA_VERSION
            article.current_content_hash = content_hash
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
            article.review_version = next_review_version
            article.review_status = "pending_review"
            article.review_note = None
            article.reviewed_at = None
            article.reviewed_by = None
            article.publication_blocked_reason = "awaiting_review"
            if autosave_id is not None:
                autosave = await session.scalar(
                    select(ArticleAutosave).where(
                        ArticleAutosave.id == autosave_id,
                        ArticleAutosave.article_id == article.id,
                        ArticleAutosave.user_id == edited_by,
                    )
                )
                if autosave is None:
                    raise ValueError("autosave_not_found")
                if autosave.content_hash != content_hash:
                    raise ValueError("autosave_content_mismatch")
                autosave.promoted_version_number = next_version
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article.id,
                action="article.version_saved",
                target_type="article_version",
                target_id=version.id,
                version_number=next_version,
                before_state={
                    "version_number": before_version_number,
                    "content_hash": before_content_hash,
                },
                after_state={
                    "version_number": next_version,
                    "content_hash": content_hash,
                    "review_version": next_review_version,
                },
                reason=reason,
            )
            await session.commit()
            await session.refresh(article)
            return article, run

    async def submit_article_review(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        version_number: int,
        assigned_to: str | None,
        assigned_group: str | None,
        submitted_by: str,
        idempotency_key: str,
        request_hash: str,
        audit: ContentAuditContext,
    ) -> ArticleReviewTask:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            existing = await session.scalar(
                select(ArticleReviewTask).where(
                    ArticleReviewTask.organization_id == organization_id,
                    ArticleReviewTask.project_id == project_id,
                    ArticleReviewTask.submission_idempotency_key == idempotency_key,
                )
            )
            if existing is not None:
                if existing.submission_request_hash != request_hash:
                    raise ValueError("review_submission_idempotency_conflict")
                return existing
            if version_number != article.current_version_number:
                raise ValueError(
                    f"stale_version_number:{article.current_version_number}"
                )
            version = await session.scalar(
                select(ArticleVersion).where(
                    ArticleVersion.article_id == article.id,
                    ArticleVersion.version_number == version_number,
                )
            )
            if version is None or not version.document_snapshot:
                raise LookupError("article_version_not_found")
            active_tasks = list(
                (
                    await session.scalars(
                        select(ArticleReviewTask)
                        .where(
                            ArticleReviewTask.article_id == article.id,
                            ArticleReviewTask.status.in_({"pending", "in_review"}),
                        )
                        .with_for_update()
                    )
                ).all()
            )
            matching = next(
                (task for task in active_tasks if task.version_number == version_number),
                None,
            )
            if matching is not None:
                return matching
            for active in active_tasks:
                before = {"status": active.status}
                active.status = "cancelled"
                self._add_audit_event(
                    session,
                    audit=audit,
                    project_id=project_id,
                    article_id=article.id,
                    action="article.review_cancelled_stale",
                    target_type="article_review_task",
                    target_id=active.id,
                    version_number=active.version_number,
                    before_state=before,
                    after_state={"status": active.status},
                    reason="newer_version_submitted",
                )
            policy = await session.get(ArticleReviewPolicy, project_id)
            policy_version = f"article-review-policy.v{policy.version if policy else 1}"
            task = ArticleReviewTask(
                id=str(uuid4()),
                article_id=article.id,
                version_id=version.id,
                version_number=version.version_number,
                organization_id=organization_id,
                project_id=project_id,
                status="pending",
                assigned_to=assigned_to,
                assigned_group=assigned_group,
                submitted_by=submitted_by,
                policy_version=policy_version,
                submission_idempotency_key=idempotency_key,
                submission_request_hash=request_hash,
            )
            session.add(task)
            article.review_status = "pending_review"
            article.review_note = None
            article.reviewed_at = None
            article.reviewed_by = None
            article.publication_blocked_reason = "awaiting_review"
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article.id,
                action="article.review_submitted",
                target_type="article_review_task",
                target_id=task.id,
                version_number=version.version_number,
                after_state={
                    "status": task.status,
                    "assigned_to": assigned_to,
                    "assigned_group": assigned_group,
                },
                policy_version=policy_version,
            )
            await session.commit()
            await session.refresh(task)
            return task

    async def list_article_review_tasks(
        self,
        organization_id: str,
        project_id: str,
        *,
        article_id: str | None = None,
        statuses: set[str] | None = None,
    ) -> list[ArticleReviewTask]:
        async with self.sessions() as session:
            query = select(ArticleReviewTask).where(
                ArticleReviewTask.organization_id == organization_id,
                ArticleReviewTask.project_id == project_id,
            )
            if article_id is not None:
                query = query.where(ArticleReviewTask.article_id == article_id)
            if statuses:
                query = query.where(ArticleReviewTask.status.in_(statuses))
            return list(
                (
                    await session.scalars(
                        query.order_by(ArticleReviewTask.submitted_at.desc())
                    )
                ).all()
            )

    async def get_article_review_task(
        self,
        organization_id: str,
        project_id: str,
        task_id: str,
    ) -> tuple[ArticleReviewTask, list[ArticleReviewComment]] | None:
        async with self.sessions() as session:
            task = await session.scalar(
                select(ArticleReviewTask).where(
                    ArticleReviewTask.id == task_id,
                    ArticleReviewTask.organization_id == organization_id,
                    ArticleReviewTask.project_id == project_id,
                )
            )
            if task is None:
                return None
            comments = list(
                (
                    await session.scalars(
                        select(ArticleReviewComment)
                        .where(ArticleReviewComment.task_id == task.id)
                        .order_by(ArticleReviewComment.created_at)
                    )
                ).all()
            )
            return task, comments

    async def get_article_review_snapshot(
        self,
        organization_id: str,
        project_id: str,
        task_id: str,
    ) -> tuple[
        ArticleReviewTask,
        list[ArticleReviewComment],
        ArticleVersion,
        ArticleVersion | None,
        Article,
    ] | None:
        async with self.sessions() as session:
            task = await session.scalar(
                select(ArticleReviewTask).where(
                    ArticleReviewTask.id == task_id,
                    ArticleReviewTask.organization_id == organization_id,
                    ArticleReviewTask.project_id == project_id,
                )
            )
            if task is None:
                return None
            article = await session.scalar(
                select(Article).where(
                    Article.id == task.article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            version = await session.scalar(
                select(ArticleVersion).where(
                    ArticleVersion.id == task.version_id,
                    ArticleVersion.article_id == task.article_id,
                )
            )
            if article is None or version is None:
                raise LookupError("article_review_snapshot_not_found")
            prior_approved_number = await session.scalar(
                select(func.max(ArticleReviewTask.version_number)).where(
                    ArticleReviewTask.article_id == task.article_id,
                    ArticleReviewTask.status == "approved",
                    ArticleReviewTask.version_number < task.version_number,
                )
            )
            baseline = None
            if prior_approved_number is not None:
                baseline = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == task.article_id,
                        ArticleVersion.version_number == prior_approved_number,
                    )
                )
            if baseline is None:
                baseline = await session.scalar(
                    select(ArticleVersion)
                    .where(
                        ArticleVersion.article_id == task.article_id,
                        ArticleVersion.version_number < task.version_number,
                        ArticleVersion.document_snapshot.is_not(None),
                    )
                    .order_by(ArticleVersion.version_number.desc())
                    .limit(1)
                )
            comments = list(
                (
                    await session.scalars(
                        select(ArticleReviewComment)
                        .where(ArticleReviewComment.task_id == task.id)
                        .order_by(ArticleReviewComment.created_at)
                    )
                ).all()
            )
            return task, comments, version, baseline, article

    async def claim_article_review_task(
        self,
        organization_id: str,
        project_id: str,
        task_id: str,
        *,
        reviewer_id: str,
        reviewer_groups: set[str],
        audit: ContentAuditContext,
    ) -> ArticleReviewTask:
        async with self.sessions() as session:
            task = await session.scalar(
                select(ArticleReviewTask)
                .where(
                    ArticleReviewTask.id == task_id,
                    ArticleReviewTask.organization_id == organization_id,
                    ArticleReviewTask.project_id == project_id,
                )
                .with_for_update()
            )
            if task is None:
                raise LookupError("article_review_task_not_found")
            if task.status == "in_review" and task.claimed_by == reviewer_id:
                return task
            if task.status != "pending":
                raise ValueError("article_review_task_not_claimable")
            if task.assigned_to and task.assigned_to != reviewer_id:
                raise PermissionError("article_review_task_assigned_to_another_user")
            if task.assigned_group and task.assigned_group not in reviewer_groups:
                raise PermissionError("article_review_task_group_mismatch")
            before = {"status": task.status, "claimed_by": task.claimed_by}
            task.status = "in_review"
            task.claimed_by = reviewer_id
            task.claimed_at = datetime.now(UTC)
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=task.article_id,
                action="article.review_claimed",
                target_type="article_review_task",
                target_id=task.id,
                version_number=task.version_number,
                before_state=before,
                after_state={"status": task.status, "claimed_by": reviewer_id},
                policy_version=task.policy_version,
            )
            await session.commit()
            await session.refresh(task)
            return task

    async def add_article_review_comment(
        self,
        organization_id: str,
        project_id: str,
        task_id: str,
        *,
        author_id: str,
        body: str,
        node_id: str | None,
        position: dict[str, Any] | None,
        audit: ContentAuditContext,
    ) -> ArticleReviewComment:
        async with self.sessions() as session:
            task = await session.scalar(
                select(ArticleReviewTask).where(
                    ArticleReviewTask.id == task_id,
                    ArticleReviewTask.organization_id == organization_id,
                    ArticleReviewTask.project_id == project_id,
                )
            )
            if task is None:
                raise LookupError("article_review_task_not_found")
            if task.status not in {"pending", "in_review"}:
                raise ValueError("article_review_task_terminal")
            comment = ArticleReviewComment(
                id=str(uuid4()),
                task_id=task.id,
                author_id=author_id,
                body=body,
                node_id=node_id,
                position_json=position,
            )
            session.add(comment)
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=task.article_id,
                action="article.review_commented",
                target_type="article_review_comment",
                target_id=comment.id,
                version_number=task.version_number,
                after_state={"task_id": task.id, "node_id": node_id},
                policy_version=task.policy_version,
            )
            await session.commit()
            await session.refresh(comment)
            return comment

    async def decide_article_review_task(
        self,
        organization_id: str,
        project_id: str,
        task_id: str,
        *,
        reviewer_id: str,
        decision: str,
        comment: str | None,
        idempotency_key: str,
        request_hash: str,
        audit: ContentAuditContext,
    ) -> tuple[ArticleReviewTask, Article]:
        from app.modules.content_plan.models import ContentPlanSettings
        from app.modules.content_plan.scheduling import publication_blocked_reason

        async with self.sessions() as session:
            task = await session.scalar(
                select(ArticleReviewTask)
                .where(
                    ArticleReviewTask.id == task_id,
                    ArticleReviewTask.organization_id == organization_id,
                    ArticleReviewTask.project_id == project_id,
                )
                .with_for_update()
            )
            if task is None:
                raise LookupError("article_review_task_not_found")
            if task.decision_idempotency_key is not None:
                if (
                    task.decision_idempotency_key == idempotency_key
                    and task.decision_request_hash == request_hash
                    and task.status == decision
                ):
                    article = await session.get(Article, task.article_id)
                    if article is None:
                        raise LookupError("article_not_found")
                    return task, article
                raise ValueError("review_decision_idempotency_conflict")
            if task.status != "in_review" or task.claimed_by != reviewer_id:
                raise ValueError("article_review_task_not_decidable")
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == task.article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            policy = await session.get(ArticleReviewPolicy, project_id)
            allow_self_review = bool(policy.allow_self_review) if policy else False
            policy_version = f"article-review-policy.v{policy.version if policy else 1}"
            if task.submitted_by == reviewer_id and not allow_self_review:
                raise PermissionError("article_self_review_forbidden")
            version = await session.scalar(
                select(ArticleVersion).where(ArticleVersion.id == task.version_id)
            )
            if version is None:
                raise LookupError("article_version_not_found")
            if decision == "approved":
                await self._validate_version_asset_manifest(session, project_id, version)
            now = datetime.now(UTC)
            before = {"status": task.status, "review_status": article.review_status}
            task.status = decision
            task.decided_by = reviewer_id
            task.decided_at = now
            task.decision_comment = comment
            task.decision_idempotency_key = idempotency_key
            task.decision_request_hash = request_hash
            task.policy_version = policy_version
            article.review_status = (
                "approved" if decision == "approved" else "changes_requested"
            )
            article.review_note = comment
            article.reviewed_at = now
            article.reviewed_by = reviewer_id
            if decision == "approved":
                article.approved_version_number = task.version_number
            else:
                article.approved_version_number = None
            settings = await session.get(ContentPlanSettings, project_id)
            article.publication_blocked_reason = publication_blocked_reason(
                review_status=article.review_status,
                publication_status=article.publication_status,
                paused=bool(settings.paused) if settings else False,
            )
            session.add(
                ArticleReviewDecision(
                    article_id=article.id,
                    article_run_id=article.current_run_id,
                    review_version=version.review_version or article.review_version,
                    decision=(
                        "approved" if decision == "approved" else "changes_requested"
                    ),
                    review_note=comment,
                    reviewed_by=reviewer_id,
                    reviewed_at=now,
                )
            )
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article.id,
                action=(
                    "article.review_approved"
                    if decision == "approved"
                    else "article.review_changes_requested"
                ),
                target_type="article_review_task",
                target_id=task.id,
                version_number=task.version_number,
                before_state=before,
                after_state={
                    "status": task.status,
                    "review_status": article.review_status,
                    "approved_version_number": article.approved_version_number,
                    "self_review": task.submitted_by == reviewer_id,
                },
                reason=comment,
                policy_version=policy_version,
            )
            await session.commit()
            await session.refresh(task)
            await session.refresh(article)
            return task, article

    async def cancel_article_review_task(
        self,
        organization_id: str,
        project_id: str,
        task_id: str,
        *,
        cancelled_by: str,
        can_review: bool,
        reason: str,
        audit: ContentAuditContext,
    ) -> ArticleReviewTask:
        async with self.sessions() as session:
            task = await session.scalar(
                select(ArticleReviewTask)
                .where(
                    ArticleReviewTask.id == task_id,
                    ArticleReviewTask.organization_id == organization_id,
                    ArticleReviewTask.project_id == project_id,
                )
                .with_for_update()
            )
            if task is None:
                raise LookupError("article_review_task_not_found")
            if task.status == "cancelled":
                return task
            if task.status not in {"pending", "in_review"}:
                raise ValueError("article_review_task_terminal")
            if task.submitted_by != cancelled_by and not can_review:
                raise PermissionError("article_review_task_cancel_forbidden")
            before = {"status": task.status}
            task.status = "cancelled"
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=task.article_id,
                action="article.review_cancelled",
                target_type="article_review_task",
                target_id=task.id,
                version_number=task.version_number,
                before_state=before,
                after_state={"status": task.status},
                reason=reason,
                policy_version=task.policy_version,
            )
            await session.commit()
            await session.refresh(task)
            return task

    async def acquire_article_lock(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        lock_type: str,
        version_number: int | None,
        owner_id: str,
        reason: str,
        lease_seconds: int,
        audit: ContentAuditContext,
    ) -> tuple[ArticleLock, str]:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            now = datetime.now(UTC)
            active = await session.scalar(
                select(ArticleLock)
                .where(
                    ArticleLock.article_id == article.id,
                    ArticleLock.lock_type == lock_type,
                    ArticleLock.released_at.is_(None),
                )
                .with_for_update()
            )
            if active is not None and active.expires_at > now:
                raise ArticleLockConflictError("article_lock_already_held")
            if active is not None:
                active.released_at = now
                active.released_by = owner_id
                active.release_reason = "expired_takeover"
            fence = int(
                await session.scalar(
                    select(func.coalesce(func.max(ArticleLock.fence), 0)).where(
                        ArticleLock.article_id == article.id,
                        ArticleLock.lock_type == lock_type,
                    )
                )
                or 0
            ) + 1
            token = token_urlsafe(48)
            lock = ArticleLock(
                id=str(uuid4()),
                article_id=article.id,
                organization_id=organization_id,
                project_id=project_id,
                lock_type=lock_type,
                version_number=version_number,
                owner_id=owner_id,
                reason=reason,
                token_hash=sha256(token.encode("utf-8")).hexdigest(),
                fence=fence,
                acquired_at=now,
                renewed_at=now,
                expires_at=now + timedelta(seconds=lease_seconds),
            )
            session.add(lock)
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article.id,
                action="article.lock_acquired",
                target_type="article_lock",
                target_id=lock.id,
                version_number=version_number,
                after_state={
                    "lock_type": lock_type,
                    "owner_id": owner_id,
                    "fence": fence,
                    "expires_at": lock.expires_at.isoformat(),
                },
                reason=reason,
            )
            await session.commit()
            await session.refresh(lock)
            return lock, token

    async def get_active_article_lock(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        lock_type: str = "edit_lock",
    ) -> ArticleLock | None:
        async with self.sessions() as session:
            article_exists = await session.scalar(
                select(Article.id).where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if article_exists is None:
                raise LookupError("article_not_found")
            return await session.scalar(
                select(ArticleLock).where(
                    ArticleLock.article_id == article_id,
                    ArticleLock.lock_type == lock_type,
                    ArticleLock.released_at.is_(None),
                    ArticleLock.expires_at > datetime.now(UTC),
                )
            )

    async def renew_article_lock(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        lock_id: str,
        *,
        owner_id: str,
        lock_type: str,
        token: str,
        fence: int,
        lease_seconds: int,
        audit: ContentAuditContext,
    ) -> ArticleLock:
        async with self.sessions() as session:
            lock = await session.scalar(
                select(ArticleLock)
                .where(
                    ArticleLock.id == lock_id,
                    ArticleLock.article_id == article_id,
                    ArticleLock.organization_id == organization_id,
                    ArticleLock.project_id == project_id,
                )
                .with_for_update()
            )
            if lock is None:
                raise LookupError("article_lock_not_found")
            if lock.lock_type != lock_type:
                raise ArticleLockConflictError("article_lock_type_mismatch")
            now = datetime.now(UTC)
            token_hash = sha256(token.encode("utf-8")).hexdigest()
            if lock.released_at is not None or lock.expires_at <= now:
                raise ArticleLockConflictError("article_lock_expired")
            if (
                lock.owner_id != owner_id
                or lock.fence != fence
                or not hmac.compare_digest(lock.token_hash, token_hash)
            ):
                raise ArticleLockConflictError("article_lock_stale_fence")
            before_expiry = lock.expires_at
            lock.renewed_at = now
            lock.expires_at = now + timedelta(seconds=lease_seconds)
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article_id,
                action="article.lock_renewed",
                target_type="article_lock",
                target_id=lock.id,
                version_number=lock.version_number,
                before_state={"expires_at": before_expiry.isoformat()},
                after_state={"expires_at": lock.expires_at.isoformat(), "fence": fence},
            )
            await session.commit()
            await session.refresh(lock)
            return lock

    async def release_article_lock(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        lock_id: str,
        *,
        owner_id: str,
        lock_type: str,
        token: str,
        fence: int,
        reason: str,
        audit: ContentAuditContext,
    ) -> ArticleLock:
        async with self.sessions() as session:
            lock = await session.scalar(
                select(ArticleLock)
                .where(
                    ArticleLock.id == lock_id,
                    ArticleLock.article_id == article_id,
                    ArticleLock.organization_id == organization_id,
                    ArticleLock.project_id == project_id,
                )
                .with_for_update()
            )
            if lock is None:
                raise LookupError("article_lock_not_found")
            if lock.lock_type != lock_type:
                raise ArticleLockConflictError("article_lock_type_mismatch")
            if lock.released_at is not None:
                return lock
            token_hash = sha256(token.encode("utf-8")).hexdigest()
            if (
                lock.owner_id != owner_id
                or lock.fence != fence
                or not hmac.compare_digest(lock.token_hash, token_hash)
            ):
                raise ArticleLockConflictError("article_lock_stale_fence")
            lock.released_at = datetime.now(UTC)
            lock.released_by = owner_id
            lock.release_reason = reason
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article_id,
                action="article.lock_released",
                target_type="article_lock",
                target_id=lock.id,
                version_number=lock.version_number,
                after_state={"released_by": owner_id, "fence": fence},
                reason=reason,
            )
            await session.commit()
            await session.refresh(lock)
            return lock

    async def force_release_article_lock(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        lock_id: str,
        *,
        released_by: str,
        reason: str,
        audit: ContentAuditContext,
    ) -> ArticleLock:
        async with self.sessions() as session:
            lock = await session.scalar(
                select(ArticleLock)
                .where(
                    ArticleLock.id == lock_id,
                    ArticleLock.article_id == article_id,
                    ArticleLock.organization_id == organization_id,
                    ArticleLock.project_id == project_id,
                )
                .with_for_update()
            )
            if lock is None:
                raise LookupError("article_lock_not_found")
            if lock.released_at is None:
                lock.released_at = datetime.now(UTC)
                lock.released_by = released_by
                lock.release_reason = reason
                self._add_audit_event(
                    session,
                    audit=audit,
                    project_id=project_id,
                    article_id=article_id,
                    action="article.lock_force_released",
                    target_type="article_lock",
                    target_id=lock.id,
                    version_number=lock.version_number,
                    before_state={"owner_id": lock.owner_id, "fence": lock.fence},
                    after_state={"released_by": released_by},
                    reason=reason,
                )
            await session.commit()
            await session.refresh(lock)
            return lock

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
        now = datetime.now(UTC)
        request_hash = autosave_request_hash(
            client_id=client_id,
            sequence=sequence,
            base_version_number=base_version_number,
            base_review_version=base_review_version,
            document=document,
            metadata=metadata,
            content_hash=content_hash,
        )
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            await self._require_edit_lock(
                session,
                article_id=article.id,
                owner_id=user_id,
                token=lock_token,
                fence=lock_fence,
            )
            normalized_metadata = article_metadata_snapshot(article, metadata)
            if advanced_seo_changed(article, normalized_metadata) and not can_manage_seo_advanced:
                raise PermissionError("content:manage_seo_advanced")
            metadata = normalized_metadata
            existing = await session.scalar(
                select(ArticleAutosave).where(
                    ArticleAutosave.article_id == article.id,
                    ArticleAutosave.user_id == user_id,
                    ArticleAutosave.idempotency_key == idempotency_key,
                )
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
                    "version_conflict:"
                    f"{article.review_version}:{article.current_version_number}"
                )
            latest_sequence = await session.scalar(
                select(func.max(ArticleAutosave.sequence)).where(
                    ArticleAutosave.article_id == article.id,
                    ArticleAutosave.user_id == user_id,
                    ArticleAutosave.client_id == client_id,
                )
            )
            if latest_sequence is not None and sequence <= int(latest_sequence):
                raise ValueError(f"autosave_stale:{int(latest_sequence)}")
            expected_hash = document_content_hash(document, metadata)
            if content_hash != expected_hash:
                raise ValueError("article_content_hash_mismatch")
            manifest = extract_asset_manifest(document)
            await self._validate_asset_manifest(session, project_id, manifest)
            autosave = ArticleAutosave(
                id=str(uuid4()),
                article_id=article.id,
                user_id=user_id,
                client_id=client_id,
                sequence=sequence,
                base_version_number=base_version_number,
                base_review_version=base_review_version,
                schema_version=CURRENT_SCHEMA_VERSION,
                document_snapshot=document,
                metadata_snapshot=metadata,
                content_hash=content_hash,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                created_at=now,
                expires_at=now + timedelta(days=AUTOSAVE_TTL_DAYS),
            )
            session.add(autosave)
            await session.flush()
            stale_ids = list(
                await session.scalars(
                    select(ArticleAutosave.id)
                    .where(
                        ArticleAutosave.article_id == article.id,
                        ArticleAutosave.user_id == user_id,
                        ArticleAutosave.client_id == client_id,
                    )
                    .order_by(
                        ArticleAutosave.sequence.desc(),
                        ArticleAutosave.created_at.desc(),
                    )
                    .offset(AUTOSAVE_KEEP_PER_CLIENT)
                )
            )
            if stale_ids:
                await session.execute(
                    delete(ArticleAutosave).where(ArticleAutosave.id.in_(stale_ids))
                )
            await session.commit()
            await session.refresh(autosave)
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
        async with self.sessions() as session:
            article_exists = await session.scalar(
                select(Article.id).where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if article_exists is None:
                raise LookupError("article_not_found")
            conditions = [
                ArticleAutosave.article_id == article_id,
                ArticleAutosave.user_id == user_id,
                ArticleAutosave.expires_at > datetime.now(UTC),
            ]
            if client_id is not None:
                conditions.append(ArticleAutosave.client_id == client_id)
            return await session.scalar(
                select(ArticleAutosave)
                .where(*conditions)
                .order_by(ArticleAutosave.created_at.desc(), ArticleAutosave.sequence.desc())
                .limit(1)
            )

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
        audit: ContentAuditContext | None = None,
    ) -> tuple[Article, ArticleRun]:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            await self._require_edit_lock(
                session,
                article_id=article.id,
                owner_id=user_id,
                token=lock_token,
                fence=lock_fence,
            )
            run = await session.get(ArticleRun, article.current_run_id) if article.current_run_id else None
            if run is None or run.status not in {"completed", "completed_with_warnings"}:
                raise ValueError("article_not_editable")
            autosave = await session.scalar(
                select(ArticleAutosave).where(
                    ArticleAutosave.id == autosave_id,
                    ArticleAutosave.article_id == article.id,
                    ArticleAutosave.user_id == user_id,
                )
            )
            if autosave is None:
                raise LookupError("autosave_not_found")
            if autosave.expires_at <= datetime.now(UTC):
                raise ValueError("autosave_expired")
            if autosave.promoted_version_number is not None:
                return article, run
            if (
                article.current_version_number != base_version_number
                or article.review_version != base_review_version
                or autosave.base_version_number != base_version_number
                or autosave.base_review_version != base_review_version
            ):
                raise ValueError(
                    "version_conflict:"
                    f"{article.review_version}:{article.current_version_number}"
                )
            document = normalize_document(autosave.document_snapshot)
            metadata = article_metadata_snapshot(
                article, dict(autosave.metadata_snapshot or {})
            )
            if advanced_seo_changed(article, metadata) and not can_manage_seo_advanced:
                raise PermissionError("content:manage_seo_advanced")
            content_hash = document_content_hash(document, metadata)
            if content_hash != autosave.content_hash:
                raise ValueError("autosave_content_mismatch")
            if article.current_content_hash == content_hash:
                autosave.promoted_version_number = article.current_version_number
                await session.commit()
                return article, run
            markdown = document_to_markdown(document)
            html = document_to_html(document)
            manifest = extract_asset_manifest(document)
            await self._validate_asset_manifest(session, project_id, manifest)
            next_version = article.current_version_number + 1
            next_review = article.review_version + 1
            session.add(
                self._build_permanent_version(
                    article=article,
                    run=run,
                    document=document,
                    metadata=metadata,
                    markdown=markdown,
                    html=html,
                    manifest=manifest,
                    content_hash=content_hash,
                    version_number=next_version,
                    review_version=next_review,
                    version_type="manual_edit",
                    created_by=user_id,
                    reason=reason or "promoted_autosave",
                )
            )
            await self._replace_current_asset_bindings(session, article.id, manifest)
            self._add_version_asset_bindings(session, article.id, next_version, manifest)
            self._apply_article_snapshot(
                article, document, metadata, markdown, html, content_hash, next_version, next_review
            )
            autosave.promoted_version_number = next_version
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article.id,
                action="article.autosave_promoted",
                target_type="article_version",
                target_id=autosave.id,
                version_number=next_version,
                before_state={"autosave_id": autosave.id},
                after_state={
                    "version_number": next_version,
                    "review_version": next_review,
                },
                reason=reason or "promoted_autosave",
            )
            await session.commit()
            await session.refresh(article)
            return article, run

    async def delete_article_autosave(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        autosave_id: str,
        *,
        user_id: str,
    ) -> None:
        async with self.sessions() as session:
            autosave = await session.scalar(
                select(ArticleAutosave)
                .join(Article, Article.id == ArticleAutosave.article_id)
                .where(
                    ArticleAutosave.id == autosave_id,
                    ArticleAutosave.article_id == article_id,
                    ArticleAutosave.user_id == user_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if autosave is None:
                raise LookupError("autosave_not_found")
            await session.delete(autosave)
            await session.commit()

    @staticmethod
    def _build_permanent_version(
        *,
        article: Article,
        run: ArticleRun,
        document: dict[str, Any],
        metadata: dict[str, Any],
        markdown: str,
        html: str,
        manifest: list[dict[str, Any]],
        content_hash: str,
        version_number: int,
        review_version: int,
        version_type: str,
        created_by: str,
        reason: str | None,
        source_version_number: int | None = None,
        restored_from_version_id: str | None = None,
        retention_protected: bool = False,
    ) -> ArticleVersion:
        return ArticleVersion(
            id=str(uuid4()),
            article_id=article.id,
            run_id=run.id,
            version_number=version_number,
            version_type=version_type,
            review_version=review_version,
            outline_json=dict(article.outline_json or {}),
            quality_json={},
            content_json={
                **metadata,
                "document": document,
                "markdown": markdown,
                "html": html,
            },
            schema_version=CURRENT_SCHEMA_VERSION,
            document_snapshot=document,
            metadata_snapshot=metadata,
            asset_manifest=manifest,
            content_hash=content_hash,
            parent_version_number=article.current_version_number or None,
            source_version_number=source_version_number,
            reason=reason,
            retention_protected=retention_protected,
            created_by=created_by,
            restored_from_version_id=restored_from_version_id,
        )

    @staticmethod
    def _apply_article_snapshot(
        article: Article,
        document: dict[str, Any],
        metadata: dict[str, Any],
        markdown: str,
        html: str,
        content_hash: str,
        version_number: int,
        review_version: int,
    ) -> None:
        metadata = article_metadata_snapshot(article, metadata)
        article.document_json = document
        article.document_schema_version = CURRENT_SCHEMA_VERSION
        article.current_content_hash = content_hash
        article.current_version_number = version_number
        article.markdown = markdown
        article.html = html
        article.title = metadata["title"]
        article.slug = metadata["slug"]
        article.meta_title = metadata["meta_title"]
        article.meta_description = metadata["meta_description"]
        article.focus_keyword = metadata["focus_keyword"]
        article.secondary_keywords_json = metadata["secondary_keywords"]
        article.canonical_url = metadata["canonical_url"]
        article.indexing = metadata["indexing"]
        article.seo_field_states_json = metadata["field_states"]
        article.publication_status = metadata["publication_status"]
        article.review_version = review_version
        article.review_status = "pending_review"
        article.review_note = None
        article.reviewed_at = None
        article.reviewed_by = None
        article.publication_blocked_reason = "awaiting_review"

    @staticmethod
    async def _validate_asset_manifest(
        session: AsyncSession,
        project_id: str,
        manifest: list[dict[str, Any]],
    ) -> None:
        if not manifest:
            return
        asset_ids = {str(item["asset_id"]) for item in manifest}
        assets = {
            asset.id: asset
            for asset in await session.scalars(
                select(ContentAsset)
                .where(ContentAsset.id.in_(asset_ids))
                .with_for_update()
            )
        }
        if set(assets) != asset_ids:
            raise ValueError("asset_not_found")
        expected_types = {
            "image": "image",
            "gallery_item": "image",
            "thumbnail": "image",
            "poster": "image",
            "video": "video",
            "audio": "audio",
            "file": "file",
        }
        for item in manifest:
            asset = assets[str(item["asset_id"])]
            if asset.project_id != project_id:
                raise ValueError("asset_cross_project")
            if asset.status != "ready":
                raise ValueError("asset_not_ready")
            if asset.asset_type != expected_types[item["binding_role"]]:
                raise ValueError("asset_type_mismatch")

    @staticmethod
    async def _get_action_version(
        session: AsyncSession,
        article: Article,
        *,
        version_number: int | None,
        expected_review_version: int | None,
        missing_code: str,
    ) -> ArticleVersion:
        if version_number is None or version_number <= 0:
            raise ValueError(missing_code)
        version = await session.scalar(
            select(ArticleVersion)
            .where(
                ArticleVersion.article_id == article.id,
                ArticleVersion.version_number == version_number,
            )
            .with_for_update()
        )
        if version is None:
            raise ValueError(missing_code)
        if (
            expected_review_version is not None
            and version.review_version != expected_review_version
        ):
            raise ValueError("stale_review_version")
        return version

    @classmethod
    async def _validate_version_asset_manifest(
        cls,
        session: AsyncSession,
        project_id: str,
        version: ArticleVersion,
    ) -> None:
        manifest = extract_asset_manifest(version.document_snapshot)
        if manifest != list(version.asset_manifest or []):
            raise ValueError("asset_manifest_mismatch")
        await cls._validate_asset_manifest(session, project_id, manifest)

    @staticmethod
    async def _replace_current_asset_bindings(
        session: AsyncSession,
        article_id: str,
        manifest: list[dict[str, Any]],
    ) -> None:
        now = datetime.now(UTC)
        active = list(
            await session.scalars(
                select(ArticleAssetBinding).where(
                    ArticleAssetBinding.article_id == article_id,
                    ArticleAssetBinding.version_number.is_(None),
                    ArticleAssetBinding.removed_at.is_(None),
                )
            )
        )
        desired = {
            (
                str(item["node_id"]),
                item.get("item_id"),
                str(item["asset_id"]),
                str(item["binding_role"]),
            )
            for item in manifest
        }
        existing = {
            (row.node_id, row.item_id, row.asset_id, row.binding_role): row
            for row in active
        }
        for key, row in existing.items():
            if key not in desired:
                row.removed_at = now
        for node_id, item_id, asset_id, binding_role in desired - set(existing):
            session.add(
                ArticleAssetBinding(
                    id=str(uuid4()),
                    article_id=article_id,
                    version_number=None,
                    node_id=node_id,
                    item_id=item_id,
                    asset_id=asset_id,
                    binding_role=binding_role,
                )
            )

    @staticmethod
    def _add_version_asset_bindings(
        session: AsyncSession,
        article_id: str,
        version_number: int,
        manifest: list[dict[str, Any]],
    ) -> None:
        for item in manifest:
            session.add(
                ArticleAssetBinding(
                    id=str(uuid4()),
                    article_id=article_id,
                    version_number=version_number,
                    node_id=str(item["node_id"]),
                    item_id=item.get("item_id"),
                    asset_id=str(item["asset_id"]),
                    binding_role=str(item["binding_role"]),
                )
            )

    async def list_article_versions(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
    ) -> list[ArticleVersion]:
        async with self.sessions() as session:
            article_exists = await session.scalar(
                select(Article.id).where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if article_exists is None:
                raise LookupError("article_not_found")
            return list(
                (
                    await session.scalars(
                        select(ArticleVersion)
                        .where(ArticleVersion.article_id == article_id)
                        .order_by(ArticleVersion.version_number.desc())
                    )
                ).all()
            )

    async def get_article_version(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        version_number: int,
    ) -> ArticleVersion | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ArticleVersion)
                .join(Article, Article.id == ArticleVersion.article_id)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                    ArticleVersion.version_number == version_number,
                )
            )

    async def compare_article_versions(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        from_version_number: int,
        to_version_number: int,
    ) -> tuple[ArticleVersion, ArticleVersion, dict[str, Any]]:
        async with self.sessions() as session:
            article_exists = await session.scalar(
                select(Article.id).where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if article_exists is None:
                raise LookupError("article_not_found")
            rows = list(
                (
                    await session.scalars(
                        select(ArticleVersion).where(
                            ArticleVersion.article_id == article_id,
                            ArticleVersion.version_number.in_(
                                {from_version_number, to_version_number}
                            ),
                        )
                    )
                ).all()
            )
            versions = {row.version_number: row for row in rows}
            before = versions.get(from_version_number)
            after = versions.get(to_version_number)
            if before is None or after is None:
                raise LookupError("article_version_not_found")
            cached = await session.scalar(
                select(ArticleVersionDiffCache).where(
                    ArticleVersionDiffCache.article_id == article_id,
                    ArticleVersionDiffCache.from_version_number
                    == from_version_number,
                    ArticleVersionDiffCache.to_version_number == to_version_number,
                    ArticleVersionDiffCache.algorithm_version
                    == ARTICLE_DIFF_ALGORITHM_VERSION,
                )
            )
            if (
                cached is not None
                and cached.from_content_hash == before.content_hash
                and cached.to_content_hash == after.content_hash
            ):
                return before, after, dict(cached.result_json or {})

            before_content = dict(before.content_json or {})
            after_content = dict(after.content_json or {})
            result = build_article_diff(
                before.document_snapshot or before_content.get("document") or {},
                after.document_snapshot or after_content.get("document") or {},
                before.metadata_snapshot or before_content,
                after.metadata_snapshot or after_content,
            )
            if cached is None:
                cached = ArticleVersionDiffCache(
                    id=str(uuid4()),
                    article_id=article_id,
                    from_version_number=from_version_number,
                    to_version_number=to_version_number,
                    from_content_hash=before.content_hash,
                    to_content_hash=after.content_hash,
                    algorithm_version=ARTICLE_DIFF_ALGORITHM_VERSION,
                    result_json=result,
                )
                session.add(cached)
            else:
                cached.from_content_hash = before.content_hash
                cached.to_content_hash = after.content_hash
                cached.result_json = result
            await session.commit()
            return before, after, result

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
        audit: ContentAuditContext | None = None,
    ) -> tuple[Article, ArticleRun, ArticleVersion]:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")
            await self._require_edit_lock(
                session,
                article_id=article.id,
                owner_id=restored_by,
                token=lock_token,
                fence=lock_fence,
            )
            run = (
                await session.get(ArticleRun, article.current_run_id)
                if article.current_run_id
                else None
            )
            if run is None or run.status not in {
                "completed",
                "completed_with_warnings",
            }:
                raise ValueError("article_not_editable")
            if article.review_version != expected_version:
                raise ValueError(f"stale_review_version:{article.review_version}")
            source = await session.scalar(
                select(ArticleVersion).where(
                    ArticleVersion.article_id == article.id,
                    ArticleVersion.version_number == version_number,
                )
            )
            if source is None:
                raise LookupError("article_version_not_found")
            snapshot = dict(source.content_json or {})
            source_document = source.document_snapshot or snapshot.get("document")
            if not (
                isinstance(source_document, dict)
                and source_document.get("type") == "doc"
                and isinstance(source_document.get("content"), list)
            ):
                raise ValueError("article_version_not_restorable")
            document = normalize_document(source_document)
            markdown = document_to_markdown(document)
            html = document_to_html(document)
            next_version_number = int(
                await session.scalar(
                    select(func.coalesce(func.max(ArticleVersion.version_number), 0)).where(
                        ArticleVersion.article_id == article.id
                    )
                )
                or 0
            ) + 1
            next_review_version = article.review_version + 1
            source_metadata = dict(source.metadata_snapshot or {})
            metadata = article_metadata_snapshot(
                article,
                {
                    "title": source_metadata.get("title", snapshot.get("title")),
                    "slug": source_metadata.get("slug", snapshot.get("slug")),
                    "meta_title": source_metadata.get(
                        "meta_title", snapshot.get("meta_title")
                    ),
                    "meta_description": source_metadata.get(
                        "meta_description", snapshot.get("meta_description")
                    ),
                    "focus_keyword": source_metadata.get(
                        "focus_keyword", snapshot.get("focus_keyword")
                    ),
                    "secondary_keywords": source_metadata.get(
                        "secondary_keywords", snapshot.get("secondary_keywords")
                    ),
                    "canonical_url": source_metadata.get(
                        "canonical_url", snapshot.get("canonical_url")
                    ),
                    "indexing": source_metadata.get("indexing", snapshot.get("indexing")),
                    "field_states": source_metadata.get(
                        "field_states", snapshot.get("field_states")
                    ),
                    "publication_status": source_metadata.get(
                        "publication_status", snapshot.get("publication_status")
                    ),
                },
            )
            if advanced_seo_changed(article, metadata) and not can_manage_seo_advanced:
                raise PermissionError("content:manage_seo_advanced")
            manifest = extract_asset_manifest(document)
            await self._validate_asset_manifest(session, article.project_id, manifest)
            content_hash = document_content_hash(document, metadata)
            restored = self._build_permanent_version(
                article=article,
                run=run,
                document=document,
                metadata=metadata,
                markdown=markdown,
                html=html,
                manifest=manifest,
                content_hash=content_hash,
                version_number=next_version_number,
                review_version=next_review_version,
                version_type="restored",
                created_by=restored_by,
                reason="restored_version",
                source_version_number=source.version_number,
                restored_from_version_id=source.id,
                retention_protected=True,
            )
            restored.outline_json = dict(source.outline_json or {})
            restored.quality_json = dict(source.quality_json or {})
            session.add(restored)
            before_version_number = article.current_version_number
            article.outline_json = dict(source.outline_json or {})
            await self._replace_current_asset_bindings(session, article.id, manifest)
            self._add_version_asset_bindings(
                session, article.id, next_version_number, manifest
            )
            self._apply_article_snapshot(
                article,
                document,
                metadata,
                markdown,
                html,
                content_hash,
                next_version_number,
                next_review_version,
            )
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article.id,
                action="article.version_restored",
                target_type="article_version",
                target_id=restored.id,
                version_number=next_version_number,
                before_state={"version_number": before_version_number},
                after_state={
                    "version_number": next_version_number,
                    "restored_from_version_number": source.version_number,
                    "review_version": next_review_version,
                },
                reason="restored_version",
            )
            await session.commit()
            await session.refresh(article)
            await session.refresh(restored)
            return article, run, restored

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
        from app.modules.content_plan.models import ContentPlanSettings

        try:
            async with self.sessions() as session:
                article = await session.scalar(
                    select(Article)
                    .where(
                        Article.id == article_id,
                        Article.organization_id == organization_id,
                        Article.project_id == project_id,
                    )
                    .with_for_update()
                )
                if article is None:
                    raise LookupError("article_not_found")
                if article.approved_version_number != approved_version_number:
                    raise ValueError(
                        f"approved_version_mismatch:{article.approved_version_number or 0}"
                    )
                approved_version = await self._get_action_version(
                    session,
                    article,
                    version_number=approved_version_number,
                    expected_review_version=None,
                    missing_code="approved_version_not_found",
                )
                snapshot = {
                    **dict(approved_version.content_json or {}),
                    **dict(approved_version.metadata_snapshot or {}),
                }
                if snapshot.get("publication_status") != "publish_ready":
                    raise ValueError("quality_not_ready")
                settings = await session.get(ContentPlanSettings, project_id)
                if settings is not None and settings.paused:
                    raise ValueError("publishing_paused")
                approval_task = await session.scalar(
                    select(ArticleReviewTask.id).where(
                        ArticleReviewTask.article_id == article.id,
                        ArticleReviewTask.version_number == approved_version_number,
                        ArticleReviewTask.status == "approved",
                    )
                )
                legacy_approval = None
                if approval_task is None and approved_version.review_version is not None:
                    legacy_approval = await session.scalar(
                        select(ArticleReviewDecision.id).where(
                            ArticleReviewDecision.article_id == article.id,
                            ArticleReviewDecision.review_version
                            == approved_version.review_version,
                            ArticleReviewDecision.decision == "approved",
                        )
                    )
                if approval_task is None and legacy_approval is None:
                    raise ValueError("approved_version_not_reviewed")
                run = await session.get(ArticleRun, approved_version.run_id)
                if run is None or run.status not in {
                    "completed",
                    "completed_with_warnings",
                }:
                    raise ValueError("article_not_publishable")
                await self._validate_version_asset_manifest(
                    session, article.project_id, approved_version
                )
                existing = await self._publication_idempotent_result(
                    session,
                    organization_id,
                    project_id,
                    idempotency_key,
                    request_hash,
                )
                if existing is not None:
                    return article, run, approved_version, existing, False
                blocked = await session.scalar(
                    select(ArticlePublication)
                    .where(
                        ArticlePublication.article_id == article.id,
                        ArticlePublication.status.in_({"submitting", "uncertain"}),
                    )
                    .order_by(ArticlePublication.created_at.desc())
                    .limit(1)
                )
                if blocked is not None:
                    raise ValueError(f"article_publication_{blocked.status}")
                previous = await session.scalar(
                    select(ArticlePublication)
                    .where(
                        ArticlePublication.article_id == article.id,
                        ArticlePublication.status == "published",
                    )
                    .order_by(ArticlePublication.created_at.desc())
                    .limit(1)
                )
                attempt = int(
                    await session.scalar(
                        select(
                            func.coalesce(func.max(ArticlePublication.attempt), 0)
                        ).where(ArticlePublication.article_id == article.id)
                    )
                    or 0
                ) + 1
                publication = ArticlePublication(
                    id=str(uuid4()),
                    article_id=article.id,
                    organization_id=organization_id,
                    project_id=project_id,
                    idempotency_key=idempotency_key,
                    request_hash=request_hash,
                    status="submitting",
                    attempt=attempt,
                    wordpress_post_id=previous.wordpress_post_id if previous else None,
                    wordpress_url=previous.wordpress_url if previous else None,
                    request_summary_json={
                        "approved_version_number": approved_version_number,
                        "operation": "update" if previous else "create",
                    },
                )
                session.add(publication)
                await session.commit()
                await session.refresh(publication)
                return article, run, approved_version, publication, True
        except IntegrityError:
            async with self.sessions() as session:
                existing = await self._publication_idempotent_result(
                    session,
                    organization_id,
                    project_id,
                    idempotency_key,
                    request_hash,
                )
                if existing is not None:
                    article = await session.get(Article, existing.article_id)
                    run = (
                        await session.get(ArticleRun, article.current_run_id)
                        if article is not None and article.current_run_id
                        else None
                    )
                    if article is None or run is None:
                        raise ValueError("article_publication_integrity_error")
                    approved_version = await self._get_action_version(
                        session,
                        article,
                        version_number=article.approved_version_number,
                        expected_review_version=None,
                        missing_code="approved_version_not_found",
                    )
                    run = await session.get(ArticleRun, approved_version.run_id)
                    if run is None:
                        raise ValueError("article_publication_integrity_error")
                    return article, run, approved_version, existing, False
                blocked = await session.scalar(
                    select(ArticlePublication)
                    .where(
                        ArticlePublication.article_id == article_id,
                        ArticlePublication.status.in_({"submitting", "uncertain"}),
                    )
                    .order_by(ArticlePublication.created_at.desc())
                    .limit(1)
                )
                if blocked is not None:
                    raise ValueError(f"article_publication_{blocked.status}")
            raise

    async def _publication_idempotent_result(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        idempotency_key: str,
        request_hash: str,
    ) -> ArticlePublication | None:
        existing = await session.scalar(
            select(ArticlePublication).where(
                ArticlePublication.organization_id == organization_id,
                ArticlePublication.project_id == project_id,
                ArticlePublication.idempotency_key == idempotency_key,
            )
        )
        if existing is not None and existing.request_hash != request_hash:
            raise ArticleIdempotencyConflictError
        return existing

    async def complete_publication(
        self,
        publication_id: str,
        *,
        wordpress_post_id: int,
        wordpress_url: str,
        response_summary: dict[str, Any],
    ) -> ArticlePublication:
        async with self.sessions() as session:
            publication = await session.scalar(
                select(ArticlePublication)
                .where(ArticlePublication.id == publication_id)
                .with_for_update()
            )
            if publication is None:
                raise LookupError("article_publication_not_found")
            if publication.status == "published":
                return publication
            if publication.status != "submitting":
                raise ValueError("article_publication_not_submitting")
            publication.status = "published"
            publication.wordpress_post_id = wordpress_post_id
            publication.wordpress_url = wordpress_url
            publication.response_summary_json = response_summary
            publication.error_code = None
            publication.error_detail = None
            publication.published_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(publication)
            return publication

    async def fail_publication(
        self,
        publication_id: str,
        *,
        error_code: str,
        error_detail: str,
        uncertain: bool,
    ) -> ArticlePublication:
        async with self.sessions() as session:
            publication = await session.scalar(
                select(ArticlePublication)
                .where(ArticlePublication.id == publication_id)
                .with_for_update()
            )
            if publication is None:
                raise LookupError("article_publication_not_found")
            if publication.status != "submitting":
                return publication
            publication.status = "uncertain" if uncertain else "failed"
            publication.error_code = error_code[:100]
            publication.error_detail = error_detail[:2000]
            await session.commit()
            await session.refresh(publication)
            return publication

    async def latest_publications(
        self, article_ids: list[str]
    ) -> dict[str, ArticlePublication]:
        if not article_ids:
            return {}
        async with self.sessions() as session:
            rows = list(
                (
                    await session.scalars(
                        select(ArticlePublication)
                        .where(ArticlePublication.article_id.in_(article_ids))
                        .order_by(
                            ArticlePublication.article_id,
                            ArticlePublication.created_at.desc(),
                        )
                    )
                ).all()
            )
        result: dict[str, ArticlePublication] = {}
        for row in rows:
            result.setdefault(row.article_id, row)
        return result

    async def list_articles(
        self,
        organization_id: str,
        project_id: str,
        page: int,
        page_size: int,
        article_status: str | None,
        search: str | None,
    ) -> tuple[list[tuple[Article, ArticleRun | None]], int]:
        conditions = [
            Article.organization_id == organization_id,
            Article.project_id == project_id,
        ]
        if article_status is not None:
            conditions.append(Article.status == article_status)
        if search is not None:
            pattern = f"%{search}%"
            conditions.append(
                or_(Article.primary_keyword.ilike(pattern), Article.title.ilike(pattern))
            )

        async with self.sessions() as session:
            total = int(
                await session.scalar(
                    select(func.count()).select_from(Article).where(*conditions)
                )
                or 0
            )
            rows = list(
                (
                    await session.execute(
                        select(Article, ArticleRun)
                        .outerjoin(ArticleRun, ArticleRun.id == Article.current_run_id)
                        .where(*conditions)
                        .order_by(Article.updated_at.desc())
                        .offset((page - 1) * page_size)
                        .limit(page_size)
                    )
                ).all()
            )
        return rows, total

    async def get_article(
        self, organization_id: str, project_id: str, article_id: str
    ) -> tuple[Article, ArticleRun | None] | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(Article, ArticleRun)
                    .outerjoin(ArticleRun, ArticleRun.id == Article.current_run_id)
                    .where(
                        Article.id == article_id,
                        Article.organization_id == organization_id,
                        Article.project_id == project_id,
                    )
                )
            ).one_or_none()
        return row

    async def get_run(
        self, organization_id: str, project_id: str, article_id: str
    ) -> ArticleRun | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ArticleRun)
                .join(Article, Article.current_run_id == ArticleRun.id)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                    ArticleRun.organization_id == organization_id,
                    ArticleRun.project_id == project_id,
                )
            )

    async def get_cached_seo_analysis(
        self,
        article_id: str,
        document_hash: str,
        metadata_hash: str,
        ruleset_version: str,
    ) -> ArticleSeoAnalysis | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ArticleSeoAnalysis).where(
                    ArticleSeoAnalysis.article_id == article_id,
                    ArticleSeoAnalysis.document_hash == document_hash,
                    ArticleSeoAnalysis.metadata_hash == metadata_hash,
                    ArticleSeoAnalysis.ruleset_version == ruleset_version,
                    ArticleSeoAnalysis.status == "completed",
                )
            )

    async def latest_seo_analysis(
        self,
        article_id: str,
        *,
        ruleset_version: str | None = None,
        completed_only: bool = False,
    ) -> ArticleSeoAnalysis | None:
        conditions = [ArticleSeoAnalysis.article_id == article_id]
        if ruleset_version is not None:
            conditions.append(ArticleSeoAnalysis.ruleset_version == ruleset_version)
        if completed_only:
            conditions.append(ArticleSeoAnalysis.status == "completed")
        async with self.sessions() as session:
            return await session.scalar(
                select(ArticleSeoAnalysis)
                .where(*conditions)
                .order_by(ArticleSeoAnalysis.created_at.desc())
                .limit(1)
            )

    async def is_article_focus_keyword_new(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        keyword: str,
    ) -> bool:
        normalized_keyword = keyword.strip().casefold()
        if not normalized_keyword:
            return True
        effective_keyword = func.lower(
            func.trim(
                func.coalesce(
                    func.nullif(Article.focus_keyword, ""),
                    Article.primary_keyword,
                )
            )
        )
        async with self.sessions() as session:
            duplicate = await session.scalar(
                select(Article.id)
                .where(
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                    Article.id != article_id,
                    effective_keyword == normalized_keyword,
                )
                .limit(1)
            )
        return duplicate is None

    async def save_seo_analysis(
        self,
        *,
        article_id: str,
        version_number: int | None,
        document_hash: str,
        metadata_hash: str,
        ruleset_version: str,
        input_snapshot: dict[str, Any],
        results: dict[str, Any],
        score: int,
        max_score: int,
        status: str,
        error_code: str | None = None,
        error_detail: str | None = None,
    ) -> ArticleSeoAnalysis:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticleSeoAnalysis)
                .where(
                    ArticleSeoAnalysis.article_id == article_id,
                    ArticleSeoAnalysis.document_hash == document_hash,
                    ArticleSeoAnalysis.metadata_hash == metadata_hash,
                    ArticleSeoAnalysis.ruleset_version == ruleset_version,
                )
                .with_for_update()
            )
            if row is None:
                row = ArticleSeoAnalysis(
                    id=f"sea_{uuid4().hex}",
                    article_id=article_id,
                    version_number=version_number,
                    document_hash=document_hash,
                    metadata_hash=metadata_hash,
                    ruleset_version=ruleset_version,
                    input_snapshot=input_snapshot,
                    results=results,
                    score=score,
                    max_score=max_score,
                    status=status,
                    error_code=error_code,
                    error_detail=error_detail,
                )
                session.add(row)
            else:
                row.version_number = version_number
                row.input_snapshot = input_snapshot
                row.results = results
                row.score = score
                row.max_score = max_score
                row.status = status
                row.error_code = error_code
                row.error_detail = error_detail
                row.created_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(row)
            return row

    async def create_link_analysis_job(
        self,
        *,
        article_id: str,
        version_number: int | None,
        document_hash: str,
        ruleset_version: str,
        options_hash: str,
        input_snapshot: dict[str, Any],
    ) -> ArticleLinkAnalysis:
        conditions = (
            ArticleLinkAnalysis.article_id == article_id,
            ArticleLinkAnalysis.document_hash == document_hash,
            ArticleLinkAnalysis.ruleset_version == ruleset_version,
            ArticleLinkAnalysis.options_hash == options_hash,
            ArticleLinkAnalysis.status.in_(("queued", "running")),
        )
        try:
            async with self.sessions() as session, session.begin():
                existing = await session.scalar(
                    select(ArticleLinkAnalysis)
                    .where(*conditions)
                    .order_by(ArticleLinkAnalysis.created_at.desc())
                    .limit(1)
                    .with_for_update()
                )
                if existing is not None:
                    return existing
                row = ArticleLinkAnalysis(
                    id=f"lia_{uuid4().hex}",
                    article_id=article_id,
                    version_number=version_number,
                    document_hash=document_hash,
                    ruleset_version=ruleset_version,
                    options_hash=options_hash,
                    input_snapshot=input_snapshot,
                    results={},
                    status="queued",
                    attempt=0,
                )
                session.add(row)
                await session.flush()
                return row
        except IntegrityError:
            async with self.sessions() as session:
                existing = await session.scalar(
                    select(ArticleLinkAnalysis)
                    .where(*conditions)
                    .order_by(ArticleLinkAnalysis.created_at.desc())
                    .limit(1)
                )
                if existing is None:
                    raise
                return existing

    async def latest_link_analysis(
        self,
        article_id: str,
        *,
        completed_only: bool = False,
    ) -> ArticleLinkAnalysis | None:
        conditions = [ArticleLinkAnalysis.article_id == article_id]
        if completed_only:
            conditions.append(ArticleLinkAnalysis.status == "completed")
        async with self.sessions() as session:
            return await session.scalar(
                select(ArticleLinkAnalysis)
                .where(*conditions)
                .order_by(ArticleLinkAnalysis.created_at.desc())
                .limit(1)
            )

    async def claim_link_analysis_jobs(
        self,
        *,
        limit: int,
        lease_seconds: int = 120,
    ) -> list[tuple[str, str]]:
        now = datetime.now(UTC)
        async with self.sessions() as session, session.begin():
            rows = list(
                await session.scalars(
                    select(ArticleLinkAnalysis)
                    .where(
                        or_(
                            ArticleLinkAnalysis.status == "queued",
                            (
                                (ArticleLinkAnalysis.status == "running")
                                & (ArticleLinkAnalysis.lease_until < now)
                            ),
                        )
                    )
                    .order_by(ArticleLinkAnalysis.created_at)
                    .with_for_update(skip_locked=True)
                    .limit(limit)
                )
            )
            claimed: list[tuple[str, str]] = []
            for row in rows:
                token = uuid4().hex
                row.status = "running"
                row.started_at = row.started_at or now
                row.lease_until = now + timedelta(seconds=lease_seconds)
                row.lease_token = token
                row.attempt = int(row.attempt or 0) + 1
                row.error_code = None
                row.error_detail = None
                claimed.append((row.id, token))
            return claimed

    async def get_claimed_link_analysis(
        self, analysis_id: str, lease_token: str
    ) -> ArticleLinkAnalysis | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ArticleLinkAnalysis).where(
                    ArticleLinkAnalysis.id == analysis_id,
                    ArticleLinkAnalysis.status == "running",
                    ArticleLinkAnalysis.lease_token == lease_token,
                )
            )

    async def complete_link_analysis(
        self,
        analysis_id: str,
        lease_token: str,
        results: dict[str, Any],
    ) -> ArticleLinkAnalysis:
        async with self.sessions() as session, session.begin():
            row = await session.scalar(
                select(ArticleLinkAnalysis)
                .where(
                    ArticleLinkAnalysis.id == analysis_id,
                    ArticleLinkAnalysis.status == "running",
                    ArticleLinkAnalysis.lease_token == lease_token,
                )
                .with_for_update()
            )
            if row is None:
                raise LookupError("link_analysis_lease_lost")
            row.results = results
            row.status = "completed"
            row.error_code = None
            row.error_detail = None
            row.completed_at = datetime.now(UTC)
            row.lease_until = None
            row.lease_token = None
            await session.flush()
            return row

    async def fail_link_analysis(
        self,
        analysis_id: str,
        lease_token: str,
        *,
        error_code: str,
        error_detail: str,
    ) -> None:
        async with self.sessions() as session, session.begin():
            row = await session.scalar(
                select(ArticleLinkAnalysis)
                .where(
                    ArticleLinkAnalysis.id == analysis_id,
                    ArticleLinkAnalysis.status == "running",
                    ArticleLinkAnalysis.lease_token == lease_token,
                )
                .with_for_update()
            )
            if row is None:
                return
            row.status = "failed"
            row.error_code = error_code
            row.error_detail = error_detail[:2000]
            row.completed_at = datetime.now(UTC)
            row.lease_until = None
            row.lease_token = None

    async def get_project_link_context(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
    ) -> dict[str, Any] | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(Article, ArticleRun, Project, SiteProfile)
                    .outerjoin(ArticleRun, ArticleRun.id == Article.current_run_id)
                    .join(
                        Project,
                        (Project.id == Article.project_id)
                        & (Project.organization_id == Article.organization_id),
                    )
                    .outerjoin(SiteProfile, SiteProfile.project_id == Project.id)
                    .where(
                        Article.id == article_id,
                        Article.organization_id == organization_id,
                        Article.project_id == project_id,
                    )
                )
            ).one_or_none()
        if row is None:
            return None
        article, run, project, profile = row
        merged_profile, profile_status = merge_project_profile(profile)
        return {
            "article": article,
            "run": run,
            "project": project,
            "profile": merged_profile,
            "profile_status": profile_status,
        }

    async def list_fact_source_candidates(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
    ) -> list[ArticleSource]:
        async with self.sessions() as session:
            return list(
                await session.scalars(
                    select(ArticleSource)
                    .join(ArticleRun, ArticleRun.id == ArticleSource.run_id)
                    .join(Article, Article.id == ArticleRun.article_id)
                    .where(
                        Article.id == article_id,
                        Article.organization_id == organization_id,
                        Article.project_id == project_id,
                        ArticleRun.organization_id == organization_id,
                        ArticleRun.project_id == project_id,
                        ArticleSource.status == "available",
                        ArticleSource.source_type.in_(
                            ("authority", "research", "competitor")
                        ),
                    )
                    .order_by(ArticleSource.source_type, ArticleSource.url)
                )
            )

    async def list_article_sources(self, run_id: str) -> list[ArticleSource]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(ArticleSource)
                        .where(ArticleSource.run_id == run_id)
                        .order_by(ArticleSource.retrieved_at, ArticleSource.url)
                    )
                ).all()
            )

    async def cancel_article(
        self, organization_id: str, project_id: str, article_id: str,
        *, expected_run_id: str | None = None,
    ) -> tuple[Article, ArticleRun | None] | None:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article)
                .where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
                .with_for_update()
            )
            if article is None:
                return None
            if expected_run_id is not None and article.current_run_id != expected_run_id:
                raise ValueError("TASK_RUN_CHANGED")
            run = (
                await session.scalar(
                    select(ArticleRun)
                    .where(
                        ArticleRun.id == article.current_run_id,
                        ArticleRun.organization_id == organization_id,
                        ArticleRun.project_id == project_id,
                    )
                    .with_for_update()
                )
                if article.current_run_id
                else None
            )
            if article.status in {"queued", "running"}:
                now = datetime.now(UTC)
                article.status = "cancelled"
                if run is not None and run.status in {"queued", "running"}:
                    run.status = "cancelled"
                    run.stage = "cancelled"
                    run.finished_at = now
                await session.commit()
                await session.refresh(article)
                if run is not None:
                    await session.refresh(run)
            return article, run

    async def begin_run(
        self, run_id: str, target_seconds: int, hard_timeout_seconds: int
    ) -> ArticleRun | None:
        async with self.sessions() as session:
            run = await session.scalar(
                select(ArticleRun).where(ArticleRun.id == run_id).with_for_update()
            )
            if run is None or run.status in {"failed", "cancelled"}:
                return run
            if run.status in {"completed", "completed_with_warnings"}:
                return run
            now = datetime.now(UTC)
            if run.started_at is None:
                run.started_at = now
                run.soft_deadline_at = now + timedelta(seconds=max(1, target_seconds))
                run.hard_deadline_at = now + timedelta(
                    seconds=max(target_seconds, hard_timeout_seconds)
                )
            run.status = "running"
            article = await session.get(Article, run.article_id)
            if article is not None and article.status == "queued":
                article.status = "running"
            await session.commit()
            await session.refresh(run)
            return run

    async def get_run_context(self, run_id: str) -> dict[str, Any] | None:
        async with self.sessions() as session:
            run = await session.get(ArticleRun, run_id)
            if run is None:
                return None
            article = await session.get(Article, run.article_id)
            if article is None:
                return None
            steps = list(
                (
                    await session.scalars(
                        select(ArticleRunStep)
                        .where(ArticleRunStep.run_id == run_id)
                        .order_by(ArticleRunStep.started_at, ArticleRunStep.step_key)
                    )
                ).all()
            )
        return {
            "run_id": run.id,
            "article_id": run.article_id,
            "organization_id": run.organization_id,
            "project_id": run.project_id,
            "primary_keyword": article.primary_keyword,
            "plan_input": dict(run.plan_input_snapshot_json),
            "project_snapshot": dict(run.project_snapshot_json),
            "model_snapshot": dict(run.model_snapshot_json),
            "status": run.status,
            "stage": run.stage,
            "progress": run.progress,
            "started_at": run.started_at,
            "soft_deadline_at": run.soft_deadline_at,
            "hard_deadline_at": run.hard_deadline_at,
            "warnings": list(run.warnings_json),
            "completed_steps": {
                step.step_key: {
                    "output_ref": step.output_ref,
                    "summary": dict(step.summary_json),
                    "warning_code": step.warning_code,
                }
                for step in steps
                if step.status == "completed"
            },
        }

    async def save_project_snapshot(self, run_id: str) -> tuple[dict[str, Any], list[str]]:
        async with self.sessions() as session:
            run = await session.scalar(
                select(ArticleRun).where(ArticleRun.id == run_id).with_for_update()
            )
            if run is None:
                raise LookupError("article_run_not_found")
            if run.project_snapshot_json:
                snapshot = dict(run.project_snapshot_json)
                return snapshot, project_snapshot_warnings(snapshot)
            project = await session.scalar(
                select(Project).where(
                    Project.id == run.project_id,
                    Project.organization_id == run.organization_id,
                )
            )
            if project is None:
                raise LookupError("article_project_not_found")
            profile = await session.get(SiteProfile, project.id)
            merged_profile, profile_status = merge_project_profile(profile)
            snapshot = {
                "organization_id": project.organization_id,
                "project_id": project.id,
                "domain": project.domain,
                "country": project.country,
                "language": project.language,
                "profile": merged_profile,
                "profile_status": profile_status,
            }
            warnings = project_snapshot_warnings(snapshot)
            run.project_snapshot_json = snapshot
            await session.commit()
            return snapshot, warnings

    async def list_internal_link_candidates(
        self,
        run_id: str,
        keyword: str,
        profile_key_pages: list[dict[str, Any]],
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        async with self.sessions() as session:
            run = await session.get(ArticleRun, run_id)
            if run is None:
                return []
            snapshot = dict(run.project_snapshot_json or {})
            project_domain = str(snapshot.get("domain") or "")
            query_terms = _internal_link_query_terms(keyword)
            ranked = (
                select(
                    PageSnapshot.page_id.label("page_id"),
                    PageSnapshot.final_url.label("url"),
                    PageSnapshot.title.label("title"),
                    PageSnapshot.description.label("description"),
                    PageSnapshot.h1.label("h1"),
                    PageSnapshot.h2.label("h2"),
                    PageSnapshot.headings.label("headings"),
                    PageSnapshot.structured_data.label("structured_data"),
                    PageSnapshot.schema_org.label("schema_org"),
                    PageSnapshot.status_code.label("status_code"),
                    PageSnapshot.word_count.label("word_count"),
                    func.row_number()
                    .over(
                        partition_by=PageSnapshot.page_id,
                        order_by=PageSnapshot.fetched_at.desc(),
                    )
                    .label("row_number"),
                )
                .join(CrawlRun, CrawlRun.run_id == PageSnapshot.run_id)
                .join(Page, Page.id == PageSnapshot.page_id)
                .where(
                    CrawlRun.organization_id == run.organization_id,
                    CrawlRun.project_id == run.project_id,
                    CrawlRun.task_type.not_in(
                        ("content_research", "source_verification")
                    ),
                    PageSnapshot.error.is_(None),
                    PageSnapshot.status_code.between(200, 399),
                )
                .subquery()
            )
            relevance_filters = [
                column.ilike(f"%{term}%")
                for term in query_terms
                for column in (
                    ranked.c.url,
                    ranked.c.title,
                    ranked.c.description,
                    ranked.c.h1.cast(Text),
                    ranked.c.h2.cast(Text),
                )
            ]
            rows = [
                dict(row)
                for row in (
                    await session.execute(
                        select(ranked)
                        .where(
                            ranked.c.row_number == 1,
                            or_(*relevance_filters) if relevance_filters else False,
                        )
                        .limit(1000)
                    )
                ).mappings()
            ]
            row_urls = [str(row.get("url") or "") for row in rows if row.get("url")]
            navigation_filters = [
                column.ilike(f"%{term}%")
                for term in query_terms
                for column in (LinkEdge.target_url, LinkEdge.anchor_text)
            ]
            if row_urls:
                navigation_filters.append(LinkEdge.target_url.in_(row_urls))
            navigation_rows = [
                dict(row)
                for row in (
                    await session.execute(
                        select(
                            LinkEdge.target_url.label("url"),
                            LinkEdge.anchor_text.label("anchor_text"),
                            func.max(LinkEdge.target_status).label("status_code"),
                        )
                        .join(CrawlRun, CrawlRun.run_id == LinkEdge.run_id)
                        .where(
                            CrawlRun.organization_id == run.organization_id,
                            CrawlRun.project_id == run.project_id,
                            CrawlRun.task_type.not_in(
                                ("content_research", "source_verification")
                            ),
                            LinkEdge.is_internal.is_(True),
                            LinkEdge.in_navigation.is_(True),
                            or_(*navigation_filters) if navigation_filters else False,
                        )
                        .group_by(LinkEdge.target_url, LinkEdge.anchor_text)
                        .limit(5000)
                    )
                ).mappings()
            ]

        navigation: dict[str, list[str]] = {}
        navigation_status: dict[str, int | None] = {}
        for row in navigation_rows:
            url = str(row.get("url") or "")
            if not _usable_internal_url(url, project_domain):
                continue
            key = normalize_source_url(url)
            anchor = str(row.get("anchor_text") or "").strip()
            if anchor:
                navigation.setdefault(key, []).append(anchor)
            status = row.get("status_code")
            navigation_status[key] = int(status) if status is not None else None

        candidates: dict[str, dict[str, Any]] = {}
        for page in profile_key_pages:
            url = str(page.get("url") or "")
            title = str(page.get("title") or "").strip()
            if not title or not _usable_internal_url(url, project_domain):
                continue
            key = normalize_source_url(url)
            candidates[key] = {
                "url": url,
                "title": title,
                "description": str(page.get("description") or "").strip(),
                "headings": [],
                "anchor_texts": [],
                "candidate_kind": "business_page",
                "word_count": 0,
            }

        for row in rows:
            url = str(row.get("url") or "")
            if not _usable_internal_url(url, project_domain):
                continue
            key = normalize_source_url(url)
            is_article = _looks_like_published_article(row)
            if not is_article and key not in navigation:
                continue
            title = str(row.get("title") or "").strip()
            if not title:
                title = next(
                    (str(item).strip() for item in row.get("h1") or [] if str(item).strip()),
                    "",
                )
            if not title and navigation.get(key):
                title = navigation[key][0]
            if not title:
                continue
            candidate = {
                "url": url,
                "title": title,
                "description": str(row.get("description") or "").strip(),
                "headings": _unique_text(
                    [*(row.get("h1") or []), *(row.get("h2") or [])]
                )[:20],
                "anchor_texts": _unique_text(navigation.get(key, []))[:10],
                "candidate_kind": "published_article" if is_article else "navigation",
                "word_count": int(row.get("word_count") or 0),
            }
            existing = candidates.get(key)
            if existing is None:
                candidates[key] = candidate
            else:
                existing["title"] = existing.get("title") or candidate["title"]
                existing["description"] = existing.get("description") or candidate["description"]
                existing["headings"] = candidate["headings"]
                existing["anchor_texts"] = candidate["anchor_texts"]
                existing["word_count"] = candidate["word_count"]

        for key, anchors in navigation.items():
            status = navigation_status.get(key)
            if key in candidates or status is None or not 200 <= status < 400:
                continue
            url = key
            candidates[key] = {
                "url": url,
                "title": anchors[0] if anchors else "",
                "description": "",
                "headings": [],
                "anchor_texts": _unique_text(anchors)[:10],
                "candidate_kind": "navigation",
                "word_count": 0,
            }

        keyword_terms = _internal_link_terms(keyword)
        relevant: list[dict[str, Any]] = []
        for candidate in candidates.values():
            relevance_score, overlaps = _internal_link_candidate_score(
                candidate, keyword_terms
            )
            if relevance_score <= 0:
                continue
            kind_weight = {
                "business_page": 3,
                "published_article": 2,
                "navigation": 1,
            }[str(candidate["candidate_kind"])]
            candidate["selection_score"] = relevance_score + kind_weight
            candidate["selection_reason"] = (
                "相关词命中："
                f"标题 {overlaps['title']}、描述 {overlaps['description']}、"
                f"URL {overlaps['url']}、H1/H2 {overlaps['headings']}、"
                f"导航锚文本 {overlaps['anchors']}；来源为 {candidate['candidate_kind']}"
            )
            relevant.append(candidate)
        ordered = sorted(
            relevant,
            key=lambda item: (
                int(item["selection_score"]),
                int(item.get("word_count") or 0),
                str(item.get("title") or ""),
            ),
            reverse=True,
        )
        return ordered[: max(1, min(limit, 50))]

    async def upsert_source(
        self,
        run_id: str,
        *,
        source_type: str,
        url: str,
        status: str,
        title: str | None = None,
        domain: str | None = None,
        content_ref: str | None = None,
        summary: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        normalized_url = normalize_source_url(url)
        async with self.sessions() as session:
            source = await session.scalar(
                select(ArticleSource).where(
                    ArticleSource.run_id == run_id,
                    ArticleSource.normalized_url == normalized_url,
                    ArticleSource.source_type == source_type,
                )
            )
            if source is None:
                source = ArticleSource(
                    id=str(uuid4()),
                    run_id=run_id,
                    source_type=source_type,
                    url=url,
                    normalized_url=normalized_url,
                    status=status,
                )
                session.add(source)
            source.status = status
            source.title = title
            source.domain = domain
            source.content_ref = content_ref
            source.summary_json = summary or {}
            source.metadata_json = metadata or {}
            source.retrieved_at = datetime.now(UTC)
            await session.commit()

    async def replace_internal_sources(
        self, run_id: str, sources: list[dict[str, Any]]
    ) -> None:
        normalized_sources = {
            normalize_source_url(str(item["url"])): item
            for item in sources
            if item.get("url")
        }
        retrieved_at = datetime.now(UTC)
        async with self.sessions() as session:
            existing = list(
                (
                    await session.scalars(
                        select(ArticleSource).where(
                            ArticleSource.run_id == run_id,
                            ArticleSource.source_type == "internal",
                        )
                    )
                ).all()
            )
            existing_by_url = {item.normalized_url: item for item in existing}
            for normalized_url, item in normalized_sources.items():
                source = existing_by_url.get(normalized_url)
                if source is None:
                    source = ArticleSource(
                        id=str(uuid4()),
                        run_id=run_id,
                        source_type="internal",
                        url=str(item["url"]),
                        normalized_url=normalized_url,
                        status="available",
                    )
                    session.add(source)
                source.url = str(item["url"])
                source.status = "available"
                source.title = str(item.get("title") or "") or None
                source.domain = str(item.get("domain") or "") or None
                source.content_ref = None
                source.summary_json = dict(item.get("summary") or {})
                source.metadata_json = {}
                source.claims_json = []
                source.section_ids_json = []
                source.retrieved_at = retrieved_at
            for normalized_url, source in existing_by_url.items():
                if normalized_url in normalized_sources:
                    continue
                source.status = "unavailable"
                source.content_ref = None
                source.claims_json = []
                source.section_ids_json = []
                source.retrieved_at = retrieved_at
            await session.commit()

    async def list_sources(
        self, run_id: str, source_type: str
    ) -> list[dict[str, Any]]:
        async with self.sessions() as session:
            sources = list(
                (
                    await session.scalars(
                        select(ArticleSource)
                        .where(
                            ArticleSource.run_id == run_id,
                            ArticleSource.source_type == source_type,
                        )
                        .order_by(ArticleSource.retrieved_at, ArticleSource.url)
                    )
                ).all()
            )
        return [
            {
                "url": source.url,
                "title": source.title,
                "domain": source.domain,
                "status": source.status,
                "content_ref": source.content_ref,
                "summary": dict(source.summary_json),
                "metadata": dict(source.metadata_json),
            }
            for source in sources
        ]

    async def bind_plan_sources(self, run_id: str, plan: dict[str, Any]) -> None:
        claims_by_url: dict[str, list[dict[str, Any]]] = {}
        sections_by_url: dict[str, list[str]] = {}
        for claim in plan.get("claims", []):
            source_url = str(claim.get("source_url") or "")
            if not source_url:
                continue
            normalized = normalize_source_url(source_url)
            claims_by_url.setdefault(normalized, []).append(dict(claim))
            section_id = claim.get("section_id")
            if section_id:
                sections_by_url.setdefault(normalized, []).append(str(section_id))
        for section in plan.get("sections", []):
            section_id = str(section.get("section_id") or "")
            if not section_id:
                continue
            for source_url in section.get("internal_urls") or []:
                normalized = normalize_source_url(str(source_url))
                sections_by_url.setdefault(normalized, []).append(section_id)

        async with self.sessions() as session:
            sources = list(
                (
                    await session.scalars(
                        select(ArticleSource).where(ArticleSource.run_id == run_id)
                    )
                ).all()
            )
            for source in sources:
                source.claims_json = claims_by_url.get(source.normalized_url, [])
                source.section_ids_json = list(
                    dict.fromkeys(sections_by_url.get(source.normalized_url, []))
                )
            await session.commit()

    async def queued_runs(self, limit: int = 20) -> list[ArticleRun]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(ArticleRun)
                        .where(ArticleRun.status == "queued")
                        .order_by(ArticleRun.created_at, ArticleRun.id)
                        .limit(max(1, min(limit, 100)))
                    )
                ).all()
            )

    async def active_runs(self, limit: int = 100) -> list[ArticleRun]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(ArticleRun)
                        .where(ArticleRun.status.in_({"queued", "running"}))
                        .order_by(ArticleRun.created_at, ArticleRun.id)
                        .limit(max(1, min(limit, 100)))
                    )
                ).all()
            )

    async def fail_run(
        self,
        run_id: str,
        *,
        error_code: str,
        error_detail: str,
        failed_stage: str,
        retryable: bool,
    ) -> None:
        async with self.sessions() as session:
            run = await session.scalar(
                select(ArticleRun).where(ArticleRun.id == run_id).with_for_update()
            )
            if run is None or run.status not in {"queued", "running"}:
                return
            terminal_failed_stage = failed_stage.strip()[:100] or run.stage
            run.status = "failed"
            run.stage = "failed"
            run.error_code = error_code.strip()[:100] or "article_generation_failed"
            run.error_detail = error_detail.strip()[:2000]
            run.failed_stage = terminal_failed_stage
            run.retryable = retryable
            run.finished_at = datetime.now(UTC)
            article = await session.scalar(
                select(Article).where(Article.id == run.article_id).with_for_update()
            )
            if article is not None and article.current_run_id == run.id:
                article.status = "failed"
            await session.commit()

    async def ensure_competitor_crawl(
        self, run_id: str, urls: list[str]
    ) -> tuple[CrawlRun, dict[str, Any]]:
        from uuid import NAMESPACE_URL, uuid5

        async with self.sessions() as session:
            article_run = await session.get(ArticleRun, run_id)
            if article_run is None:
                raise LookupError("article_run_not_found")
            snapshot = dict(article_run.project_snapshot_json)
            crawl_run_id = str(uuid5(NAMESPACE_URL, f"article:{run_id}:competitors"))
            existing = await session.get(CrawlRun, crawl_run_id)
            task = {
                "organization_id": article_run.organization_id,
                "project_id": article_run.project_id,
                "run_id": crawl_run_id,
                "type": "content_research",
                "urls": urls[:12],
                "max_pages": min(len(urls), 12),
                "rendering": "auto",
                "country": str(snapshot.get("country") or "US"),
                "language": str(snapshot.get("language") or "en"),
            }
            if existing is not None:
                return existing, dict(existing.config_snapshot or task)
            crawl_run = CrawlRun(
                run_id=crawl_run_id,
                organization_id=article_run.organization_id,
                project_id=article_run.project_id,
                task_type="content_research",
                country=task["country"],
                language=task["language"],
                status="queued",
                stage="queued",
                message="竞争文章采集任务已进入队列",
                config_snapshot=task,
                temporal_workflow_id=f"crawler:content_research:{crawl_run_id}",
            )
            session.add(crawl_run)
            await session.commit()
            await session.refresh(crawl_run)
            return crawl_run, task

    async def ensure_source_verification_crawl(
        self, run_id: str, urls: list[str], *, rendering: str = "auto"
    ) -> tuple[CrawlRun, dict[str, Any]]:
        from uuid import NAMESPACE_URL, uuid5

        bounded_urls = list(dict.fromkeys(urls))[:12]
        if not bounded_urls:
            raise ValueError("source_verification_urls_required")
        url_signature = sha256(
            f"{rendering}\n".encode() + "\n".join(sorted(bounded_urls)).encode()
        ).hexdigest()[:16]
        async with self.sessions() as session:
            article_run = await session.get(ArticleRun, run_id)
            if article_run is None:
                raise LookupError("article_run_not_found")
            snapshot = dict(article_run.project_snapshot_json)
            crawl_run_id = str(
                uuid5(
                    NAMESPACE_URL,
                    f"article:{run_id}:source-verification:{url_signature}",
                )
            )
            existing = await session.get(CrawlRun, crawl_run_id)
            task = {
                "organization_id": article_run.organization_id,
                "project_id": article_run.project_id,
                "run_id": crawl_run_id,
                "type": "source_verification",
                "urls": bounded_urls,
                "max_pages": len(bounded_urls),
                "rendering": rendering,
                "country": str(snapshot.get("country") or "US"),
                "language": str(snapshot.get("language") or "en"),
            }
            if existing is not None:
                return existing, dict(existing.config_snapshot or task)
            crawl_run = CrawlRun(
                run_id=crawl_run_id,
                organization_id=article_run.organization_id,
                project_id=article_run.project_id,
                task_type="source_verification",
                country=task["country"],
                language=task["language"],
                status="queued",
                stage="queued",
                message="权威来源核验任务已进入队列",
                config_snapshot=task,
                temporal_workflow_id=f"crawler:source_verification:{crawl_run_id}",
            )
            session.add(crawl_run)
            await session.commit()
            await session.refresh(crawl_run)
            return crawl_run, task

    async def get_crawl_run(self, crawl_run_id: str) -> CrawlRun | None:
        async with self.sessions() as session:
            return await session.get(CrawlRun, crawl_run_id)

    async def list_competitor_pages(self, crawl_run_id: str) -> list[dict[str, Any]]:
        async with self.sessions() as session:
            rows = list(
                (
                    await session.execute(
                        select(PageSnapshot, Page.normalized_url, Page.id)
                        .join(Page, Page.id == PageSnapshot.page_id)
                        .where(PageSnapshot.run_id == crawl_run_id)
                        .order_by(PageSnapshot.word_count.desc())
                    )
                ).all()
            )
            links_by_page: dict[int, list[dict[str, Any]]] = {}
            for link in (
                await session.scalars(
                    select(LinkEdge)
                    .where(LinkEdge.run_id == crawl_run_id)
                    .order_by(LinkEdge.id)
                )
            ).all():
                links_by_page.setdefault(link.source_page_id, []).append(
                    {
                        "url": link.target_url,
                        "text": link.anchor_text or "",
                        "rel": link.rel or "",
                        "placement": link.placement,
                        "is_internal": link.is_internal,
                    }
                )
        return [
            {
                "url": snapshot.final_url or normalized_url,
                "requested_url": snapshot.requested_url or normalized_url,
                "title": snapshot.title,
                "status": "failed" if snapshot.error else "available",
                "error_type": snapshot.error_type,
                "content_ref": snapshot.main_text_ref,
                "html_ref": snapshot.main_html_ref,
                "word_count": snapshot.word_count,
                "h2": list(snapshot.h2 or []),
                "h3": list(snapshot.h3 or []),
                "headings": list(snapshot.headings or []),
                "outbound_links": links_by_page.get(page_id, []),
            }
            for snapshot, normalized_url, page_id in rows
        ]

    async def claim_step(
        self,
        run_id: str,
        step_key: str,
        worker_id: str,
        lease_seconds: int,
    ) -> tuple[str, ArticleRunStep | None]:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(ArticleRun).where(ArticleRun.id == run_id).with_for_update()
            )
            if run is None:
                return "missing", None
            if run.status == "cancelled":
                return "cancelled", None
            if run.status in {"completed", "completed_with_warnings", "failed"}:
                return "terminal", None
            step = await session.scalar(
                select(ArticleRunStep)
                .where(
                    ArticleRunStep.run_id == run_id,
                    ArticleRunStep.step_key == step_key,
                )
                .with_for_update()
            )
            if step is not None and step.status == "completed":
                return "completed", step
            if (
                step is not None
                and step.status == "executing"
                and step.lease_expires_at is not None
                and step.lease_expires_at > now
                and step.worker_id != worker_id
            ):
                return "busy", step
            if step is None:
                step = ArticleRunStep(
                    id=str(uuid4()),
                    run_id=run_id,
                    step_key=step_key,
                    status="executing",
                    attempts=0,
                )
                session.add(step)
            step.status = "executing"
            step.attempts += 1
            step.worker_id = worker_id
            step.lease_expires_at = now + timedelta(seconds=max(1, lease_seconds))
            step.started_at = step.started_at or now
            step.finished_at = None
            await session.commit()
            await session.refresh(step)
            return "claimed", step

    async def complete_step(
        self,
        run_id: str,
        step_key: str,
        worker_id: str,
        *,
        summary: dict[str, Any],
        output_ref: str | None = None,
        warning_code: str | None = None,
        duration_ms: int | None = None,
        usage: dict[str, Any] | None = None,
    ) -> ArticleRunStep:
        async with self.sessions() as session:
            step = await session.scalar(
                select(ArticleRunStep)
                .where(
                    ArticleRunStep.run_id == run_id,
                    ArticleRunStep.step_key == step_key,
                )
                .with_for_update()
            )
            if step is None:
                raise LookupError("article_step_not_found")
            if step.status == "completed":
                return step
            if (
                step.worker_id != worker_id
                or step.status != "executing"
                or step.lease_expires_at is None
                or step.lease_expires_at <= datetime.now(UTC)
            ):
                raise RuntimeError("文章步骤执行租约已失效")
            step.status = "completed"
            step.summary_json = summary
            step.output_ref = output_ref
            step.warning_code = warning_code
            step.duration_ms = duration_ms
            step.input_tokens = (usage or {}).get("input_tokens")
            step.output_tokens = (usage or {}).get("output_tokens")
            step.cost = None
            step.reported_cost = (usage or {}).get("reported_cost")
            step.estimated_cost = (usage or {}).get("estimated_cost")
            step.cost_currency = (usage or {}).get("cost_currency")
            step.estimation_basis_json = dict(
                (usage or {}).get("estimation_basis") or {}
            )
            step.finished_at = datetime.now(UTC)
            step.lease_expires_at = None
            await session.commit()
            await session.refresh(step)
            return step

    async def renew_step_lease(
        self,
        run_id: str,
        step_key: str,
        worker_id: str,
        lease_seconds: int,
    ) -> bool:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            step = await session.scalar(
                select(ArticleRunStep)
                .where(
                    ArticleRunStep.run_id == run_id,
                    ArticleRunStep.step_key == step_key,
                )
                .with_for_update()
            )
            if (
                step is None
                or step.status != "executing"
                or step.worker_id != worker_id
                or step.lease_expires_at is None
                or step.lease_expires_at <= now
            ):
                return False
            step.lease_expires_at = now + timedelta(
                seconds=max(1, lease_seconds)
            )
            await session.commit()
            return True

    async def force_claim_step(
        self,
        run_id: str,
        step_key: str,
        worker_id: str,
        lease_seconds: int,
    ) -> tuple[str, ArticleRunStep | None]:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(ArticleRun).where(ArticleRun.id == run_id).with_for_update()
            )
            if run is None:
                return "missing", None
            if run.status == "cancelled":
                return "cancelled", None
            if run.status in {"completed", "completed_with_warnings", "failed"}:
                return "terminal", None
            step = await session.scalar(
                select(ArticleRunStep)
                .where(
                    ArticleRunStep.run_id == run_id,
                    ArticleRunStep.step_key == step_key,
                )
                .with_for_update()
            )
            if step is not None and step.status == "completed":
                return "completed", step
            if (
                step is not None
                and step.status == "executing"
                and step.lease_expires_at is not None
                and step.lease_expires_at > now
            ):
                return "busy", step
            if step is None:
                step = ArticleRunStep(
                    id=str(uuid4()),
                    run_id=run_id,
                    step_key=step_key,
                    status="executing",
                    attempts=0,
                )
                session.add(step)
            step.status = "executing"
            step.attempts += 1
            step.worker_id = worker_id
            step.lease_expires_at = now + timedelta(seconds=max(1, lease_seconds))
            step.started_at = step.started_at or now
            step.finished_at = None
            await session.commit()
            await session.refresh(step)
            return "claimed", step

    async def fail_step(
        self, run_id: str, step_key: str, worker_id: str, warning_code: str
    ) -> None:
        async with self.sessions() as session:
            step = await session.scalar(
                select(ArticleRunStep)
                .where(
                    ArticleRunStep.run_id == run_id,
                    ArticleRunStep.step_key == step_key,
                )
                .with_for_update()
            )
            if step is None or step.status == "completed" or step.worker_id != worker_id:
                return
            step.status = "failed"
            step.warning_code = warning_code
            step.finished_at = datetime.now(UTC)
            step.lease_expires_at = None
            await session.commit()

    async def set_stage(self, run_id: str, stage: str, progress: int) -> None:
        async with self.sessions() as session:
            run = await session.scalar(
                select(ArticleRun).where(ArticleRun.id == run_id).with_for_update()
            )
            if run is None or run.status != "running" or progress < run.progress:
                return
            run.stage = stage
            run.progress = progress
            await session.commit()

    async def finish_run(
        self,
        run_id: str,
        status: str,
        warnings: list[dict[str, str]],
        *,
        artifact: dict[str, Any],
        html: str,
        final_content_ref: str,
    ) -> None:
        if status not in {"completed", "completed_with_warnings"}:
            raise ValueError("invalid article terminal status")
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(ArticleRun).where(ArticleRun.id == run_id).with_for_update()
            )
            if run is None or run.status in {"failed", "cancelled"}:
                return
            if run.status in {"completed", "completed_with_warnings"}:
                return
            article = await session.scalar(
                select(Article).where(Article.id == run.article_id).with_for_update()
            )
            if article is None:
                raise LookupError("article_not_found")

            unique_warnings = list(
                {
                    str(item.get("code")): {
                        "code": str(item.get("code")),
                        "message": str(item.get("message", ""))[:200],
                    }
                    for item in warnings
                    if item.get("code")
                }.values()
            )
            steps = list(
                (
                    await session.scalars(
                        select(ArticleRunStep)
                        .where(
                            ArticleRunStep.run_id == run_id,
                            ArticleRunStep.status == "completed",
                        )
                        .order_by(ArticleRunStep.started_at, ArticleRunStep.step_key)
                    )
                ).all()
            )
            step_by_key = {step.step_key: step for step in steps}
            existing_versions = list(
                await session.scalars(
                    select(ArticleVersion)
                    .where(ArticleVersion.run_id == run_id)
                    .order_by(ArticleVersion.version_number)
                )
            )
            existing_by_type = {
                version.version_type: version for version in existing_versions
            }
            existing_types = set(existing_by_type)
            next_version = int(
                await session.scalar(
                    select(func.coalesce(func.max(ArticleVersion.version_number), 0)).where(
                        ArticleVersion.article_id == article.id
                    )
                )
                or 0
            ) + 1
            version_specs = [
                ("outline", (step_by_key.get("planning") or None)),
                ("draft", (step_by_key.get("writing") or None)),
                (
                    "revised",
                    next(
                        (
                            step_by_key.get(key)
                            for key in (
                                "checking_4",
                                "revising_3",
                                "checking_3",
                                "revising_2",
                                "checking_2",
                                "revising_1",
                                "checking_1",
                                "revising",
                                "checking",
                            )
                            if step_by_key.get(key) is not None
                        ),
                        None,
                    ),
                ),
                ("final", None),
            ]
            outline = dict(artifact.get("plan") or {})
            quality = dict(artifact.get("quality") or {})
            final_version: ArticleVersion | None = existing_by_type.get("final")
            for version_type, step in version_specs:
                if version_type in existing_types:
                    continue
                content_ref = (
                    final_content_ref
                    if version_type == "final"
                    else (step.output_ref if step is not None else None)
                )
                if content_ref is None and version_type != "final":
                    continue
                version = ArticleVersion(
                    id=str(uuid4()),
                    article_id=article.id,
                    run_id=run.id,
                    version_number=next_version,
                    version_type=version_type,
                    content_ref=content_ref,
                    outline_json=outline,
                    quality_json=quality if version_type in {"revised", "final"} else {},
                    created_by="system",
                )
                session.add(version)
                if version_type == "final":
                    final_version = version
                next_version += 1

            reported_steps = [step for step in steps if step.reported_cost is not None]
            estimated_steps = [
                step
                for step in steps
                if step.reported_cost is None and step.estimated_cost is not None
            ]
            reported_currencies = {
                step.cost_currency for step in reported_steps if step.cost_currency
            }
            estimated_currencies = {
                step.cost_currency for step in estimated_steps if step.cost_currency
            }
            run.metrics_json = {
                "stage_count": len(steps),
                "duration_ms": sum(step.duration_ms or 0 for step in steps),
                "input_tokens": sum(step.input_tokens or 0 for step in steps),
                "output_tokens": sum(step.output_tokens or 0 for step in steps),
                "reported_cost": (
                    sum(float(step.reported_cost) for step in reported_steps)
                    if reported_steps
                    else None
                ),
                "estimated_cost": (
                    sum(float(step.estimated_cost) for step in estimated_steps)
                    if estimated_steps
                    else None
                ),
                "reported_cost_currency": (
                    next(iter(reported_currencies))
                    if len(reported_currencies) == 1
                    else None
                ),
                "estimated_cost_currency": (
                    next(iter(estimated_currencies))
                    if len(estimated_currencies) == 1
                    else None
                ),
                "estimation_basis": [
                    {
                        "step_key": step.step_key,
                        **dict(step.estimation_basis_json or {}),
                    }
                    for step in estimated_steps
                ],
                "provider_request_ids": list(
                    dict.fromkeys(
                        str(request_id)
                        for step in steps
                        for request_id in (step.summary_json.get("usage") or {}).get(
                            "provider_request_ids", []
                        )
                        if request_id
                    )
                ),
            }

            article.publication_status = publication_status_for_artifact(artifact)
            plan_input = dict(run.plan_input_snapshot_json or {})
            locked_title = dict(plan_input.get("title") or {})
            if locked_title.get("policy") == "locked":
                generated_title = str(artifact.get("title") or "").strip()
                required_title = str(locked_title.get("value") or "").strip()
                if generated_title != required_title:
                    unique_warnings.append(
                        {
                            "code": "locked_requirement_failed",
                            "message": "Generated title did not preserve the locked plan title.",
                        }
                    )
                    article.publication_status = "complete_draft"
            locked_direction = dict(plan_input.get("writing_direction") or {})
            if locked_direction.get("policy") == "locked":
                required_direction = str(locked_direction.get("value") or "")
                checks = (artifact.get("quality") or {}).get(
                    "locked_requirement_checks"
                ) or []
                direction_passed = any(
                    isinstance(check, dict)
                    and check.get("field") == "writing_direction"
                    and check.get("requirement") == required_direction
                    and check.get("passed") is True
                    for check in checks
                )
                if not direction_passed:
                    unique_warnings.append(
                        {
                            "code": "locked_requirement_failed",
                            "message": "Generated article did not preserve the locked writing direction.",
                        }
                    )
                    article.publication_status = "complete_draft"
            unique_warnings = list(
                {str(item["code"]): item for item in unique_warnings}.values()
            )
            terminal_status = "completed_with_warnings" if unique_warnings else status
            run.status = terminal_status
            run.stage = "completed"
            run.progress = 100
            run.warnings_json = unique_warnings
            run.finished_at = now
            article.status = terminal_status
            article.warning_count = len(unique_warnings)
            title = str(
                locked_title.get("value")
                if locked_title.get("policy") == "locked"
                else artifact.get("title") or article.primary_keyword
            )[:300]
            metadata = article_metadata_snapshot(
                article,
                {
                    "title": title,
                    "slug": str(artifact.get("slug") or "article")[:200],
                    "meta_title": str(artifact.get("meta_title") or title)[:300],
                    "meta_description": str(artifact.get("meta_description") or "")[:500],
                    "publication_status": article.publication_status,
                },
            )
            artifact_document = artifact.get("document")
            document = (
                normalize_document(artifact_document)
                if isinstance(artifact_document, dict)
                else markdown_to_document(str(artifact.get("markdown") or ""))
            )
            markdown = document_to_markdown(document)
            rendered_html = document_to_html(document)
            manifest = extract_asset_manifest(document)
            await self._validate_asset_manifest(session, article.project_id, manifest)
            content_hash = document_content_hash(document, metadata)
            next_review_version = (article.review_version or 0) + 1
            article.outline_json = outline
            if final_version is not None:
                final_version.review_version = next_review_version
                final_version.content_json = {
                    **metadata,
                    "document": document,
                    "markdown": markdown,
                    "html": rendered_html,
                }
                final_version.schema_version = CURRENT_SCHEMA_VERSION
                final_version.document_snapshot = document
                final_version.metadata_snapshot = metadata
                final_version.asset_manifest = manifest
                final_version.content_hash = content_hash
                final_version.parent_version_number = article.current_version_number or None
                final_version.reason = "article_generation_completed"
                final_version.retention_protected = True
                await self._replace_current_asset_bindings(
                    session, article.id, manifest
                )
                self._add_version_asset_bindings(
                    session, article.id, final_version.version_number, manifest
                )
                self._apply_article_snapshot(
                    article,
                    document,
                    metadata,
                    markdown,
                    rendered_html,
                    content_hash,
                    final_version.version_number,
                    next_review_version,
                )
            else:
                raise ValueError("article_final_version_missing")
            if article.plan_item_id:
                from app.modules.content_plan.models import ContentPlanItem

                plan_item = await session.get(ContentPlanItem, article.plan_item_id)
                if plan_item is not None:
                    plan_item.status = "generated"
                    plan_item.trigger_lease_until = None
            await session.commit()

    async def _idempotent_result(
        self,
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        idempotency_key: str,
        request_hash: str,
    ) -> tuple[Article, ArticleRun] | None:
        key = await session.get(
            ArticleIdempotencyKey,
            (organization_id, project_id, idempotency_key),
        )
        if key is None:
            return None
        if key.request_hash != request_hash:
            raise ArticleIdempotencyConflictError
        row = (
            await session.execute(
                select(Article, ArticleRun)
                .join(ArticleRun, ArticleRun.id == Article.current_run_id)
                .where(
                    Article.id == key.article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
        ).one()
        return row


def _copied_source_metadata(
    source_type: str, metadata: dict[str, Any], parent_run_id: str
) -> dict[str, Any]:
    copied = {**metadata, "copied_from_run_id": parent_run_id}
    if source_type != "serp":
        return copied
    original_request_id = copied.pop("provider_request_id", None)
    copied.update(
        {
            "cached": True,
            "reused": True,
            "reuse_method": "persisted_run_source",
            "request_cost_usd": 0.0,
        }
    )
    if original_request_id:
        copied["original_provider_request_id"] = original_request_id
    return copied


def normalize_source_url(value: str) -> str:
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    parsed = urlsplit(value.strip())
    tracking = {
        "fbclid",
        "gclid",
        "utm_campaign",
        "utm_content",
        "utm_medium",
        "utm_source",
        "utm_term",
    }
    query = urlencode(
        [
            (key, item)
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
            if key.casefold() not in tracking
        ],
        doseq=True,
    )
    return urlunsplit(
        (parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or "/", query, "")
    )
