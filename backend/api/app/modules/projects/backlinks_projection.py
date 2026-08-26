import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi.responses import Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)

PROJECT_CONTEXT_EVENT_TYPE = "backlinks.project-context.projection.requested.v1"
PROJECT_CONTEXT_MAX_DELIVERY_ATTEMPTS = 8
PROJECT_CONTEXT_RETRY_BASE_SECONDS = 5
PROJECT_CONTEXT_RETRY_MAX_SECONDS = 900


class ProjectContextProjectionError(RuntimeError):
    pass


class ProjectContextPublisher(Protocol):
    async def publish_project_context(
        self,
        *,
        resolved: ResolvedPlatformRequestContext,
        website_project_key: str,
        payload: dict[str, object],
    ) -> Response: ...


@dataclass(frozen=True)
class ProjectContextProjection:
    event_id: str | None
    snapshot_version: int
    input_required: tuple[str, ...]
    outbox_status: str

    @property
    def input_complete(self) -> bool:
        return not self.input_required


@dataclass(frozen=True)
class ProjectContextDispatch:
    event_id: str
    status: str
    upstream_status: int | None = None


def _retryable_upstream_status(status_code: int) -> bool:
    return status_code in {408, 425, 429} or status_code >= 500


def _delivery_retry_at(attempt_count: int) -> datetime:
    delay_seconds = min(
        PROJECT_CONTEXT_RETRY_BASE_SECONDS * (2 ** max(attempt_count - 1, 0)),
        PROJECT_CONTEXT_RETRY_MAX_SECONDS,
    )
    return datetime.now(UTC) + timedelta(seconds=delay_seconds)


def _normalize_items(values: object, *, maximum: int = 100) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    normalized = list(
        dict.fromkeys(
            value.strip()
            for value in values
            if isinstance(value, str) and value.strip()
        )
    )
    return normalized[:maximum]


def _profile_items(profile: Mapping[str, object], *names: str) -> list[str]:
    for name in names:
        values = _normalize_items(profile.get(name))
        if values:
            return values
    return []


def _canonical_domain(value: str) -> str:
    candidate = value.strip()
    parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
    domain = (parsed.hostname or "").lower().rstrip(".")
    if not domain:
        raise ProjectContextProjectionError("Project canonical domain is invalid.")
    return domain


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _fingerprint(value: object) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _as_utc(value: datetime | None, *, fallback: datetime) -> datetime:
    if value is None:
        return fallback
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _evidence_reference(
    *,
    organization_id: str,
    project_id: str,
    source_module: str,
    source_record_id: str,
    source_version: str,
    evidence_type: str,
    normalized_parameters: Mapping[str, object],
    market: str,
    location: str,
    language: str,
    observed_at: datetime,
) -> dict[str, object]:
    request_fingerprint = _fingerprint(
        {
            "projectId": project_id,
            "sourceModule": source_module,
            "sourceRecordId": source_record_id,
            "sourceVersion": source_version,
            "normalizedParameters": normalized_parameters,
            "market": market,
            "location": location,
            "language": language,
        }
    )
    return {
        "recordId": str(
            uuid5(
                NAMESPACE_URL,
                (
                    f"growthos:backlinks:evidence:{organization_id}:{project_id}:"
                    f"{source_module}:{source_record_id}:{source_version}"
                ),
            )
        ),
        "snapshot": {
            "organizationId": organization_id,
            "websiteProjectId": project_id,
            "evidenceType": evidence_type,
            "sourceModule": source_module,
            "sourceRecordId": source_record_id,
            "sourceVersion": source_version,
            "provider": "growthos-platform",
            "endpoint": f"website-project/{source_module}",
            "normalizedParameters": dict(normalized_parameters),
            "requestFingerprint": request_fingerprint,
            "market": market,
            "location": location,
            "language": language,
            "fetchedAt": _iso(observed_at),
            "expiresAt": _iso(observed_at + timedelta(days=30)),
            "providerRequestId": (
                f"platform:{project_id}:{source_module}:"
                f"{source_record_id}:{source_version}"
            ),
            "providerTaskId": None,
            "costMicros": 0,
            "artifactRef": (
                f"platform://website-project/{project_id}/{source_module}/"
                f"{source_record_id}/{source_version}"
            ),
            "status": "ready",
        },
    }


def _serialize_context(resolved: ResolvedPlatformRequestContext) -> dict[str, object]:
    return {
        "actor": {
            "userId": resolved.actor.user_id,
            "sessionId": resolved.actor.session_id,
            "roles": list(resolved.actor.roles),
        },
        "tenant": {
            "organizationId": resolved.tenant.organization_id,
            "workspaceId": resolved.tenant.workspace_id,
        },
        "project": {
            "websiteProjectId": resolved.project.website_project_id,
            "websiteProjectKey": resolved.project.website_project_key,
        },
        "permissions": list(resolved.permissions),
        "correlationId": resolved.correlation_id,
    }


def _deserialize_context(payload: Mapping[str, object]) -> ResolvedPlatformRequestContext:
    actor = payload.get("actor")
    tenant = payload.get("tenant")
    project = payload.get("project")
    if not isinstance(actor, Mapping) or not isinstance(tenant, Mapping):
        raise ProjectContextProjectionError("Stored Platform context is invalid.")
    if not isinstance(project, Mapping):
        raise ProjectContextProjectionError("Stored project context is invalid.")
    permissions = payload.get("permissions")
    if not isinstance(permissions, list):
        raise ProjectContextProjectionError("Stored project permissions are invalid.")
    return ResolvedPlatformRequestContext(
        actor=PlatformActor(
            user_id=str(actor["userId"]),
            session_id=str(actor["sessionId"]),
            roles=tuple(str(value) for value in actor["roles"]),
        ),
        tenant=PlatformTenant(
            organization_id=str(tenant["organizationId"]),
            workspace_id=str(tenant["workspaceId"]),
        ),
        project=PlatformProject(
            website_project_id=str(project["websiteProjectId"]),
            website_project_key=str(project["websiteProjectKey"]),
        ),
        permissions=tuple(str(value) for value in permissions),
        correlation_id=str(payload["correlationId"]),
    )


class ProjectContextProjector:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def ensure_projected(
        self,
        resolved: ResolvedPlatformRequestContext,
        *,
        session: AsyncSession | None = None,
    ) -> ProjectContextProjection:
        if session is None:
            async with self._sessions() as owned_session, owned_session.begin():
                return await self.ensure_projected(
                    resolved,
                    session=owned_session,
                )
        else:
                now = datetime.now(UTC)
                project = (
                    await session.execute(
                        text(
                            """
                            SELECT p.id, p.organization_id, p.workspace_id,
                                   p.project_key, p.status, p.context_version,
                                   p.name, p.domain, p.country, p.target_market,
                                   p.language, p.current_profile_version_id,
                                   p.current_promotion_target_version_id,
                                   sp.profile_json, sp.user_overrides,
                                   sp.updated_at AS site_profile_updated_at,
                                   wp.version AS website_profile_version,
                                   wp.products AS website_products,
                                   wp.created_at AS website_profile_created_at,
                                   pt.version AS promotion_target_version,
                                   pt.keywords AS promotion_keywords,
                                   pt.target_urls AS promotion_target_urls,
                                   pt.target_audiences
                                     AS promotion_target_audiences,
                                   pt.partnership_goals
                                     AS promotion_partnership_goals,
                                   pt.created_at AS promotion_target_created_at
                              FROM platform.projects p
                              LEFT JOIN platform.site_profiles sp
                                ON sp.project_id = p.id
                               LEFT JOIN platform.website_profile_versions wp
                                 ON wp.id = p.current_profile_version_id
                                AND wp.project_id = p.id
                                AND wp.organization_id = p.organization_id
                                AND wp.workspace_id = p.workspace_id
                               LEFT JOIN platform.promotion_target_versions pt
                                 ON pt.id = p.current_promotion_target_version_id
                                AND pt.project_id = p.id
                                AND pt.organization_id = p.organization_id
                                AND pt.workspace_id = p.workspace_id
                              WHERE p.id = :project_id
                                AND p.project_key = :project_key
                                AND p.organization_id = :organization_id
                                AND p.workspace_id = :workspace_id
                              FOR UPDATE OF p
                            """
                        ),
                        {
                            "project_id": resolved.project.website_project_id,
                            "project_key": resolved.project.website_project_key,
                            "organization_id": resolved.tenant.organization_id,
                            "workspace_id": resolved.tenant.workspace_id,
                        },
                    )
                ).mappings().first()
                if project is None:
                    raise ProjectContextProjectionError(
                        "The Website Project no longer exists."
                    )
                if project["id"] != resolved.project.website_project_id:
                    raise ProjectContextProjectionError(
                        "The Website Project binding changed before projection."
                    )

                previous = (
                    await session.execute(
                        text(
                            """
                            SELECT id, aggregate_version, payload, status
                              FROM platform.project_outbox_events
                             WHERE project_id = :project_id
                               AND event_type = :event_type
                             ORDER BY aggregate_version DESC
                             LIMIT 1
                            """
                        ),
                        {
                            "project_id": project["id"],
                            "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                        },
                    )
                ).mappings().first()
                previous_payload = (
                    previous["payload"]
                    if previous is not None and isinstance(previous["payload"], dict)
                    else {}
                )
                latest_persisted_version = int(
                    await session.scalar(
                        text(
                            """
                            SELECT GREATEST(
                              COALESCE((
                                SELECT max(version)
                                  FROM platform.website_profile_versions
                                 WHERE project_id = :project_id
                              ), 0),
                              COALESCE((
                                SELECT max(version)
                                  FROM platform.promotion_target_versions
                                 WHERE project_id = :project_id
                              ), 0)
                            )
                            """
                        ),
                        {"project_id": project["id"]},
                    )
                    or 0
                )
                keyword_rows = (
                    await session.execute(
                        text(
                            """
                            SELECT id::text AS id, keyword, business_topic,
                                   updated_at
                              FROM public.keywords
                             WHERE project_id = :project_id
                               AND lower(country) = lower(:country)
                               AND lower(language) = lower(:language)
                               AND status = 'active'
                               AND review_status = 'approved'
                             ORDER BY priority_score DESC NULLS LAST, created_at, id
                             LIMIT 100
                            """
                        ),
                        {
                            "project_id": project["id"],
                            "country": project["country"],
                            "language": project["language"],
                        },
                    )
                ).mappings().all()
                published_rows = (
                    await session.execute(
                        text(
                            """
                            SELECT publication.id::text AS id,
                                   publication.remote_url,
                                   publication.version_number,
                                   publication.published_at,
                                   article.primary_keyword,
                                   article.title
                              FROM public.article_publications publication
                              JOIN public.articles article
                                ON article.id = publication.article_id
                               AND article.project_id = publication.project_id
                             WHERE publication.project_id = :project_id
                               AND publication.status = 'published'
                               AND publication.remote_url IS NOT NULL
                             ORDER BY publication.published_at DESC NULLS LAST,
                                      publication.created_at DESC
                             LIMIT 100
                            """
                        ),
                        {"project_id": project["id"]},
                    )
                ).mappings().all()
                competitor_run = (
                    await session.execute(
                        text(
                            """
                            SELECT run.id::text AS id, run.status, run.updated_at,
                                   run.discovery_keywords,
                                   COALESCE(
                                     jsonb_agg(
                                       DISTINCT competitor.domain
                                       ORDER BY competitor.domain
                                     ) FILTER (
                                       WHERE competitor.domain IS NOT NULL
                                         AND competitor.status = 'completed'
                                         AND competitor.selected_for_gap = true
                                     ),
                                     '[]'::jsonb
                                   ) AS domains
                              FROM public.keyword_competitor_analysis_runs run
                              LEFT JOIN public.keyword_competitors competitor
                                ON competitor.analysis_run_id = run.id
                               AND competitor.project_id = run.project_id
                             WHERE run.project_id = :project_id
                               AND run.status IN ('partial', 'completed')
                             GROUP BY run.id
                             ORDER BY run.updated_at DESC
                             LIMIT 1
                            """
                        ),
                        {"project_id": project["id"]},
                    )
                ).mappings().first()
                audit_run = (
                    await session.execute(
                        text(
                            """
                            SELECT run_id::text AS id, task_type, result_ref,
                                   finished_at
                              FROM crawling.crawl_runs
                             WHERE project_id = :project_id
                               AND status = 'completed'
                               AND task_type IN (
                                 'site_understanding',
                                 'technical_audit'
                               )
                             ORDER BY finished_at DESC NULLS LAST
                             LIMIT 1
                            """
                        ),
                        {"project_id": project["id"]},
                    )
                ).mappings().first()
                gsc_row = (
                    await session.execute(
                        text(
                            """
                            SELECT project_id::text AS id,
                                   site_url AS property_url,
                                   updated_at
                              FROM public.gsc_connections
                             WHERE project_id = :project_id
                               AND requires_reconnect = false
                            UNION ALL
                            SELECT project_id::text AS id, property_url,
                                   verified_at AS updated_at
                              FROM public.gsc_project_connections
                             WHERE project_id = :project_id
                             ORDER BY updated_at DESC
                             LIMIT 1
                            """
                        ),
                        {"project_id": project["id"]},
                    )
                ).mappings().first()
                domain = _canonical_domain(str(project["domain"]))
                upstream_keywords = _normalize_items(
                    [row["keyword"] for row in keyword_rows]
                )
                published_urls = _normalize_items(
                    [row["remote_url"] for row in published_rows]
                )
                published_topics = _normalize_items(
                    [
                        value
                        for row in published_rows
                        for value in (row["primary_keyword"], row["title"])
                        if isinstance(value, str)
                    ]
                )
                promotion_keywords = _normalize_items(
                    project["promotion_keywords"]
                )
                promotion_target_urls = _normalize_items(
                    project["promotion_target_urls"]
                )
                facts = {
                    "products": _normalize_items(project["website_products"]),
                    "keywords": list(promotion_keywords),
                    "target_urls": list(promotion_target_urls),
                    "target_audiences": _normalize_items(
                        project["promotion_target_audiences"]
                    ),
                    "partnership_goals": _normalize_items(
                        project["promotion_partnership_goals"]
                    ),
                }
                locale = str(project["language"] or "").strip()
                country_code = str(project["country"] or "").strip().upper()
                target_market = str(project["target_market"] or "").strip()
                input_required: list[str] = []
                profile_version_id = (
                    str(project["current_profile_version_id"])
                    if project["current_profile_version_id"] is not None
                    else None
                )
                promotion_target_version_id = (
                    str(project["current_promotion_target_version_id"])
                    if project["current_promotion_target_version_id"] is not None
                    else None
                )
                if profile_version_id is None:
                    input_required.append("PROJECTS:complete_site_profile")
                if not facts["products"]:
                    input_required.append("PROJECTS:complete_site_profile")
                if not locale or not country_code or not target_market:
                    input_required.append("PROJECTS:set_project_language_market")
                if promotion_target_version_id is None:
                    input_required.append(
                        "WEBSITE_PROJECT:publish_promotion_target"
                    )
                elif not promotion_keywords and not promotion_target_urls:
                    input_required.append(
                        "WEBSITE_PROJECT:add_promotion_topic_or_publish_target"
                    )
                previous_version = (
                    int(previous["aggregate_version"]) if previous is not None else 0
                )
                context_version = int(project["context_version"])
                website_observed_at = (
                    _as_utc(project["website_profile_created_at"], fallback=now)
                    if project["website_profile_created_at"] is not None
                    else None
                )
                promotion_observed_at = (
                    _as_utc(project["promotion_target_created_at"], fallback=now)
                    if project["promotion_target_created_at"] is not None
                    else None
                )
                organization_id = str(project["organization_id"])
                workspace_id = str(project["workspace_id"])
                actor_id = resolved.actor.user_id
                if input_required:
                    recovery_payload = {
                        "profileVersionId": profile_version_id,
                        "promotionTargetVersionId": promotion_target_version_id,
                        "inputRequired": input_required,
                    }
                    recovery_fingerprint = _fingerprint(
                        {
                            "recoveryContractVersion": 1,
                            "projectId": str(project["id"]),
                            "locale": locale,
                            "countryCode": country_code,
                            "targetMarket": target_market,
                            "products": facts["products"],
                            "promotionKeywords": promotion_keywords,
                            "promotionTargetUrls": promotion_target_urls,
                            **recovery_payload,
                        }
                    )
                    recovery_event_id = str(
                        uuid5(
                            NAMESPACE_URL,
                            (
                                "growthos:backlinks:projection-recovery:"
                                f"{project['id']}:{recovery_fingerprint}"
                            ),
                        )
                    )
                    await session.execute(
                        text(
                            """
                            INSERT INTO platform.project_audit_events (
                              id, organization_id, workspace_id, project_id,
                              event_type, context_version, payload, actor_id
                            ) VALUES (
                              :id, :organization_id, :workspace_id, :project_id,
                              :event_type, :context_version,
                              CAST(:payload AS jsonb), :actor_id
                            )
                            ON CONFLICT (id) DO NOTHING
                            """
                        ),
                        {
                            "id": recovery_event_id,
                            "organization_id": organization_id,
                            "workspace_id": workspace_id,
                            "project_id": project["id"],
                            "event_type": (
                                "BACKLINKS_RECOMMENDATION_RECOVERY_REQUIRED"
                            ),
                            "context_version": context_version,
                            "payload": _json(
                                {
                                    "fingerprint": recovery_fingerprint,
                                    **recovery_payload,
                                }
                            ),
                            "actor_id": actor_id,
                        },
                    )
                    return ProjectContextProjection(
                        event_id=None,
                        snapshot_version=context_version,
                        input_required=tuple(input_required),
                        outbox_status="recovery_required",
                    )

                assert profile_version_id is not None
                assert promotion_target_version_id is not None
                assert website_observed_at is not None
                assert promotion_observed_at is not None
                website_profile_version = int(project["website_profile_version"])
                promotion_target_version = int(
                    project["promotion_target_version"]
                )
                required_observed_at = min(
                    website_observed_at,
                    promotion_observed_at,
                )
                snapshot_version = max(
                    context_version,
                    previous_version + 1,
                    latest_persisted_version,
                )
                authorized_sources = [
                    "WEBSITE_PROJECT",
                    "CURATED_RESOURCE_LIBRARY",
                ]
                site_evidence = _evidence_reference(
                    organization_id=organization_id,
                    project_id=str(project["id"]),
                    source_module="site-profile",
                    source_record_id=profile_version_id,
                    source_version=str(website_profile_version),
                    evidence_type="website-project-profile",
                    normalized_parameters={
                        "canonicalDomain": domain,
                        "products": facts["products"],
                        "promotionTargetVersionId": promotion_target_version_id,
                        "promotionTargetVersion": promotion_target_version,
                        "targetAudiences": facts["target_audiences"],
                        "audit": (
                            {
                                "runId": str(audit_run["id"]),
                                "taskType": str(audit_run["task_type"]),
                                "resultRef": str(audit_run["result_ref"]),
                            }
                            if audit_run is not None
                            else None
                        ),
                    },
                    market=target_market,
                    location=country_code,
                    language=locale,
                    observed_at=required_observed_at,
                )
                shared_evidence = [site_evidence]
                if keyword_rows:
                    keyword_observed_at = max(
                        _as_utc(row["updated_at"], fallback=now)
                        for row in keyword_rows
                    )
                    if keyword_observed_at + timedelta(days=30) > now:
                        authorized_sources.append("KEYWORDS")
                        facts["keywords"] = _normalize_items(
                            [*facts["keywords"], *upstream_keywords]
                        )
                        shared_evidence.append(
                            _evidence_reference(
                                organization_id=organization_id,
                                project_id=str(project["id"]),
                                source_module="keywords",
                                source_record_id=str(project["id"]),
                                source_version=_fingerprint(
                                    [
                                        {
                                            "id": row["id"],
                                            "keyword": row["keyword"],
                                            "businessTopic": row["business_topic"],
                                            "updatedAt": _iso(
                                                _as_utc(
                                                    row["updated_at"],
                                                    fallback=now,
                                                )
                                            ),
                                        }
                                        for row in keyword_rows
                                    ]
                                ),
                                evidence_type="approved-keyword-set",
                                normalized_parameters={
                                    "keywords": upstream_keywords,
                                    "businessTopics": _normalize_items(
                                        [
                                            row["business_topic"]
                                            for row in keyword_rows
                                            if isinstance(
                                                row["business_topic"],
                                                str,
                                            )
                                        ]
                                    ),
                                },
                                market=target_market,
                                location=country_code,
                                language=locale,
                                observed_at=keyword_observed_at,
                            )
                        )
                content_is_fresh = False
                if published_rows:
                    content_observed_at = max(
                        _as_utc(row["published_at"], fallback=now)
                        for row in published_rows
                    )
                    content_is_fresh = (
                        content_observed_at + timedelta(days=30) > now
                    )
                    if content_is_fresh:
                        authorized_sources.append("CONTENT")
                        facts["keywords"] = _normalize_items(
                            [*facts["keywords"], *published_topics]
                        )
                        facts["target_urls"] = _normalize_items(
                            [*facts["target_urls"], *published_urls]
                        )
                        shared_evidence.append(
                            _evidence_reference(
                                organization_id=organization_id,
                                project_id=str(project["id"]),
                                source_module="content",
                                source_record_id=str(project["id"]),
                                source_version=_fingerprint(
                                    [
                                        {
                                            "id": row["id"],
                                            "version": row["version_number"],
                                            "url": row["remote_url"],
                                            "publishedAt": _iso(
                                                _as_utc(
                                                    row["published_at"],
                                                    fallback=now,
                                                )
                                            ),
                                        }
                                        for row in published_rows
                                    ]
                                ),
                                evidence_type="published-content-targets",
                                normalized_parameters={
                                    "targetUrls": published_urls,
                                    "topics": published_topics,
                                },
                                market=target_market,
                                location=country_code,
                                language=locale,
                                observed_at=content_observed_at,
                            )
                        )
                competitor_domains = (
                    _normalize_items(competitor_run["domains"])
                    if competitor_run is not None
                    else []
                )
                if competitor_run is not None and competitor_domains:
                    competitor_observed_at = _as_utc(
                        competitor_run["updated_at"],
                        fallback=now,
                    )
                    if competitor_observed_at + timedelta(days=30) > now:
                        authorized_sources.append("COMPETITOR_SERP")
                        shared_evidence.append(
                            _evidence_reference(
                                organization_id=organization_id,
                                project_id=str(project["id"]),
                                source_module="competitor-serp",
                                source_record_id=str(competitor_run["id"]),
                                source_version=_iso(competitor_observed_at),
                                evidence_type="competitor-domain-seeds",
                                normalized_parameters={
                                    "domains": competitor_domains,
                                    "discoveryKeywords": _normalize_items(
                                        competitor_run["discovery_keywords"]
                                    ),
                                },
                                market=target_market,
                                location=country_code,
                                language=locale,
                                observed_at=competitor_observed_at,
                            )
                        )
                if gsc_row is not None:
                    gsc_observed_at = _as_utc(
                        gsc_row["updated_at"],
                        fallback=now,
                    )
                    if gsc_observed_at + timedelta(days=30) > now:
                        authorized_sources.append("GSC")
                        shared_evidence.append(
                            _evidence_reference(
                                organization_id=organization_id,
                                project_id=str(project["id"]),
                                source_module="gsc",
                                source_record_id=str(gsc_row["id"]),
                                source_version=_iso(gsc_observed_at),
                                evidence_type="gsc-project-connection",
                                normalized_parameters={
                                    "propertyUrl": str(gsc_row["property_url"]),
                                },
                                market=target_market,
                                location=country_code,
                                language=locale,
                                observed_at=gsc_observed_at,
                            )
                        )

                stable_facts = {
                    "projectStatus": (
                        "ACTIVE" if project["status"] == "ACTIVE" else "PAUSED"
                    ),
                    "canonicalDomain": domain,
                    "locale": locale,
                    "countryCode": country_code,
                    "targetMarket": target_market,
                    "profileVersionId": profile_version_id,
                    "promotionTargetVersionId": promotion_target_version_id,
                    "products": facts["products"],
                    "keywords": facts["keywords"],
                    "targetUrls": facts["target_urls"],
                    "targetAudiences": facts["target_audiences"],
                    "partnershipGoals": facts["partnership_goals"],
                    "inputComplete": not input_required,
                }
                fingerprint = _fingerprint(
                    {
                        "projectionFingerprintVersion": 2,
                        **stable_facts,
                        "authorizedDiscoverySources": authorized_sources,
                        "sharedEvidence": [
                            {
                                "recordId": item["recordId"],
                                "sourceModule": item["snapshot"]["sourceModule"],
                                "sourceRecordId": item["snapshot"]["sourceRecordId"],
                                "sourceVersion": item["snapshot"]["sourceVersion"],
                            }
                            for item in shared_evidence
                        ],
                    }
                )
                if (
                    previous is not None
                    and previous_payload.get("fingerprint") == fingerprint
                ):
                    return ProjectContextProjection(
                        event_id=str(previous["id"]),
                        snapshot_version=int(previous["aggregate_version"]),
                        input_required=tuple(input_required),
                        outbox_status=str(previous["status"]),
                    )
                snapshot_id = str(uuid4())
                job_id = str(uuid4())
                event_id = str(uuid4())
                audit_event_id = str(uuid4())
                outreach_fingerprint = _fingerprint(
                    {
                        "organizationId": organization_id,
                        "websiteProjectId": project["id"],
                        **stable_facts,
                        "authorizedDiscoverySources": authorized_sources,
                    }
                )
                outreach_record_id = str(
                    uuid5(
                        NAMESPACE_URL,
                        f"growthos:backlinks:outreach-profile:{outreach_fingerprint}",
                    )
                )
                pin_fingerprint = _fingerprint(
                    {
                        "projectContextVersion": snapshot_version,
                        "siteProfileVersionId": profile_version_id,
                        "outreachProfileVersionId": profile_version_id,
                        "promotionTargetVersionId": promotion_target_version_id,
                        "evidence": [
                            item["recordId"] for item in shared_evidence
                        ],
                        "market": target_market,
                        "qualificationContractVersion": (
                            "recommendation-qualification.v1"
                        ),
                    }
                )
                pin_record_id = str(
                    uuid5(
                        NAMESPACE_URL,
                        f"growthos:backlinks:generation-pin:{pin_fingerprint}",
                    )
                )
                request_payload = {
                    "snapshotId": snapshot_id,
                    "snapshotVersion": snapshot_version,
                    **stable_facts,
                    "jobId": job_id,
                    "outboxEventId": event_id,
                    "outreachProfile": {
                        "recordId": outreach_record_id,
                        "immutableFingerprint": outreach_fingerprint,
                        "profile": {
                            "organizationId": organization_id,
                            "websiteProjectId": str(project["id"]),
                            "profileVersionId": profile_version_id,
                            "promotionTargetVersionId": (
                                promotion_target_version_id
                            ),
                            "keywordsAndTopics": facts["keywords"],
                            "productsAndServices": facts["products"],
                            "targetUrls": facts["target_urls"],
                            "targetAudiences": facts["target_audiences"],
                            "partnershipGoals": facts["partnership_goals"],
                            "market": target_market,
                            "location": country_code,
                            "language": locale,
                            "authorizedDiscoverySources": authorized_sources,
                            "immutableFingerprint": outreach_fingerprint,
                        },
                    },
                    "sharedSeoEvidence": shared_evidence,
                    "generationInputPins": {
                        "recordId": pin_record_id,
                        "outreachProfileRecordId": outreach_record_id,
                        "immutableFingerprint": pin_fingerprint,
                        "pins": {
                            "organizationId": organization_id,
                            "websiteProjectId": str(project["id"]),
                            "projectContextVersion": snapshot_version,
                            "siteProfileVersionId": profile_version_id,
                            "outreachProfileVersionId": profile_version_id,
                            "promotionTargetVersionId": (
                                promotion_target_version_id
                            ),
                            "keywordEvidenceSnapshotIds": [
                                item["recordId"]
                                for item in shared_evidence
                                if item["snapshot"]["sourceModule"]
                                == "keywords"
                            ],
                            "sharedEvidenceSnapshotIds": [
                                item["recordId"] for item in shared_evidence
                            ],
                            "market": target_market,
                            "qualificationContractVersion": (
                                "recommendation-qualification.v1"
                            ),
                        },
                    },
                }
                outbox_payload = {
                    "schemaVersion": 2,
                    "fingerprint": fingerprint,
                    "context": _serialize_context(resolved),
                    "request": request_payload,
                    "inputRequired": input_required,
                }
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.project_outbox_events (
                          id, organization_id, workspace_id, project_id, event_type,
                          aggregate_version, payload, status, created_by
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_id, :event_type,
                          :aggregate_version, CAST(:payload AS jsonb), 'pending', :created_by
                        )
                        """
                    ),
                    {
                        "id": event_id,
                        "organization_id": organization_id,
                        "workspace_id": workspace_id,
                        "project_id": project["id"],
                        "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                        "aggregate_version": snapshot_version,
                        "payload": _json(outbox_payload),
                        "created_by": actor_id,
                    },
                )
                await session.execute(
                    text(
                        """
                        INSERT INTO platform.project_audit_events (
                          id, organization_id, workspace_id, project_id, event_type,
                          context_version, payload, actor_id
                        ) VALUES (
                          :id, :organization_id, :workspace_id, :project_id, :event_type,
                          :context_version, CAST(:payload AS jsonb), :actor_id
                        )
                        """
                    ),
                    {
                        "id": audit_event_id,
                        "organization_id": organization_id,
                        "workspace_id": workspace_id,
                        "project_id": project["id"],
                        "event_type": "BACKLINKS_PROJECT_CONTEXT_VERSION_CREATED",
                        "context_version": snapshot_version,
                        "payload": _json(
                            {
                                "outboxEventId": event_id,
                                "fingerprint": fingerprint,
                                "inputRequired": input_required,
                            }
                        ),
                        "actor_id": actor_id,
                    },
                )
                await session.execute(
                    text(
                        """
                        UPDATE platform.projects
                           SET context_version = :context_version,
                               updated_at = now()
                         WHERE id = :project_id
                        """
                    ),
                    {
                        "context_version": snapshot_version,
                        "project_id": project["id"],
                    },
                )
                return ProjectContextProjection(
                    event_id=event_id,
                    snapshot_version=snapshot_version,
                    input_required=tuple(input_required),
                    outbox_status="pending",
                )


class ProjectContextProjectionDispatcher:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        publisher: ProjectContextPublisher,
    ) -> None:
        self._sessions = sessions
        self._publisher = publisher

    async def dispatch_event(self, event_id: str) -> ProjectContextDispatch:
        async with self._sessions() as session, session.begin():
            locked = await session.scalar(
                text("SELECT pg_try_advisory_xact_lock(hashtext(:event_id))"),
                {"event_id": event_id},
            )
            if not locked:
                return ProjectContextDispatch(event_id=event_id, status="pending")
            event = (
                await session.execute(
                    text(
                        """
                        SELECT id, payload, status, attempt_count
                          FROM platform.project_outbox_events
                         WHERE id = :event_id
                           AND event_type = :event_type
                         FOR UPDATE
                        """
                    ),
                    {
                        "event_id": event_id,
                        "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                    },
                )
            ).mappings().first()
            if event is None:
                raise ProjectContextProjectionError(
                    "The project context outbox event does not exist."
                )
            if event["status"] == "published":
                return ProjectContextDispatch(event_id=event_id, status="published")
            payload = event["payload"]
            if not isinstance(payload, dict):
                raise ProjectContextProjectionError(
                    "The project context outbox payload is invalid."
                )
            context = payload.get("context")
            request_payload = payload.get("request")
            if not isinstance(context, dict) or not isinstance(request_payload, dict):
                raise ProjectContextProjectionError(
                    "The project context outbox payload is incomplete."
                )
            resolved = _deserialize_context(context)
            attempt_count = int(event["attempt_count"]) + 1
            try:
                response = await self._publisher.publish_project_context(
                    resolved=resolved,
                    website_project_key=resolved.project.website_project_key,
                    payload=request_payload,
                )
            except Exception as error:  # noqa: BLE001 - persist delivery failures.
                retryable = attempt_count < PROJECT_CONTEXT_MAX_DELIVERY_ATTEMPTS
                await self._mark_failed(
                    session,
                    event_id=event_id,
                    attempt_count=attempt_count,
                    retryable=retryable,
                    failure_code=(
                        "delivery_error" if retryable else "retry_exhausted"
                    ),
                    last_error=f"{type(error).__name__}: {error}"[:2_000],
                )
                return ProjectContextDispatch(event_id=event_id, status="failed")
            if 200 <= response.status_code < 300:
                await session.execute(
                    text(
                        """
                        UPDATE platform.project_outbox_events
                           SET status = 'published',
                               attempt_count = :attempt_count,
                               retryable = true,
                               failure_code = NULL,
                               last_error = NULL,
                               published_at = now()
                         WHERE id = :event_id
                        """
                    ),
                    {
                        "event_id": event_id,
                        "attempt_count": attempt_count,
                    },
                )
                return ProjectContextDispatch(
                    event_id=event_id,
                    status="published",
                    upstream_status=response.status_code,
                )
            body = bytes(response.body).decode("utf-8", errors="replace")[:2_000]
            upstream_retryable = _retryable_upstream_status(response.status_code)
            retryable = (
                upstream_retryable
                and attempt_count < PROJECT_CONTEXT_MAX_DELIVERY_ATTEMPTS
            )
            await self._mark_failed(
                session,
                event_id=event_id,
                attempt_count=attempt_count,
                retryable=retryable,
                failure_code=(
                    "upstream_retryable"
                    if retryable
                    else (
                        "retry_exhausted"
                        if upstream_retryable
                        else "upstream_rejected"
                    )
                ),
                last_error=f"HTTP {response.status_code}: {body}",
            )
            return ProjectContextDispatch(
                event_id=event_id,
                status="failed",
                upstream_status=response.status_code,
            )

    async def _mark_failed(
        self,
        session: AsyncSession,
        *,
        event_id: str,
        attempt_count: int,
        retryable: bool,
        failure_code: str,
        last_error: str,
    ) -> None:
        await session.execute(
            text(
                """
                UPDATE platform.project_outbox_events
                   SET status = 'failed',
                       attempt_count = :attempt_count,
                       next_attempt_at = :next_attempt_at,
                       retryable = :retryable,
                       failure_code = :failure_code,
                       last_error = :last_error
                 WHERE id = :event_id
                """
            ),
            {
                "event_id": event_id,
                "attempt_count": attempt_count,
                "next_attempt_at": _delivery_retry_at(attempt_count),
                "retryable": retryable,
                "failure_code": failure_code,
                "last_error": last_error,
            },
        )

    async def dispatch_pending(self, *, limit: int = 25) -> None:
        async with self._sessions() as session:
            event_ids = (
                await session.execute(
                    text(
                        """
                        SELECT event.id
                          FROM platform.project_outbox_events AS event
                         WHERE event.event_type = :event_type
                           AND event.next_attempt_at <= now()
                           AND (
                              event.status = 'pending'
                              OR (
                                event.status = 'failed'
                                AND event.retryable
                                AND event.attempt_count < :max_attempts
                              )
                            )
                           AND NOT EXISTS (
                             SELECT 1
                               FROM platform.project_outbox_events AS newer
                              WHERE newer.event_type = event.event_type
                                AND newer.project_id = event.project_id
                                AND newer.status = 'published'
                                AND newer.aggregate_version >
                                    event.aggregate_version
                           )
                         ORDER BY event.next_attempt_at, event.created_at
                         LIMIT :limit
                        """
                    ),
                    {
                        "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                        "limit": limit,
                        "max_attempts": PROJECT_CONTEXT_MAX_DELIVERY_ATTEMPTS,
                    },
                )
            ).scalars().all()
        for event_id in event_ids:
            await self.dispatch_event(str(event_id))

    async def health_snapshot(self) -> dict[str, object]:
        async with self._sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        WITH current_delivery_events AS (
                          SELECT event.*
                            FROM platform.project_outbox_events AS event
                           WHERE event.event_type = :event_type
                             AND NOT EXISTS (
                               SELECT 1
                                 FROM platform.project_outbox_events AS newer
                                WHERE newer.event_type = event.event_type
                                  AND newer.project_id = event.project_id
                                  AND newer.status = 'published'
                                  AND newer.aggregate_version >
                                      event.aggregate_version
                             )
                        )
                        SELECT
                          count(*) FILTER (
                            WHERE status = 'pending'
                              AND next_attempt_at <= now()
                          )::integer AS due_pending,
                          count(*) FILTER (
                            WHERE status = 'failed'
                              AND retryable
                              AND attempt_count < :max_attempts
                          )::integer AS retryable_failed,
                          count(*) FILTER (
                            WHERE status = 'failed'
                              AND NOT retryable
                              AND failure_code <> 'retry_exhausted'
                          )::integer AS permanent_failed,
                          count(*) FILTER (
                            WHERE status = 'failed'
                              AND failure_code = 'retry_exhausted'
                          )::integer AS exhausted,
                          min(created_at) FILTER (
                            WHERE status = 'pending'
                               OR (status = 'failed' AND retryable)
                          ) AS oldest_waiting_at,
                          (
                            array_agg(failure_code ORDER BY created_at DESC)
                              FILTER (WHERE status = 'failed')
                          )[1] AS latest_failure_code,
                          (
                            array_agg(last_error ORDER BY created_at DESC)
                              FILTER (WHERE status = 'failed')
                          )[1] AS latest_error
                        FROM current_delivery_events
                        """
                    ),
                    {
                        "event_type": PROJECT_CONTEXT_EVENT_TYPE,
                        "max_attempts": PROJECT_CONTEXT_MAX_DELIVERY_ATTEMPTS,
                    },
                )
            ).mappings().one()
        oldest_waiting_at = row["oldest_waiting_at"]
        return {
            "due_pending": int(row["due_pending"] or 0),
            "retryable_failed": int(row["retryable_failed"] or 0),
            "permanent_failed": int(row["permanent_failed"] or 0),
            "exhausted": int(row["exhausted"] or 0),
            "oldest_waiting_at": (
                _iso(oldest_waiting_at)
                if isinstance(oldest_waiting_at, datetime)
                else None
            ),
            "latest_failure_code": row["latest_failure_code"],
            "latest_error": row["latest_error"],
        }
