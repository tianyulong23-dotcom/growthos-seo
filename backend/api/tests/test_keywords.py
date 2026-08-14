from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.routes.keywords import get_keyword_service
from app.main import app
from app.modules.keywords.schemas import (
    KeywordBuildRunResponse,
    KeywordCompetitorAnalysisRunListResponse,
    KeywordCompetitorAnalysisRunSummaryResponse,
    KeywordCompetitorAnalysisRequest,
    KeywordCompetitorAnalysisRunResponse,
    KeywordCompetitorListResponse,
    KeywordCompetitorOpportunityListResponse,
    KeywordCompetitorOpportunityResponse,
    KeywordCompetitorResponse,
    KeywordCompetitorRankingResponse,
    KeywordCompetitorOpportunityBatchRequest,
    KeywordCompetitorOpportunityBatchResponse,
    KeywordCostSummaryResponse,
    KeywordExternalIssueListResponse,
    KeywordExternalIssueResponse,
    KeywordGSCSaveRequest,
    KeywordGSCSaveResponse,
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
        self.saved_gsc_keywords: list[str] = []

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

    async def save_gsc_keywords(
        self,
        project_id: str,
        request: KeywordGSCSaveRequest,
    ) -> KeywordGSCSaveResponse:
        self.saved_gsc_keywords = request.keywords
        return KeywordGSCSaveResponse(
            saved=len(request.keywords),
            added_to_library=len(request.keywords),
            already_in_library=0,
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

    async def start_competitor_analysis(
        self,
        project_id: str,
        request: KeywordCompetitorAnalysisRequest,
    ) -> KeywordCompetitorAnalysisRunResponse:
        return competitor_analysis_run().model_copy(
            update={
                "mode": request.mode,
                "requested_competitor_domains": request.competitor_domains,
                "local_market": (
                    request.local_market.model_dump(exclude_none=True)
                    if request.local_market
                    else {}
                ),
                "competitor_limit": len(request.competitor_domains)
                if request.mode == "manual"
                else 5,
            }
        )

    async def competitor_analysis_status(
        self, project_id: str
    ) -> KeywordCompetitorAnalysisRunResponse:
        return competitor_analysis_run()

    async def list_competitors(
        self, project_id: str, *, include_evidence: bool = False
    ) -> KeywordCompetitorListResponse:
        return KeywordCompetitorListResponse(
            run_id="competitor-run-1",
            items=[
                KeywordCompetitorResponse(
                    id="competitor-1",
                    domain="competitor.example",
                    provider_rank=1,
                    avg_position=12.5,
                    median_position=9,
                    rating=24,
                    etv=18000,
                    keywords_count=4,
                    visibility=12.5,
                    relevant_serp_items=6,
                    keywords_positions={"1": 1, "2_3": 2},
                    domain_type="direct_product_competitor",
                    is_seo_competitor=True,
                    is_business_competitor=True,
                    classification_confidence=0.92,
                    why_they_matter="Ranks repeatedly for representative market queries.",
                    serp_evidence=[],
                    domain_overview={"organic_keywords": 4200, "organic_traffic": 18000},
                    ranked_keywords_evidence=[],
                    ranked_keywords_evidence_count=0,
                    backlinks_evidence={},
                    selected_for_gap=True,
                    site_check_status="verified",
                    site_relation="related",
                    site_verification={"final_domain": "competitor.example"},
                    intersections=800,
                    organic_keywords=4200,
                    organic_traffic=18000,
                    status="completed",
                    keyword_count=100,
                    cost_usd=0.024,
                )
            ],
        )

    async def list_competitor_opportunities(
        self, project_id: str, **kwargs
    ) -> KeywordCompetitorOpportunityListResponse:
        page = kwargs["page"]
        page_size = kwargs["page_size"]
        return KeywordCompetitorOpportunityListResponse(
            run_id="competitor-run-1",
            analyzed_at=NOW,
            items=[
                KeywordCompetitorOpportunityResponse(
                    id="opportunity-1",
                    keyword="solar panel installation",
                    normalized_keyword="solar panel installation",
                    best_competitor_rank=4,
                    competitor_count=1,
                    opportunity_score=72.5,
                    search_volume=2400,
                    competition_level="HIGH",
                    keyword_difficulty=42,
                    intent="commercial",
                    metrics_fetched_at=NOW,
                    status="new",
                    in_library=False,
                    analyzed_at=NOW,
                    updated_at=NOW,
                    rankings=[
                        KeywordCompetitorRankingResponse(
                            competitor_id="competitor-1",
                            domain="competitor.example",
                            rank=4,
                        )
                    ],
                )
            ],
            total=1,
            page=page,
            page_size=page_size,
        )

    async def competitor_analysis_runs(
        self, project_id: str, *, limit: int
    ) -> KeywordCompetitorAnalysisRunListResponse:
        run = competitor_analysis_run()
        return KeywordCompetitorAnalysisRunListResponse(
            items=[
                KeywordCompetitorAnalysisRunSummaryResponse(
                    run_id=run.run_id,
                    mode=run.mode,
                    status=run.status,
                    discovered_count=run.discovered_count,
                    analyzed_competitor_count=run.analyzed_competitor_count,
                    completed_competitors=run.completed_competitors,
                    unique_keyword_count=run.unique_keyword_count,
                    total_cost_usd=run.total_cost_usd,
                    created_at=run.created_at,
                )
            ]
        )

    async def batch_competitor_opportunities(
        self,
        project_id: str,
        request: KeywordCompetitorOpportunityBatchRequest,
    ) -> KeywordCompetitorOpportunityBatchResponse:
        return KeywordCompetitorOpportunityBatchResponse(
            updated=len(request.opportunity_ids),
            added_to_library=(len(request.opportunity_ids) if request.action == "accept" else 0),
            already_in_library=0,
        )


def competitor_analysis_run() -> KeywordCompetitorAnalysisRunResponse:
    return KeywordCompetitorAnalysisRunResponse(
        run_id="competitor-run-1",
        target_domain="example.com",
        country="US",
        language="en",
        mode="auto",
        requested_competitor_domains=[],
        discovery_method="serp_competitors",
        discovery_keywords=[
            "market query one",
            "market query two",
            "market query three",
            "market query four",
            "market query five",
        ],
        discovery_result_types=["organic", "local_pack"],
        discovery_include_subdomains=None,
        discovery_sort="visibility",
        discovery_limit=50,
        discovery_offset=0,
        status="completed",
        stage="completed",
        message="竞争分析已完成",
        progress=100,
        competitor_limit=5,
        keyword_limit=100,
        discovered_count=5,
        analyzed_competitor_count=5,
        completed_competitors=5,
        failed_competitors=0,
        raw_keyword_count=500,
        unique_keyword_count=360,
        discovery_cost_usd=0.0126,
        total_cost_usd=0.1326,
        recovery_count=0,
        started_at=NOW,
        finished_at=NOW,
        created_at=NOW,
    )


async def api_request(
    method: str,
    path: str,
    service: FakeKeywordService,
    **kwargs,
):
    app.dependency_overrides[get_keyword_service] = lambda: service
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            return await client.request(method, path, **kwargs)
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
    assert "total_cost_usd" not in payload["run"]


async def test_competitor_analysis_endpoints_expose_five_by_one_hundred_contract() -> None:
    service = FakeKeywordService()
    started = await api_request(
        "POST",
        "/api/v1/projects/project-1/keywords/competitor-analysis",
        service,
        json={"mode": "auto", "competitor_domains": []},
    )
    competitors = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/competitor-analysis/competitors",
        service,
    )
    opportunities = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/competitor-analysis/opportunities"
        "?page=1&page_size=50&opportunity_status=new&min_volume=100"
        "&max_difficulty=60&sort=opportunity_score&order=desc",
        service,
    )
    runs = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/competitor-analysis/runs?limit=10",
        service,
    )
    accepted = await api_request(
        "PATCH",
        "/api/v1/projects/project-1/keywords/competitor-analysis/opportunities",
        service,
        json={"opportunity_ids": ["opportunity-1"], "action": "accept"},
    )

    assert started.status_code == 202
    assert started.json()["competitor_limit"] == 5
    assert started.json()["keyword_limit"] == 100
    assert started.json()["total_cost_usd"] == 0.1326
    assert started.json()["discovery_cost_usd"] == 0.0126
    assert competitors.status_code == 200
    assert competitors.json()["items"][0]["keyword_count"] == 100
    assert competitors.json()["items"][0]["keywords_count"] == 4
    assert started.json()["discovery_keywords"] == [
        "market query one",
        "market query two",
        "market query three",
        "market query four",
        "market query five",
    ]
    assert started.json()["discovery_result_types"] == ["organic", "local_pack"]
    assert competitors.json()["items"][0]["domain_type"] == "direct_product_competitor"
    assert opportunities.status_code == 200
    assert opportunities.json()["items"][0]["best_competitor_rank"] == 4
    assert "own_rank" not in opportunities.json()["items"][0]
    assert "position_gap" not in opportunities.json()["items"][0]
    assert runs.status_code == 200
    assert runs.json()["items"][0]["run_id"] == "competitor-run-1"
    assert runs.json()["items"][0]["total_cost_usd"] == 0.1326
    assert "gsc_query_evidence" not in runs.json()["items"][0]
    assert accepted.status_code == 200
    assert accepted.json()["added_to_library"] == 1


async def test_competitor_analysis_accepts_full_local_market_contract() -> None:
    response = await api_request(
        "POST",
        "/api/v1/projects/project-1/keywords/competitor-analysis",
        FakeKeywordService(),
        json={
            "mode": "auto",
            "competitor_domains": [],
            "local_market": {
                "latitude": -26.2041,
                "longitude": 28.0473,
                "radius_km": 10,
                "zoom": 12,
                "search_type": "maps",
                "device": "desktop",
                "depth": 1,
                "business_query": "video service",
                "categories": ["media_company"],
                "include_questions": True,
                "questions_keyword": "Elephant TV",
                "questions_depth": 12,
            },
        },
    )

    assert response.status_code == 202
    assert response.json()["local_market"] == {
        "latitude": -26.2041,
        "longitude": 28.0473,
        "radius_km": 10.0,
        "zoom": 12,
        "search_type": "maps",
        "device": "desktop",
        "depth": 1,
        "business_query": "video service",
        "categories": ["media_company"],
        "include_questions": True,
        "questions_keyword": "Elephant TV",
        "questions_depth": 12,
    }


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


async def test_gsc_search_performance_keywords_can_be_saved_to_library() -> None:
    service = FakeKeywordService()
    response = await api_request(
        "POST",
        "/api/v1/projects/project-1/keywords/gsc",
        service,
        json={"keywords": ["solar panels", "solar installation"]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "saved": 2,
        "added_to_library": 2,
        "already_in_library": 0,
    }
    assert service.saved_gsc_keywords == ["solar panels", "solar installation"]


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


async def test_legacy_competitor_gaps_are_not_public() -> None:
    response = await api_request(
        "GET",
        "/api/v1/projects/project-1/keywords/gaps",
        FakeKeywordService(),
    )

    assert response.status_code == 404


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
