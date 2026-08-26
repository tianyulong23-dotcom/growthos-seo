from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.projects.schemas import ProjectOutreachReadinessResponse
from app.modules.projects.service import ProjectNotFoundError

PROJECT_OUTREACH_READINESS_SQL = """
SELECT project.id AS website_project_id,
       project.status AS lifecycle_status,
       project.context_version,
       understanding.status AS understanding_status,
       profile.id AS site_profile_version_id,
       profile.created_at AS site_profile_created_at,
       COALESCE(
         NULLIF(site_profile.profile_json ->> 'confirmed_at', ''),
         NULLIF(site_profile.user_overrides ->> 'confirmed_at', '')
       ) IS NOT NULL AS site_profile_confirmed,
       profile.products,
       profile.input_required AS site_profile_input_required,
       project.country,
       project.target_market,
       project.language,
       target.id AS promotion_target_version_id,
       target.created_at AS promotion_target_created_at,
       target.keywords,
       target.target_urls,
       target.input_required AS promotion_target_input_required,
       promotion_event.payload
         -> 'validationContext'
         ->> 'siteProfileVersionId'
         AS promotion_source_site_profile_version_id
  FROM platform.projects project
  LEFT JOIN crawling.crawl_runs understanding
    ON understanding.run_id = project.understanding_run_id
  LEFT JOIN platform.site_profiles site_profile
    ON site_profile.project_id = project.id
  LEFT JOIN platform.website_profile_versions profile
    ON profile.id = project.current_profile_version_id
   AND profile.organization_id = project.organization_id
   AND profile.workspace_id = project.workspace_id
   AND profile.project_id = project.id
  LEFT JOIN platform.promotion_target_versions target
    ON target.id = project.current_promotion_target_version_id
   AND target.organization_id = project.organization_id
   AND target.workspace_id = project.workspace_id
   AND target.project_id = project.id
  LEFT JOIN LATERAL (
    SELECT event.payload
      FROM platform.project_audit_events event
     WHERE event.organization_id = project.organization_id
       AND event.workspace_id = project.workspace_id
       AND event.project_id = project.id
       AND event.event_type = 'PROMOTION_TARGET_VERSION_PUBLISHED'
       AND event.payload ->> 'promotionTargetVersionId' = target.id
     ORDER BY event.created_at DESC
     LIMIT 1
  ) promotion_event ON true
 WHERE project.id = :project_id
   AND project.organization_id = :organization_id
   AND project.workspace_id = :workspace_id
"""


@dataclass(frozen=True)
class ProjectOutreachReadinessSnapshot:
    website_project_id: str
    lifecycle_status: str
    context_version: int
    understanding_status: str | None
    site_profile_version_id: str | None
    site_profile_created_at: datetime | None
    site_profile_confirmed: bool
    products: tuple[str, ...]
    site_profile_input_required: tuple[str, ...]
    country: str
    target_market: str
    language: str
    promotion_target_version_id: str | None
    promotion_target_created_at: datetime | None
    keywords: tuple[str, ...]
    target_urls: tuple[str, ...]
    promotion_target_input_required: tuple[str, ...]
    promotion_source_site_profile_version_id: str | None


def _normalized_items(values: Any) -> tuple[str, ...]:
    if not isinstance(values, (list, tuple)):
        return ()
    return tuple(
        dict.fromkeys(
            str(value).strip()
            for value in values
            if str(value).strip()
        )
    )


def _fingerprint(
    snapshot: ProjectOutreachReadinessSnapshot,
    *,
    status: str,
    input_required: list[str],
) -> str:
    payload = {
        "websiteProjectId": snapshot.website_project_id,
        "projectContextVersion": snapshot.context_version,
        "status": status,
        "siteProfileVersionId": snapshot.site_profile_version_id,
        # The current projection intentionally pins outreach and site profile
        # to the same immutable Website Profile version.
        "outreachProfileVersionId": snapshot.site_profile_version_id,
        "promotionTargetVersionId": snapshot.promotion_target_version_id,
        "inputRequired": input_required,
    }
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return f"sha256:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"


def build_project_outreach_readiness(
    snapshot: ProjectOutreachReadinessSnapshot,
) -> ProjectOutreachReadinessResponse:
    input_required = list(
        dict.fromkeys(
            (
                *snapshot.site_profile_input_required,
                *snapshot.promotion_target_input_required,
            )
        )
    )

    if snapshot.lifecycle_status != "ACTIVE":
        input_required.append("PROJECTS:restore_project")
        status = "INPUT_REQUIRED"
        primary_action = "RESTORE_PROJECT"
    elif snapshot.understanding_status in {"queued", "running"}:
        status = "REFRESHING"
        primary_action = "WAIT_FOR_SITE_PROFILE"
    elif snapshot.site_profile_version_id is None or not snapshot.products:
        input_required.append("PROJECTS:complete_site_profile")
        status = "INPUT_REQUIRED"
        primary_action = "COMPLETE_SITE_PROFILE"
    elif not snapshot.site_profile_confirmed:
        input_required.append("PROJECTS:confirm_business_profile")
        status = "INPUT_REQUIRED"
        primary_action = "CONFIRM_BUSINESS_PROFILE"
    elif not snapshot.country or not snapshot.target_market or not snapshot.language:
        input_required.append("PROJECTS:set_project_language_market")
        status = "INPUT_REQUIRED"
        primary_action = "SET_PROJECT_LANGUAGE_MARKET"
    elif snapshot.promotion_target_version_id is None:
        input_required.append("WEBSITE_PROJECT:publish_promotion_target")
        status = "INPUT_REQUIRED"
        primary_action = "PUBLISH_PROMOTION_TARGET"
    elif not snapshot.keywords and not snapshot.target_urls:
        input_required.append(
            "WEBSITE_PROJECT:add_promotion_topic_or_publish_target"
        )
        status = "INPUT_REQUIRED"
        primary_action = "ADD_PROMOTION_TOPIC_OR_PUBLISHED_TARGET"
    else:
        source_profile_id = snapshot.promotion_source_site_profile_version_id
        missing_lineage_is_stale = (
            source_profile_id is None
            and snapshot.site_profile_created_at is not None
            and snapshot.promotion_target_created_at is not None
            and snapshot.site_profile_created_at
            > snapshot.promotion_target_created_at
        )
        if (
            source_profile_id is not None
            and source_profile_id != snapshot.site_profile_version_id
        ) or missing_lineage_is_stale:
            input_required.append("WEBSITE_PROJECT:republish_promotion_target")
            status = "STALE"
            primary_action = "REPUBLISH_PROMOTION_TARGET"
        elif input_required:
            status = "INPUT_REQUIRED"
            primary_action = "REVIEW_PROJECT_INPUTS"
        else:
            status = "READY"
            primary_action = "OPEN_RECOMMENDATIONS"

    normalized_required = list(dict.fromkeys(input_required))
    return ProjectOutreachReadinessResponse(
        website_project_id=snapshot.website_project_id,
        status=status,
        site_profile_version_id=snapshot.site_profile_version_id,
        outreach_profile_version_id=snapshot.site_profile_version_id,
        promotion_target_version_id=snapshot.promotion_target_version_id,
        fingerprint=_fingerprint(
            snapshot,
            status=status,
            input_required=normalized_required,
        ),
        input_required=normalized_required,
        primary_recovery_action=primary_action,
    )


class ProjectOutreachReadinessService:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        settings: Settings,
    ) -> None:
        self._sessions = sessions
        self._settings = settings

    async def get(
        self,
        project_id: str,
        *,
        organization_id: str | None,
        workspace_id: str,
    ) -> ProjectOutreachReadinessResponse:
        resolved_organization_id = (
            organization_id or self._settings.default_organization_id
        )
        async with self._sessions() as session:
            row = (
                await session.execute(
                    text(PROJECT_OUTREACH_READINESS_SQL),
                    {
                        "project_id": project_id,
                        "organization_id": resolved_organization_id,
                        "workspace_id": workspace_id,
                    },
                )
            ).mappings().first()
        if row is None:
            raise ProjectNotFoundError
        return build_project_outreach_readiness(
            ProjectOutreachReadinessSnapshot(
                website_project_id=str(row["website_project_id"]),
                lifecycle_status=str(row["lifecycle_status"]),
                context_version=int(row["context_version"]),
                understanding_status=(
                    str(row["understanding_status"])
                    if row["understanding_status"] is not None
                    else None
                ),
                site_profile_version_id=(
                    str(row["site_profile_version_id"])
                    if row["site_profile_version_id"] is not None
                    else None
                ),
                site_profile_created_at=row["site_profile_created_at"],
                site_profile_confirmed=bool(row["site_profile_confirmed"]),
                products=_normalized_items(row["products"]),
                site_profile_input_required=_normalized_items(
                    row["site_profile_input_required"]
                ),
                country=str(row["country"] or "").strip(),
                target_market=str(row["target_market"] or "").strip(),
                language=str(row["language"] or "").strip(),
                promotion_target_version_id=(
                    str(row["promotion_target_version_id"])
                    if row["promotion_target_version_id"] is not None
                    else None
                ),
                promotion_target_created_at=row["promotion_target_created_at"],
                keywords=_normalized_items(row["keywords"]),
                target_urls=_normalized_items(row["target_urls"]),
                promotion_target_input_required=_normalized_items(
                    row["promotion_target_input_required"]
                ),
                promotion_source_site_profile_version_id=(
                    str(row["promotion_source_site_profile_version_id"])
                    if row["promotion_source_site_profile_version_id"] is not None
                    else None
                ),
            )
        )


def build_project_outreach_readiness_service() -> ProjectOutreachReadinessService:
    return ProjectOutreachReadinessService(session_factory, get_settings())
