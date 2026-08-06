from dataclasses import replace
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from temporalio.exceptions import ApplicationError

from seo_workers.keywords.activities import (
    KeywordActivities,
    apply_related_redirect_domains,
    classified_domains,
    competitive_landscape_summary_evidence,
    competitive_query_evidence,
    crawler_site_verification_facts,
    landscape_finding_mismatch,
    local_competitor_item,
    metric_from_candidate,
    raw_keyword_evidence,
    selected_gsc_queries,
    site_verification_for_ai,
)
from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.domain import MergedCandidate, RawKeyword
from seo_workers.keywords.providers import (
    AIProviderConfig,
    AIResult,
    CompetitorGap,
    DataForSEOBilling,
    DataForSEOClient,
    DataForSEOProviderConfig,
    DiscoveredCompetitor,
    GSCProviderConfig,
    GSCQueryRow,
    OpenAICompatibleClient,
    ProviderError,
)
from seo_workers.keywords.repository import (
    CompetitorAnalysisContext,
    ExternalRequestRecord,
    KeywordCommitResult,
    KeywordRepository,
    KeywordRunContext,
    ProfilePollResult,
    StagedKeyword,
    gsc_site_matches_domain,
)


def approved_initial_filter_payload(candidate_count: int) -> dict[str, list[str]]:
    return {"decisions": ["keep"] * candidate_count}


def test_metric_from_candidate_reads_nested_competition_level() -> None:
    candidate = MergedCandidate(
        keyword="solar panels",
        normalized_keyword="solar panels",
        rows=[
            RawKeyword(
                keyword="solar panels",
                source="labs_site",
                raw_payload={"keyword_data": {"keyword_info": {"competition_level": "HIGH"}}},
            )
        ],
        relevance=1,
    )

    assert metric_from_candidate(candidate)["competition_level"] == "HIGH"


def test_local_competitor_item_preserves_rating_and_review_evidence() -> None:
    item = local_competitor_item(
        {
            "title": "Local business",
            "website": "https://local.example/",
            "rating": {"value": 4.7, "votes_count": 128},
        }
    )

    assert item["domain"] == "local.example"
    assert item["rating"] == 4.7
    assert item["reviews_count"] == 128


def test_raw_keyword_evidence_reads_nested_competition_level() -> None:
    row = RawKeyword(
        keyword="solar panels",
        source="keyword_overview",
        raw_payload={"keyword_data": {"keyword_info": {"competition_level": "HIGH"}}},
    )

    assert raw_keyword_evidence(row)["competition_level"] == "HIGH"


def test_competitive_landscape_summary_matches_openseo_tool_columns() -> None:
    evidence = competitive_landscape_summary_evidence(
        {
            "domain_type": "direct_product_competitor",
            "why_they_matter": "recurring domain",
            "domain_overview": {
                "domain": "competitor.example",
                "organic_traffic": 1200,
                "organic_keywords": 80,
                "has_data": True,
                "raw": {"large": "provider payload"},
            },
            "ranked_keywords_evidence": [
                {
                    "keyword_data": {
                        "keyword": "solar panels",
                        "keyword_info": {"search_volume": 900, "cpc": 2.5},
                        "search_intent_info": {"main_intent": "commercial"},
                    },
                    "ranked_serp_element": {
                        "serp_item": {
                            "rank_absolute": 3,
                            "url": "https://competitor.example/solar",
                            "etv": 120,
                            "description": "large unused provider field",
                        }
                    },
                }
            ],
            "backlinks_evidence": {
                "summary": {
                    "backlinks": 100,
                    "referring_domains": 20,
                    "referring_pages": 30,
                    "rank": 42,
                    "info": {"unused": True},
                },
                "referring_domains": [
                    {
                        "domain": "publisher.example",
                        "backlinks": 4,
                        "referring_pages": 2,
                        "rank": 30,
                        "referring_links_types": {"anchor": 4},
                    }
                ],
            },
        }
    )

    assert evidence["domain_overview"] == {
        "domain": "competitor.example",
        "organic_traffic": 1200,
        "organic_keywords": 80,
        "has_data": True,
    }
    assert evidence["ranked_keywords_evidence"] == [
        {
            "keyword": "solar panels",
            "rank": 3,
            "volume": 900,
            "cpc": 2.5,
            "url": "https://competitor.example/solar",
            "intent": "commercial",
            "etv": 120,
        }
    ]
    assert evidence["backlinks_evidence"] == {
        "summary": {
            "backlinks": 100,
            "referring_domains": 20,
            "referring_pages": 30,
            "rank": 42,
        },
        "referring_domains": [
            {
                "domain": "publisher.example",
                "backlinks": 4,
                "referring_pages": 2,
                "rank": 30,
            }
        ],
    }


@pytest.mark.anyio
async def test_competitor_paid_transform_failure_records_returned_cost() -> None:
    repository = CompetitorOpportunityRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def execute():
        return [RawKeyword(keyword="solar", source="keyword_overview")], DataForSEOBilling(
            cost_usd=0.0132,
            path=["tasks", "0", "result"],
        )

    def fail_transform(_rows):
        raise AttributeError("broken local transform")

    with pytest.raises(ProviderError, match="broken local transform") as error:
        await activities._competitor_paid_json(
            context=repository.context,
            phase="query-metrics",
            endpoint=DataForSEOClient.KEYWORD_OVERVIEW_PATH,
            request_payload={"keywords": ["solar"]},
            execute=execute,
            transform=fail_transform,
        )

    assert error.value.cost_usd == 0.0132
    assert error.value.path == ["tasks", "0", "result"]
    assert repository.failed_requests[0]["failure_status"] == "charged_failed"
    assert repository.failed_requests[0]["cost_usd"] == 0.0132


@pytest.mark.anyio
async def test_competitor_paid_unresolved_request_preserves_original_error() -> None:
    repository = CompetitorOpportunityRepository()

    async def begin_unresolved(**kwargs):
        return ExternalRequestRecord(
            request_key=kwargs["request_key"],
            status="uncertain",
            build_run_id=None,
            competitor_analysis_run_id=repository.context.run_id,
            result_count=0,
            response_metadata={"path": ["tasks", "0"]},
            expires_at=None,
            claim_token=None,
            error_code="network_error",
            error_detail="provider received request before disconnect",
            cost_usd=0.0095,
        )

    repository.begin_competitor_external_request = begin_unresolved
    execute = AsyncMock(side_effect=AssertionError("unresolved request must not execute"))

    with pytest.raises(ProviderError) as error:
        await KeywordActivities(repository, KeywordWorkerSettings())._competitor_paid_json(
            context=repository.context,
            phase="serp-1",
            endpoint=DataForSEOClient.LIVE_SERP_PATH,
            request_payload={"keyword": "solar"},
            execute=execute,
        )

    assert error.value.code == "network_error"
    assert error.value.failure_status == "uncertain"
    assert error.value.cost_usd == 0.0095
    assert error.value.path == ["tasks", "0"]
    execute.assert_not_awaited()


def test_competitive_query_evidence_combines_gsc_and_keyword_metrics() -> None:
    [row] = gsc_rows(1)

    evidence = competitive_query_evidence(
        [row],
        {row.query: {"intent": "commercial", "selection_reason": "core offer"}},
        [
            {
                "keyword": row.query.upper(),
                "search_volume": 1200,
                "keyword_difficulty": 42,
                "cpc": 3.5,
                "competition": 0.7,
                "competition_level": "HIGH",
                "intent": "transactional",
                "monthly_searches": [{"year": 2026, "month": 7, "search_volume": 1200}],
            }
        ],
    )

    assert evidence == [
        {
            "query": "market query 1",
            "clicks": 99.0,
            "impressions": 999.0,
            "ctr": 0.1,
            "position": 1.0,
            "intent": "commercial",
            "selection_reason": "core offer",
            "search_volume": 1200,
            "keyword_difficulty": 42,
            "cpc": 3.5,
            "competition": 0.7,
            "competition_level": "HIGH",
            "provider_intent": "transactional",
            "monthly_searches": [{"year": 2026, "month": 7, "search_volume": 1200}],
        }
    ]


def test_selected_gsc_queries_accepts_representatives_beyond_first_two_hundred() -> None:
    rows = gsc_rows(1000)
    payload = {
        "queries": [
            {
                "id": f"q{index:03d}",
                "intent": "commercial",
                "reason": "lower-click business query",
            }
            for index in range(996, 1001)
        ],
        "directional": False,
    }

    selected, metadata = selected_gsc_queries(rows, payload)

    assert [row.query for row in selected] == [
        f"market query {index}" for index in range(996, 1001)
    ]
    assert metadata["market query 1000"]["selection_reason"] == ("lower-click business query")


@pytest.mark.parametrize(
    ("site_url", "domain", "expected"),
    [
        ("sc-domain:example.com", "example.com", True),
        ("sc-domain:example.com", "www.example.com", True),
        ("https://www.example.com/", "example.com", True),
        ("https://shop.example.com/", "example.com", False),
        ("sc-domain:unrelated.example", "example.com", False),
    ],
)
def test_worker_rejects_gsc_properties_for_other_domains(
    site_url: str, domain: str, expected: bool
) -> None:
    assert gsc_site_matches_domain(site_url, domain) is expected


CONTEXT = KeywordRunContext(
    organization_id="org-1",
    project_id="project-1",
    run_id="run-1",
    kind="initial",
    round_number=1,
    domain="example.com",
    country="US",
    language="en",
    competitor_domain=None,
    profile={},
    profile_source="",
    profile_version="",
)


class CompetitorOpportunityRepository:
    def __init__(self) -> None:
        self.context = CompetitorAnalysisContext(
            organization_id="org-1",
            project_id="project-1",
            run_id="competitor-run-1",
            domain="example.com",
            country="US",
            language="en",
            competitor_limit=5,
            keyword_limit=100,
        )
        self.saved_rows: list[CompetitorGap] = []
        self.failed_requests: list[dict] = []
        self.failed_competitors: list[dict] = []
        self.failed_analyses: list[dict] = []
        self.completed_metadata: dict = {}
        self.saved_competitors: list[DiscoveredCompetitor] = []
        self.discovery_configuration: dict = {}
        self.landscape_evidence: dict = {}
        self.completed_requests: list[dict] = []
        self.gsc_reconnect_projects: list[str] = []
        self.cached_site_verifications: dict[str, dict] = {}
        self.cost_breakdown: dict[str, float] = {}

    async def begin_competitor_external_request(self, **kwargs) -> ExternalRequestRecord:
        return ExternalRequestRecord(
            request_key=kwargs["request_key"],
            status="prepared",
            build_run_id=None,
            competitor_analysis_run_id=self.context.run_id,
            result_count=0,
            response_metadata={},
            expires_at=None,
            claim_token="claim-1",
        )

    async def mark_external_request_submitted(self, *args, **kwargs) -> bool:
        return True

    async def complete_external_request(self, request_key: str, **kwargs) -> None:
        self.completed_requests.append({"request_key": request_key, **kwargs})

    async def load_competitor_analysis_context(self, task: dict) -> CompetitorAnalysisContext:
        return self.context

    async def load_gsc_config(self, context: CompetitorAnalysisContext) -> GSCProviderConfig:
        return GSCProviderConfig(
            project_id=context.project_id,
            site_url="sc-domain:example.com",
            refresh_token="refresh-token",
            client_id="client-id",
            client_secret="client-secret",
        )

    async def mark_gsc_reconnect_required(self, project_id: str) -> None:
        self.gsc_reconnect_projects.append(project_id)

    async def load_competitor_business_profile(self, context: CompetitorAnalysisContext) -> dict:
        return {
            "business_type": "SEO software",
            "business_summary": "Keyword research software for marketing teams.",
            "products_services": ["keyword research", "rank tracking"],
        }

    async def load_ai_config(self, organization_id: str) -> AIProviderConfig:
        return AIProviderConfig(
            base_url="https://ai.example/v1",
            api_key="ai-key",
            model="test-model",
            timeout_seconds=30,
            max_retries=0,
        )

    async def save_competitor_discovery_configuration(self, context, **kwargs) -> None:
        self.discovery_configuration = kwargs

    async def save_competitor_landscape_evidence(self, context, **kwargs) -> None:
        self.landscape_evidence = kwargs

    async def load_cached_competitor_site_verifications(self, context, domains) -> dict:
        return dict(self.cached_site_verifications)

    async def save_competitor_site_verifications(self, context, values) -> None:
        self.cached_site_verifications.update(values)

    async def save_competitor_cost_breakdown(self, run_id, values) -> None:
        self.cost_breakdown = dict(values)

    async def mark_competitor_started(self, *args) -> None:
        return None

    async def save_discovered_competitors(
        self,
        context: CompetitorAnalysisContext,
        rows: list[DiscoveredCompetitor],
        *,
        cost_usd: float,
    ) -> list[dict]:
        self.saved_competitors = rows
        return [
            {"id": f"competitor-{index}", "domain": row.domain}
            for index, row in enumerate(rows[: self.context.competitor_limit], start=1)
            if row.raw_payload.get("_landscape", {}).get("selected_for_gap", True)
        ]

    async def save_discovered_competitors_and_complete_external_request(
        self,
        context: CompetitorAnalysisContext,
        rows: list[DiscoveredCompetitor],
        *,
        cost_usd: float,
        **kwargs,
    ) -> list[dict]:
        self.saved_competitors = rows
        self.completed_metadata = dict(kwargs["metadata"])
        return [
            {"id": f"auto-{index}", "domain": row.domain}
            for index, row in enumerate(rows[:5], start=1)
        ]

    async def load_dataforseo_config(self, organization_id: str) -> DataForSEOProviderConfig:
        return DataForSEOProviderConfig(login="login", password="password")

    async def save_competitor_opportunities_and_complete_external_request(
        self,
        context: CompetitorAnalysisContext,
        competitor_id: str,
        rows: list[CompetitorGap],
        *,
        cost_usd: float,
        **kwargs,
    ) -> int:
        assert competitor_id == "competitor-1"
        assert cost_usd == 0.024
        self.saved_rows = rows
        self.completed_metadata = dict(kwargs["metadata"])
        return len(rows)

    async def fail_external_request(self, request_key: str, **kwargs) -> bool:
        self.failed_requests.append({"request_key": request_key, **kwargs})
        return True

    async def fail_competitor(self, context, competitor_id: str, **kwargs) -> None:
        self.failed_competitors.append({"competitor_id": competitor_id, **kwargs})

    async def fail_competitor_analysis(self, run_id: str, **kwargs) -> None:
        self.failed_analyses.append({"run_id": run_id, **kwargs})


def gsc_rows(count: int = 10) -> list[GSCQueryRow]:
    return [
        GSCQueryRow(
            query=f"market query {index}",
            clicks=float(100 - index),
            impressions=float(1000 - index),
            ctr=0.1,
            position=float(index),
            raw_payload={},
        )
        for index in range(1, count + 1)
    ]


def query_selection_result(count: int = 5) -> AIResult:
    intents = [
        "informational",
        "commercial",
        "comparison",
        "transactional",
        "informational",
    ]
    return AIResult(
        payload={
            "queries": [
                {"id": f"q{index:03d}", "intent": intents[index - 1], "reason": "representative"}
                for index in range(1, count + 1)
            ],
            "directional": False,
        },
        usage={},
        model="test-model",
    )


async def stub_gsc_performance(client, **kwargs) -> list[GSCQueryRow]:
    return gsc_rows()


async def stub_query_selection(client, **kwargs) -> AIResult:
    return query_selection_result()


async def stub_keyword_overview(client, **kwargs):
    return [], DataForSEOBilling(cost_usd=0, path=["keyword_overview"])


async def stub_live_serp(client, **kwargs):
    return [], DataForSEOBilling(cost_usd=0, path=["live_serp"])


@pytest.mark.anyio
async def test_competitor_analysis_requests_only_opportunity_keywords(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = CompetitorOpportunityRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    captured: dict = {}

    async def domain_intersection(client: DataForSEOClient, **kwargs):
        captured.update(kwargs)
        return (
            [
                CompetitorGap(
                    keyword="solar opportunity",
                    provider_rank=1,
                    competitor_rank=4,
                    own_rank=None,
                    competitor_url="https://competitor.example/solar",
                    own_url=None,
                    search_volume=2400,
                    cpc=4.2,
                    competition=0.7,
                    competition_level="HIGH",
                    keyword_difficulty=42,
                    intent="commercial",
                    monthly_searches=[],
                    raw_payload={},
                )
            ],
            DataForSEOBilling(cost_usd=0.024, path=["domain_intersection"]),
        )

    monkeypatch.setattr(DataForSEOClient, "domain_intersection", domain_intersection)

    result = await activities.fetch_competitor_opportunities(
        {
            "task": {
                "organization_id": "org-1",
                "project_id": "project-1",
                "run_id": "competitor-run-1",
            },
            "competitor_id": "competitor-1",
            "competitor_domain": "competitor.example",
        }
    )

    assert captured["competitor_domain"] == "competitor.example"
    assert captured["domain"] == "example.com"
    assert captured["limit"] == 100
    assert captured["intersections"] is False
    assert result["count"] == 1
    assert repository.saved_rows[0].own_rank is None
    assert repository.saved_rows[0].competition_level == "HIGH"
    assert repository.saved_rows[0].metrics_fetched_at is not None
    assert repository.completed_metadata["rows"][0]["metrics_fetched_at"] == (
        repository.saved_rows[0].metrics_fetched_at.isoformat()
    )


@pytest.mark.anyio
async def test_manual_competitors_are_prepared_without_provider_discovery() -> None:
    repository = CompetitorOpportunityRepository()
    repository.context = CompetitorAnalysisContext(
        **{
            **repository.context.__dict__,
            "analysis_mode": "manual",
            "competitor_domains": ("one.example", "two.example"),
            "competitor_limit": 2,
        }
    )
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    result = await activities.prepare_manual_competitors({})

    assert result["manual"] is True
    assert result["cost_usd"] == 0
    assert [row.domain for row in repository.saved_competitors] == [
        "one.example",
        "two.example",
    ]
    assert all(row.raw_payload == {"source": "manual"} for row in repository.saved_competitors)


@pytest.mark.anyio
async def test_cached_competitor_metrics_keep_original_snapshot_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    snapshot_at = datetime.now(UTC) - timedelta(hours=1)

    class CachedRepository(CompetitorOpportunityRepository):
        async def begin_competitor_external_request(self, **kwargs) -> ExternalRequestRecord:
            return ExternalRequestRecord(
                request_key=kwargs["request_key"],
                status="completed",
                build_run_id=None,
                competitor_analysis_run_id=self.context.run_id,
                result_count=1,
                response_metadata={
                    "rows": [
                        {
                            "keyword": "cached solar opportunity",
                            "provider_rank": 1,
                            "competitor_rank": 5,
                            "own_rank": None,
                            "competitor_url": "https://competitor.example/cached",
                            "own_url": None,
                            "search_volume": 900,
                            "cpc": 3.1,
                            "competition": 0.6,
                            "competition_level": "MEDIUM",
                            "keyword_difficulty": None,
                            "intent": None,
                            "monthly_searches": [],
                            "raw_payload": {},
                            "metrics_fetched_at": snapshot_at.isoformat(),
                        }
                    ]
                },
                expires_at=datetime.now(UTC) + timedelta(hours=1),
                claim_token=None,
            )

        async def save_competitor_opportunities(
            self,
            context: CompetitorAnalysisContext,
            competitor_id: str,
            rows: list[CompetitorGap],
            *,
            cost_usd: float,
        ) -> int:
            assert cost_usd == 0
            self.saved_rows = rows
            return len(rows)

    repository = CachedRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    provider_call = AsyncMock(side_effect=AssertionError("cache reuse must not call provider"))
    monkeypatch.setattr(DataForSEOClient, "domain_intersection", provider_call)

    result = await activities.fetch_competitor_opportunities(
        {
            "task": {
                "organization_id": "org-1",
                "project_id": "project-1",
                "run_id": "competitor-run-1",
            },
            "competitor_id": "competitor-1",
            "competitor_domain": "competitor.example",
        }
    )

    assert result["cached"] is True
    assert repository.saved_rows[0].metrics_fetched_at == snapshot_at
    assert repository.saved_rows[0].keyword_difficulty is None
    provider_call.assert_not_awaited()


@pytest.mark.anyio
async def test_competitor_analysis_marks_zero_cost_transient_failure_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = CompetitorOpportunityRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def domain_intersection(client: DataForSEOClient, **kwargs):
        raise ProviderError("dataforseo_http_error", "temporary", transient=True)

    monkeypatch.setattr(DataForSEOClient, "domain_intersection", domain_intersection)

    result = await activities.fetch_competitor_opportunities(
        {
            "task": {
                "organization_id": "org-1",
                "project_id": "project-1",
                "run_id": "competitor-run-1",
            },
            "competitor_id": "competitor-1",
            "competitor_domain": "competitor.example",
        }
    )

    assert result["status"] == "failed"
    assert result["retryable"] is True
    assert repository.failed_requests[0]["failure_status"] == "retryable_failed"
    assert repository.failed_competitors[0]["competitor_id"] == "competitor-1"


@pytest.mark.anyio
async def test_competitor_analysis_does_not_retry_a_charged_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = CompetitorOpportunityRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def domain_intersection(client: DataForSEOClient, **kwargs):
        raise ProviderError(
            "dataforseo_task_failed",
            "charged",
            transient=True,
            failure_status="charged_failed",
            cost_usd=0.024,
        )

    monkeypatch.setattr(DataForSEOClient, "domain_intersection", domain_intersection)

    result = await activities.fetch_competitor_opportunities(
        {
            "task": {
                "organization_id": "org-1",
                "project_id": "project-1",
                "run_id": "competitor-run-1",
            },
            "competitor_id": "competitor-1",
            "competitor_domain": "competitor.example",
        }
    )

    assert result["status"] == "failed"
    assert result["retryable"] is False
    assert repository.failed_requests[0]["failure_status"] == "charged_failed"
    assert repository.failed_competitors[0]["cost_usd"] == 0.024


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("retry_enabled", "failed_analysis_count"),
    [(True, 0), (False, 1)],
)
async def test_competitor_discovery_preserves_legacy_failure_semantics(
    monkeypatch: pytest.MonkeyPatch,
    retry_enabled: bool,
    failed_analysis_count: int,
) -> None:
    repository = CompetitorOpportunityRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    monkeypatch.setattr(
        "seo_workers.keywords.activities.GoogleSearchConsoleClient.query_performance",
        stub_gsc_performance,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_competitive_market_queries",
        stub_query_selection,
    )
    monkeypatch.setattr(DataForSEOClient, "keyword_overview", stub_keyword_overview)
    monkeypatch.setattr(DataForSEOClient, "live_serp", stub_live_serp)

    async def serp_competitors(client: DataForSEOClient, **kwargs):
        raise ProviderError("dataforseo_http_error", "temporary", transient=True)

    monkeypatch.setattr(DataForSEOClient, "serp_competitors", serp_competitors)
    task = {
        "organization_id": "org-1",
        "project_id": "project-1",
        "run_id": "competitor-run-1",
    }
    if retry_enabled:
        task["_competitor_request_retry_enabled"] = True

    result = await activities.discover_competitors(task)

    assert result["status"] == "failed"
    assert result["retryable"] is True
    assert len(repository.failed_analyses) == failed_analysis_count


@pytest.mark.anyio
async def test_competitor_discovery_uses_gsc_queries_and_keeps_all_openseo_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = CompetitorOpportunityRepository()
    repository.context = replace(
        repository.context,
        local_market={
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
    )
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    captured: list[dict] = []
    events: list[str] = []
    ranked_domains: list[str] = []
    overview_domains: list[str] = []
    synthesis_snapshots: list[list[dict]] = []
    selected_input_counts: list[int] = []
    local_business_calls: list[dict] = []
    local_serp_calls: list[dict] = []
    question_calls: list[dict] = []

    monkeypatch.setattr(
        "seo_workers.keywords.activities.GoogleSearchConsoleClient.query_performance",
        AsyncMock(return_value=gsc_rows(1000)),
    )

    async def select_queries(client: OpenAICompatibleClient, **kwargs):
        selected_input_counts.append(len(kwargs["rows"]))
        return query_selection_result()

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_competitive_market_queries",
        select_queries,
    )
    monkeypatch.setattr(DataForSEOClient, "keyword_overview", stub_keyword_overview)

    async def live_serp(client: DataForSEOClient, **kwargs):
        keyword = kwargs["keyword"]
        events.append(f"serp:{keyword}")
        if keyword == "market query 3":
            raise ProviderError(
                "dataforseo_serp_unavailable",
                "one representative SERP failed",
                failure_status="charged_failed",
                cost_usd=0.003,
            )
        return [
            {
                "type": "organic",
                "rank": 1,
                "domain": "competitor-11.example",
                "url": f"https://competitor-11.example/{keyword.replace(' ', '-')}",
            }
        ], DataForSEOBilling(cost_usd=0, path=["live_serp"])

    monkeypatch.setattr(DataForSEOClient, "live_serp", live_serp)

    async def local_businesses(client: DataForSEOClient, **kwargs):
        local_business_calls.append(kwargs)
        return [], DataForSEOBilling(cost_usd=0, path=["local_businesses"])

    async def local_serp(client: DataForSEOClient, **kwargs):
        local_serp_calls.append(kwargs)
        return [], DataForSEOBilling(cost_usd=0, path=["local_serp"])

    async def business_questions(client: DataForSEOClient, **kwargs):
        question_calls.append(kwargs)
        return [{"question_text": "Do you offer installation?", "items": []}], DataForSEOBilling(
            cost_usd=0, path=["business_questions"]
        )

    monkeypatch.setattr(DataForSEOClient, "local_businesses", local_businesses)
    monkeypatch.setattr(DataForSEOClient, "local_serp", local_serp)
    monkeypatch.setattr(DataForSEOClient, "business_questions", business_questions)

    async def probe_sites(**kwargs):
        return {
            row.domain.casefold(): {
                "domain": row.domain,
                "requested_url": f"https://{row.domain}/",
                "final_url": f"https://{row.domain}/",
                "final_domain": row.domain,
                "status": "ok",
            }
            for row in kwargs["rows"]
        }

    monkeypatch.setattr("seo_workers.keywords.activities.probe_competitor_sites", probe_sites)

    async def serp_competitors(client: DataForSEOClient, **kwargs):
        captured.append(kwargs)
        events.append("serp_competitors")
        rows = [
            DiscoveredCompetitor(
                domain=("example.com" if index == 0 else f"competitor-{index}.example"),
                provider_rank=index + 1,
                avg_position=float(index + 1),
                median_position=float(index + 1),
                rating=float(index),
                etv=float(index * 100),
                keywords_count=index,
                visibility=float(index),
                relevant_serp_items=index,
                keywords_positions={},
                raw_payload={"index": index},
            )
            for index in range(12)
        ]
        return rows, DataForSEOBilling(cost_usd=0.012, path=["serp_competitors"])

    async def classify(client: OpenAICompatibleClient, **kwargs):
        competitors = kwargs["competitors"]
        return AIResult(
            payload={
                "domains": [
                    {
                        "id": f"d{index:03d}",
                        "type": "direct_product_competitor",
                        "is_seo_competitor": True,
                        "is_business_competitor": True,
                        "relevant_publisher": False,
                        "confidence": 0.9,
                        "why_they_matter": "recurs across representative SERPs",
                        "site_relation": "related",
                        "site_reason": "verified product website",
                    }
                    for index in range(1, len(competitors) + 1)
                ]
            },
            usage={},
            model="test-model",
        )

    async def domain_overview(client: DataForSEOClient, **kwargs):
        overview_domains.append(kwargs["domain"])
        return {"domain": kwargs["domain"], "organic_keywords": 100}, DataForSEOBilling(
            cost_usd=0, path=["domain_overview"]
        )

    async def ranked_keywords(client: DataForSEOClient, **kwargs):
        ranked_domains.append(kwargs["domain"])
        return [], DataForSEOBilling(cost_usd=0, path=["ranked_keywords"])

    async def assess_backlinks(client: OpenAICompatibleClient, **kwargs):
        return AIResult(
            payload={
                "domains": [
                    {
                        "id": f"d{index:03d}",
                        "needed": index == 1,
                        "reason": "authority may explain the leader"
                        if index == 1
                        else "not needed",
                    }
                    for index in range(1, len(kwargs["competitors"]) + 1)
                ]
            },
            usage={},
            model="test-model",
        )

    async def backlinks_overview(client: DataForSEOClient, **kwargs):
        raise ProviderError(
            "dataforseo_backlinks_unavailable",
            "backlinks subscription unavailable",
            failure_status="charged_failed",
            cost_usd=0.05,
        )

    async def synthesize(client: OpenAICompatibleClient, **kwargs):
        synthesis_snapshots.append(kwargs["serp_snapshots"])
        competitor_findings = [
            {
                "domain": row["domain"],
                "type": row["domain_type"],
                "why_they_matter": row["why_they_matter"],
                "organic_footprint": "100 organic keywords",
                "winning_themes": ["keyword research"],
                "weakness_gap": "limited workflow content",
            }
            for row in kwargs["competitors"]
        ]
        return AIResult(
            payload={
                "market_read": "Directional market read",
                "market_leaders": [],
                "most_winnable_opportunity": "comparison content",
                "biggest_barrier": "authority",
                "content_formats": ["comparison pages"],
                "winning_themes": ["keyword research"],
                "keyword_theme_gaps": ["workflow templates"],
                "backlink_authority_observations": [],
                "competitor_findings": competitor_findings,
                "recommended_workflows": ["competitor_analysis"],
            },
            usage={},
            model="test-model",
        )

    monkeypatch.setattr(DataForSEOClient, "serp_competitors", serp_competitors)
    monkeypatch.setattr(OpenAICompatibleClient, "classify_competitive_domains", classify)
    monkeypatch.setattr(DataForSEOClient, "domain_overview", domain_overview)
    monkeypatch.setattr(DataForSEOClient, "ranked_keywords", ranked_keywords)
    monkeypatch.setattr(OpenAICompatibleClient, "assess_backlink_validation_need", assess_backlinks)
    monkeypatch.setattr(DataForSEOClient, "backlinks_overview", backlinks_overview)
    monkeypatch.setattr(OpenAICompatibleClient, "synthesize_competitive_landscape", synthesize)
    result = await activities.discover_competitors(
        {
            "organization_id": "org-1",
            "project_id": "project-1",
            "run_id": "competitor-run-1",
        }
    )

    assert len(captured) == 1
    assert selected_input_counts == [1000]
    assert events[0] == "serp_competitors"
    assert captured[0] == {
        "keywords": [f"market query {index}" for index in range(1, 6)],
        "country": "US",
        "language": "en",
        "item_types": ["organic", "local_pack"],
        "limit": 50,
        "offset": 0,
    }
    assert repository.discovery_configuration == {
        "keywords": [f"market query {index}" for index in range(1, 6)],
        "result_types": ["organic", "local_pack"],
        "include_subdomains": None,
        "sort_by": "visibility",
        "limit": 50,
        "offset": 0,
    }
    assert len(repository.saved_competitors) == 11
    assert repository.saved_competitors[0].domain == "competitor-11.example"
    assert all(row.domain != "example.com" for row in repository.saved_competitors)
    assert overview_domains == [f"competitor-{index}.example" for index in range(11, 6, -1)]
    assert ranked_domains == overview_domains
    assert len(result["competitors"]) == 5
    assert result["status"] == "completed"
    assert result["cost_usd"] == pytest.approx(0.065)
    assert len(repository.landscape_evidence["gsc_query_evidence"]) == 5
    assert len(repository.landscape_evidence["serp_snapshots"]) == 12
    failed_snapshot = repository.landscape_evidence["serp_snapshots"][2]
    assert failed_snapshot["ok"] is False
    assert failed_snapshot["error_code"] == "dataforseo_serp_unavailable"
    assert synthesis_snapshots[0][2] == failed_snapshot
    assert local_business_calls[0]["query"] == "video service"
    assert len(local_serp_calls) == 5
    assert all(call["depth"] == 1 for call in local_serp_calls)
    assert question_calls == [
        {
            "keyword": "Elephant TV",
            "latitude": -26.2041,
            "longitude": 28.0473,
            "radius_km": 10.0,
            "language": "en",
            "depth": 12,
        }
    ]
    assert any(
        snapshot.get("source") == "google_business_questions" for snapshot in synthesis_snapshots[0]
    )
    assert repository.landscape_evidence["cost_breakdown"]["live_serps"] == 0.003
    assert repository.landscape_evidence["cost_breakdown"]["backlinks"] == 0.05
    assert (
        repository.saved_competitors[0].raw_payload["_landscape"]["backlinks_evidence"]["available"]
        is False
    )


@pytest.mark.anyio
async def test_competitor_discovery_with_fewer_than_five_gsc_queries_is_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = CompetitorOpportunityRepository()
    paid_call = AsyncMock()
    gsc_call = AsyncMock(return_value=gsc_rows(4))
    monkeypatch.setattr(
        "seo_workers.keywords.activities.GoogleSearchConsoleClient.query_performance",
        gsc_call,
    )
    monkeypatch.setattr(DataForSEOClient, "serp_competitors", paid_call)

    result = await KeywordActivities(repository, KeywordWorkerSettings()).discover_competitors(
        {
            "organization_id": "org-1",
            "project_id": "project-1",
            "run_id": "competitor-run-1",
        }
    )

    paid_call.assert_not_awaited()
    assert result["reason"] == "gsc_representative_queries_insufficient"
    assert result["cost_usd"] == 0
    assert repository.landscape_evidence["directional_result"] is True
    assert "仅返回 4 个查询" in repository.landscape_evidence["landscape_summary"]["market_read"]
    assert "未调用任何付费" in repository.landscape_evidence["landscape_summary"]["market_read"]


@pytest.mark.anyio
async def test_competitor_discovery_marks_revoked_gsc_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = CompetitorOpportunityRepository()

    async def revoked(client, **kwargs):
        raise ProviderError("gsc_reconnect_required", "grant revoked")

    monkeypatch.setattr(
        "seo_workers.keywords.activities.GoogleSearchConsoleClient.query_performance",
        revoked,
    )

    result = await KeywordActivities(repository, KeywordWorkerSettings()).discover_competitors(
        {
            "organization_id": "org-1",
            "project_id": "project-1",
            "run_id": "competitor-run-1",
        }
    )

    assert result["status"] == "failed"
    assert result["error_code"] == "gsc_reconnect_required"
    assert repository.gsc_reconnect_projects == ["project-1"]


def test_openseo_five_domain_types_and_gap_eligibility_are_preserved() -> None:
    domain_types = [
        "direct_product_competitor",
        "publisher_media",
        "marketplace_directory",
        "community_forum",
        "documentation_resource",
    ]
    rows = [
        DiscoveredCompetitor(
            domain=f"candidate-{index}.example",
            provider_rank=index,
            avg_position=None,
            median_position=None,
            rating=None,
            etv=None,
            keywords_count=None,
            visibility=None,
            relevant_serp_items=None,
            keywords_positions={},
            raw_payload={},
        )
        for index in range(1, 6)
    ]
    payload = {
        "domains": [
            {
                "id": f"d{index:03d}",
                "type": domain_type,
                "is_seo_competitor": True,
                "is_business_competitor": index == 1,
                "relevant_publisher": index == 2,
                "confidence": 0.8,
                "why_they_matter": "recurring SERP domain",
                "site_relation": "related",
                "site_reason": "verified relevant website",
            }
            for index, domain_type in enumerate(domain_types, start=1)
        ]
    }

    site_verifications = {
        row.domain: {
            "domain": row.domain,
            "final_domain": row.domain,
            "status": "ok",
        }
        for row in rows
    }
    classified = classified_domains(rows, payload, site_verifications)

    assert [classified[row.domain]["domain_type"] for row in rows] == domain_types
    assert classified[rows[0].domain]["selected_for_gap"] is True
    assert classified[rows[1].domain]["selected_for_gap"] is True
    assert classified[rows[2].domain]["selected_for_gap"] is False
    assert classified[rows[3].domain]["selected_for_gap"] is False
    assert classified[rows[4].domain]["selected_for_gap"] is False


def test_site_verification_is_a_hard_paid_gap_gate() -> None:
    rows = [
        DiscoveredCompetitor(
            domain="en.e-lephant.tv",
            provider_rank=1,
            avg_position=1,
            median_position=1,
            rating=None,
            etv=None,
            keywords_count=1,
            visibility=1,
            relevant_serp_items=1,
            keywords_positions={},
            raw_payload={},
        ),
        DiscoveredCompetitor(
            domain="blocked.example",
            provider_rank=2,
            avg_position=2,
            median_position=2,
            rating=None,
            etv=None,
            keywords_count=1,
            visibility=1,
            relevant_serp_items=1,
            keywords_positions={},
            raw_payload={},
        ),
        DiscoveredCompetitor(
            domain="related-old.example",
            provider_rank=3,
            avg_position=3,
            median_position=3,
            rating=None,
            etv=None,
            keywords_count=1,
            visibility=1,
            relevant_serp_items=1,
            keywords_positions={},
            raw_payload={},
        ),
    ]
    payload = {
        "domains": [
            {
                "id": "d001",
                "type": "direct_product_competitor",
                "is_seo_competitor": True,
                "is_business_competitor": True,
                "relevant_publisher": False,
                "confidence": 0.99,
                "why_they_matter": "namesake",
                "site_relation": "unrelated",
                "site_reason": "redirects to an unrelated education service",
            },
            {
                "id": "d002",
                "type": "direct_product_competitor",
                "is_seo_competitor": True,
                "is_business_competitor": True,
                "relevant_publisher": False,
                "confidence": 0.5,
                "why_they_matter": "cannot verify",
                "site_relation": "uncertain",
                "site_reason": "access blocked",
            },
            {
                "id": "d003",
                "type": "direct_product_competitor",
                "is_seo_competitor": True,
                "is_business_competitor": True,
                "relevant_publisher": False,
                "confidence": 0.9,
                "why_they_matter": "verified business migration",
                "site_relation": "related",
                "site_reason": "same product moved domains",
            },
        ]
    }
    verifications = {
        "en.e-lephant.tv": {
            "status": "redirected",
            "final_domain": "eduone.jp",
            "final_url": "https://eduone.jp/",
        },
        "blocked.example": {"status": "blocked", "final_domain": "blocked.example"},
        "related-old.example": {
            "status": "redirected",
            "final_domain": "related-new.example",
        },
    }

    classified = classified_domains(rows, payload, verifications)

    assert classified["en.e-lephant.tv"]["site_check_status"] == "redirected_unrelated"
    assert classified["en.e-lephant.tv"]["selected_for_gap"] is False
    assert classified["blocked.example"]["site_check_status"] == "blocked"
    assert classified["blocked.example"]["selected_for_gap"] is False
    assert classified["related-old.example"]["selected_for_gap"] is True

    attached = []
    for row in rows:
        row.raw_payload["_landscape"] = classified[row.domain]
        attached.append(row)
    redirected = apply_related_redirect_domains(attached)
    assert [row.domain for row in redirected] == [
        "en.e-lephant.tv",
        "blocked.example",
        "related-new.example",
    ]


def test_cached_site_verification_keeps_crawler_facts_only() -> None:
    cached = {
        "domain": "old.example",
        "status": "redirected",
        "final_domain": "new.example",
        "checked_at": "2026-08-05T00:00:00Z",
        "site_check_status": "redirected_related",
        "site_relation": "related",
        "site_reason": "previous AI conclusion",
        "checks": [
            {
                "status": "ok",
                "title": "New site",
                "checked_at": "2026-08-05T00:00:00Z",
                "site_relation": "related",
            }
        ],
    }

    facts = crawler_site_verification_facts(cached)
    ai_evidence = site_verification_for_ai(cached)

    assert facts["checked_at"] == "2026-08-05T00:00:00Z"
    assert facts["checks"][0]["title"] == "New site"
    assert "site_relation" not in facts
    assert "site_reason" not in facts
    assert "site_check_status" not in facts
    assert "checked_at" not in ai_evidence
    assert "checked_at" not in ai_evidence["checks"][0]


def test_related_redirect_domains_merge_metrics_and_serp_evidence() -> None:
    rows = []
    for rank, domain, evidence_keyword in (
        (1, "old.example", "first query"),
        (2, "new.example", "second query"),
    ):
        landscape = {
            "selected_for_gap": True,
            "is_seo_competitor": True,
            "is_business_competitor": True,
            "classification_confidence": 0.8 + rank / 100,
            "site_check_status": "redirected_related" if rank == 1 else "verified",
            "site_verification": {
                "original_domain": domain,
                "final_domain": "new.example",
            },
            "serp_evidence": [{"keyword": evidence_keyword, "rank": rank}],
        }
        rows.append(
            DiscoveredCompetitor(
                domain=domain,
                provider_rank=rank,
                avg_position=float(rank),
                median_position=float(rank),
                rating=float(rank),
                etv=float(rank * 10),
                keywords_count=rank,
                visibility=float(rank),
                relevant_serp_items=rank,
                keywords_positions={"top_10": rank},
                raw_payload={"_landscape": landscape},
            )
        )

    merged = apply_related_redirect_domains(rows)

    assert len(merged) == 1
    assert merged[0].domain == "new.example"
    assert merged[0].etv == 30
    assert merged[0].keywords_count == 3
    assert merged[0].keywords_positions == {"top_10": 3}
    landscape = merged[0].raw_payload["_landscape"]
    assert [item["keyword"] for item in landscape["serp_evidence"]] == [
        "first query",
        "second query",
    ]
    assert len(landscape["related_redirect_sources"]) == 2


def test_landscape_mismatch_reports_missing_and_duplicate_domains() -> None:
    rows = [
        DiscoveredCompetitor(
            domain=domain,
            provider_rank=index,
            avg_position=None,
            median_position=None,
            rating=None,
            etv=None,
            keywords_count=None,
            visibility=None,
            relevant_serp_items=None,
            keywords_positions={},
            raw_payload={},
        )
        for index, domain in enumerate(["one.example", "two.example", "three.example"], 1)
    ]

    missing, duplicates = landscape_finding_mismatch(
        rows,
        {
            "competitor_findings": [
                {"domain": "one.example"},
                {"domain": "ONE.EXAMPLE"},
                {"domain": "three.example"},
            ]
        },
    )

    assert missing == ["two.example"]
    assert duplicates == ["one.example"]


class DiscoveryRepository:
    def __init__(self) -> None:
        self.partial_failures: list[dict] = []

    async def load_context(self, task: dict) -> KeywordRunContext:
        return CONTEXT

    async def set_stage(self, *args, **kwargs) -> None:
        return None

    async def request_ideas(self, run_id: str, source: str) -> list[RawKeyword]:
        return []

    async def record_partial_failure(self, run_id: str, **kwargs) -> None:
        self.partial_failures.append({"run_id": run_id, **kwargs})


class SeedPreparationRepository:
    def __init__(self, candidate_count: int) -> None:
        self.context = KeywordRunContext(
            **{
                **CONTEXT.__dict__,
                "profile": {
                    "business_model": "service",
                    "business_type": "Residential solar installer",
                    "business_summary": "Installs residential solar systems.",
                    "products_services": ["solar installation", "home battery storage"],
                },
                "profile_source": "site_profile",
                "profile_version": "profile-1",
            }
        )
        self.candidate_count = candidate_count
        self.started_requests: list[str] = []
        self.submitted_requests: list[str] = []
        self.completed_requests: list[tuple[str, dict]] = []
        self.partial_failures: list[dict] = []
        self.saved_decisions = []

    async def load_context(self, task: dict) -> KeywordRunContext:
        return self.context

    async def load_selected_topics(self, run_id: str) -> list[dict]:
        return []

    async def set_stage(self, *args, **kwargs) -> None:
        return None

    async def load_ideas(self, run_id: str, sources: list[str]) -> list[RawKeyword]:
        return [
            RawKeyword(
                keyword=f"solar installation topic {index}",
                source="google_ads_site",
                provider_rank=index,
                search_volume=10_000 - index,
            )
            for index in range(1, self.candidate_count + 1)
        ]

    async def save_ideas(self, context, rows) -> int:
        return len(list(rows))

    async def load_confirmed_gap_keywords(self, run_id: str) -> list[RawKeyword]:
        return []

    async def load_ai_config(self, organization_id: str) -> AIProviderConfig:
        return AIProviderConfig(
            base_url="https://ai.example.test/v1",
            api_key="test-key",
            model="test-model",
            timeout_seconds=10,
            max_retries=0,
        )

    async def begin_external_request(self, **kwargs) -> ExternalRequestRecord:
        request_key = kwargs["request_key"]
        self.started_requests.append(request_key)
        return ExternalRequestRecord(
            request_key=request_key,
            status="prepared",
            build_run_id=self.context.run_id,
            result_count=0,
            response_metadata={},
            expires_at=None,
            claim_token=f"claim:{request_key}",
        )

    async def mark_external_request_submitted(
        self,
        request_key: str,
        *,
        claim_token: str,
    ) -> bool:
        assert claim_token == f"claim:{request_key}"
        self.submitted_requests.append(request_key)
        return True

    async def complete_external_request(self, request_key: str, **kwargs) -> None:
        self.completed_requests.append((request_key, kwargs))

    async def fail_external_request(self, *args, **kwargs) -> None:
        raise AssertionError("valid AI responses must not fail")

    async def record_partial_failure(self, run_id: str, **kwargs) -> None:
        self.partial_failures.append({"run_id": run_id, **kwargs})

    async def save_seed_decisions(self, context, decisions, excluded) -> list[dict]:
        self.saved_decisions = decisions
        return [
            {
                "id": f"seed-{decision.ai_rank}",
                "keyword": decision.candidate.keyword,
                "ai_rank": decision.ai_rank,
            }
            for decision in decisions
            if decision.selected
        ]


@pytest.mark.anyio
@pytest.mark.parametrize("candidate_count", [7, 25])
async def test_seed_preparation_saves_every_valid_unique_topic(
    monkeypatch: pytest.MonkeyPatch,
    candidate_count: int,
) -> None:
    repository = SeedPreparationRepository(candidate_count)
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    calls: list[str] = []
    monkeypatch.setattr(
        activities,
        "_keyword_ideas_request",
        AsyncMock(return_value=([], False)),
    )
    monkeypatch.setattr(
        activities,
        "_google_ads_site_request",
        AsyncMock(return_value=[]),
    )

    async def select_topics(client, **kwargs) -> AIResult:
        calls.append("topics")
        assert kwargs["profile"]["business_model"] == "service"
        return AIResult(
            payload=approved_initial_filter_payload(len(kwargs["candidates"])),
            usage={"prompt_tokens": 100, "completion_tokens": 50},
            model="test-model",
        )

    async def rank_topics(client, **kwargs) -> AIResult:
        calls.append("ranking")
        assert kwargs["profile"]["business_model"] == "service"
        assert len(kwargs["topics"]) == candidate_count
        return AIResult(
            payload={
                "duplicate_pair_ids": [],
            },
            usage={"prompt_tokens": 50, "completion_tokens": 25},
            model="test-model",
        )

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        select_topics,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        rank_topics,
    )

    result = await activities.prepare_seeds({})

    assert calls == ["topics", "ranking"]
    assert result["business_model"] == "service"
    assert result["topic_count"] == candidate_count
    assert result["selected_topic_count"] == candidate_count
    assert result["google_ads_supplemented"] is False
    assert len(repository.started_requests) == 2
    assert repository.submitted_requests == repository.started_requests
    assert len(repository.completed_requests) == 2
    assert sum(decision.selected for decision in repository.saved_decisions) == candidate_count


@pytest.mark.anyio
async def test_seed_preparation_does_not_supplement_fifty_valid_topics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = SeedPreparationRepository(50)
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    google_ads = AsyncMock(return_value=[])
    keyword_ideas = AsyncMock(return_value=([], False))
    monkeypatch.setattr(activities, "_google_ads_site_request", google_ads)
    monkeypatch.setattr(activities, "_keyword_ideas_request", keyword_ideas)
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        AsyncMock(
            return_value=AIResult(
                payload=approved_initial_filter_payload(50),
                usage={},
                model="test-model",
            )
        ),
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        AsyncMock(
            return_value=AIResult(
                payload={"duplicate_pair_ids": []},
                usage={},
                model="test-model",
            )
        ),
    )

    result = await activities.prepare_seeds({})

    assert result["selected_topic_count"] == 50
    assert result["google_ads_supplemented"] is False
    assert result["fallback_keyword_ideas_used"] is False
    google_ads.assert_not_awaited()
    keyword_ideas.assert_not_awaited()


@pytest.mark.anyio
async def test_seed_preparation_filters_five_hundred_candidates_in_two_batches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = SeedPreparationRepository(500)
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    google_ads = AsyncMock(return_value=[])
    keyword_ideas = AsyncMock(return_value=([], False))
    monkeypatch.setattr(activities, "_google_ads_site_request", google_ads)
    monkeypatch.setattr(activities, "_keyword_ideas_request", keyword_ideas)
    request_sizes: list[int] = []

    async def filter_candidates(client, **kwargs) -> AIResult:
        request_sizes.append(len(kwargs["candidates"]))
        return AIResult(
            payload=approved_initial_filter_payload(len(kwargs["candidates"])),
            usage={},
            model="test-model",
        )

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        filter_candidates,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        AsyncMock(
            return_value=AIResult(
                payload={"duplicate_pair_ids": []},
                usage={},
                model="test-model",
            )
        ),
    )

    result = await activities.prepare_seeds({})

    assert request_sizes == [500]
    assert result["selected_topic_count"] == 500
    assert result["google_ads_supplemented"] is False
    assert sum(":primary:" in key for key in repository.started_requests) == 1
    google_ads.assert_not_awaited()
    keyword_ideas.assert_not_awaited()


@pytest.mark.anyio
async def test_seed_preparation_skips_second_ai_when_no_duplicate_pairs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DistinctTopicRepository(SeedPreparationRepository):
        async def load_ideas(self, run_id: str, sources: list[str]) -> list[RawKeyword]:
            return [
                RawKeyword(
                    keyword="solar panel installation",
                    source="labs_site",
                    provider_rank=1,
                    search_volume=4_000,
                ),
                RawKeyword(
                    keyword="home battery storage",
                    source="labs_site",
                    provider_rank=2,
                    search_volume=3_000,
                ),
            ]

    repository = DistinctTopicRepository(2)
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    monkeypatch.setattr(
        activities,
        "_keyword_ideas_request",
        AsyncMock(return_value=([], False)),
    )
    monkeypatch.setattr(
        activities,
        "_google_ads_site_request",
        AsyncMock(return_value=[]),
    )

    async def select_topics(client, **kwargs) -> AIResult:
        return AIResult(
            payload=approved_initial_filter_payload(len(kwargs["candidates"])),
            usage={},
            model="test-model",
        )

    async def unexpected_second_ai(client, **kwargs) -> AIResult:
        raise AssertionError("second AI must be skipped without duplicate pairs")

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        select_topics,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        unexpected_second_ai,
    )

    result = await activities.prepare_seeds({})

    assert result["selected_topic_count"] == 2
    assert result["possible_duplicate_pair_count"] == 0
    assert len(repository.started_requests) == 1


@pytest.mark.anyio
async def test_seed_preparation_never_loads_internal_profile_seeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SourceAwareRepository(SeedPreparationRepository):
        def __init__(self) -> None:
            super().__init__(1)
            self.requested_sources: list[tuple[str, ...]] = []

        async def load_ideas(self, run_id: str, sources: list[str]) -> list[RawKeyword]:
            self.requested_sources.append(tuple(sources))
            rows = [
                RawKeyword(
                    keyword="solar installation",
                    source="labs_site",
                    search_volume=1_000,
                ),
                RawKeyword(
                    keyword="invented internal query",
                    source="profile_seed",
                ),
            ]
            return [row for row in rows if row.source in sources]

    repository = SourceAwareRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    monkeypatch.setattr(
        activities,
        "_google_ads_site_request",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        activities,
        "_keyword_ideas_request",
        AsyncMock(return_value=([], False)),
    )

    async def select_topics(client, **kwargs) -> AIResult:
        assert [candidate.keyword for candidate in kwargs["candidates"]] == ["solar installation"]
        return AIResult(
            payload=approved_initial_filter_payload(1),
            usage={},
            model="test-model",
        )

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        select_topics,
    )

    result = await activities.prepare_seeds({})

    assert result["selected_topic_count"] == 1
    assert repository.requested_sources
    assert all("profile_seed" not in sources for sources in repository.requested_sources)


@pytest.mark.anyio
async def test_invalid_seed_topic_response_keeps_all_mechanically_valid_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class InvalidResponseRepository(SeedPreparationRepository):
        async def fail_external_request(self, *args, **kwargs) -> bool:
            self.partial_failures.append({"ledger_failure": kwargs})
            return True

    repository = InvalidResponseRepository(25)
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    topic_calls = 0
    monkeypatch.setattr(
        activities,
        "_google_ads_site_request",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        activities,
        "_keyword_ideas_request",
        AsyncMock(return_value=([], False)),
    )

    async def invalid_topics(client, **kwargs) -> AIResult:
        nonlocal topic_calls
        topic_calls += 1
        return AIResult(
            payload={**approved_initial_filter_payload(25), "malformed": ["k999"]},
            usage={},
            model="test-model",
        )

    async def rank_topics(client, **kwargs) -> AIResult:
        return AIResult(
            payload={
                "duplicate_pair_ids": [],
            },
            usage={},
            model="test-model",
        )

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        invalid_topics,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        rank_topics,
    )

    result = await activities.prepare_seeds({})

    assert topic_calls == 1
    assert result["selected_topic_count"] == 25
    assert len(repository.submitted_requests) == 2
    assert any(failure.get("source") == "seed_topic_ai" for failure in repository.partial_failures)
    ledger_failure = next(
        failure["ledger_failure"]
        for failure in repository.partial_failures
        if "ledger_failure" in failure
    )
    assert ledger_failure["cost_usd"] == 0
    assert ledger_failure["metadata"] == {
        "model": "test-model",
        "usage": {},
        "payload": {**approved_initial_filter_payload(25), "malformed": ["k999"]},
    }


class SupplementalSeedRepository(SeedPreparationRepository):
    def __init__(self) -> None:
        super().__init__(0)
        self.ideas = [
            *[
                RawKeyword(
                    keyword=f"solar installation topic {index}",
                    source="labs_site",
                    provider_rank=index,
                    search_volume=10_000 - index,
                )
                for index in range(1, 19)
            ],
            RawKeyword(
                keyword="solar installation",
                source="labs_site",
                provider_rank=19,
                search_volume=500,
            ),
            RawKeyword(
                keyword="installation solar",
                source="labs_site",
                provider_rank=20,
                search_volume=500,
            ),
            RawKeyword(
                keyword="the solar installation",
                source="labs_site",
                provider_rank=21,
                search_volume=500,
            ),
        ]

    async def load_ideas(self, run_id: str, sources: list[str]) -> list[RawKeyword]:
        return [row for row in self.ideas if row.source in sources]


@pytest.mark.anyio
async def test_seed_preparation_supplements_when_final_valid_count_is_below_fifty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = SupplementalSeedRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    supplemented_contexts: list[KeywordRunContext] = []

    async def add_google_ads_rows(context: KeywordRunContext) -> list[RawKeyword]:
        rows = [
            RawKeyword(
                keyword=f"residential solar solution {index}",
                source="google_ads_site",
                provider_rank=index,
                search_volume=400 - index,
            )
            for index in range(1, 36)
        ]
        repository.ideas.extend(rows)
        supplemented_contexts.append(context)
        return rows

    async def select_topics(client, **kwargs) -> AIResult:
        return AIResult(
            payload=approved_initial_filter_payload(len(kwargs["candidates"])),
            usage={},
            model="test-model",
        )

    async def rank_topics(client, **kwargs) -> AIResult:
        return AIResult(
            payload={
                "duplicate_pair_ids": [],
            },
            usage={},
            model="test-model",
        )

    monkeypatch.setattr(activities, "_google_ads_site_request", add_google_ads_rows)
    keyword_ideas = AsyncMock(return_value=([], False))
    monkeypatch.setattr(activities, "_keyword_ideas_request", keyword_ideas)
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        select_topics,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        rank_topics,
    )

    result = await activities.prepare_seeds({})

    assert supplemented_contexts == [repository.context]
    assert result["google_ads_supplemented"] is True
    assert result["candidate_count"] == 56
    assert result["selected_topic_count"] == 54
    assert result["deterministic_duplicate_pair_count"] == 0
    assert len(repository.saved_decisions) == 56
    assert sum(not decision.selected for decision in repository.saved_decisions) == 2
    keyword_ideas.assert_not_awaited()


@pytest.mark.anyio
async def test_seed_preparation_supplements_large_irrelevant_labs_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class IrrelevantLabsRepository(SeedPreparationRepository):
        def __init__(self) -> None:
            super().__init__(0)
            self.ideas = [
                RawKeyword(
                    keyword=f"unrelated weather report {index}",
                    source="labs_site",
                    provider_rank=index,
                    search_volume=20_000 - index,
                )
                for index in range(1, 501)
            ]

        async def load_ideas(self, run_id: str, sources: list[str]) -> list[RawKeyword]:
            return [row for row in self.ideas if row.source in sources]

        async def save_ideas(self, context, rows) -> int:
            saved = list(rows)
            self.ideas.extend(saved)
            return len(saved)

    repository = IrrelevantLabsRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    google_ads_calls: list[str] = []
    keyword_ideas_calls: list[tuple[list[str], bool]] = []

    async def add_google_ads_rows(context: KeywordRunContext) -> list[RawKeyword]:
        google_ads_calls.append(context.domain)
        rows = [
            RawKeyword(
                keyword=f"solar installation quote {index}",
                source="google_ads_site",
                provider_rank=index,
                search_volume=1_000 - index,
            )
            for index in range(1, 6)
        ]
        repository.ideas.extend(rows)
        return rows

    async def add_keyword_ideas(context, *, keywords, closely_variants, **kwargs):
        keyword_ideas_calls.append((keywords, closely_variants))
        modifiers = [
            "cost",
            "price",
            "service",
            "company",
            "contractor",
            "quote",
            "financing",
            "warranty",
            "consultation",
            "assessment",
            "planning",
            "design",
            "maintenance",
            "repair",
            "inspection",
            "support",
            "specialist",
            "provider",
            "packages",
            "options",
            "benefits",
            "requirements",
            "incentives",
            "timeline",
            "process",
        ]
        rows = [
            RawKeyword(
                keyword=f"solar installation {modifier}",
                source=(
                    DataForSEOClient.KEYWORD_IDEAS_CLOSE_SOURCE
                    if closely_variants
                    else DataForSEOClient.KEYWORD_IDEAS_BROAD_SOURCE
                ),
                provider_rank=index,
                search_volume=800 - index,
            )
            for index, modifier in enumerate(modifiers, start=1)
        ]
        repository.ideas.extend(rows)
        return rows, False

    async def select_topics(client, **kwargs) -> AIResult:
        decisions = [
            (
                "keep"
                if "solar installation" in candidate.normalized_keyword
                else "remove_irrelevant"
            )
            for candidate in kwargs["candidates"]
        ]
        return AIResult(payload={"decisions": decisions}, usage={}, model="test-model")

    async def rank_topics(client, **kwargs) -> AIResult:
        return AIResult(payload={"duplicate_pair_ids": []}, usage={}, model="test-model")

    monkeypatch.setattr(activities, "_google_ads_site_request", add_google_ads_rows)
    monkeypatch.setattr(activities, "_keyword_ideas_request", add_keyword_ideas)
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        select_topics,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        rank_topics,
    )

    result = await activities.prepare_seeds({})

    assert google_ads_calls == [repository.context.domain]
    assert len(keyword_ideas_calls) == 1
    assert all("solar installation" in keywords for keywords, _ in keyword_ideas_calls)
    assert {closely_variants for _, closely_variants in keyword_ideas_calls} == {False}
    assert result["google_ads_supplemented"] is True
    assert result["fallback_keyword_ideas_used"] is True
    assert result["selected_topic_count"] >= 20


@pytest.mark.anyio
async def test_seed_preparation_does_not_use_competitor_when_site_sources_are_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CompetitorFallbackRepository(SeedPreparationRepository):
        def __init__(self) -> None:
            super().__init__(0)
            self.context = KeywordRunContext(
                **{
                    **self.context.__dict__,
                    "competitor_domain": "competitor.example",
                }
            )

        async def load_confirmed_gap_keywords(self, run_id: str) -> list[RawKeyword]:
            return [
                RawKeyword(
                    keyword="residential solar financing",
                    source="competitor_gap",
                    provider_rank=1,
                    search_volume=1_900,
                    keyword_difficulty=28,
                    intent="commercial",
                )
            ]

    repository = CompetitorFallbackRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    monkeypatch.setattr(
        activities,
        "_keyword_ideas_request",
        AsyncMock(return_value=([], False)),
    )
    monkeypatch.setattr(
        activities,
        "_google_ads_site_request",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        activities,
        "fetch_competitor_gap",
        AsyncMock(return_value={"status": "pending", "count": 1}),
    )
    monkeypatch.setattr(
        activities,
        "validate_competitor",
        AsyncMock(return_value={"status": "confirmed", "count": 1}),
    )

    async def select_topics(client, **kwargs) -> AIResult:
        return AIResult(
            payload=approved_initial_filter_payload(len(kwargs["candidates"])),
            usage={},
            model="test-model",
        )

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        select_topics,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        AsyncMock(
            return_value=AIResult(
                payload={"duplicate_pair_ids": []},
                usage={},
                model="test-model",
            )
        ),
    )

    with pytest.raises(ApplicationError) as exc_info:
        await activities.prepare_seeds({})

    assert exc_info.value.type == "seed_candidates_empty"
    activities.fetch_competitor_gap.assert_not_awaited()
    activities.validate_competitor.assert_not_awaited()


@pytest.mark.anyio
async def test_seed_preparation_keeps_competitor_analysis_out_of_site_keywords(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CompetitorSupplementRepository(SeedPreparationRepository):
        def __init__(self) -> None:
            super().__init__(2)
            self.context = KeywordRunContext(
                **{
                    **self.context.__dict__,
                    "competitor_domain": "competitor.example",
                }
            )

        async def load_confirmed_gap_keywords(self, run_id: str) -> list[RawKeyword]:
            return [
                RawKeyword(
                    keyword="residential solar financing",
                    source="competitor_gap",
                    provider_rank=1,
                    search_volume=1_900,
                    keyword_difficulty=28,
                    intent="commercial",
                )
            ]

    repository = CompetitorSupplementRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    fetch = AsyncMock(return_value={"status": "pending", "count": 1})
    validate = AsyncMock(return_value={"status": "confirmed", "count": 1})
    monkeypatch.setattr(activities, "fetch_competitor_gap", fetch)
    monkeypatch.setattr(activities, "validate_competitor", validate)
    monkeypatch.setattr(
        activities,
        "_google_ads_site_request",
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        activities,
        "_keyword_ideas_request",
        AsyncMock(return_value=([], False)),
    )

    async def select_topics(client, **kwargs) -> AIResult:
        return AIResult(
            payload=approved_initial_filter_payload(len(kwargs["candidates"])),
            usage={},
            model="test-model",
        )

    monkeypatch.setattr(
        OpenAICompatibleClient,
        "filter_initial_library_candidates",
        select_topics,
    )
    monkeypatch.setattr(
        OpenAICompatibleClient,
        "select_active_topic_representatives",
        AsyncMock(
            return_value=AIResult(
                payload={"duplicate_pair_ids": []},
                usage={},
                model="test-model",
            )
        ),
    )

    result = await activities.prepare_seeds({})

    fetch.assert_not_awaited()
    validate.assert_not_awaited()
    assert result["competitor_supplemented"] is False
    assert result["competitor_status"] == "not_requested"
    assert result["candidate_count"] == 2
    assert result["selected_topic_count"] == 2


class ExpansionRepository:
    def __init__(self, existing: dict[str, list[RawKeyword]] | None = None) -> None:
        self.ideas = dict(existing or {})
        self.started_requests: list[str] = []
        self.submitted_requests: list[str] = []
        self.completed_requests: list[tuple[str, dict]] = []
        self.partial_failures: list[dict] = []

    async def load_context(self, task: dict) -> KeywordRunContext:
        return CONTEXT

    async def set_stage(self, *args, **kwargs) -> None:
        return None

    async def load_active_seeds(self, run_id: str) -> list[dict]:
        return [
            {
                "id": f"seed-{index}",
                "keyword": f"seed keyword {index}",
                "ai_rank": index,
            }
            for index in range(1, 23)
        ]

    async def request_ideas(self, run_id: str, source: str) -> list[RawKeyword]:
        return self.ideas.get(source, [])

    async def begin_external_request(self, **kwargs) -> ExternalRequestRecord:
        request_key = kwargs["request_key"]
        self.started_requests.append(request_key)
        return ExternalRequestRecord(
            request_key=request_key,
            status="prepared",
            build_run_id=CONTEXT.run_id,
            result_count=0,
            response_metadata={},
            expires_at=None,
            claim_token=f"claim:{request_key}",
        )

    async def mark_external_request_submitted(
        self,
        request_key: str,
        *,
        claim_token: str,
    ) -> bool:
        assert claim_token == f"claim:{request_key}"
        self.submitted_requests.append(request_key)
        return True

    async def load_dataforseo_config(
        self,
        organization_id: str,
    ) -> DataForSEOProviderConfig:
        return DataForSEOProviderConfig(login="login", password="password")

    async def save_ideas(
        self,
        context: KeywordRunContext,
        rows: list[RawKeyword],
    ) -> int:
        for row in rows:
            self.ideas.setdefault(row.source, []).append(row)
        return len(rows)

    async def complete_external_request(self, request_key: str, **kwargs) -> None:
        self.completed_requests.append((request_key, kwargs))

    async def fail_external_request(self, *args, **kwargs) -> None:
        raise AssertionError("keyword ideas request should not fail")

    async def record_partial_failure(self, run_id: str, **kwargs) -> None:
        self.partial_failures.append({"run_id": run_id, **kwargs})


class TopicCommitRepository:
    def __init__(self) -> None:
        self.context = KeywordRunContext(
            **{
                **CONTEXT.__dict__,
                "profile": {
                    "business_model": "product",
                    "products_services": ["car care products"],
                },
            }
        )
        self.completed_requests: list[tuple[str, dict]] = []
        self.records: list[dict] = []
        self.selected_candidates = []
        self.staged_metrics: dict[str, dict] = {}

    async def load_context(self, task: dict) -> KeywordRunContext:
        return self.context

    async def load_selected_topics(self, run_id: str) -> list[dict]:
        return [
            {
                "id": "seed-1",
                "keyword": "headlight restoration",
                "normalized_keyword": "headlight restoration",
                "ai_rank": 1,
                "business_topic": "headlight | restoration | informational",
                "candidate_score": 0.8,
            },
            {
                "id": "seed-2",
                "keyword": "car scratch remover",
                "normalized_keyword": "car scratch remover",
                "ai_rank": 2,
                "business_topic": "car scratch | removal | product",
                "candidate_score": 0.95,
            },
        ]

    async def load_ideas(self, run_id: str, sources: list[str]) -> list[RawKeyword]:
        return [
            RawKeyword(
                keyword="headlight restoration",
                source="labs_site",
                provider_rank=1,
                search_volume=8_100,
                cpc=1.4,
                competition=0.4,
                keyword_difficulty=31,
                intent="informational",
            ),
            RawKeyword(
                keyword="car scratch remover",
                source="google_ads_site",
                provider_rank=2,
                search_volume=6_600,
                cpc=2.2,
                competition=0.7,
            ),
        ]

    async def load_confirmed_gap_keywords(self, run_id: str) -> list[RawKeyword]:
        return []

    async def mark_candidate_selection(self, *args, **kwargs) -> None:
        self.selected_candidates = list(args[1])

    async def save_staged_metrics(self, run_id: str, metrics: dict[str, dict]) -> None:
        self.staged_metrics = metrics

    async def load_staged_keywords(self, run_id: str) -> list[StagedKeyword]:
        return [
            StagedKeyword(
                candidate=candidate,
                metric={
                    key: value
                    for key, value in self.staged_metrics[candidate.normalized_keyword].items()
                    if not key.startswith("_")
                },
                metrics_status=str(
                    self.staged_metrics[candidate.normalized_keyword].get("_status")
                ),
            )
            for candidate in self.selected_candidates
        ]

    async def set_stage(self, *args, **kwargs) -> None:
        return None

    async def load_dataforseo_config(
        self,
        organization_id: str,
    ) -> DataForSEOProviderConfig:
        return DataForSEOProviderConfig(login="login", password="password")

    async def begin_external_request(self, **kwargs) -> ExternalRequestRecord:
        return ExternalRequestRecord(
            request_key=kwargs["request_key"],
            status="prepared",
            build_run_id=self.context.run_id,
            result_count=0,
            response_metadata={},
            expires_at=None,
            claim_token="claim-overview",
        )

    async def mark_external_request_submitted(
        self,
        request_key: str,
        *,
        claim_token: str,
    ) -> bool:
        return claim_token == "claim-overview"

    async def complete_external_request(self, request_key: str, **kwargs) -> None:
        self.completed_requests.append((request_key, kwargs))

    async def fail_external_request(self, *args, **kwargs) -> None:
        raise AssertionError("overview request should not fail")

    async def record_partial_failure(self, *args, **kwargs) -> None:
        raise AssertionError("overview request should not create a partial failure")

    async def commit_keywords(
        self,
        context,
        records: list[dict],
    ) -> KeywordCommitResult:
        self.records = records
        return KeywordCommitResult(
            result_version=7,
            keyword_count=len(records),
            pending_metrics_count=sum(record["metrics_status"] == "pending" for record in records),
        )

    async def load_pending_metric_keywords(self, run_id: str) -> list[str]:
        return ["car scratch remover"]

    async def finish_pending_metrics(
        self,
        context,
        keywords: list[str],
        rows: list[RawKeyword],
        *,
        failed: bool,
    ) -> dict[str, int]:
        assert keywords == ["car scratch remover"]
        assert failed is False
        assert rows[0].keyword == "car scratch remover"
        return {
            "updated": 1,
            "failed": 0,
            "no_data": 0,
            "pending_metrics_count": 0,
            "result_version": 8,
        }


@pytest.mark.anyio
async def test_topic_metrics_are_staged_before_database_only_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TopicCommitRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    overview_calls: list[list[str]] = []

    async def keyword_overview(client: DataForSEOClient, **kwargs):
        overview_calls.append(kwargs["keywords"])
        return (
            [
                RawKeyword(
                    keyword="car scratch remover",
                    source="keyword_overview",
                    search_volume=6_600,
                    cpc=2.2,
                    competition=0.7,
                    keyword_difficulty=38,
                    intent="commercial",
                )
            ],
            DataForSEOBilling(cost_usd=0.01, path=["keyword_overview"]),
        )

    monkeypatch.setattr(DataForSEOClient, "keyword_overview", keyword_overview)

    metrics_result = await activities.prepare_topic_metrics({})
    result = await activities.commit_topics({})

    assert overview_calls == [["car scratch remover"]]
    assert metrics_result == {
        "topic_count": 2,
        "pending_metrics_count": 0,
        "overview_requested_count": 1,
        "overview_returned_count": 1,
        "overview_failed": False,
        "overview_retryable": False,
        "overview_failure_code": "",
        "failed_metrics_count": 0,
    }
    assert result == {
        "keyword_count": 2,
        "pending_metrics_count": 0,
        "result_version": 7,
    }
    assert len(repository.records) == 2
    assert [candidate.relevance for candidate in repository.selected_candidates] == [0.8, 0.95]
    assert all(record["metrics_status"] == "fresh" for record in repository.records)
    assert repository.records[1]["metric"]["keyword_difficulty"] == 38
    assert repository.records[1]["metric"]["intent"] == "commercial"
    assert repository.records[1]["primary_seed_id"] == "seed-2"
    assert repository.completed_requests[0][0].endswith("keyword-overview:initial")


@pytest.mark.anyio
async def test_labs_null_metrics_do_not_trigger_paid_overview(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TopicCommitRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def load_ideas(run_id: str, sources: list[str]) -> list[RawKeyword]:
        return [
            RawKeyword(keyword="headlight restoration", source="labs_site", provider_rank=1),
            RawKeyword(keyword="car scratch remover", source="labs_site", provider_rank=2),
        ]

    overview = AsyncMock(side_effect=AssertionError("Labs nulls must not be re-fetched"))
    monkeypatch.setattr(repository, "load_ideas", load_ideas)
    monkeypatch.setattr(activities, "_keyword_overview_request", overview)

    metrics_result = await activities.prepare_topic_metrics({})
    commit_result = await activities.commit_topics({})

    assert metrics_result["overview_requested_count"] == 0
    assert metrics_result["pending_metrics_count"] == 0
    assert metrics_result["failed_metrics_count"] == 0
    assert commit_result["pending_metrics_count"] == 0
    assert all(record["metrics_status"] == "fresh" for record in repository.records)
    assert all(record["metric"]["keyword_difficulty"] is None for record in repository.records)
    overview.assert_not_awaited()


@pytest.mark.anyio
async def test_overview_null_response_is_completed_without_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TopicCommitRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def keyword_overview(client: DataForSEOClient, **kwargs):
        return (
            [
                RawKeyword(
                    keyword="car scratch remover",
                    source="keyword_overview",
                    search_volume=6_600,
                    keyword_difficulty=None,
                    intent=None,
                )
            ],
            DataForSEOBilling(cost_usd=0.01, path=["keyword_overview"]),
        )

    monkeypatch.setattr(DataForSEOClient, "keyword_overview", keyword_overview)

    metrics_result = await activities.prepare_topic_metrics({})
    commit_result = await activities.commit_topics({})

    assert metrics_result["overview_requested_count"] == 1
    assert metrics_result["overview_returned_count"] == 1
    assert metrics_result["pending_metrics_count"] == 0
    assert metrics_result["failed_metrics_count"] == 0
    assert commit_result["pending_metrics_count"] == 0
    null_record = next(
        record
        for record in repository.records
        if record["candidate"].normalized_keyword == "car scratch remover"
    )
    assert null_record["metrics_status"] == "fresh"
    assert null_record["metric"]["keyword_difficulty"] is None
    assert null_record["metric"]["intent"] is None


@pytest.mark.anyio
async def test_refresh_pending_metrics_finishes_the_background_metric_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TopicCommitRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def keyword_overview(client: DataForSEOClient, **kwargs):
        return (
            [
                RawKeyword(
                    keyword="car scratch remover",
                    source="keyword_overview",
                    keyword_difficulty=38,
                    intent="commercial",
                )
            ],
            DataForSEOBilling(cost_usd=0.01, path=["keyword_overview"]),
        )

    monkeypatch.setattr(DataForSEOClient, "keyword_overview", keyword_overview)

    result = await activities.refresh_pending_metrics({})

    assert result == {
        "requested": 1,
        "retryable": False,
        "updated": 1,
        "failed": 0,
        "no_data": 0,
        "pending_metrics_count": 0,
        "result_version": 8,
    }


@pytest.mark.anyio
async def test_refresh_pending_metrics_keeps_retryable_failure_pending(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TopicCommitRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    events: list[str] = []

    async def keyword_overview(*args, **kwargs):
        raise ApplicationError(
            "DataForSEO暂时不可用",
            type="dataforseo_retryable",
        )

    async def record_partial_failure(*args, **kwargs) -> None:
        events.append("recorded")

    monkeypatch.setattr(activities, "_keyword_overview_request", keyword_overview)
    monkeypatch.setattr(repository, "record_partial_failure", record_partial_failure)

    result = await activities.refresh_pending_metrics({})

    assert events == ["recorded"]
    assert result == {
        "requested": 1,
        "updated": 0,
        "failed": 0,
        "no_data": 0,
        "pending_metrics_count": 1,
        "retryable": True,
        "failure_code": "dataforseo_retryable",
    }


@pytest.mark.anyio
async def test_settle_pending_metrics_closes_pending_state_without_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = TopicCommitRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    recorded: list[dict] = []

    async def record_partial_failure(*args, **kwargs) -> None:
        recorded.append(kwargs)

    async def finish_pending_metrics(
        context,
        keywords: list[str],
        rows: list[RawKeyword],
        *,
        failed: bool,
    ) -> dict[str, int]:
        assert keywords == ["car scratch remover"]
        assert rows == []
        assert failed is True
        return {
            "updated": 0,
            "failed": 1,
            "no_data": 0,
            "pending_metrics_count": 0,
            "result_version": 8,
        }

    monkeypatch.setattr(repository, "record_partial_failure", record_partial_failure)
    monkeypatch.setattr(repository, "finish_pending_metrics", finish_pending_metrics)

    result = await activities.settle_pending_metrics(
        {
            "task": {},
            "code": "activity_crashed",
            "detail": "worker connection interrupted",
        }
    )

    assert recorded[0]["code"] == "activity_crashed"
    assert result["pending_metrics_count"] == 0


class PriorityRefreshConnection:
    def __init__(self) -> None:
        self.updates: list[tuple] = []

    async def fetch(self, query: str, *args):
        assert "FROM keywords AS keyword" in query
        return [
            {
                "id": "keyword-1",
                "keyword": "headlight restoration",
                "normalized_keyword": "headlight restoration",
                "classification_confidence": 0.9,
                "search_volume": 1000,
                "keyword_difficulty": 30,
                "intent": "informational",
            },
            {
                "id": "keyword-2",
                "keyword": "car scratch remover",
                "normalized_keyword": "car scratch remover",
                "classification_confidence": 0.8,
                "search_volume": 500,
                "keyword_difficulty": 60,
                "intent": "commercial",
            },
        ]

    async def executemany(self, query: str, values: list[tuple]) -> None:
        assert "priority_score = $2" in query
        self.updates = values


@pytest.mark.anyio
async def test_priority_scores_are_recalculated_from_recovered_metrics() -> None:
    repository = KeywordRepository(None, KeywordWorkerSettings())  # type: ignore[arg-type]
    connection = PriorityRefreshConnection()

    updated = await repository._refresh_priority_scores(connection, CONTEXT)  # type: ignore[arg-type]

    assert updated == 2
    assert len(connection.updates) == 2
    first = connection.updates[0]
    assert first[0] == "keyword-1"
    assert first[2] == 0.9
    assert first[3]["values"]["difficulty"] == 70.0
    assert first[3]["values"]["intent"] is not None


@pytest.mark.anyio
async def test_labs_site_discovery_requests_five_hundred_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = ExpansionRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    requested_limits: list[int] = []

    async def labs_keywords_for_site(client: DataForSEOClient, **kwargs):
        requested_limits.append(kwargs["limit"])
        return (
            [
                RawKeyword(
                    keyword="car care products",
                    source="labs_site",
                    search_volume=10_000,
                )
            ],
            DataForSEOBilling(cost_usd=0.01, path=["keywords_for_site"]),
        )

    monkeypatch.setattr(
        DataForSEOClient,
        "labs_keywords_for_site",
        labs_keywords_for_site,
    )

    rows = await activities._labs_site_request(CONTEXT)

    assert requested_limits == [500]
    assert rows[0].keyword == "car care products"
    assert repository.completed_requests[0][1]["metadata"]["limit"] == 500


@pytest.mark.anyio
async def test_seed_discovery_uses_labs_without_calling_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activities = KeywordActivities(DiscoveryRepository(), KeywordWorkerSettings())
    labs = AsyncMock(
        return_value=[
            RawKeyword(
                keyword="solar installation",
                source="labs_site",
                provider_rank=1,
            )
        ]
    )
    fallback = AsyncMock()
    monkeypatch.setattr(activities, "_labs_site_request", labs)
    monkeypatch.setattr(activities, "_google_ads_site_request", fallback)

    result = await activities.discover_seeds({})

    assert result == {"source": "labs_site", "count": 1, "fallback": False}
    fallback.assert_not_awaited()


@pytest.mark.anyio
async def test_seed_discovery_falls_back_only_when_labs_returns_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activities = KeywordActivities(DiscoveryRepository(), KeywordWorkerSettings())
    labs = AsyncMock(return_value=[])
    fallback = AsyncMock(
        return_value=[
            RawKeyword(
                keyword="car care products",
                source="google_ads_site",
                provider_rank=1,
            )
        ]
    )
    monkeypatch.setattr(activities, "_labs_site_request", labs)
    monkeypatch.setattr(activities, "_google_ads_site_request", fallback)

    result = await activities.discover_seeds({})

    assert result == {
        "source": "google_ads_site",
        "count": 1,
        "fallback": True,
    }
    fallback.assert_awaited_once()


@pytest.mark.anyio
async def test_seed_discovery_defers_empty_sources_to_business_keyword_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activities = KeywordActivities(DiscoveryRepository(), KeywordWorkerSettings())
    monkeypatch.setattr(activities, "_labs_site_request", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        activities,
        "_google_ads_site_request",
        AsyncMock(return_value=[]),
    )

    result = await activities.discover_seeds({})

    assert result == {
        "source": "none",
        "count": 0,
        "fallback": True,
    }


@pytest.mark.anyio
async def test_seed_discovery_uses_google_ads_when_labs_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = DiscoveryRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    labs = AsyncMock(
        side_effect=ApplicationError(
            "DataForSEO 暂时不可用",
            type="network_error",
        )
    )
    fallback = AsyncMock(
        return_value=[
            RawKeyword(
                keyword="car care products",
                source="google_ads_site",
                provider_rank=1,
            )
        ]
    )
    monkeypatch.setattr(activities, "_labs_site_request", labs)
    monkeypatch.setattr(activities, "_google_ads_site_request", fallback)

    result = await activities.discover_seeds({})

    assert result == {
        "source": "google_ads_site",
        "count": 1,
        "fallback": True,
    }
    fallback.assert_awaited_once()
    assert repository.partial_failures == [
        {
            "run_id": CONTEXT.run_id,
            "source": "labs_site",
            "code": "network_error",
            "message": "network_error: DataForSEO 暂时不可用",
        }
    ]


@pytest.mark.anyio
async def test_keyword_expansion_combines_broad_and_close_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = ExpansionRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    calls: list[dict] = []

    async def keyword_ideas(
        client: DataForSEOClient,
        *,
        keywords: list[str],
        country: str,
        language: str,
        closely_variants: bool,
        limit: int,
    ) -> tuple[list[RawKeyword], DataForSEOBilling]:
        calls.append(
            {
                "keywords": keywords,
                "country": country,
                "language": language,
                "closely_variants": closely_variants,
                "limit": limit,
            }
        )
        source = (
            client.KEYWORD_IDEAS_CLOSE_SOURCE
            if closely_variants
            else client.KEYWORD_IDEAS_BROAD_SOURCE
        )
        suffix = "close" if closely_variants else "broad"
        return (
            [
                RawKeyword(keyword="shared keyword", source=source, provider_rank=1),
                RawKeyword(keyword=f"{suffix} keyword", source=source, provider_rank=2),
            ],
            DataForSEOBilling(cost_usd=0.05, path=["v3", "keyword_ideas"]),
        )

    monkeypatch.setattr(DataForSEOClient, "keyword_ideas", keyword_ideas)

    result = await activities.expand_ideas({})

    assert [(call["closely_variants"], call["limit"]) for call in calls] == [
        (False, 400),
        (True, 300),
    ]
    assert all(len(call["keywords"]) == 20 for call in calls)
    assert result == {
        "count": 3,
        "fetched_count": 4,
        "broad_count": 2,
        "close_count": 2,
        "reused": False,
    }
    assert repository.started_requests == [
        "keyword:run-1:dataforseo:keyword-ideas:expansion:broad",
        "keyword:run-1:dataforseo:keyword-ideas:expansion:close",
    ]
    assert len(repository.completed_requests) == 2
    assert repository.completed_requests[0][1]["metadata"]["closely_variants"] is False
    assert repository.completed_requests[1][1]["metadata"]["closely_variants"] is True


@pytest.mark.anyio
async def test_keyword_expansion_reuses_both_saved_modes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = ExpansionRepository(
        {
            "keyword_ideas_broad": [
                RawKeyword(
                    keyword="shared keyword",
                    source="keyword_ideas_broad",
                    provider_rank=1,
                )
            ],
            "keyword_ideas_close": [
                RawKeyword(
                    keyword="shared keyword",
                    source="keyword_ideas_close",
                    provider_rank=1,
                )
            ],
        }
    )
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    request = AsyncMock(side_effect=AssertionError("saved modes must not be requested again"))
    monkeypatch.setattr(DataForSEOClient, "keyword_ideas", request)

    result = await activities.expand_ideas({})

    assert result == {
        "count": 1,
        "fetched_count": 2,
        "broad_count": 1,
        "close_count": 1,
        "reused": True,
    }
    assert repository.started_requests == []
    request.assert_not_awaited()


@pytest.mark.anyio
async def test_keyword_expansion_reuses_legacy_saved_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = ExpansionRepository(
        {
            "keyword_ideas": [
                RawKeyword(
                    keyword="legacy keyword",
                    source="keyword_ideas",
                    provider_rank=1,
                )
            ],
        }
    )
    activities = KeywordActivities(repository, KeywordWorkerSettings())
    request = AsyncMock(side_effect=AssertionError("legacy results must not be requested again"))
    monkeypatch.setattr(DataForSEOClient, "keyword_ideas", request)

    result = await activities.expand_ideas({})

    assert result == {
        "count": 1,
        "fetched_count": 1,
        "broad_count": 0,
        "close_count": 0,
        "reused": True,
        "legacy": True,
    }
    assert repository.started_requests == []
    request.assert_not_awaited()


@pytest.mark.anyio
async def test_keyword_expansion_keeps_successful_mode_when_the_other_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = ExpansionRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def request_mode(
        context: KeywordRunContext,
        *,
        keywords: list[str],
        closely_variants: bool,
        limit: int,
    ) -> tuple[list[RawKeyword], bool]:
        if closely_variants:
            raise ApplicationError("相近拓词暂时不可用", type="network_error")
        return (
            [
                RawKeyword(
                    keyword="car care guide",
                    source="keyword_ideas_broad",
                    provider_rank=1,
                )
            ],
            False,
        )

    monkeypatch.setattr(activities, "_keyword_ideas_request", request_mode)

    result = await activities.expand_ideas({})

    assert result["count"] == 1
    assert result["broad_count"] == 1
    assert result["close_count"] == 0
    assert result["partial_failures"] == [
        {
            "mode": "close",
            "code": "network_error",
            "message": "network_error: 相近拓词暂时不可用",
        }
    ]
    assert repository.partial_failures[0]["source"] == "keyword_ideas_close"


@pytest.mark.anyio
async def test_keyword_expansion_defers_when_both_paid_modes_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = ExpansionRepository()
    activities = KeywordActivities(repository, KeywordWorkerSettings())

    async def request_mode(
        context: KeywordRunContext,
        *,
        keywords: list[str],
        closely_variants: bool,
        limit: int,
    ) -> tuple[list[RawKeyword], bool]:
        mode = "close" if closely_variants else "broad"
        raise ApplicationError(
            f"{mode} mode unavailable",
            type=f"{mode}_provider_error",
        )

    monkeypatch.setattr(activities, "_keyword_ideas_request", request_mode)

    with pytest.raises(
        ApplicationError,
        match="两种拓词方式暂时都没有返回可用关键词",
    ) as caught:
        await activities.expand_ideas({})

    assert caught.value.type == "keyword_expansion_recovery_required"
    assert [failure["source"] for failure in repository.partial_failures] == [
        "keyword_ideas_broad",
        "keyword_ideas_close",
    ]


@pytest.mark.anyio
async def test_keyword_expansion_treats_two_successful_empty_modes_as_no_data(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activities = KeywordActivities(ExpansionRepository(), KeywordWorkerSettings())

    async def request_mode(*args, **kwargs) -> tuple[list[RawKeyword], bool]:
        return [], False

    monkeypatch.setattr(activities, "_keyword_ideas_request", request_mode)

    with pytest.raises(ApplicationError) as caught:
        await activities.expand_ideas({})

    assert caught.value.type == "expanded_keywords_empty"
    assert caught.value.non_retryable is True


@pytest.mark.anyio
async def test_keyword_expansion_preserves_an_uncertain_paid_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activities = KeywordActivities(ExpansionRepository(), KeywordWorkerSettings())

    async def request_mode(
        context: KeywordRunContext,
        *,
        closely_variants: bool,
        **kwargs,
    ) -> tuple[list[RawKeyword], bool]:
        if closely_variants:
            return [], False
        raise ApplicationError(
            "请求结果无法确认",
            type="external_request_uncertain",
            non_retryable=True,
        )

    monkeypatch.setattr(activities, "_keyword_ideas_request", request_mode)

    with pytest.raises(ApplicationError) as caught:
        await activities.expand_ideas({})

    assert caught.value.type == "external_request_uncertain"


class FallbackProfileRepository:
    def __init__(self) -> None:
        self.saved_profile: dict | None = None
        self.saved_source = ""
        self.completed_request = ""
        self.submitted_request = ""
        self.partial_failures: list[dict] = []

    async def load_context(self, task: dict) -> KeywordRunContext:
        return CONTEXT

    async def set_stage(self, *args, **kwargs) -> None:
        return None

    async def poll_profile(self, context: KeywordRunContext) -> ProfilePollResult:
        return ProfilePollResult(
            profile=None,
            terminal=False,
            status="running",
            message="正在识别网站业务",
            source="",
            version="crawl-run-1",
            page_hints=[
                {
                    "url": "https://example.com/services",
                    "title": "Residential solar installation",
                    "description": "Solar panels and home batteries",
                    "h1": ["Solar installation"],
                }
            ],
        )

    async def load_ideas(self, run_id: str, sources: list[str]) -> list[RawKeyword]:
        return [
            RawKeyword(
                keyword="residential solar installer",
                source="labs_site",
                provider_rank=1,
                search_volume=1000,
            )
        ]

    async def load_ai_config(self, organization_id: str) -> AIProviderConfig:
        return AIProviderConfig(
            base_url="https://ai.example.test/v1",
            api_key="test-key",
            model="test-model",
            timeout_seconds=10,
            max_retries=0,
        )

    async def begin_external_request(self, **kwargs) -> ExternalRequestRecord:
        return ExternalRequestRecord(
            request_key=kwargs["request_key"],
            status="prepared",
            build_run_id=CONTEXT.run_id,
            result_count=0,
            response_metadata={},
            expires_at=None,
            claim_token=f"claim:{kwargs['request_key']}",
        )

    async def mark_external_request_submitted(
        self,
        request_key: str,
        *,
        claim_token: str,
    ) -> bool:
        assert claim_token == f"claim:{request_key}"
        self.submitted_request = request_key
        return True

    async def complete_external_request(self, request_key: str, **kwargs) -> None:
        self.completed_request = request_key

    async def fail_external_request(self, *args, **kwargs) -> None:
        raise AssertionError("fallback profile request should not fail")

    async def record_partial_failure(self, run_id: str, **kwargs) -> None:
        self.partial_failures.append({"run_id": run_id, **kwargs})

    async def save_profile_snapshot(
        self,
        context: KeywordRunContext,
        profile: dict,
        *,
        source: str,
        version: str,
    ) -> dict:
        self.saved_profile = profile
        self.saved_source = source
        return profile


class ExpiredClock:
    def __init__(self) -> None:
        self.calls = 0

    def time(self) -> float:
        self.calls += 1
        return 0.0 if self.calls == 1 else 2.0


@pytest.mark.anyio
async def test_business_profile_timeout_builds_an_ai_domain_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = FallbackProfileRepository()
    settings = KeywordWorkerSettings(keyword_profile_wait_seconds=1)
    activities = KeywordActivities(repository, settings)
    captured: dict = {}

    async def build_profile(client, **kwargs) -> AIResult:
        captured.update(kwargs)
        return AIResult(
            payload={
                "business_name": "Example Solar",
                "business_type": "solar installer",
                "business_summary": "Installs residential solar and battery systems.",
                "products_services": ["solar installation", "home batteries"],
                "target_audiences": ["homeowners"],
                "use_cases": ["lower electricity bills"],
                "content_topics": ["solar energy"],
                "exclusion_terms": [],
                "confidence": 0.81,
                "evidence_summary": "Domain, page title and candidate keyword agree.",
            },
            usage={"input_tokens": 100, "output_tokens": 80},
            model="test-model",
        )

    monkeypatch.setattr(
        "seo_workers.keywords.activities.asyncio.get_running_loop",
        lambda: ExpiredClock(),
    )
    monkeypatch.setattr(
        "seo_workers.keywords.activities.OpenAICompatibleClient.build_fallback_profile",
        build_profile,
    )

    result = await activities.acquire_business_profile({})

    assert result["source"] == "ai_domain_fallback"
    assert captured["domain"] == "example.com"
    assert captured["candidates"][0].keyword == "residential solar installer"
    assert captured["page_hints"][0]["title"] == "Residential solar installation"
    assert repository.saved_source == "ai_domain_fallback"
    assert repository.saved_profile is not None
    assert repository.saved_profile["business_model"] == "service"
    assert repository.saved_profile["extraction_method"] == "ai_domain_fallback"
    assert repository.saved_profile["confidence"] == 0.81
    assert repository.completed_request.endswith("domain-profile-fallback:v1")
    assert repository.submitted_request == repository.completed_request
