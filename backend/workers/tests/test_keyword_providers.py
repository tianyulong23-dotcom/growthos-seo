import json
from datetime import UTC, datetime

import httpx
import pytest

from seo_workers.keywords.domain import (
    RawKeyword,
    SeedCandidate,
    SeedPoolGroup,
    TopicDuplicatePair,
)
from seo_workers.keywords.providers import (
    CHARGED_FAILURE,
    RETRYABLE_FAILURE,
    UNCERTAIN_FAILURE,
    AIProviderConfig,
    DataForSEOClient,
    DataForSEOProviderConfig,
    GSCProviderConfig,
    GoogleSearchConsoleClient,
    JsonHttpClient,
    OpenAICompatibleClient,
    ProviderError,
    build_active_seed_selection_prompt,
    build_diverse_seed_pool_prompt,
    build_grouped_active_seed_prompt,
    build_initial_library_filter_prompt,
    build_natural_seed_clustering_prompt,
    build_seed_clustering_prompt,
    build_seed_filter_prompt,
    build_seed_ranking_prompt,
    build_seed_topic_representatives_prompt,
    build_topic_active_selection_prompt,
    compact_seed_profile,
    completion_token_parameter,
    host_matches_domain,
    initial_library_filter_schema,
    is_same_domain,
    sort_serp_competitors,
)


def dataforseo_response(result: list[dict], *, cost: float = 0.01) -> dict:
    return {
        "status_code": 20000,
        "status_message": "Ok.",
        "tasks": [
            {
                "status_code": 20000,
                "status_message": "Ok.",
                "cost": cost,
                "path": ["v3", "dataforseo_labs", "google"],
                "result": result,
            }
        ],
    }


async def mock_client(
    handler: httpx.MockTransport,
) -> tuple[DataForSEOClient, JsonHttpClient]:
    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=handler)
    config = DataForSEOProviderConfig(
        login="api-login",
        password="api-password",
    )
    return DataForSEOClient(config, http), http


@pytest.mark.anyio
async def test_gsc_query_performance_matches_openseo_date_and_query_contract() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "access-token"})
        return httpx.Response(
            200,
            json={
                "rows": [
                    {
                        "keys": ["seo software"],
                        "clicks": 20,
                        "impressions": 400,
                        "ctr": 0.05,
                        "position": 6.2,
                    }
                ]
            },
        )

    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = GoogleSearchConsoleClient(
        http,
        GSCProviderConfig(
            project_id="project-1",
            site_url="sc-domain:example.com",
            refresh_token="refresh-token",
            client_id="client-id",
            client_secret="client-secret",
        ),
    )
    try:
        rows = await client.query_performance(
            now=datetime(2026, 6, 1, 12, tzinfo=UTC)
        )
    finally:
        await http.close()

    assert len(requests) == 2
    assert requests[0].url.path == "/token"
    token_body = requests[0].content.decode()
    assert "grant_type=refresh_token" in token_body
    assert requests[1].url.raw_path.decode().endswith(
        "/sites/sc-domain%3Aexample.com/searchAnalytics/query"
    )
    assert json.loads(requests[1].content) == {
        "startDate": "2026-05-01",
        "endDate": "2026-05-29",
        "dimensions": ["query"],
        "rowLimit": 1000,
        "type": "web",
        "dataState": "all",
    }
    assert rows[0].query == "seo software"
    assert rows[0].clicks == 20
    assert rows[0].position == 6.2


@pytest.mark.anyio
async def test_gsc_revoked_refresh_token_requires_reconnect() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(400, json={"error": "invalid_grant"})

    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = GoogleSearchConsoleClient(
        http,
        GSCProviderConfig(
            project_id="project-1",
            site_url="sc-domain:example.com",
            refresh_token="revoked-token",
            client_id="client-id",
            client_secret="client-secret",
        ),
    )
    try:
        with pytest.raises(ProviderError) as caught:
            await client.query_performance()
    finally:
        await http.close()

    assert calls == 1
    assert caught.value.code == "gsc_reconnect_required"


@pytest.mark.anyio
async def test_labs_keywords_for_site_uses_site_discovery_parameters() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=dataforseo_response(
                [
                    {
                        "items": [
                            {
                                "keyword_data": {
                                    "keyword": "solar panel installation",
                                    "keyword_info": {
                                        "search_volume": 2400,
                                        "cpc": 3.2,
                                        "competition": 0.64,
                                        "monthly_searches": [
                                            {
                                                "year": 2026,
                                                "month": 6,
                                                "search_volume": 2400,
                                            }
                                        ],
                                    },
                                    "keyword_properties": {
                                        "keyword_difficulty": 42,
                                    },
                                    "search_intent_info": {
                                        "main_intent": "commercial",
                                    },
                                }
                            }
                        ]
                    }
                ],
                cost=0.012,
            ),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, billing = await client.labs_keywords_for_site(
            domain="example.com",
            country="US",
            language="en-US",
            limit=200,
        )
    finally:
        await http.close()

    assert len(requests) == 1
    request = requests[0]
    body = json.loads(request.content)[0]
    assert request.url.path.endswith("/dataforseo_labs/google/keywords_for_site/live")
    assert request.headers["authorization"].startswith("Basic ")
    assert body == {
        "target": "example.com",
        "location_name": "United States",
        "language_code": "en",
        "limit": 200,
        "include_subdomains": False,
        "include_clickstream_data": False,
        "include_serp_info": False,
    }
    assert billing.cost_usd == 0.012
    assert rows[0].keyword == "solar panel installation"
    assert rows[0].search_volume == 2400
    assert rows[0].keyword_difficulty == 42
    assert rows[0].intent == "commercial"


@pytest.mark.anyio
async def test_dataforseo_no_search_results_is_a_billable_empty_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status_code": 20000,
                "status_message": "Ok.",
                "tasks": [
                    {
                        "status_code": 40501,
                        "status_message": "No Search Results.",
                        "cost": 0.02,
                        "path": ["v3", "dataforseo_labs", "google"],
                        "result": None,
                    }
                ],
            },
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, billing = await client.labs_keywords_for_site(
            domain="no-results.example",
            country="US",
            language="en",
        )
    finally:
        await http.close()

    assert rows == []
    assert billing.cost_usd == 0.02


@pytest.mark.anyio
async def test_backlink_partial_failure_keeps_all_confirmed_costs() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                200,
                json=dataforseo_response([{"backlinks": 120}], cost=0.02),
            )
        return httpx.Response(
            200,
            json={
                "status_code": 20000,
                "status_message": "Ok.",
                "tasks": [
                    {
                        "status_code": 50000,
                        "status_message": "Internal provider error",
                        "cost": 0.03,
                        "path": ["v3", "backlinks", "referring_domains", "live"],
                        "result": None,
                    }
                ],
            },
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        with pytest.raises(ProviderError) as caught:
            await client.backlinks_overview(domain="competitor.example")
    finally:
        await http.close()

    assert calls == 2
    assert caught.value.cost_usd == pytest.approx(0.05)
    assert caught.value.failure_status == CHARGED_FAILURE
    assert caught.value.transient is False
    assert caught.value.path == [
        "v3",
        "dataforseo_labs",
        "google",
        "v3",
        "backlinks",
        "referring_domains",
        "live",
    ]


@pytest.mark.anyio
async def test_paid_dataforseo_read_timeout_is_not_retried() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("response timed out", request=request)

    http = JsonHttpClient(timeout_seconds=10, max_retries=3)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = DataForSEOClient(
        DataForSEOProviderConfig(login="api-login", password="api-password"),
        http,
    )
    try:
        with pytest.raises(ProviderError) as caught:
            await client.labs_keywords_for_site(
                domain="example.com",
                country="US",
                language="en",
            )
    finally:
        await http.close()

    assert calls == 1
    assert caught.value.code == "network_error"
    assert caught.value.failure_status == UNCERTAIN_FAILURE
    assert caught.value.transient is False


@pytest.mark.anyio
async def test_paid_dataforseo_connect_failure_is_safe_to_retry_later() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("connection refused", request=request)

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        with pytest.raises(ProviderError) as caught:
            await client.labs_keywords_for_site(
                domain="example.com",
                country="US",
                language="en",
            )
    finally:
        await http.close()

    assert calls == 1
    assert caught.value.code == "network_error"
    assert caught.value.failure_status == RETRYABLE_FAILURE
    assert caught.value.transient is True


@pytest.mark.anyio
async def test_paid_ai_read_timeout_is_not_retried() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("response timed out", request=request)

    http = JsonHttpClient(timeout_seconds=10, max_retries=3)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = OpenAICompatibleClient(
        http,
        AIProviderConfig(
            base_url="https://api.openai.test/v1",
            api_key="test-key",
            model="gpt-5.4-mini",
            timeout_seconds=10,
            max_retries=3,
        ),
    )
    try:
        with pytest.raises(ProviderError) as caught:
            await client.select_active_topic_representatives(
                topics=[
                    {
                        "representative_id": "k001",
                        "representative_keyword": "car care products",
                        "object": "car care",
                        "need": "product",
                        "page_intent": "product",
                        "search_volume": 1_000,
                    }
                ],
                duplicate_pairs=[],
                profile={"business_type": "Car care product brand"},
                country="US",
                language="en",
            )
    finally:
        await http.close()

    assert calls == 1
    assert caught.value.code == "network_error"
    assert caught.value.failure_status == UNCERTAIN_FAILURE
    assert caught.value.transient is False


@pytest.mark.anyio
async def test_paid_ai_http_failure_ignores_configured_internal_retries() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, json={"error": {"message": "busy"}})

    http = JsonHttpClient(timeout_seconds=10, max_retries=3)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = OpenAICompatibleClient(
        http,
        AIProviderConfig(
            base_url="https://api.openai.test/v1",
            api_key="test-key",
            model="gpt-5.4-mini",
            timeout_seconds=10,
            max_retries=2,
        ),
    )
    try:
        with pytest.raises(ProviderError) as caught:
            await client.select_active_topic_representatives(
                topics=[],
                duplicate_pairs=[],
                profile={},
                country="US",
                language="en",
            )
    finally:
        await http.close()

    assert calls == 1
    assert caught.value.code == "ai_http_error"


@pytest.mark.anyio
async def test_paid_ai_response_exposes_provider_reported_cost() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "model": "gpt-5.4-mini",
                "choices": [{"message": {"content": '{"duplicate_pair_ids":[],"ranked":[]}'}}],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                    "cost": 0.0015,
                },
            },
        )

    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await OpenAICompatibleClient(
            http,
            AIProviderConfig(
                base_url="https://api.openai.test/v1",
                api_key="test-key",
                model="gpt-5.4-mini",
                timeout_seconds=10,
                max_retries=0,
            ),
        ).select_active_topic_representatives(
            topics=[],
            duplicate_pairs=[],
            profile={},
            country="US",
            language="en",
        )
    finally:
        await http.close()

    assert result.cost_usd == 0.0015
    assert result.usage["total_tokens"] == 15


@pytest.mark.anyio
async def test_paid_ai_invalid_content_is_recorded_as_consumed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "model": "gpt-5.4-mini",
                "choices": [{"message": {"content": "not-json"}}],
                "usage": {"cost": 0.0012},
            },
        )

    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = OpenAICompatibleClient(
        http,
        AIProviderConfig(
            base_url="https://api.openai.test/v1",
            api_key="test-key",
            model="gpt-5.4-mini",
            timeout_seconds=10,
            max_retries=0,
        ),
    )
    try:
        with pytest.raises(ProviderError) as caught:
            await client.select_active_topic_representatives(
                topics=[
                    {
                        "representative_id": "k001",
                        "representative_keyword": "car care products",
                        "object": "car care",
                        "need": "product",
                        "page_intent": "product",
                        "search_volume": 1_000,
                    }
                ],
                duplicate_pairs=[],
                profile={"business_type": "Car care product brand"},
                country="US",
                language="en",
            )
    finally:
        await http.close()

    assert caught.value.code == "invalid_ai_json"
    assert caught.value.failure_status == CHARGED_FAILURE
    assert caught.value.cost_usd == 0.0012
    assert caught.value.metadata == {
        "model": "gpt-5.4-mini",
        "usage": {"cost": 0.0012},
        "raw_content": "not-json",
    }


@pytest.mark.anyio
async def test_dataforseo_charged_task_failure_preserves_cost_and_path() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status_code": 20000,
                "status_message": "Ok.",
                "tasks": [
                    {
                        "status_code": 50000,
                        "status_message": "Task failed after processing.",
                        "cost": 0.027,
                        "path": ["v3", "dataforseo_labs", "google", "keyword_ideas", "live"],
                        "result": None,
                    }
                ],
            },
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        with pytest.raises(ProviderError) as caught:
            await client.keyword_ideas(
                keywords=["car care"],
                country="US",
                language="en",
                closely_variants=False,
            )
    finally:
        await http.close()

    assert caught.value.code == "dataforseo_task_failed"
    assert caught.value.failure_status == CHARGED_FAILURE
    assert caught.value.cost_usd == 0.027
    assert caught.value.path == [
        "v3",
        "dataforseo_labs",
        "google",
        "keyword_ideas",
        "live",
    ]


@pytest.mark.anyio
async def test_google_ads_site_fallback_parses_the_dataforseo_result() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=dataforseo_response(
                [
                    {
                        "keyword": "car care products",
                        "competition": "LOW",
                        "competition_index": 23,
                        "search_volume": 18100,
                        "cpc": 2.14,
                        "monthly_searches": [],
                    }
                ],
                cost=0.09,
            ),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, billing = await client.google_ads_keywords_for_site(
            domain="bikicarcare.com",
            country="US",
            language="en",
        )
    finally:
        await http.close()

    body = json.loads(requests[0].content)[0]
    assert requests[0].url.path.endswith("/keywords_data/google_ads/keywords_for_site/live")
    assert body == {
        "target": "bikicarcare.com",
        "target_type": "site",
        "location_name": "United States",
        "language_code": "en",
        "search_partners": False,
        "include_adult_keywords": False,
        "sort_by": "relevance",
    }
    assert billing.cost_usd == 0.09
    assert rows[0].keyword == "car care products"
    assert rows[0].competition == 0.23


@pytest.mark.anyio
async def test_keyword_overview_batches_missing_topic_metrics() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=dataforseo_response(
                [
                    {
                        "items": [
                            {
                                "keyword": "car scratch remover",
                                "keyword_info": {
                                    "search_volume": 6_600,
                                    "cpc": 2.2,
                                    "competition": 0.7,
                                },
                                "keyword_properties": {
                                    "keyword_difficulty": 38,
                                },
                                "search_intent_info": {
                                    "main_intent": "commercial",
                                },
                            }
                        ]
                    }
                ],
                cost=0.01,
            ),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, billing = await client.keyword_overview(
            keywords=["car scratch remover"],
            country="US",
            language="en",
        )
    finally:
        await http.close()

    body = json.loads(requests[0].content)[0]
    assert requests[0].url.path.endswith("/dataforseo_labs/google/keyword_overview/live")
    assert body == {
        "keywords": ["car scratch remover"],
        "location_name": "United States",
        "language_code": "en",
        "include_clickstream_data": False,
        "include_serp_info": False,
    }
    assert billing.cost_usd == 0.01
    assert rows[0].keyword == "car scratch remover"
    assert rows[0].keyword_difficulty == 38
    assert rows[0].intent == "commercial"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("closely_variants", "expected_source"),
    [
        (False, "keyword_ideas_broad"),
        (True, "keyword_ideas_close"),
    ],
)
async def test_keyword_ideas_returns_metrics_without_an_overview_request(
    closely_variants: bool,
    expected_source: str,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=dataforseo_response(
                [
                    {
                        "items": [
                            {
                                "keyword": "residential solar cost",
                                "keyword_info": {
                                    "search_volume": 1900,
                                    "cpc": 4.25,
                                    "competition": 0.71,
                                    "competition_level": "HIGH",
                                    "monthly_searches": [],
                                },
                                "keyword_properties": {
                                    "keyword_difficulty": 37,
                                },
                                "search_intent_info": {
                                    "main_intent": "commercial",
                                },
                            }
                        ]
                    }
                ],
                cost=0.072,
            ),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, billing = await client.keyword_ideas(
            keywords=["solar panels", "solar installation"],
            country="US",
            language="en",
            closely_variants=closely_variants,
            limit=500,
        )
    finally:
        await http.close()

    body = json.loads(requests[0].content)[0]
    assert requests[0].url.path.endswith("/dataforseo_labs/google/keyword_ideas/live")
    assert body == {
        "keywords": ["solar panels", "solar installation"],
        "location_name": "United States",
        "language_code": "en",
        "limit": 500,
        "closely_variants": closely_variants,
        "include_clickstream_data": False,
    }
    assert billing.cost_usd == 0.072
    assert rows[0].search_volume == 1900
    assert rows[0].keyword_difficulty == 37
    assert rows[0].intent == "commercial"
    assert rows[0].source == expected_source


@pytest.mark.anyio
async def test_domain_intersection_keeps_only_organic_competitor_results() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        organic = {
            "keyword_data": {
                "keyword": "solar installation company",
                "keyword_info": {
                    "search_volume": 720,
                    "cpc": 5.4,
                    "competition": 0.8,
                    "competition_level": "HIGH",
                    "monthly_searches": [],
                },
                "keyword_properties": {"keyword_difficulty": 51},
                "search_intent_info": {"main_intent": "commercial"},
            },
            "first_domain_serp_element": {
                "type": "organic",
                "rank_group": 6,
                "rank_absolute": 8,
            },
            "second_domain_serp_element": None,
        }
        paid = {
            **organic,
            "keyword_data": {
                **organic["keyword_data"],
                "keyword": "solar panel sale",
            },
            "first_domain_serp_element": {
                "type": "paid",
                "rank_absolute": 1,
            },
        }
        return httpx.Response(
            200,
            json=dataforseo_response([{"items": [organic, paid]}], cost=0.036),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, billing = await client.domain_intersection(
            competitor_domain="competitor.com",
            domain="example.com",
            country="US",
            language="en",
            limit=200,
        )
    finally:
        await http.close()

    body = json.loads(requests[0].content)[0]
    assert requests[0].url.path.endswith("/dataforseo_labs/google/domain_intersection/live")
    assert body == {
        "target1": "competitor.com",
        "target2": "example.com",
        "intersections": False,
        "location_name": "United States",
        "language_code": "en",
        "limit": 200,
        "item_types": ["organic"],
        "include_serp_info": False,
        "order_by": ["keyword_data.keyword_info.search_volume,desc"],
        "filters": [["first_domain_serp_element.type", "=", "organic"]],
    }
    assert billing.cost_usd == 0.036
    assert len(rows) == 1
    assert rows[0].keyword == "solar installation company"
    assert rows[0].competitor_rank == 8
    assert rows[0].competition_level == "HIGH"
    assert rows[0].keyword_difficulty == 51


@pytest.mark.anyio
async def test_serp_competitors_preserves_openseo_request_and_response_granularity() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=dataforseo_response(
                [
                    {
                        "items": [
                            {
                                "domain": "competitor.example",
                                "avg_position": 12.5,
                                "median_position": 8,
                                "rating": 42,
                                "etv": 18000.5,
                                "keywords_count": 4,
                                "visibility": 17.25,
                                "relevant_serp_items": 6,
                                "keywords_positions": {"1": 1, "2_3": 2},
                            }
                        ]
                    }
                ],
                cost=0.0126,
            ),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, billing = await client.serp_competitors(
            keywords=["business keyword", "second keyword"],
            country="US",
            language="en",
            limit=50,
        )
    finally:
        await http.close()

    body = json.loads(requests[0].content)[0]
    assert requests[0].url.path.endswith("/dataforseo_labs/google/serp_competitors/live")
    assert body == {
        "keywords": ["business keyword", "second keyword"],
        "location_code": 2840,
        "language_code": "en",
        "limit": 50,
    }
    assert billing.cost_usd == 0.0126
    assert rows[0].domain == "competitor.example"
    assert rows[0].keywords_count == 4
    assert rows[0].median_position == 8
    assert rows[0].rating == 42
    assert rows[0].etv == 18000.5
    assert rows[0].visibility == 17.25
    assert rows[0].relevant_serp_items == 6
    assert rows[0].keywords_positions == {"1": 1, "2_3": 2}


@pytest.mark.anyio
async def test_local_market_requests_match_openseo_contracts() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/business_data/google/questions_and_answers/live"):
            return httpx.Response(
                200,
                json=dataforseo_response(
                    [
                        {
                            "items": [{"question_text": "Answered question"}],
                            "items_without_answers": [
                                {"question_text": "Unanswered question"}
                            ],
                        }
                    ],
                    cost=0.004,
                ),
            )
        return httpx.Response(
            200,
            json=dataforseo_response(
                [{"items": [{"title": "Local competitor", "domain": "local.example"}]}],
                cost=0.004,
            ),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        businesses, business_billing = await client.local_businesses(
            latitude=-26.2041,
            longitude=28.0473,
            radius_km=10,
            query="video service",
            categories=["media_company"],
        )
        local_rows, local_billing = await client.local_serp(
            keyword="video service johannesburg",
            latitude=-26.2041,
            longitude=28.0473,
            zoom=12,
            language="en",
            search_type="maps",
            device="desktop",
            depth=1,
        )
        questions, questions_billing = await client.business_questions(
            keyword="Elephant TV",
            latitude=-26.2041,
            longitude=28.0473,
            radius_km=10,
            language="en",
            depth=12,
        )
    finally:
        await http.close()

    business_body = json.loads(requests[0].content)[0]
    assert requests[0].url.path.endswith("/business_data/business_listings/search/live")
    assert business_body == {
        "location_coordinate": "-26.2041,28.0473,10",
        "limit": 20,
        "title": "video service",
        "categories": ["media_company"],
    }
    local_body = json.loads(requests[1].content)[0]
    assert requests[1].url.path.endswith("/serp/google/maps/live/advanced")
    assert local_body == {
        "keyword": "video service johannesburg",
        "location_coordinate": "-26.2041,28.0473,12z",
        "language_code": "en",
        "device": "desktop",
        "os": "windows",
        "depth": 1,
        "search_places": False,
    }
    questions_body = json.loads(requests[2].content)[0]
    assert requests[2].url.path.endswith("/business_data/google/questions_and_answers/live")
    assert questions_body == {
        "keyword": "Elephant TV",
        "location_coordinate": "-26.2041,28.0473,10000",
        "language_code": "en",
        "depth": 12,
    }
    assert businesses[0]["domain"] == "local.example"
    assert local_rows[0]["title"] == "Local competitor"
    assert [question["question_text"] for question in questions] == [
        "Answered question",
        "Unanswered question",
    ]
    assert business_billing.cost_usd == 0.004
    assert local_billing.cost_usd == 0.004
    assert questions_billing.cost_usd == 0.004


def test_serp_competitor_sorting_and_explicit_domain_matching_match_openseo() -> None:
    from seo_workers.keywords.providers import DiscoveredCompetitor

    rows = [
        DiscoveredCompetitor(
            domain="low.example",
            provider_rank=1,
            avg_position=3,
            median_position=2,
            rating=1,
            etv=10,
            keywords_count=5,
            visibility=2,
            relevant_serp_items=5,
            keywords_positions={},
            raw_payload={},
        ),
        DiscoveredCompetitor(
            domain="high.example",
            provider_rank=2,
            avg_position=9,
            median_position=8,
            rating=2,
            etv=100,
            keywords_count=20,
            visibility=8,
            relevant_serp_items=20,
            keywords_positions={},
            raw_payload={},
        ),
    ]
    assert [row.domain for row in sort_serp_competitors(rows, "visibility")] == [
        "high.example",
        "low.example",
    ]
    assert [row.domain for row in sort_serp_competitors(rows, "traffic_estimate")] == [
        "high.example",
        "low.example",
    ]
    assert [row.domain for row in sort_serp_competitors(rows, "keyword_count")] == [
        "high.example",
        "low.example",
    ]
    assert [row.domain for row in sort_serp_competitors(rows, "avg_position")] == [
        "low.example",
        "high.example",
    ]
    assert host_matches_domain("www.example.com", "example.com")
    assert host_matches_domain("shop.example.com", "example.com")
    assert not host_matches_domain("directory.example", "example.com")
    assert is_same_domain("www.example.com", "example.com")
    assert not is_same_domain("shop.example.com", "example.com")


@pytest.mark.anyio
async def test_domain_intersection_fetches_one_hundred_opportunity_keywords() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        item = {
            "keyword_data": {
                "keyword": "solar panel installation",
                "keyword_info": {"search_volume": 2400, "monthly_searches": []},
                "keyword_properties": {"keyword_difficulty": 42},
                "search_intent_info": {"main_intent": "commercial"},
            },
            "first_domain_serp_element": {
                "type": "organic",
                "rank_absolute": 4,
                "url": "https://competitor.example/solar",
            },
            "second_domain_serp_element": None,
        }
        return httpx.Response(
            200,
            json=dataforseo_response([{"items": [item]}], cost=0.024),
        )

    client, http = await mock_client(httpx.MockTransport(handler))
    try:
        rows, _ = await client.domain_intersection(
            competitor_domain="competitor.example",
            domain="example.com",
            country="US",
            language="en",
            limit=100,
            intersections=False,
        )
    finally:
        await http.close()

    body = json.loads(requests[0].content)[0]
    assert body["limit"] == 100
    assert body["intersections"] is False
    assert body["order_by"] == ["keyword_data.keyword_info.search_volume,desc"]
    assert body["filters"] == [["first_domain_serp_element.type", "=", "organic"]]
    assert rows[0].competitor_rank == 4
    assert rows[0].own_rank is None
    assert rows[0].competitor_url == "https://competitor.example/solar"
    assert rows[0].own_url is None


def test_provider_config_does_not_expose_the_password() -> None:
    config = DataForSEOProviderConfig(
        login="api-login",
        password="api-password",
    )

    assert config.configured is True
    assert "api-password" not in repr(config)


def test_initial_library_filter_uses_only_general_usability_rules() -> None:
    candidates = [
        SeedCandidate(
            keyword=keyword,
            normalized_keyword=keyword,
            rank=index,
            selection_details={},
            raw=RawKeyword(keyword=keyword, source="labs_site", search_volume=100 - index),
        )
        for index, keyword in enumerate(
            ["accounting software", "example login", "broken fragment"],
            start=1,
        )
    ]

    prompt = build_initial_library_filter_prompt(
        candidates=candidates,
        profile={
            "business_name": "Example Company",
            "business_summary": "Cloud accounting software for small businesses.",
            "products_services": ["Cloud accounting software"],
        },
        country="US",
        language="en",
    )
    schema = initial_library_filter_schema(candidates)

    assert "general SEO keyword usability filter" in prompt
    assert "Judge the complete search need" in prompt
    assert "business profile is evidence" in prompt
    assert "keep: the query has a clear connection" in prompt
    assert "remove_irrelevant" in prompt
    assert "remove_entity" in prompt
    assert "remove_navigation" in prompt
    assert "remove_unusable" in prompt
    assert "affirmative support in the business profile" in prompt
    assert "industry proximity or a shared general word is not affirmative support" in prompt
    assert "do not invent domain-specific rules" in prompt
    assert "search_volume" not in prompt
    assert "decisions item 1 classifies k001" in prompt
    assert schema["required"] == ["decisions"]
    assert schema["properties"]["decisions"]["minItems"] == 3
    assert schema["properties"]["decisions"]["maxItems"] == 3
    assert schema["properties"]["decisions"]["items"]["enum"] == [
        "keep",
        "remove_irrelevant",
        "remove_entity",
        "remove_navigation",
        "remove_unusable",
    ]


def test_seed_ranking_prompt_uses_only_compact_candidate_input() -> None:
    candidate = SeedCandidate(
        keyword="car wash",
        normalized_keyword="car wash",
        rank=1,
        selection_details={"rule_version": "test"},
        raw=RawKeyword(
            keyword="car wash",
            source="google_ads_site",
            provider_rank=1,
            search_volume=2_240_000,
            cpc=1.29,
            competition=0.17,
            raw_payload={
                "keyword_annotations": {
                    "concepts": [
                        {
                            "name": "Car wash",
                            "concept_group": {"name": "Service", "type": None},
                        }
                    ]
                }
            },
        ),
    )
    prompt = build_seed_ranking_prompt(
        candidates=[candidate],
        profile={
            "business_name": "Biki Car Care",
            "business_type": "Car care products",
            "business_summary": "Sells car cleaning and detailing products.",
            "products_services": ["car wash products"],
            "target_audiences": ["car owners"],
            "content_topics": ["car washing"],
            "exclusion_terms": ["vehicle sales"],
            "key_pages": [{"url": "https://example.com/large-unused-profile-field"}],
        },
        country="US",
        language="en",
    )

    candidate_payload = json.loads(prompt.split("Candidate keywords:", 1)[1])
    assert candidate_payload == [["k001", "car wash", 2_240_000]]
    assert '"name":"Biki Car Care"' in prompt
    assert "keyword_annotations" not in prompt
    assert "concepts" not in prompt
    assert "cpc" not in prompt
    assert "competition" not in prompt
    assert "key_pages" not in prompt
    assert '"active":["k001","k002"]' in prompt
    assert '"reserve":["k003","k004"]' in prompt
    assert "You are an SEO keyword strategist" in prompt
    assert "Select the best SEO seed keywords" in prompt
    assert "Be directly related to the website business" in prompt
    assert "Be expandable into related content" in prompt
    assert "1. Business relevance" in prompt
    assert "2. Search intent" in prompt
    assert "3. Topic uniqueness" in prompt
    assert "4. Search volume" in prompt
    assert "Mainly represent offline services" in prompt
    assert "Are unrelated brands" in prompt
    assert "Group keywords with the same SEO topic" in prompt
    assert "Only keep one keyword per topic" in prompt
    assert "They would target the same page" in prompt
    assert "They have the same SERP intent" in prompt
    assert "Apply deduplication to both active and reserve" in prompt
    assert "Select exactly 20 active keywords" in prompt
    assert "Each active keyword must represent a unique topic" in prompt
    assert "lower-priority unique topics" in prompt
    assert "Do not include rejected or duplicate keywords" in prompt
    assert "business_topic" not in prompt
    assert "reason_code" not in prompt
    assert "selected and rejected arrays" not in prompt


def test_compact_seed_profile_has_bounded_text_and_lists() -> None:
    profile = compact_seed_profile(
        {
            "business_summary": "x" * 2_000,
            "products_services": ["y" * 200 for _ in range(40)],
            "target_audiences": ["audience" for _ in range(25)],
            "content_topics": ["topic" for _ in range(35)],
            "exclusion_terms": ["exclude" for _ in range(35)],
        }
    )

    assert len(profile["summary"]) == 1_500
    assert len(profile["offerings"]) == 30
    assert all(len(item) <= 120 for item in profile["offerings"])
    assert len(profile["audiences"]) == 20
    assert len(profile["topics"]) == 30
    assert len(profile["exclude"]) == 30


def test_seed_clustering_prompt_uses_compact_ids_and_user_rules() -> None:
    candidate = SeedCandidate(
        keyword="car detailing products",
        normalized_keyword="car detailing products",
        rank=1,
        selection_details={"rule_version": "test"},
        raw=RawKeyword(
            keyword="car detailing products",
            source="google_ads_site",
            search_volume=27_100,
            cpc=1.5,
            raw_payload={"unused": "value"},
        ),
    )

    prompt = build_seed_clustering_prompt(
        candidates=[candidate],
        profile={
            "business_name": "Biki Car Care",
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
            "products_services": ["car detailing products"],
            "key_pages": [{"url": "https://example.com"}],
        },
        country="US",
        language="en",
    )

    candidate_payload = json.loads(prompt.split("Candidate keywords:", 1)[1])
    assert candidate_payload == [["k001", "car detailing products", 27_100]]
    assert "You are an SEO keyword topic clustering expert" in prompt
    assert "accurate SEO topic clusters" in prompt
    assert "ONE SEO landing page or one content group" in prompt
    assert "Prefer multiple specific SEO topics over a few broad topics" in prompt
    assert "Do NOT exclude valid topics only because they are specific" in prompt
    assert "Product categories, solutions, customer problems" in prompt
    assert "Assign keywords into the same cluster ONLY" in prompt
    assert "Share a general word" in prompt
    assert "Different purchase intents" in prompt
    assert "broad category and its subtopics should usually remain separate" in prompt
    assert "Each keyword must have exactly one final status" in prompt
    assert "Put the same keyword in both topics and excluded" in prompt
    assert "1. Strong business relevance" in prompt
    assert "Topic clusters are specific enough to become independent SEO pages" in prompt
    assert "No keyword appears twice" in prompt
    assert "Website business model: Car care product brand" in prompt
    assert '"representative": "k001"' in prompt
    assert '"members": ["k001","k002"]' in prompt
    assert '"excluded": [' in prompt
    assert '"k003"' in prompt
    assert "key_pages" not in prompt
    assert "raw_payload" not in prompt
    assert "cpc" not in prompt


def test_active_seed_selection_prompt_has_one_narrow_task_and_compact_output() -> None:
    candidates = [
        SeedCandidate(
            keyword=f"car care topic {index}",
            normalized_keyword=f"car care topic {index}",
            rank=index,
            selection_details={
                "source_candidate_rank": index,
                "category": "car care tips",
            },
            raw=RawKeyword(
                keyword=f"car care topic {index}",
                source="saved_ai_filter",
                search_volume=10_000 - index,
                intent="Commercial",
            ),
        )
        for index in range(1, 72)
    ]

    prompt = build_active_seed_selection_prompt(
        candidates=candidates,
        profile={
            "business_name": "Biki Car Care",
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
            "products_services": ["car detailing products"],
        },
        country="US",
        language="en",
    )

    candidate_payload = json.loads(prompt.split("Candidate keywords:", 1)[1])
    assert len(candidate_payload) == 71
    assert candidate_payload[0] == [
        "k001",
        "car care topic 1",
        "car care tips",
        "Commercial",
        9_999,
    ]
    assert "Select exactly 20 active seed keywords" in prompt
    assert "seeds for keyword expansion, not final article keywords" in prompt
    assert "different parts of the business" in prompt
    assert "website sells products used for that service" in prompt
    assert "substantially the same keyword ideas" in prompt
    assert "Related products may remain separate" in prompt
    assert "Compare every pair in active" in prompt
    assert '{"active":["k001","k002"]}' in prompt
    assert '"reserve"' not in prompt
    assert '"excluded"' not in prompt


def test_diverse_seed_pool_prompt_requests_one_hundred_grouped_ids() -> None:
    candidates = [
        SeedCandidate(
            keyword=f"car care topic {index}",
            normalized_keyword=f"car care topic {index}",
            rank=index,
            selection_details={"rule_version": "test"},
            raw=RawKeyword(
                keyword=f"car care topic {index}",
                source="google_ads_site",
                search_volume=10_000 - index,
            ),
        )
        for index in range(1, 101)
    ]

    prompt = build_diverse_seed_pool_prompt(
        candidates=candidates,
        profile={
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
            "products_services": ["car detailing products"],
        },
        country="US",
        language="en",
    )

    candidate_payload = json.loads(prompt.split("Candidate keywords:", 1)[1])
    assert len(candidate_payload) == 100
    assert candidate_payload[0] == ["k001", "car care topic 1", 9_999]
    assert "Select exactly 100 candidate IDs" in prompt
    assert "exactly 25 specific SEO topic groups" in prompt
    assert "exactly 4 candidate IDs" in prompt
    assert "Do not let one high-volume topic dominate the pool" in prompt
    assert '"groups":[{"topic":"specific topic","ids":["k001","k002"]}]' in prompt


def test_natural_seed_clustering_prompt_uses_bounded_topic_signatures() -> None:
    candidates = [
        SeedCandidate(
            keyword=f"car care topic {index}",
            normalized_keyword=f"car care topic {index}",
            rank=index,
            selection_details={"rule_version": "test"},
            raw=RawKeyword(
                keyword=f"car care topic {index}",
                source="google_ads_site",
                search_volume=10_000 - index,
            ),
        )
        for index in range(1, 6)
    ]

    prompt = build_natural_seed_clustering_prompt(
        candidates=candidates,
        profile={
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
            "products_services": ["car detailing products"],
        },
        country="US",
        language="en",
    )

    candidate_payload = json.loads(prompt.split("Candidate keywords:", 1)[1])
    assert len(candidate_payload) == 5
    assert "bounded SEO seed-topic clustering" in prompt
    assert "There is no required number of topic groups" in prompt
    assert "Create no more than 100 topic groups" in prompt
    assert "Each group may contain 1 to 8 candidate IDs" in prompt
    assert "Never add a keyword to fill a group" in prompt
    assert "object, need, and page_intent are all equivalent" in prompt
    assert "tire cleaner, tire shine, and tire coating must be separate" in prompt
    assert "Each candidate ID must appear exactly once" in prompt
    assert "Do not select final active seeds" in prompt
    assert '"topics":[{"topic":"specific topic"' in prompt
    assert '"object":"specific object"' in prompt
    assert '"need":"specific action or problem"' in prompt
    assert '"page_intent":"page purpose"' in prompt


def test_seed_topic_representatives_prompt_returns_only_unique_topics() -> None:
    candidates = [
        SeedCandidate(
            keyword=f"car care topic {index}",
            normalized_keyword=f"car care topic {index}",
            rank=index,
            selection_details={"rule_version": "test"},
            raw=RawKeyword(
                keyword=f"car care topic {index}",
                source="google_ads_site",
                search_volume=10_000 - index,
            ),
        )
        for index in range(1, 6)
    ]

    prompt = build_seed_topic_representatives_prompt(
        candidates=candidates,
        profile={
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
            "products_services": ["car detailing products"],
        },
        country="US",
        language="en",
    )

    candidate_payload = json.loads(prompt.split("Candidate keywords:", 1)[1])
    assert len(candidate_payload) == 5
    assert "account for every ID exactly once" in prompt
    assert "Return every valid distinct topic; there is no fixed topic target" in prompt
    assert "Do not create weak or duplicate topics to reach a number" in prompt
    assert "Put every valid candidate ID in exactly one topic members array" in prompt
    assert "Put every unusable candidate ID in excluded" in prompt
    assert "Each object + need + page_intent signature may appear once only" in prompt
    assert "Canonicalization is mandatory" in prompt
    assert "object must be a short base noun phrase" in prompt
    assert "Normalize car, auto, automotive, and vehicle wording" in prompt
    assert "page_intent: exactly one of product, informational, commercial, or service" in prompt
    assert "tire shine and car tire shine are one topic" in prompt
    assert "streak free car window cleaner are one topic" in prompt
    assert "Do not assign different page intents to close wording variations" in prompt
    assert "Compare every pair of proposed topics before output" in prompt
    assert "Do not stop after listing only broad business categories" in prompt
    assert "car detailing products and car detailing kits are separate" in prompt
    assert "different canonical object, different canonical need" in prompt
    assert "Do not remove related but distinct subtopics" in prompt
    assert '"representative":"k001"' in prompt
    assert '"members"' in prompt
    assert '"excluded"' in prompt


@pytest.mark.parametrize(
    ("business_model", "expected_rule"),
    [
        (
            "service",
            "Service-intent keywords are valid when the website provides that service.",
        ),
        (
            "software",
            "Prioritize capabilities, jobs to be done, use cases, integrations",
        ),
        (
            "content",
            "Prioritize subject areas, recurring audience questions, guides",
        ),
        (
            "mixed",
            "Cover the website's evidenced products, services, capabilities",
        ),
    ],
)
def test_duplicate_confirmation_does_not_inject_business_model_rules(
    business_model: str,
    expected_rule: str,
) -> None:
    candidate = SeedCandidate(
        keyword="example topic",
        normalized_keyword="example topic",
        rank=1,
        selection_details={"rule_version": "test"},
        raw=RawKeyword(
            keyword="example topic",
            source="google_ads_site",
            search_volume=1_000,
        ),
    )
    profile = {
        "business_model": business_model,
        "business_type": "Test website",
        "business_summary": "Provides an offering for a defined audience.",
    }

    topic_prompt = build_seed_topic_representatives_prompt(
        candidates=[candidate],
        profile=profile,
        country="US",
        language="en",
    )
    selection_prompt = build_topic_active_selection_prompt(
        topics=[
            {
                "representative_id": "k001",
                "representative_keyword": "example topic",
                "object": "example",
                "need": "topic",
                "page_intent": "informational",
                "search_volume": 1_000,
            }
        ],
        duplicate_pairs=[],
        profile=profile,
        country="US",
        language="en",
    )

    assert f"Canonical website model: {business_model}" in topic_prompt
    assert f"Website business model: {business_model}" in selection_prompt
    assert expected_rule in topic_prompt
    assert expected_rule not in selection_prompt
    if business_model == "service":
        assert "Do not require product keywords." in topic_prompt
        assert "emergency plumbing, drain cleaning" in topic_prompt
        assert "emergency plumbing" not in selection_prompt
    if business_model == "software":
        assert "CRM integrations, CRM automation" in topic_prompt
        assert "CRM integrations" not in selection_prompt
    if business_model == "content":
        assert "tomato growing, tomato plant diseases" in topic_prompt
        assert "tomato growing" not in selection_prompt
    assert "tire shine" not in selection_prompt


def test_topic_active_selection_prompt_sends_only_bounded_pairs() -> None:
    topics = [
        {
            "representative_id": f"k{index:03d}",
            "representative_keyword": f"car care topic {index}",
            "object": f"object {index}",
            "need": f"need {index}",
            "page_intent": "product",
            "search_volume": 10_000 - index,
        }
        for index in range(1, 22)
    ]

    prompt = build_topic_active_selection_prompt(
        topics=topics,
        duplicate_pairs=[
            TopicDuplicatePair(
                pair_id="p001",
                left_id="k001",
                right_id="k002",
                signals=("similar_wording",),
            )
        ],
        profile={
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
            "products_services": ["car detailing products"],
        },
        country="US",
        language="en",
    )

    pair_payload = json.loads(prompt.split("Possible duplicate pairs: ", 1)[1])
    assert pair_payload == [
        [
            "p001",
            "k001",
            "car care topic 1",
            "k002",
            "car care topic 2",
            ["similar_wording"],
        ]
    ]
    assert "car care topic 21" not in prompt
    assert "Do exactly one task" in prompt
    assert "do not filter or reject topics in this step" in prompt
    assert "may confirm duplication only for a supplied pair ID" in prompt
    assert "keyword text as the source of truth" in prompt
    assert "canonical subject, user need" in prompt
    assert "a false merge is worse than retaining two partly overlapping topics" in prompt
    assert "meaningful qualifier changes the audience, location" in prompt
    assert "Examples for this website model" not in prompt
    assert "tire cleaner" not in prompt
    assert "headlight cleaner" not in prompt
    assert "CRM software" not in prompt
    assert "If there is any reasonable doubt, do not return that pair ID" in prompt
    assert "rankings" in prompt
    assert (
        'Possible duplicate pairs: [["p001","k001","car care topic 1","k002",'
        '"car care topic 2",["similar_wording"]]]'
    ) in prompt
    assert '"duplicate_pair_ids"' in prompt
    assert '"ranked"' not in prompt
    assert '"active"' not in prompt
    assert '"rejected"' not in prompt


def test_grouped_active_prompt_requires_twenty_different_topics() -> None:
    groups = [
        SeedPoolGroup(
            topic=f"topic {index}",
            member_ids=(f"k{index:03d}",),
            members=(
                SeedCandidate(
                    keyword=f"car care topic {index}",
                    normalized_keyword=f"car care topic {index}",
                    rank=index,
                    selection_details={"rule_version": "test"},
                    raw=RawKeyword(
                        keyword=f"car care topic {index}",
                        source="google_ads_site",
                        search_volume=10_000 - index,
                    ),
                ),
            ),
        )
        for index in range(1, 21)
    ]

    prompt = build_grouped_active_seed_prompt(
        groups=groups,
        profile={
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
        },
        country="US",
        language="en",
    )

    grouped_payload = json.loads(prompt.split("Grouped candidates:", 1)[1])
    assert len(grouped_payload) == 20
    assert grouped_payload[0] == {
        "topic": "topic 1",
        "candidates": [["k001", "car care topic 1", 9_999]],
    }
    assert "Select exactly 20 candidate IDs" in prompt
    assert "different topic group" in prompt
    assert "not select more than one ID from the same supplied topic group" in prompt


def test_seed_filter_prompt_only_removes_clearly_unusable_ids() -> None:
    candidates = [
        SeedCandidate(
            keyword="car detailing",
            normalized_keyword="car detailing",
            rank=1,
            selection_details={"rule_version": "test"},
            raw=RawKeyword(
                keyword="car detailing",
                source="google_ads_site",
                search_volume=110_000,
            ),
        ),
        SeedCandidate(
            keyword="car detailing products",
            normalized_keyword="car detailing products",
            rank=2,
            selection_details={"rule_version": "test"},
            raw=RawKeyword(
                keyword="car detailing products",
                source="google_ads_site",
                search_volume=27_100,
            ),
        ),
    ]

    prompt = build_seed_filter_prompt(
        candidates=candidates,
        profile={
            "business_name": "Biki Car Care",
            "business_type": "Car care product brand",
            "business_summary": "Sells car care products.",
            "products_services": ["car detailing products"],
            "content_topics": ["detailing guides"],
        },
        country="US",
        language="en",
    )

    candidate_payload = json.loads(
        prompt.split("## Candidate Keywords\n\n", 1)[1].split("\n\n## Instructions", 1)[0]
    )
    assert candidate_payload == ["car detailing", "car detailing products"]
    assert "SEO keyword filtering and classification assistant" in prompt
    assert "Sells car care products." in prompt
    assert '["car detailing products"]' in prompt
    assert '["detailing guides"]' in prompt
    assert "Assign each retained keyword exactly one category" in prompt
    assert "Informational: learning or solving a problem" in prompt
    assert "Judge only business relevance" in prompt
    assert "Preserve every keyword exactly as provided" in prompt
    assert "Include every input keyword exactly once" in prompt
    assert "110000" not in prompt
    assert "27100" not in prompt
    assert '"kept": [' in prompt
    assert '"removed": [' in prompt
    assert '"active"' not in prompt
    assert '"reserve"' not in prompt


def test_completion_token_parameter_supports_new_and_compatible_models() -> None:
    assert completion_token_parameter("gpt-5.4-mini") == "max_completion_tokens"
    assert completion_token_parameter("o3-mini") == "max_completion_tokens"
    assert completion_token_parameter("deepseek-chat") == "max_tokens"


@pytest.mark.anyio
async def test_initial_library_filter_uses_configured_luna_model() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "model": "gpt-5.6-luna",
                "choices": [{"message": {"content": '{"decisions":["keep"]}'}}],
                "usage": {},
            },
        )

    candidate = SeedCandidate(
        keyword="movie streaming app",
        normalized_keyword="movie streaming app",
        rank=1,
        selection_details={"rule_version": "test"},
        raw=RawKeyword(
            keyword="movie streaming app",
            source="google_ads_site",
            search_volume=1_000,
        ),
    )
    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = OpenAICompatibleClient(
        http,
        AIProviderConfig(
            base_url="https://api.openai.test/v1",
            api_key="test-key",
            model="gpt-5.4-mini",
            timeout_seconds=10,
            max_retries=0,
            initial_filter_model="gpt-5.6-luna",
        ),
    )
    try:
        await client.filter_initial_library_candidates(
            candidates=[candidate],
            profile={"business_type": "Streaming application"},
            country="US",
            language="en",
        )
    finally:
        await http.close()

    body = json.loads(requests[0].content)
    assert body["model"] == "gpt-5.6-luna"
    assert "reasoning_effort" not in body


@pytest.mark.anyio
async def test_topic_dedup_request_uses_low_reasoning_and_larger_output_budget() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "model": "gpt-5.4-mini",
                "choices": [
                    {"message": {"content": ('{"duplicate_groups":[],"ranked":["k001"]}')}}
                ],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 250,
                    "completion_tokens_details": {"reasoning_tokens": 200},
                    "total_tokens": 350,
                },
            },
        )

    http = JsonHttpClient(timeout_seconds=10, max_retries=0)
    await http.client.aclose()
    http.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = OpenAICompatibleClient(
        http,
        AIProviderConfig(
            base_url="https://api.openai.test/v1",
            api_key="test-key",
            model="gpt-5.4-mini",
            timeout_seconds=10,
            max_retries=0,
            topic_dedup_model="gpt-5.6-terra",
        ),
    )
    try:
        result = await client.select_active_topic_representatives(
            topics=[
                {
                    "representative_id": "k001",
                    "representative_keyword": "car care products",
                    "object": "car care",
                    "need": "product",
                    "page_intent": "product",
                    "search_volume": 1_000,
                }
            ],
            duplicate_pairs=[],
            profile={"business_type": "Car care product brand"},
            country="US",
            language="en",
        )
    finally:
        await http.close()

    assert len(requests) == 1
    body = json.loads(requests[0].content)
    assert body["model"] == "gpt-5.6-terra"
    assert body["reasoning_effort"] == "low"
    assert body["max_completion_tokens"] == 5_000
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    schema = body["response_format"]["json_schema"]["schema"]
    assert set(schema["properties"]) == {"duplicate_pair_ids"}
    assert "uniqueItems" not in schema["properties"]["duplicate_pair_ids"]
    assert result.usage["reasoning_tokens"] == 200
