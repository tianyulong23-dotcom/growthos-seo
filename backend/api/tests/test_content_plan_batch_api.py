import asyncio
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient

from app.api.routes.content import get_content_plan_batch_service
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
from app.modules.content_plan.batch_service import ContentPlanBatchError
from app.modules.content_plan.schemas import (
    AutomaticBatchAcceptedResponse,
    BatchRetryAcceptedResponse,
    ContentPlanBatchCollectionResponse,
    ContentPlanBatchResponse,
)


class BatchPermissionResolver(PlatformContextResolver):
    def __init__(self, denied_permission: str | None = None) -> None:
        self.denied_permission = denied_permission

    async def resolve(
        self,
        *,
        request: object,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del request
        if required_permission == self.denied_permission:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PERMISSION_DENIED",
                title="Permission denied",
                detail="Permission denied",
            )
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id="content-user",
                session_id="content-session",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id="organization-a",
                workspace_id="content-workspace",
            ),
            project=PlatformProject(
                website_project_id=f"project-internal-{website_project_key[-1]}",
                website_project_key=website_project_key,
            ),
            permissions=("content:read", "content:write"),
            correlation_id="content-request",
        )


class FakeBatchService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.dispatch_failed = False

    async def create_automatic(
        self,
        organization_id: str,
        project_id: str,
        *,
        idempotency_key: str,
    ) -> AutomaticBatchAcceptedResponse:
        self.calls.append(
            ("create", organization_id, project_id, idempotency_key)
        )
        if idempotency_key == "active-conflict":
            raise ContentPlanBatchError(
                "active_automatic_batch_exists", conflict_id="batch-active"
            )
        if idempotency_key == "same-key-different-request":
            raise ContentPlanBatchError("idempotency_key_conflict")
        return AutomaticBatchAcceptedResponse(batch_id="batch-a")

    async def get_batch(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> ContentPlanBatchResponse:
        self.calls.append(("get", organization_id, project_id, batch_id))
        if project_id != "project-internal-a" or batch_id != "batch-a":
            raise ContentPlanBatchError("content_plan_batch_not_found")
        now = datetime(2026, 8, 7, 12, tzinfo=UTC)
        return ContentPlanBatchResponse(
            batch_id=batch_id,
            project_id=project_id,
            source="automatic",
            target_count=30,
            status="building_packs",
            stage="d3_classification",
            candidate_snapshot_count=80,
            selected_count=30,
            valid_pack_count=18,
            preparation_count=30,
            preview_ready_count=0,
            plan_item_count=0,
            external_request_count=64,
            total_cost_usd=0.42,
            retryable=False,
            error_code=None,
            error_detail=None,
            created_at=now,
            updated_at=now,
            finished_at=None,
        )

    async def list_batches(
        self, organization_id: str, project_id: str, *, limit: int = 20
    ) -> ContentPlanBatchCollectionResponse:
        self.calls.append(("list", organization_id, project_id, str(limit)))
        item = await self.get_batch(organization_id, project_id, "batch-a")
        return ContentPlanBatchCollectionResponse(items=[item], total=1)

    async def retry_batch(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> BatchRetryAcceptedResponse:
        self.calls.append(("retry", organization_id, project_id, batch_id))
        if project_id != "project-internal-a" or batch_id == "missing":
            raise ContentPlanBatchError("content_plan_batch_not_found")
        if batch_id == "unsafe":
            raise ContentPlanBatchError("content_plan_batch_not_retryable")
        return BatchRetryAcceptedResponse(
            batch_id=batch_id,
            target_count=1 if batch_id == "batch-manual" else 30,
        )


def test_automatic_batch_api_accepts_without_body_and_reports_progress() -> None:
    async def scenario() -> tuple[list[object], FakeBatchService]:
        service = FakeBatchService()
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = BatchPermissionResolver()
        app.dependency_overrides[get_content_plan_batch_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                missing_key = await client.post(
                    "/api/v1/projects/a/content-plan/batches"
                )
                body_rejected = await client.post(
                    "/api/v1/projects/a/content-plan/batches",
                    headers={"Idempotency-Key": "batch-key"},
                    json={"target_count": 10},
                )
                accepted = await client.post(
                    "/api/v1/projects/a/content-plan/batches",
                    headers={"Idempotency-Key": " batch-key "},
                )
                progress = await client.get(
                    "/api/v1/projects/a/content-plan/batches/batch-a"
                )
                batches = await client.get(
                    "/api/v1/projects/a/content-plan/batches?limit=5"
                )
                return [missing_key, body_rejected, accepted, progress, batches], service
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    responses, service = asyncio.run(scenario())

    assert [row.status_code for row in responses] == [422, 422, 202, 200, 200]
    assert responses[0].json()["error"]["code"] == "idempotency_key_required"
    assert responses[1].json()["error"]["code"] == "request_body_not_allowed"
    assert responses[2].json() == {
        "batch_id": "batch-a",
        "status": "queued",
        "target_count": 30,
    }
    assert responses[3].json()["valid_pack_count"] == 18
    assert responses[3].json()["external_request_count"] == 64
    assert responses[4].json()["items"][0]["batch_id"] == "batch-a"
    assert service.calls == [
        ("create", "organization-a", "project-internal-a", "batch-key"),
        ("get", "organization-a", "project-internal-a", "batch-a"),
        ("list", "organization-a", "project-internal-a", "5"),
        ("get", "organization-a", "project-internal-a", "batch-a"),
    ]


def test_automatic_batch_api_enforces_scope_and_conflicts() -> None:
    async def scenario() -> list[object]:
        service = FakeBatchService()
        previous_resolver = app.state.platform_context_resolver
        app.dependency_overrides[get_content_plan_batch_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                app.state.platform_context_resolver = BatchPermissionResolver(
                    "content:write"
                )
                denied = await client.post(
                    "/api/v1/projects/a/content-plan/batches",
                    headers={"Idempotency-Key": "denied"},
                )
                app.state.platform_context_resolver = BatchPermissionResolver()
                active = await client.post(
                    "/api/v1/projects/a/content-plan/batches",
                    headers={"Idempotency-Key": "active-conflict"},
                )
                reused = await client.post(
                    "/api/v1/projects/a/content-plan/batches",
                    headers={"Idempotency-Key": "same-key-different-request"},
                )
                wrong_project = await client.get(
                    "/api/v1/projects/b/content-plan/batches/batch-a"
                )
                return [denied, active, reused, wrong_project]
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    denied, active, reused, wrong_project = asyncio.run(scenario())

    assert denied.status_code == 403
    assert active.status_code == 409
    assert active.json()["error"]["conflict_id"] == "batch-active"
    assert reused.status_code == 409
    assert reused.json()["error"]["code"] == "idempotency_key_conflict"
    assert wrong_project.status_code == 404


def test_automatic_batch_retry_requires_write_access_and_safe_failure() -> None:
    async def scenario() -> tuple[list[object], FakeBatchService]:
        service = FakeBatchService()
        previous_resolver = app.state.platform_context_resolver
        app.dependency_overrides[get_content_plan_batch_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                app.state.platform_context_resolver = BatchPermissionResolver(
                    "content:write"
                )
                denied = await client.post(
                    "/api/v1/projects/a/content-plan/batches/batch-a/retry"
                )
                app.state.platform_context_resolver = BatchPermissionResolver()
                retried = await client.post(
                    "/api/v1/projects/a/content-plan/batches/batch-a/retry"
                )
                manual_retried = await client.post(
                    "/api/v1/projects/a/content-plan/batches/batch-manual/retry"
                )
                unsafe = await client.post(
                    "/api/v1/projects/a/content-plan/batches/unsafe/retry"
                )
                wrong_project = await client.post(
                    "/api/v1/projects/b/content-plan/batches/batch-a/retry"
                )
                return [denied, retried, manual_retried, unsafe, wrong_project], service
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    (denied, retried, manual_retried, unsafe, wrong_project), service = asyncio.run(
        scenario()
    )

    assert denied.status_code == 403
    assert retried.status_code == 202
    assert retried.json() == {
        "batch_id": "batch-a",
        "status": "queued",
        "target_count": 30,
    }
    assert manual_retried.status_code == 202
    assert manual_retried.json() == {
        "batch_id": "batch-manual",
        "status": "queued",
        "target_count": 1,
    }
    assert unsafe.status_code == 409
    assert unsafe.json()["error"]["code"] == "content_plan_batch_not_retryable"
    assert wrong_project.status_code == 404
    assert service.calls == [
        ("retry", "organization-a", "project-internal-a", "batch-a"),
        ("retry", "organization-a", "project-internal-a", "batch-manual"),
        ("retry", "organization-a", "project-internal-a", "unsafe"),
        ("retry", "organization-a", "project-internal-b", "batch-a"),
    ]
