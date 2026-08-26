from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient

from app.api.routes.projects import (
    get_project_outreach_readiness_service,
    get_project_service,
)
from app.main import app
from app.modules.projects.readiness import (
    PROJECT_OUTREACH_READINESS_SQL,
    ProjectOutreachReadinessSnapshot,
    build_project_outreach_readiness,
)
from app.modules.projects.schemas import PromotionTargetVersionResponse


def snapshot(**overrides: object) -> ProjectOutreachReadinessSnapshot:
    values: dict[str, object] = {
        "website_project_id": "project-1",
        "lifecycle_status": "ACTIVE",
        "context_version": 7,
        "understanding_status": "completed",
        "site_profile_version_id": "profile-2",
        "site_profile_created_at": datetime(2026, 8, 22, 8, 0, tzinfo=UTC),
        "site_profile_confirmed": True,
        "products": ("Analytics",),
        "site_profile_input_required": (),
        "country": "US",
        "target_market": "US",
        "language": "en",
        "promotion_target_version_id": "target-3",
        "promotion_target_created_at": datetime(2026, 8, 22, 8, 5, tzinfo=UTC),
        "keywords": ("analytics software",),
        "target_urls": (),
        "promotion_target_input_required": (),
        "promotion_source_site_profile_version_id": "profile-2",
    }
    values.update(overrides)
    return ProjectOutreachReadinessSnapshot(**values)  # type: ignore[arg-type]


def test_readiness_requires_a_promotion_topic_or_published_target() -> None:
    readiness = build_project_outreach_readiness(
        snapshot(
            promotion_target_version_id=None,
            promotion_target_created_at=None,
            keywords=(),
            promotion_source_site_profile_version_id=None,
        )
    )

    assert readiness.status == "INPUT_REQUIRED"
    assert readiness.promotion_target_version_id is None
    assert readiness.primary_recovery_action == "PUBLISH_PROMOTION_TARGET"
    assert "WEBSITE_PROJECT:publish_promotion_target" in readiness.input_required


def test_readiness_is_ready_with_stable_version_fingerprint() -> None:
    first = build_project_outreach_readiness(snapshot())
    replay = build_project_outreach_readiness(snapshot())

    assert first.status == "READY"
    assert first.site_profile_version_id == "profile-2"
    assert first.outreach_profile_version_id == "profile-2"
    assert first.promotion_target_version_id == "target-3"
    assert first.primary_recovery_action == "OPEN_RECOMMENDATIONS"
    assert first.fingerprint.startswith("sha256:")
    assert replay.fingerprint == first.fingerprint


def test_readiness_marks_changed_site_profile_as_stale() -> None:
    readiness = build_project_outreach_readiness(
        snapshot(promotion_source_site_profile_version_id="profile-1")
    )

    assert readiness.status == "STALE"
    assert readiness.primary_recovery_action == "REPUBLISH_PROMOTION_TARGET"
    assert "WEBSITE_PROJECT:republish_promotion_target" in readiness.input_required


def test_readiness_reports_refreshing_without_mutating_current_versions() -> None:
    readiness = build_project_outreach_readiness(
        snapshot(understanding_status="running")
    )

    assert readiness.status == "REFRESHING"
    assert readiness.site_profile_version_id == "profile-2"
    assert readiness.promotion_target_version_id == "target-3"
    assert readiness.primary_recovery_action == "WAIT_FOR_SITE_PROFILE"


def test_readiness_query_reads_authority_tables_without_write_statements() -> None:
    normalized = " ".join(PROJECT_OUTREACH_READINESS_SQL.lower().split())

    assert "from platform.projects project" in normalized
    assert "left join platform.site_profiles site_profile" in normalized
    assert "site_profile.project_id = project.id" in normalized
    assert "left join platform.website_profile_versions profile" in normalized
    assert "profile.id = project.current_profile_version_id" in normalized
    assert "left join platform.promotion_target_versions target" in normalized
    assert "site_profile.id" not in normalized
    assert "current_site_profile_version_id" not in normalized
    assert all(
        keyword not in normalized
        for keyword in (" insert ", " update ", " delete ", " refill ", " lease ")
    )


class FakeReadinessService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, str]] = []

    async def get(
        self,
        project_id: str,
        *,
        organization_id: str | None,
        workspace_id: str,
    ):
        self.calls.append((project_id, organization_id, workspace_id))
        return build_project_outreach_readiness(snapshot(website_project_id=project_id))


class FakePromotionTargetService:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def publish_promotion_target(
        self,
        project_id: str,
        request,
        *,
        organization_id: str | None,
        workspace_id: str,
        created_by: str,
    ) -> PromotionTargetVersionResponse:
        self.calls.append(
            {
                "project_id": project_id,
                "request": request,
                "organization_id": organization_id,
                "workspace_id": workspace_id,
                "created_by": created_by,
            }
        )
        return PromotionTargetVersionResponse(
            id="target-4",
            project_id=project_id,
            version=4,
            keywords=["analytics software"],
            target_urls=[],
            target_audiences=[],
            partnership_goals=[],
            input_required=[],
            source_keyword_ids=["keyword-1"],
            source_published_target_ids=[],
            source_site_profile_version_id="profile-2",
            created_at=datetime(2026, 8, 22, 8, 10, tzinfo=UTC),
        )


def test_readiness_get_is_read_only_and_publish_is_an_explicit_command() -> None:
    readiness_service = FakeReadinessService()
    project_service = FakePromotionTargetService()
    app.dependency_overrides[get_project_outreach_readiness_service] = (
        lambda: readiness_service
    )
    app.dependency_overrides[get_project_service] = lambda: project_service

    async def request() -> tuple[int, dict, int, int, dict]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            readiness_response = await client.get(
                "/api/v1/projects/project-1/outreach-readiness"
            )
            publish_calls_after_get = len(project_service.calls)
            publish_response = await client.post(
                "/api/v1/projects/project-1/promotion-target",
                json={
                    "approved_keyword_ids": ["keyword-1"],
                    "published_target_ids": [],
                    "expected_project_context_version": 7,
                    "expected_site_profile_version_id": "profile-2",
                },
            )
            return (
                readiness_response.status_code,
                readiness_response.json(),
                publish_calls_after_get,
                publish_response.status_code,
                publish_response.json(),
            )

    try:
        (
            readiness_status,
            readiness_body,
            publish_calls_after_get,
            publish_status,
            publish_body,
        ) = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert readiness_status == 200
    assert readiness_body["website_project_id"] == "project-1"
    assert readiness_service.calls == [("project-1", None, "local")]
    assert publish_calls_after_get == 0

    assert publish_status == 201
    assert publish_body["id"] == "target-4"
    assert len(project_service.calls) == 1
    assert project_service.calls[0]["project_id"] == "project-1"
