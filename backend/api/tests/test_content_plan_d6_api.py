import asyncio
from datetime import UTC, date, datetime

from httpx import ASGITransport, AsyncClient

from app.api.routes.content import get_content_plan_d6_service
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
from app.modules.content_plan.d6_service import ContentPlanWorkflowError
from app.modules.content_plan.schemas import (
    ContentPlanItemCollectionResponse,
    ContentPlanItemResponse,
    ContentPlanItemSummaryResponse,
    ManualPlanAcceptedResponse,
    PendingPreparationResponse,
    PlanItemEditAcceptedResponse,
    PlanItemKeywordResponse,
    PlanItemSerpSnapshotResponse,
)


def plan_item_response(
    *,
    version: int = 4,
    status: str = "scheduled",
) -> ContentPlanItemResponse:
    return ContentPlanItemResponse(
        id="item-a",
        project_id="project-internal-a",
        source="manual",
        seed_keyword="car detailing",
        primary_keyword="how much does car detailing cost",
        secondary_keywords=["car detailing checklist"],
        keywords=[
            PlanItemKeywordResponse(
                keyword="how much does car detailing cost",
                role="primary",
                keyword_type="informational",
                source="related",
                position=1,
            ),
            PlanItemKeywordResponse(
                keyword="car detailing checklist",
                role="secondary",
                keyword_type="informational",
                source="related",
                position=2,
            ),
        ],
        title="Car detailing cost guide",
        writing_direction="Explain the price factors.",
        title_source="user",
        writing_direction_source="system",
        title_user_edited=True,
        direction_user_edited=False,
        edit_state="repreparing",
        pending_preparation_id="preparation-2",
        preparation_version=2,
        version=version,
        publish_local_date=date(2026, 8, 10),
        schedule_timezone="America/New_York",
        generation_at=datetime(2026, 8, 9, 14, tzinfo=UTC),
        status=status,
        schedule_attention_reason=None,
        article_id="article-a",
        current_serp_snapshot_id="serp-1",
        current_serp_snapshot=PlanItemSerpSnapshotResponse(
            id="serp-1",
            preparation_id="preparation-1",
            snapshot_version=1,
            primary_keyword="how much does car detailing cost",
            provider="dataforseo",
            provider_request_id="provider-request-1",
        ),
        pending_preparation=PendingPreparationResponse(
            id="preparation-2",
            preparation_version=2,
            state="expanded",
            stage="coverage_checked",
            error_code=None,
            error_detail=None,
        ),
        publication_status="publish_ready",
        review_status="pending_review",
        review_version=1,
        publication_blocked_reason="awaiting_review",
    )


class D6PermissionResolver(PlatformContextResolver):
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


class FakeD6Service:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    @staticmethod
    def _require_scope(organization_id: str, project_id: str, item_id: str) -> None:
        if (
            organization_id != "organization-a"
            or project_id != "project-internal-a"
            or item_id != "item-a"
        ):
            raise ContentPlanWorkflowError("content_plan_item_not_found")

    async def create_manual(
        self,
        organization_id: str,
        project_id: str,
        request: object,
        *,
        idempotency_key: str,
    ) -> ManualPlanAcceptedResponse:
        self.calls.append(
            (
                "create",
                organization_id,
                project_id,
                request.seed_keyword,
                idempotency_key,
            )
        )
        return ManualPlanAcceptedResponse(
            batch_id="batch-manual", preparation_id="preparation-manual"
        )

    async def get_item(
        self, organization_id: str, project_id: str, item_id: str
    ) -> ContentPlanItemResponse:
        self.calls.append(("get", organization_id, project_id, item_id))
        self._require_scope(organization_id, project_id, item_id)
        return plan_item_response()

    async def list_items(
        self,
        organization_id: str,
        project_id: str,
        *,
        start_date: date | None = None,
        end_date: date | None = None,
        statuses: tuple[str, ...] = (),
    ) -> ContentPlanItemCollectionResponse:
        self.calls.append(
            (
                "list",
                organization_id,
                project_id,
                start_date,
                end_date,
                statuses,
            )
        )
        if project_id != "project-internal-a":
            raise ContentPlanWorkflowError("project_not_found")
        return ContentPlanItemCollectionResponse(
            items=[
                ContentPlanItemSummaryResponse(
                    id="item-a",
                    project_id=project_id,
                    source="manual",
                    title="Car detailing cost guide",
                    primary_keyword="how much does car detailing cost",
                    edit_state="idle",
                    version=4,
                    publish_local_date=date(2026, 8, 10),
                    schedule_timezone="America/New_York",
                    generation_at=datetime(2026, 8, 9, 14, tzinfo=UTC),
                    status="scheduled",
                    schedule_attention_reason=None,
                    article_id="article-a",
                    publication_status="publish_ready",
                    review_status="pending_review",
                )
            ],
            total=1,
        )

    async def update_item(
        self,
        organization_id: str,
        project_id: str,
        item_id: str,
        request: object,
    ) -> ContentPlanItemResponse | PlanItemEditAcceptedResponse:
        self.calls.append(
            (
                "update",
                organization_id,
                project_id,
                item_id,
                request.model_dump(exclude_none=True),
            )
        )
        self._require_scope(organization_id, project_id, item_id)
        if request.version != 4:
            raise ContentPlanWorkflowError("stale_version", current_version=4)
        if request.publish_local_date == date(2026, 8, 11):
            raise ContentPlanWorkflowError(
                "schedule_date_conflict", conflict_id="item-conflict"
            )
        if request.seed_keyword is not None or request.primary_keyword is not None:
            return PlanItemEditAcceptedResponse(
                item_id=item_id,
                version=5,
                pending_preparation_id="preparation-3",
                preparation_version=3,
            )
        return plan_item_response(version=5)

    async def cancel_item(
        self,
        organization_id: str,
        project_id: str,
        item_id: str,
        *,
        expected_version: int,
    ) -> ContentPlanItemResponse:
        self.calls.append(
            ("cancel", organization_id, project_id, item_id, expected_version)
        )
        self._require_scope(organization_id, project_id, item_id)
        if expected_version != 4:
            raise ContentPlanWorkflowError("stale_version", current_version=4)
        return plan_item_response(version=5, status="cancelled")


def test_d6_item_api_uses_platform_scope_and_expected_status_codes() -> None:
    async def scenario() -> tuple[list[object], FakeD6Service, D6PermissionResolver]:
        service = FakeD6Service()
        resolver = D6PermissionResolver()
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = resolver
        app.dependency_overrides[get_content_plan_d6_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                missing_key = await client.post(
                    "/api/v1/projects/a/content-plan/items",
                    json={"seed_keyword": "car detailing"},
                )
                created = await client.post(
                    "/api/v1/projects/a/content-plan/items",
                    headers={"Idempotency-Key": " manual-key "},
                    json={"seed_keyword": " car detailing "},
                )
                detail = await client.get(
                    "/api/v1/projects/a/content-plan/items/item-a"
                )
                edited = await client.patch(
                    "/api/v1/projects/a/content-plan/items/item-a",
                    json={"version": 4, "title": "Updated title"},
                )
                repreparing = await client.patch(
                    "/api/v1/projects/a/content-plan/items/item-a",
                    json={"version": 4, "primary_keyword": "paint care guide"},
                )
                cancelled = await client.post(
                    "/api/v1/projects/a/content-plan/items/item-a/cancel",
                    json={"version": 4},
                )
                return (
                    [missing_key, created, detail, edited, repreparing, cancelled],
                    service,
                    resolver,
                )
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    responses, service, resolver = asyncio.run(scenario())
    assert [response.status_code for response in responses] == [422, 202, 200, 200, 202, 200]
    assert responses[0].json()["error"]["code"] == "idempotency_key_required"
    assert responses[1].json() == {
        "batch_id": "batch-manual",
        "preparation_id": "preparation-manual",
        "status": "queued",
    }
    detail = responses[2].json()
    assert detail["title_source"] == "user"
    assert detail["current_serp_snapshot"]["provider_request_id"] == "provider-request-1"
    assert detail["pending_preparation"]["preparation_version"] == 2
    assert detail["review_status"] == "pending_review"
    assert detail["publication_blocked_reason"] == "awaiting_review"
    assert responses[3].json()["version"] == 5
    assert responses[4].json()["pending_preparation_id"] == "preparation-3"
    assert responses[5].json()["status"] == "cancelled"
    assert service.calls[0] == (
        "create",
        "organization-a",
        "project-internal-a",
        "car detailing",
        "manual-key",
    )
    assert resolver.calls == [
        ("a", "content:write"),
        ("a", "content:write"),
        ("a", "content:read"),
        ("a", "content:write"),
        ("a", "content:write"),
        ("a", "content:write"),
    ]


def test_d6_item_api_enforces_permissions_and_project_isolation() -> None:
    async def scenario() -> list[object]:
        service = FakeD6Service()
        previous_resolver = app.state.platform_context_resolver
        app.dependency_overrides[get_content_plan_d6_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                app.state.platform_context_resolver = D6PermissionResolver("content:read")
                denied_read = await client.get(
                    "/api/v1/projects/a/content-plan/items/item-a"
                )
                app.state.platform_context_resolver = D6PermissionResolver("content:write")
                denied_write = await client.patch(
                    "/api/v1/projects/a/content-plan/items/item-a",
                    json={"version": 4, "title": "Denied"},
                )
                app.state.platform_context_resolver = D6PermissionResolver()
                wrong_project_read = await client.get(
                    "/api/v1/projects/b/content-plan/items/item-a"
                )
                wrong_project_write = await client.patch(
                    "/api/v1/projects/b/content-plan/items/item-a",
                    json={"version": 4, "title": "Wrong project"},
                )
                return [
                    denied_read,
                    denied_write,
                    wrong_project_read,
                    wrong_project_write,
                ]
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    responses = asyncio.run(scenario())
    assert [response.status_code for response in responses] == [403, 403, 404, 404]
    assert responses[0].json()["error"]["code"] == "PLATFORM_PERMISSION_DENIED"
    assert responses[1].json()["error"]["code"] == "PLATFORM_PERMISSION_DENIED"
    assert responses[2].json()["error"]["code"] == "content_plan_item_not_found"
    assert responses[3].json()["error"]["code"] == "content_plan_item_not_found"


def test_d6_item_api_returns_structured_conflict_details() -> None:
    async def scenario() -> list[object]:
        service = FakeD6Service()
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = D6PermissionResolver()
        app.dependency_overrides[get_content_plan_d6_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                stale = await client.patch(
                    "/api/v1/projects/a/content-plan/items/item-a",
                    json={"version": 3, "title": "Stale"},
                )
                date_conflict = await client.patch(
                    "/api/v1/projects/a/content-plan/items/item-a",
                    json={"version": 4, "publish_local_date": "2026-08-11"},
                )
                stale_cancel = await client.post(
                    "/api/v1/projects/a/content-plan/items/item-a/cancel",
                    json={"version": 3},
                )
                return [stale, date_conflict, stale_cancel]
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    stale, date_conflict, stale_cancel = asyncio.run(scenario())
    assert stale.status_code == 409
    assert stale.json()["error"] == {
        "code": "stale_version",
        "message": "stale_version",
        "retryable": False,
        "current_version": 4,
    }
    assert date_conflict.status_code == 409
    assert date_conflict.json()["error"] == {
        "code": "schedule_date_conflict",
        "message": "schedule_date_conflict",
        "retryable": False,
        "conflict_id": "item-conflict",
    }
    assert stale_cancel.status_code == 409
    assert stale_cancel.json()["error"]["current_version"] == 4


def test_d6_item_list_api_passes_real_filters_and_enforces_scope() -> None:
    async def scenario() -> tuple[list[object], FakeD6Service]:
        service = FakeD6Service()
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = D6PermissionResolver()
        app.dependency_overrides[get_content_plan_d6_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                listed = await client.get(
                    "/api/v1/projects/a/content-plan/items",
                    params=[
                        ("start_date", "2026-08-01"),
                        ("end_date", "2026-08-31"),
                        ("status", "scheduled"),
                        ("status", "generated"),
                    ],
                )
                wrong_project = await client.get(
                    "/api/v1/projects/b/content-plan/items"
                )
                return [listed, wrong_project], service
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    (listed, wrong_project), service = asyncio.run(scenario())

    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["primary_keyword"] == (
        "how much does car detailing cost"
    )
    assert service.calls[0] == (
        "list",
        "organization-a",
        "project-internal-a",
        date(2026, 8, 1),
        date(2026, 8, 31),
        ("scheduled", "generated"),
    )
    assert wrong_project.status_code == 404
    assert wrong_project.json()["error"]["code"] == "project_not_found"
