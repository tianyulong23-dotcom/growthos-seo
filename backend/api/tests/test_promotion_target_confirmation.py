import asyncio
from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.api.routes.projects import get_project_service
from app.main import app
from app.modules.projects.schemas import (
    ConfirmPromotionTargetRequest,
    PromotionTargetVersionResponse,
)
from app.modules.projects.service import (
    PromotionTargetReferenceError,
    _confirmed_promotion_target_urls,
)


def test_confirmation_contract_cleans_user_confirmed_inputs() -> None:
    request = ConfirmPromotionTargetRequest(
        confirmed_topics=[" projector reviews ", "projector reviews"],
        confirmed_target_urls=[
            "https://example.com/products/projector",
            "https://example.com/products/projector",
        ],
        expected_project_context_version=4,
        expected_site_profile_version_id="profile-v4",
    )

    assert request.confirmed_topics == ["projector reviews"]
    assert request.confirmed_target_urls == [
        "https://example.com/products/projector"
    ]

    with pytest.raises(ValidationError, match="至少需要一个"):
        ConfirmPromotionTargetRequest(
            expected_project_context_version=4,
            expected_site_profile_version_id="profile-v4",
        )


def test_confirmation_target_urls_must_belong_to_the_project() -> None:
    assert _confirmed_promotion_target_urls(
        [
            "https://www.example.com/products/projector#details",
            "https://shop.example.com/screen?size=120",
        ],
        "example.com",
    ) == [
        "https://www.example.com/products/projector",
        "https://shop.example.com/screen?size=120",
    ]

    with pytest.raises(PromotionTargetReferenceError, match="当前项目域名"):
        _confirmed_promotion_target_urls(
            ["https://other.example/products/projector"],
            "example.com",
        )

    with pytest.raises(PromotionTargetReferenceError, match="地址无效"):
        _confirmed_promotion_target_urls(
            ["https://[invalid/products/projector"],
            "example.com",
        )


class FakeConfirmationService:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def confirm_promotion_target(
        self,
        project_id: str,
        request: ConfirmPromotionTargetRequest,
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
            id="target-5",
            project_id=project_id,
            version=5,
            keywords=request.confirmed_topics,
            target_urls=request.confirmed_target_urls,
            target_audiences=[],
            partnership_goals=[],
            input_required=[],
            source_keyword_ids=[],
            source_published_target_ids=[],
            source_site_profile_version_id=request.expected_site_profile_version_id,
            created_at=datetime(2026, 8, 25, 8, 0, tzinfo=UTC),
        )


def test_confirmation_route_uses_the_explicit_project_command() -> None:
    service = FakeConfirmationService()
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, dict]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/v1/projects/project-1/promotion-target/confirm",
                json={
                    "confirmed_topics": ["projector reviews"],
                    "confirmed_target_urls": [
                        "https://example.com/products/projector"
                    ],
                    "expected_project_context_version": 4,
                    "expected_site_profile_version_id": "profile-v4",
                },
            )
            return response.status_code, response.json()

    try:
        status, body = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status == 201
    assert body["id"] == "target-5"
    assert len(service.calls) == 1
    assert service.calls[0]["project_id"] == "project-1"
    captured = service.calls[0]["request"]
    assert isinstance(captured, ConfirmPromotionTargetRequest)
    assert captured.confirmed_topics == ["projector reviews"]
