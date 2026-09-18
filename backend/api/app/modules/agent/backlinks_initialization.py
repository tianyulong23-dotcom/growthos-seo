"""Project-owned initialization; no discovery, model calls, or mail side effects."""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.modules.agent.delegation import resolve_delegation
from app.modules.projects.readiness import build_project_outreach_readiness_service
from app.modules.projects.schemas import ConfirmPromotionTargetRequest
from app.modules.projects.service import ProjectNotFoundError


def readiness_state(readiness) -> dict:
    action = readiness.primary_recovery_action
    state = {
        "PUBLISH_PROMOTION_TARGET": "PROMOTION_TARGET_REQUIRED",
        "WAIT_FOR_SITE_PROFILE": "PROFILE_REFRESHING",
        "REPUBLISH_PROMOTION_TARGET": "PROMOTION_TARGET_STALE",
        "OPEN_RECOMMENDATIONS": "PROJECT_READY",
    }.get(action, "PROJECT_INPUT_REQUIRED")
    return {
        "state": state,
        "retryable": state == "PROFILE_REFRESHING",
        "nextAction": (
            "initialize_backlink_project"
            if state == "PROMOTION_TARGET_REQUIRED" else action
        ),
        "readiness": readiness.model_dump(mode="json"),
    }


async def recommendation_read_failure(
    context, *, readiness_service=None, sessions=None, runtime_settings=None,
) -> dict | None:
    """A 404 alone proves neither missing inputs nor projection lag."""
    service = readiness_service or build_project_outreach_readiness_service()
    try:
        readiness = await service.get(
            context.project.website_project_id,
            organization_id=context.tenant.organization_id,
            workspace_id=context.tenant.workspace_id,
        )
        state = readiness_state(readiness)
        if state["state"] != "PROJECT_READY":
            return state
        if (
            runtime_settings is not None
            and not runtime_settings.backlinks_project_projection_enabled
        ):
            return {
                **state, "state": "PROJECT_SYNC_DISABLED", "retryable": False,
                "nextAction": "RESTORE_PROJECT_PROJECTION_RUNTIME",
            }
        if sessions is None:
            from app.db.session import session_factory
            sessions = session_factory
        async with sessions() as session:
            # Only a pending event for the current immutable inputs proves syncing.
            row = (await session.execute(text("""
                SELECT status,
                       payload->'request'->'generationInputPins'->'pins'
                         ->>'siteProfileVersionId' AS profile_id,
                       payload->'request'->'generationInputPins'->'pins'
                         ->>'promotionTargetVersionId' AS target_id
                  FROM platform.project_outbox_events
                 WHERE project_id = :project_id
                   AND organization_id = :organization_id
                   AND workspace_id = :workspace_id
                   AND event_type = 'backlinks.project-context.projection.requested.v1'
                 ORDER BY aggregate_version DESC, created_at DESC
                 LIMIT 1
            """), {
                "project_id": context.project.website_project_id,
                "organization_id": context.tenant.organization_id,
                "workspace_id": context.tenant.workspace_id,
            })).mappings().first()
        if (
            row and row["status"] == "pending"
            and row["profile_id"] == readiness.site_profile_version_id
            and row["target_id"] == readiness.promotion_target_version_id
        ):
            return {
                **state, "state": "PROJECTION_PENDING", "retryable": True,
                "nextAction": "get_backlink_readiness",
            }
        if row is None:
            return {
                **state, "state": "PROJECTION_REQUIRED", "retryable": False,
                "nextAction": "initialize_backlink_project",
            }
    except (ProjectNotFoundError, SQLAlchemyError, OSError, TimeoutError):
        # Retain the original read failure when diagnostic evidence is unavailable.
        return None
    return None


class BacklinksInitialization:
    def __init__(self, registry):
        self.registry = registry

    async def snapshot(self, project_id, organization_id, delegation, *, write=False):
        registry = self.registry
        registry._require_service(registry.backlinks, "backlink_initialization")
        context = await resolve_delegation(
            registry.settings, registry.backlinks.projects, delegation,
            project_id, organization_id,
            required_permission="projects:write" if write else "projects:read",
        )
        scope = {
            "organization_id": context.tenant.organization_id,
            "workspace_id": context.tenant.workspace_id,
        }
        readiness = await registry.outreach_readiness.get(project_id, **scope)
        return context, scope, readiness

    async def read(self, project_id, organization_id, delegation):
        _, _, readiness = await self.snapshot(project_id, organization_id, delegation)
        state = readiness_state(readiness)
        if state["state"] != "PROJECT_READY":
            return state
        feed = await self.registry.backlinks.read(
            project_id, organization_id, "list_backlink_recommendations",
            {"limit": 1}, delegation=delegation,
        )
        data = feed["data"]
        return {
            **state,
            "state": "NOT_GENERATED" if data["latestGeneration"] is None else "GENERATION_EXISTS",
            "nextAction": (
                "start_backlink_recommendations"
                if data["latestGeneration"] is None else "list_backlink_recommendations"
            ),
            "latestGeneration": data["latestGeneration"],
            "totalCount": data["totalCount"],
        }

    async def prepare(self, project_id, organization_id, delegation):
        _, scope, readiness = await self.snapshot(
            project_id, organization_id, delegation, write=True,
        )
        if readiness.promotion_target_version_id is not None:
            return {"existingTargetId": readiness.promotion_target_version_id}
        if readiness.primary_recovery_action != "PUBLISH_PROMOTION_TARGET":
            raise ValueError(
                "BACKLINKS_PROJECT_INPUT_REQUIRED: " + readiness.primary_recovery_action
            )
        project = await self.registry.projects.get(project_id, **scope)
        if project is None:
            raise ProjectNotFoundError
        if project.site_profile is None:
            raise ValueError("BACKLINKS_PROJECT_INPUT_REQUIRED: COMPLETE_SITE_PROFILE")
        request = ConfirmPromotionTargetRequest(
            confirmed_topics=project.site_profile.products_services,
            confirmed_target_urls=[f"https://{project.domain}/"],
            expected_project_context_version=project.context_version,
            expected_site_profile_version_id=readiness.site_profile_version_id,
        )
        return {
            "request": request.model_dump(mode="json"),
            "readinessFingerprint": readiness.fingerprint,
        }

    async def execute(self, project_id, organization_id, delegation, before):
        context, scope, readiness = await self.snapshot(
            project_id, organization_id, delegation, write=True,
        )
        if readiness.promotion_target_version_id is not None:
            if self.registry.settings.backlinks_project_projection_enabled:
                from app.db.session import session_factory
                from app.modules.projects.backlinks_projection import ProjectContextProjector

                # A target confirmed during maintenance has no outbox event yet.
                # The official projector is locked and idempotent; do not reconfirm.
                await ProjectContextProjector(session_factory).ensure_projected(context)
            return {
                "state": "ALREADY_INITIALIZED",
                "verified": True,
                "promotionTargetVersionId": readiness.promotion_target_version_id,
                "nextAction": "get_backlink_readiness",
            }
        if (
            readiness.primary_recovery_action != "PUBLISH_PROMOTION_TARGET"
            or readiness.fingerprint != before.get("readinessFingerprint")
        ):
            raise ValueError("BACKLINKS_INITIALIZATION_CHANGED: read current project inputs")
        result = await self.registry.projects.confirm_promotion_target(
            project_id, ConfirmPromotionTargetRequest.model_validate(before["request"]),
            **scope, created_by=context.actor.user_id,
        )
        return {
            "state": "INITIALIZED",
            "verified": True,
            "promotionTargetVersionId": result.id,
            "nextAction": "get_backlink_readiness",
            "generationStarted": False,
            "emailsSent": False,
        }
