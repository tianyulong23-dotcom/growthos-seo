import asyncio
from datetime import UTC, date, datetime, time
from types import SimpleNamespace

from httpx import ASGITransport, AsyncClient

from app.api.routes.content import get_content_plan_settings_service
from app.core.backlinks_gateway import (
    PlatformContextResolutionError,
    PlatformContextResolver,
)
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.main import app
from app.modules.content_plan.settings_service import ContentPlanSettingsService


class FakeSettingsRepository:
    def __init__(self) -> None:
        self.projects = {("test-org", "project-a")}
        self.row = SimpleNamespace(
            cadence="weekly_2_3",
            paused=False,
            timezone="America/New_York",
            default_publish_local_time=time(10),
            cadence_anchor_week=date(2026, 8, 3),
            version=2,
            updated_at=datetime(2026, 8, 6, 8, tzinfo=UTC),
        )
        self.updates: list[dict[str, object]] = []

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return (organization_id, project_id) in self.projects

    async def get_settings(self, project_id: str) -> object | None:
        return self.row if project_id == "project-a" else None

    async def update_settings(self, project_id: str, **values: object) -> object:
        assert project_id == "project-a"
        if values["expected_version"] != self.row.version:
            raise ValueError("stale_settings_version")
        timezone_name = values.get("timezone_name")
        if timezone_name == "Mars/Olympus":
            raise ValueError("timezone must be a valid IANA timezone")
        self.updates.append(values)
        if values.get("cadence") is not None:
            self.row.cadence = values["cadence"]
        if values.get("paused") is not None:
            self.row.paused = values["paused"]
        if timezone_name is not None:
            self.row.timezone = timezone_name
        self.row.version += 1
        return self.row


class PermissionResolver(PlatformContextResolver):
    def __init__(self, denied_permission: str | None = None) -> None:
        self.denied_permission = denied_permission
        self.calls: list[tuple[str, str | None]] = []

    async def resolve(
        self,
        *,
        request: object,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del request
        self.calls.append((website_project_key, required_permission))
        if required_permission == self.denied_permission:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PERMISSION_DENIED",
                title="Permission denied",
                detail="Permission denied",
            )
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id="settings-user", session_id="settings-session", roles=("member",)
            ),
            tenant=PlatformTenant(
                organization_id="test-org", workspace_id="settings-workspace"
            ),
            project=PlatformProject(
                website_project_id=website_project_key,
                website_project_key=website_project_key,
            ),
            permissions=("content:read", "content:write"),
            correlation_id="settings-request",
        )


def test_content_plan_settings_get_and_patch_use_scoped_permissions() -> None:
    async def scenario() -> tuple[dict, dict, list[tuple[str, str | None]], list[dict]]:
        repository = FakeSettingsRepository()
        resolver = PermissionResolver()
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = resolver
        app.dependency_overrides[get_content_plan_settings_service] = lambda: (
            ContentPlanSettingsService(repository)
        )
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                read = await client.get(
                    "/api/v1/projects/project-a/content-plan/settings"
                )
                updated = await client.patch(
                    "/api/v1/projects/project-a/content-plan/settings",
                    json={
                        "version": 2,
                        "cadence": "weekly_5",
                        "paused": True,
                        "timezone": "Asia/Shanghai",
                    },
                )
                assert read.status_code == 200
                assert updated.status_code == 200
                return read.json(), updated.json(), resolver.calls, repository.updates
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    read, updated, calls, updates = asyncio.run(scenario())
    assert read == {
        "cadence": "weekly_2_3",
        "paused": False,
        "timezone": "America/New_York",
        "default_publish_local_time": "10:00:00",
        "cadence_anchor_week": "2026-08-03",
        "version": 2,
        "updated_at": "2026-08-06T08:00:00Z",
    }
    assert updated["cadence"] == "weekly_5"
    assert updated["paused"] is True
    assert updated["timezone"] == "Asia/Shanghai"
    assert updated["version"] == 3
    assert calls == [
        ("project-a", "content:read"),
        ("project-a", "content:write"),
    ]
    assert updates[0]["cadence"] == "weekly_5"
    assert updates[0]["timezone_name"] == "Asia/Shanghai"


def test_content_plan_settings_reject_invalid_and_internal_fields() -> None:
    async def scenario() -> list[tuple[int, object]]:
        repository = FakeSettingsRepository()
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = PermissionResolver()
        app.dependency_overrides[get_content_plan_settings_service] = lambda: (
            ContentPlanSettingsService(repository)
        )
        requests = [
            {"version": 2, "cadence": "weekly_3"},
            {"version": 2, "timezone": "Mars/Olympus"},
            {"version": 1, "paused": True},
            {"version": 2, "default_publish_local_time": "09:00:00"},
            {"version": 2, "cadence_anchor_week": "2026-08-03"},
            {"version": 2},
        ]
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                responses = [
                    await client.patch(
                        "/api/v1/projects/project-a/content-plan/settings", json=payload
                    )
                    for payload in requests
                ]
                return [(response.status_code, response.json()) for response in responses]
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    responses = asyncio.run(scenario())
    assert [status for status, _body in responses] == [422, 422, 409, 422, 422, 422]
    assert responses[1][1]["error"] == {
        "code": "timezone_required",
        "message": "timezone_required",
        "retryable": False,
    }
    assert responses[2][1]["error"] == {
        "code": "stale_settings_version",
        "message": "stale_settings_version",
        "retryable": False,
    }


def test_content_plan_settings_enforce_write_permission_and_project_scope() -> None:
    async def scenario() -> tuple[object, object]:
        repository = FakeSettingsRepository()
        previous_resolver = app.state.platform_context_resolver
        app.dependency_overrides[get_content_plan_settings_service] = lambda: (
            ContentPlanSettingsService(repository)
        )
        try:
            app.state.platform_context_resolver = PermissionResolver("content:write")
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                denied = await client.patch(
                    "/api/v1/projects/project-a/content-plan/settings",
                    json={"version": 2, "paused": True},
                )
                missing = await client.get(
                    "/api/v1/projects/project-b/content-plan/settings"
                )
                return denied, missing
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    denied, missing = asyncio.run(scenario())
    assert denied.status_code == 403
    assert denied.json()["error"] == {
        "code": "PLATFORM_PERMISSION_DENIED",
        "message": "Permission denied",
        "retryable": False,
    }
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "project_not_found"
