from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import Text, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.models import (
    Article,
    ArticleIdempotencyKey,
    ArticleReviewDecision,
    ArticleRun,
    ArticleRunStep,
    ArticleSource,
    ArticleVersion,
)
from app.modules.content_plan import models as content_plan_models  # noqa: F401
from app.modules.crawling.models import CrawlRun, LinkEdge, Page, PageSnapshot
from app.modules.projects.models import Project, SiteProfile


class ArticleIdempotencyConflictError(Exception):
    pass


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
        primary_keyword: str,
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

                article_id, run_id = str(uuid4()), str(uuid4())
                article = Article(
                    id=article_id,
                    organization_id=organization_id,
                    project_id=project_id,
                    primary_keyword=primary_keyword,
                    status="queued",
                    current_run_id=run_id,
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
            now = datetime.now(UTC)
            settings = await session.get(ContentPlanSettings, project_id)
            article.review_status = decision
            article.review_note = review_note
            article.reviewed_at = now
            article.reviewed_by = reviewed_by
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
        self, organization_id: str, project_id: str, article_id: str
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
            if run is None or run.status == "cancelled":
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
                "urls": urls[:8],
                "max_pages": min(len(urls), 8),
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
        self, run_id: str, urls: list[str]
    ) -> tuple[CrawlRun, dict[str, Any]]:
        from uuid import NAMESPACE_URL, uuid5

        bounded_urls = list(dict.fromkeys(urls))[:12]
        if not bounded_urls:
            raise ValueError("source_verification_urls_required")
        url_signature = sha256("\n".join(sorted(bounded_urls)).encode()).hexdigest()[:16]
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
            if run.status in {"completed", "completed_with_warnings"}:
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
            if run.status in {"completed", "completed_with_warnings"}:
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
            if run is None or run.status == "cancelled":
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
            existing_types = set(
                await session.scalars(
                    select(ArticleVersion.version_type).where(
                        ArticleVersion.run_id == run_id
                    )
                )
            )
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
                session.add(
                    ArticleVersion(
                        id=str(uuid4()),
                        article_id=article.id,
                        run_id=run.id,
                        version_number=next_version,
                        version_type=version_type,
                        content_ref=content_ref,
                        outline_json=outline,
                        quality_json=quality if version_type in {"revised", "final"} else {},
                    )
                )
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
            article.title = str(
                locked_title.get("value")
                if locked_title.get("policy") == "locked"
                else artifact.get("title") or article.primary_keyword
            )[:300]
            article.slug = str(artifact.get("slug") or "article")[:200]
            article.meta_title = str(artifact.get("meta_title") or article.title)[:300]
            article.meta_description = str(artifact.get("meta_description") or "")[:500]
            article.outline_json = outline
            article.markdown = str(artifact.get("markdown") or "")
            article.html = html
            article.review_version = (article.review_version or 0) + 1
            article.review_status = "pending_review"
            article.review_note = None
            article.reviewed_at = None
            article.reviewed_by = None
            article.publication_blocked_reason = "awaiting_review"
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
