from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.routes.keywords import get_keyword_service
from app.main import app
from app.modules.keywords.schemas import (
    KeywordBuildRunResponse,
    KeywordCompetitorGapItemResponse,
    KeywordCompetitorGapListResponse,
    KeywordCostSummaryResponse,
    KeywordExternalIssueListResponse,
    KeywordExternalIssueResponse,
    KeywordLibraryStatusResponse,
    KeywordListItemResponse,
    KeywordListResponse,
)


NOW = datetime(2026, 7, 28, 12, 0, tzinfo=UTC)
pytestmark = pytest.mark.anyio


def completed_run(*, status: str = "completed") -> KeywordBuildRunResponse:
    return KeywordBuildRunResponse(
        run_id="keyword-run-1",
        kind="initial",
        round_number=1,
        status=status,
        stage=status,
        message="关键词库已建立",
        progress=100,
        discovered_count=500,
        selected_count=20,
        keyword_count=420,
        result_version=3,
        profile_source="ai_domain_fallback",
        gap_status="confirmed",
        gap_message="已确认竞争关系",
        gap_count=12,
        partial_failures=[],
        error_code=None,
        started_at=NOW,
        finished_at=NOW,
        elapsed_seconds=120,
    )


class FakeKeywordService:
    def __init__(self) -> None:
        self.retry_calls: list[str] = []
        self.accepted_issue_ids: list[int] = []

    async def status(self, project_id: str) -> KeywordLibraryStatusResponse:
        return KeywordLibraryStatusResponse(
            run=completed_run(),
            total_keywords=420,
            active_keywords=418,
            pending_metrics_count=2,
            result_version=3,
        )

    async def list_keywords(self, project_id: str, **kwargs) -> KeywordListResponse:
        return KeywordListResponse(
            items=[
                KeywordListItemResponse(
                    id="keyword-1",
                    keyword="residential solar cost",
                    primary_seed="solar installation",
                    business_topic="Residential solar",
                    classification_confidence=0.91,
                    review_status="needs_review",
                    intent="commercial",
                    search_volume=1900,
                    cpc=4.25,
                    competition=0.71,
                    keyword_difficulty=37,
                    monthly_searches=[],
                    priority_score=82.4,
                    priority_confidence=1,
                    priority_details={"rule_version": "priority-v1"},
                    sources=["keyword_ideas"],
                    tags=[],
                    status="active",
                    metrics_status="fresh",
                    metrics_updated_at=NOW,
                    created_at=NOW,
                    updated_at=NOW,
                )
            ],
            total=1,
            page=kwargs["page"],
            page_size=kwargs["page_size"],
            result_version=3,
        )

    async def cost_summary(self, project_id: str) -> KeywordCostSummaryResponse:
        return KeywordCostSummaryResponse(
            request_count=3,
            dataforseo_cost_usd=0.03,
            ai_reported_cost_usd=0,
            total_reported_cost_usd=0.03,
            ai_input_tokens=4200,
            ai_output_tokens=900,
            ai_cost_complete=False,
        )

    async def list_external_issues(
        self,
        project_id: str,
    ) -> KeywordExternalIssueListResponse:
        return KeywordExternalIssueListResponse(
            items=[
                KeywordExternalIssueResponse(
                    id=7,
                    provider="dataforseo",
                    endpoint="dataforseo_labs/google/keyword_overview/live",
                    status="uncertain",
                    error_code="external_request_outcome_unknown",
                    error_detail="连接中断",
                    cost_usd=0,
                    started_at=NOW,
                    finished_at=NOW,
                )
            ]
        )

    async def accept_external_issue_as_empty(
        self,
        project_id: str,
        request_id: int,
    ) -> KeywordExternalIssueResponse:
        self.accepted_issue_ids.append(request_id)
        return KeywordExternalIssueResponse(
            id=request_id,
            provider="dataforseo",
            endpoint="dataforseo_labs/google/keyword_overview/live",
            status="completed",
            cost_usd=0,
            started_at=NOW,
            finished_at=NOW,
        )

    async def list_competitor_gaps(
        self,
        project_id: str,
        *,
        page: int,
        page_size: int,
    ) -> KeywordCompetitorGapListResponse:
        return KeywordCompetitorGapListResponse(
            items=[
                KeywordCompetitorGapItemResponse(
                    id="gap-1",
                    competitor_domain="competitor.com",
                    keyword="solar installation company",
                    competitor_rank=6,
                    search_volume=720,
                    cpc=5.4,
                    competition=0.8,
                    keyword_difficulty=51,
                    intent="commercial",
                    monthly_searches=[],
                    relevance=0.88,
                    status="active",
                    created_at=NOW,
                )
            ],
            total=1,
            page=page,
            page_size=page_size,
        )

    async def retry_failed_initial_build(
        self,
        project_id: str,
    ) -> KeywordBuildRunResponse:
        self.retry_calls.append(project_id)
        return completed_run(status="queued").model_copy(
            update={
                "stage": "queued",
                "message": "关键词库重试已进入队列",
                "progress": 0,
                "finished_at": None,
            }
        )


async def api_request(
    method: str,
    path: str,
    service: FakeKeywordService,
):
    app.dependency_overrides[get_keyword_service] = lambda: service
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            return await client.request(method, path)
    finally:
        app.dependency_overrides.clear()


async def test_keyword_status_exposes_completed_result_immediately() -> None:
    response = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/status",
        FakeKeywordService(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["result_version"] == 3
    assert payload["total_keywords"] == 420
    assert payload["pending_metrics_count"] == 2
    assert payload["run"]["status"] == "completed"
    assert payload["run"]["profile_source"] == "ai_domain_fallback"
    assert payload["run"]["gap_status"] == "confirmed"


async def test_keyword_list_exposes_classification_and_dataforseo_metrics() -> None:
    response = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords?page=1&page_size=50",
        FakeKeywordService(),
    )

    assert response.status_code == 200
    [item] = response.json()["items"]
    assert item["business_topic"] == "Residential solar"
    assert item["review_status"] == "needs_review"
    assert item["sources"] == ["keyword_ideas"]
    assert item["search_volume"] == 1900
    assert item["keyword_difficulty"] == 37


async def test_keyword_costs_separate_reported_cost_and_ai_tokens() -> None:
    response = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/costs",
        FakeKeywordService(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "request_count": 3,
        "dataforseo_cost_usd": 0.03,
        "ai_reported_cost_usd": 0.0,
        "total_reported_cost_usd": 0.03,
        "ai_input_tokens": 4200,
        "ai_output_tokens": 900,
        "ai_cost_complete": False,
    }


async def test_uncertain_dataforseo_request_can_continue_as_empty_without_retry() -> None:
    service = FakeKeywordService()
    listed = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/operations/issues",
        service,
    )
    resolved = await api_request(
        "POST",
        "/api/v1/projects/project-1/keywords/operations/issues/7/accept-empty",
        service,
    )

    assert listed.status_code == 200
    assert listed.json()["items"][0]["status"] == "uncertain"
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "completed"
    assert service.accepted_issue_ids == [7]


async def test_competitor_gaps_are_a_separate_result_set() -> None:
    response = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/gaps",
        FakeKeywordService(),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["items"][0]["competitor_domain"] == "competitor.com"
    assert payload["items"][0]["keyword"] == "solar installation company"


async def test_keyword_retry_returns_a_new_queued_attempt() -> None:
    service = FakeKeywordService()

    response = await api_request(
        "POST",
        "/api/v1/projects/project-1/keywords/retry",
        service,
    )

    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    assert service.retry_calls == ["project-1"]
