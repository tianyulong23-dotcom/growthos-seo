import asyncio
import gzip
import json
from datetime import UTC, datetime, timedelta
from io import BytesIO
from types import SimpleNamespace
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app.core.config import Settings
from app.modules.content import activities as content_activities
from app.modules.content import collection
from app.modules.content.dataforseo import (
    DataForSEOClient,
    DataForSEOEmptyResult,
    DataForSEOError,
    OrganicResult,
    SERPResult,
    location_parameter,
    normalize_language_code,
    parse_serp_response,
)
from app.modules.content.object_storage import (
    ObjectWriteError,
    S3JSONWriter,
    S3TextReader,
    StoredTextCorruptError,
    StoredTextNotFoundError,
    StoredTextTooLargeError,
)
from app.modules.content.repository import (
    _internal_link_candidate_score,
    _internal_link_query_terms,
    _internal_link_terms,
    merge_project_profile,
    normalize_source_url,
    project_snapshot_warnings,
)
from app.modules.content.research_gateway import (
    ProviderFailure,
    ResearchCitation,
    ResearchError,
    ResearchFailure,
    ResearchGateway,
    ResearchProviderError,
    ResearchProviderConfig,
    ResearchRequest,
    ResearchResult,
    merge_research_results,
    parse_responses_research,
    research_cache_key,
    research_questions,
)
from app.modules.content.source_verification import (
    classify_source_tier,
    select_upstream_source_links,
    verify_source_claim_with_quote,
    verify_source_claims,
)
from app.modules.settings.data_sources import DataForSEOSettingsRecord


def serp_response() -> dict[str, Any]:
    return {
        "status_code": 20000,
        "tasks": [
            {
                "id": "dataforseo-task-1",
                "cost": 0.002,
                "status_code": 20000,
                "result": [
                    {
                        "items": [
                            {
                                "type": "organic",
                                "rank_absolute": 1,
                                "url": "https://example.net/guide",
                                "domain": "example.net",
                                "title": "Solar guide",
                                "description": "A useful guide",
                            },
                            {
                                "type": "people_also_ask",
                                "items": [
                                    {"title": "How long do batteries last?"},
                                    {"question": "What does a battery cost?"},
                                ],
                            },
                            {
                                "type": "related_searches",
                                "items": [
                                    {"title": "solar battery lifespan"},
                                    {"query": "solar battery price"},
                                ],
                            },
                            {
                                "type": "featured_snippet",
                                "text": "A supported answer",
                                "url": "https://authority.example/fact",
                            },
                            {"type": "video"},
                            {"type": "images"},
                            {"type": "video"},
                        ]
                    }
                ],
            }
        ],
    }


class FakeCache:
    def __init__(self, value: str | None = None) -> None:
        self.value = value
        self.set_calls: list[tuple[str, str, int]] = []

    async def get(self, key: str) -> str | None:
        return self.value

    async def set(self, key: str, value: str, ex: int) -> None:
        self.set_calls.append((key, value, ex))


class FakeDataForSEOSettingsService:
    def __init__(self, record: DataForSEOSettingsRecord | None = None) -> None:
        self.record = record or DataForSEOSettingsRecord(
            login="platform-login",
            password="platform-password",
        )

    async def effective_record(self) -> DataForSEOSettingsRecord:
        return self.record


@pytest.fixture(autouse=True)
def platform_dataforseo_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        collection,
        "build_dataforseo_settings_service",
        lambda: FakeDataForSEOSettingsService(),
    )


def dataforseo_client(cache: FakeCache | None = None) -> DataForSEOClient:
    return DataForSEOClient(
        login="login",
        password="password",
        base_url="https://api.example",
        cache=cache,
        cache_ttl_seconds=3600,
        timeout_seconds=10,
    )


def test_dataforseo_parses_actual_question_and_related_search_text() -> None:
    result = parse_serp_response(serp_response(), "solar battery")

    assert result.people_also_ask == [
        "How long do batteries last?",
        "What does a battery cost?",
    ]
    assert result.related_searches == [
        "solar battery lifespan",
        "solar battery price",
    ]
    assert result.featured_snippet == {
        "text": "A supported answer",
        "url": "https://authority.example/fact",
    }
    assert result.features == [
        "people_also_ask",
        "related_searches",
        "featured_snippet",
        "video",
        "images",
    ]
    assert result.request_cost_usd == 0.002
    assert result.provider_request_id == "dataforseo-task-1"


def test_dataforseo_accepts_empty_question_and_related_search_groups() -> None:
    response = serp_response()
    response["tasks"][0]["result"][0]["items"] = [
        response["tasks"][0]["result"][0]["items"][0]
    ]

    result = parse_serp_response(response, "solar battery")

    assert len(result.organic_results) == 1
    assert result.people_also_ask == []
    assert result.related_searches == []


def test_dataforseo_search_accepts_related_searches_without_organic_results() -> None:
    response = serp_response()
    response["tasks"][0]["result"][0]["items"] = [
        response["tasks"][0]["result"][0]["items"][2]
    ]
    client = dataforseo_client()
    client._request = lambda *_: response  # type: ignore[method-assign]

    result = asyncio.run(client.search("solar battery", "US", "en"))

    assert result.organic_results == []
    assert result.related_searches == ["solar battery lifespan", "solar battery price"]


def test_dataforseo_empty_result_preserves_cost_and_request_id() -> None:
    response = serp_response()
    response["tasks"][0]["result"][0]["items"] = []
    client = dataforseo_client()
    client._request = lambda *_: response  # type: ignore[method-assign]

    with pytest.raises(DataForSEOEmptyResult) as exc_info:
        asyncio.run(client.search("solar battery", "US", "en"))

    assert exc_info.value.result.request_cost_usd == 0.002
    assert exc_info.value.result.provider_request_id == "dataforseo-task-1"
    assert exc_info.value.result.raw_response == response


def test_dataforseo_never_reports_an_unusable_organic_item_as_a_feature() -> None:
    response = serp_response()
    response["tasks"][0]["result"][0]["items"].insert(
        1,
        {"type": "organic", "rank_absolute": 2, "title": "Missing URL"},
    )

    result = parse_serp_response(response, "solar battery")

    assert len(result.organic_results) == 1
    assert "organic" not in result.features


@pytest.mark.parametrize(
    ("country", "expected"),
    [
        ("US", {"location_code": 2840}),
        ("GB", {"location_code": 2826}),
        ("CN", {"location_code": 2156}),
        ("DE", {"location_name": "Germany"}),
        ("BR", {"location_name": "Brazil"}),
        ("FR", {"location_name": "France"}),
        ("ES", {"location_name": "Spain"}),
        ("JP", {"location_name": "Japan"}),
        ("IN", {"location_name": "India"}),
        ("SE", {"location_name": "Sweden"}),
    ],
)
def test_dataforseo_country_parameter(country: str, expected: dict[str, str | int]) -> None:
    assert location_parameter(country) == expected


@pytest.mark.parametrize(
    ("language", "expected"),
    [
        ("English", "en"),
        ("eng", "en"),
        ("en-US", "en"),
        ("Spanish", "es"),
        ("", "en"),
        ("unknown", "en"),
    ],
)
def test_dataforseo_language_code(language: str, expected: str) -> None:
    assert normalize_language_code(language) == expected


def test_dataforseo_search_sends_normalized_language_code() -> None:
    client = dataforseo_client()
    request_language = ""

    def request(_keyword: str, _country: str, language: str, _device: str) -> dict[str, Any]:
        nonlocal request_language
        request_language = language
        return serp_response()

    client._request = request  # type: ignore[method-assign]
    asyncio.run(client.search("solar battery", "United States", "English"))

    assert request_language == "en"


def test_dataforseo_cache_hit_avoids_request_and_retains_raw_response() -> None:
    cached_result = parse_serp_response(serp_response(), "solar battery")
    cache = FakeCache(cached_result.cache_value())
    client = dataforseo_client(cache)
    requests = 0

    def request(*_: Any) -> dict[str, Any]:
        nonlocal requests
        requests += 1
        return serp_response()

    client._request = request  # type: ignore[method-assign]
    result = asyncio.run(client.search("solar battery", "US", "en"))

    assert result.cached is True
    assert result.raw_response == serp_response()
    assert result.request_cost_usd == 0.0
    assert result.provider_request_id is None
    assert result.features == [
        "people_also_ask",
        "related_searches",
        "featured_snippet",
        "video",
        "images",
    ]
    assert requests == 0


def test_dataforseo_legacy_cache_recovers_features_from_raw_response() -> None:
    cached_result = parse_serp_response(serp_response(), "solar battery")
    legacy_payload = json.loads(cached_result.cache_value())
    legacy_payload.pop("features")
    cache = FakeCache(json.dumps(legacy_payload))
    client = dataforseo_client(cache)

    def unexpected_request(*_: Any) -> dict[str, Any]:
        raise AssertionError("legacy cache should not trigger an API request")

    client._request = unexpected_request  # type: ignore[method-assign]
    result = asyncio.run(client.search("solar battery", "US", "en"))

    assert result.cached is True
    assert result.features == [
        "people_also_ask",
        "related_searches",
        "featured_snippet",
        "video",
        "images",
    ]


def test_serp_feature_helpers_merge_explicit_and_normalized_signals() -> None:
    payload = {
        "features": ["video", "images"],
        "featured_snippet": {"text": "Answer"},
        "people_also_ask": ["Question"],
    }

    assert collection._serp_features(payload) == [
        "video",
        "images",
        "featured_snippet",
        "people_also_ask",
    ]


def test_dataforseo_corrupt_cache_fetches_fresh_response() -> None:
    cache = FakeCache("not-json")
    client = dataforseo_client(cache)
    requests = 0

    def request(*_: Any) -> dict[str, Any]:
        nonlocal requests
        requests += 1
        return serp_response()

    client._request = request  # type: ignore[method-assign]
    result = asyncio.run(client.search("solar battery", "DE", "de"))

    assert result.cached is False
    assert requests == 1
    assert len(cache.set_calls) == 1


class FakeS3Client:
    def __init__(self, response: dict[str, Any] | Exception | None = None) -> None:
        self.response = response
        self.put_requests: list[dict[str, Any]] = []

    def get_object(self, **_: Any) -> dict[str, Any]:
        if isinstance(self.response, Exception):
            raise self.response
        assert isinstance(self.response, dict)
        return self.response

    def put_object(self, **request: Any) -> None:
        self.put_requests.append(request)


def test_s3_text_reader_reports_missing_corrupt_and_oversized_objects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = Settings(app_env="test", article_source_text_max_bytes=10)
    missing = ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    monkeypatch.setattr(
        "app.modules.content.object_storage.boto3.client",
        lambda **_: FakeS3Client(missing),
    )
    with pytest.raises(StoredTextNotFoundError):
        asyncio.run(S3TextReader(settings).read_text("s3://bucket/missing.txt"))

    monkeypatch.setattr(
        "app.modules.content.object_storage.boto3.client",
        lambda **_: FakeS3Client({"Body": BytesIO(b"bad-gzip")}),
    )
    with pytest.raises(StoredTextCorruptError):
        asyncio.run(S3TextReader(settings).read_text("s3://bucket/bad.txt.gz"))

    oversized = gzip.compress(b"01234567890")
    monkeypatch.setattr(
        "app.modules.content.object_storage.boto3.client",
        lambda **_: FakeS3Client({"Body": BytesIO(oversized)}),
    )
    with pytest.raises(StoredTextTooLargeError):
        asyncio.run(S3TextReader(settings).read_text("s3://bucket/large.txt.gz"))


def test_s3_json_writer_saves_gzip_json(monkeypatch: pytest.MonkeyPatch) -> None:
    client = FakeS3Client()
    monkeypatch.setattr(
        "app.modules.content.object_storage.boto3.client", lambda **_: client
    )

    reference = asyncio.run(
        S3JSONWriter(Settings(app_env="test", s3_bucket="evidence")).write_json(
            "article-runs/run/sources/serp.json.gz", {"status_code": 20000}
        )
    )

    assert reference == "s3://evidence/article-runs/run/sources/serp.json.gz"
    request = client.put_requests[0]
    assert request["ContentEncoding"] == "gzip"
    assert json.loads(gzip.decompress(request["Body"])) == {"status_code": 20000}


class FakeSourceRepository:
    def __init__(self) -> None:
        self.sources: list[dict[str, Any]] = []
        self.internal_candidates: list[dict[str, Any]] = []
        self.internal_candidate_requests: list[dict[str, Any]] = []

    async def list_sources(self, _run_id: str, source_type: str) -> list[dict[str, Any]]:
        return [item for item in self.sources if item["source_type"] == source_type]

    async def upsert_source(self, _run_id: str, **source: Any) -> None:
        self.sources.append(source)

    async def replace_internal_sources(
        self, _run_id: str, sources: list[dict[str, Any]]
    ) -> None:
        self.sources = [
            item for item in self.sources if item.get("source_type") != "internal"
        ]
        self.sources.extend(
            {
                **source,
                "source_type": "internal",
                "status": "available",
                "content_ref": None,
            }
            for source in sources
        )

    async def list_internal_link_candidates(
        self,
        _run_id: str,
        keyword: str,
        profile_key_pages: list[dict[str, Any]],
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        self.internal_candidate_requests.append(
            {
                "keyword": keyword,
                "profile_key_pages": profile_key_pages,
                "limit": limit,
            }
        )
        return self.internal_candidates[:limit]


class FakeUpsertSourceRepository(FakeSourceRepository):
    async def upsert_source(self, _run_id: str, **source: Any) -> None:
        source_key = (
            source["source_type"],
            normalize_source_url(str(source["url"])),
        )
        for index, existing in enumerate(self.sources):
            existing_key = (
                existing["source_type"],
                normalize_source_url(str(existing["url"])),
            )
            if existing_key == source_key:
                self.sources[index] = source
                return
        self.sources.append(source)


def test_serp_collection_saves_raw_response_reference(monkeypatch: pytest.MonkeyPatch) -> None:
    repo = FakeSourceRepository()
    credentials: dict[str, str | None] = {}
    result = SERPResult(
        keyword="solar battery",
        organic_results=[OrganicResult(1, "https://example.net", "example.net", "", "")],
        raw_response=serp_response(),
        request_cost_usd=0.002,
        provider_request_id="dataforseo-task-1",
    )

    async def search(*_: Any, **__: Any) -> SERPResult:
        return result

    async def write_json(*_: Any, **__: Any) -> str:
        return "s3://bucket/raw-serp.json.gz"

    original_init = collection.DataForSEOClient.__init__

    def capture_init(self: DataForSEOClient, **kwargs: Any) -> None:
        credentials["login"] = kwargs["login"]
        credentials["password"] = kwargs["password"]
        original_init(self, **kwargs)

    monkeypatch.setattr(collection.DataForSEOClient, "__init__", capture_init)
    monkeypatch.setattr(collection.DataForSEOClient, "search", search)
    monkeypatch.setattr(collection.S3JSONWriter, "write_json", write_json)
    monkeypatch.setattr(collection, "get_redis", lambda: None)

    outcome = asyncio.run(
        collection._collect_serp(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test", dataforseo_login="x", dataforseo_password="y"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert credentials == {
        "login": "platform-login",
        "password": "platform-password",
    }
    assert repo.sources[0]["content_ref"] == "s3://bucket/raw-serp.json.gz"
    assert repo.sources[0]["metadata"] == {
        "cached": False,
        "request_cost_usd": 0.002,
        "cost_currency": "USD",
        "provider_request_id": "dataforseo-task-1",
    }
    assert "raw_response" not in repo.sources[0]["summary"]
    analysis = repo.sources[0]["summary"]["serp_analysis"]
    assert analysis["analyzed_result_count"] == 1
    assert analysis["dominant_content_type"] == "General Article"
    assert analysis["top_results"][0]["content_type"] == "General Article"


def test_existing_serp_collection_backfills_missing_analysis() -> None:
    repo = FakeSourceRepository()
    repo.sources.append(
        {
            "source_type": "serp",
            "url": "serp://google/run",
            "status": "available",
            "title": "solar battery",
            "domain": None,
            "content_ref": "s3://bucket/raw-serp.json.gz",
            "summary": {
                "keyword": "solar battery",
                "organic_results": [
                    {
                        "position": 1,
                        "url": "https://example.net/tutorial",
                        "title": "Solar Battery Tutorial",
                    }
                ],
            },
            "metadata": {"cached": True},
        }
    )

    outcome = asyncio.run(
        collection._collect_serp(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    saved = repo.sources[-1]
    assert saved["summary"]["serp_analysis"]["dominant_content_type"] == (
        "How-To Guide"
    )
    assert saved["content_ref"] == "s3://bucket/raw-serp.json.gz"
    assert saved["metadata"] == {"cached": True}


def test_content_plan_serp_source_is_reused_without_dataforseo_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeSourceRepository()
    repo.sources.append(
        {
            "source_type": "serp",
            "url": "serp://content-plan/serp-1",
            "status": "available",
            "title": "content planning",
            "domain": None,
            "content_ref": None,
            "summary": {
                "keyword": "content planning",
                "organic_results": [
                    {
                        "position": 1,
                        "url": "https://example.test/content-planning",
                        "title": "Content Planning Guide",
                    }
                ],
                "people_also_ask": ["What is content planning?"],
                "related_searches": ["editorial calendar"],
                "features": [],
            },
            "metadata": {
                "content_plan_serp_snapshot_id": "serp-1",
                "request_cost_usd": 0,
                "reused": True,
            },
        }
    )
    calls = 0

    async def search(*_: Any, **__: Any) -> SERPResult:
        nonlocal calls
        calls += 1
        raise AssertionError("content-plan SERP must be reused")

    monkeypatch.setattr(collection.DataForSEOClient, "search", search)

    outcome = asyncio.run(
        collection._collect_serp(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run-from-plan",
            "content planning",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert calls == 0
    assert repo.sources[-1]["metadata"]["reused"] is True


def test_existing_serp_collection_refreshes_older_analysis_granularity() -> None:
    repo = FakeSourceRepository()
    repo.sources.append(
        {
            "source_type": "serp",
            "url": "serp://google/run",
            "status": "available",
            "title": "solar battery",
            "domain": None,
            "content_ref": "s3://bucket/raw-serp.json.gz",
            "summary": {
                "keyword": "solar battery",
                "features": ["video", "images"],
                "organic_results": [
                    {
                        "position": 3,
                        "url": "https://example.net/tutorial",
                        "title": "Latest Solar Battery Tutorial",
                    }
                ],
                "serp_analysis": {
                    "dominant_content_type": "How-To Guide",
                    "top_results": [],
                },
            },
            "metadata": {"cached": True},
        }
    )

    asyncio.run(
        collection._collect_serp(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    analysis = repo.sources[-1]["summary"]["serp_analysis"]
    assert analysis["analysis_version"] == 3
    assert analysis["top_results"][0]["position"] == 3
    assert analysis["top_results"][0]["organic_position"] == 1
    assert analysis["freshness_signals"] == [1]
    assert analysis["content_brief"]["serp_features_to_target"] == [
        "Video - Consider embedding relevant video or creating one",
        "Images - Include high-quality images with alt text",
    ]


def test_internal_collection_saves_lightweight_candidates_without_page_text() -> None:
    repo = FakeSourceRepository()
    repo.internal_candidates = [
        {
            "url": "https://project.example/guide",
            "title": "Guide",
            "description": "A practical solar battery guide",
            "headings": ["Battery sizing", "Payback"],
            "anchor_texts": ["Solar battery guide"],
            "candidate_kind": "published_article",
            "selection_score": 22,
            "selection_reason": "关键词相关词命中 2 个；来源为 published_article",
            "word_count": 800,
        }
    ]

    outcome = asyncio.run(
        collection._collect_internal(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"domain": "project.example"},
        )
    )

    assert outcome == (None, 1)
    saved = repo.sources[0]
    assert saved["source_type"] == "internal"
    assert saved["content_ref"] is None
    assert saved["summary"] == {
        "description": "A practical solar battery guide",
        "headings": ["Battery sizing", "Payback"],
        "anchor_texts": ["Solar battery guide"],
        "candidate_kind": "published_article",
        "selection_score": 22,
        "selection_reason": "关键词相关词命中 2 个；来源为 published_article",
        "word_count": 800,
    }


def test_internal_link_relevance_maps_common_chinese_intent_to_english_pages() -> None:
    keyword_terms = _internal_link_terms("CRM 实施指南 2026")
    relevant_score, overlaps = _internal_link_candidate_score(
        {
            "url": "https://project.example/crm-implementation",
            "title": "CRM Implementation Guide",
            "description": "Plan and roll out a CRM.",
            "headings": ["Implementation steps"],
            "anchor_texts": [],
        },
        keyword_terms,
    )
    noisy_score, _ = _internal_link_candidate_score(
        {
            "url": "https://project.example/careers",
            "title": "Careers",
            "description": "Work with our CRM team.",
            "headings": [],
            "anchor_texts": [],
        },
        keyword_terms,
    )

    assert "implementation" in _internal_link_query_terms("CRM 实施指南 2026")
    assert overlaps["title"] >= 2
    assert relevant_score > 0
    assert noisy_score == 0


def test_internal_collection_passes_profile_key_pages_to_repository() -> None:
    repo = FakeSourceRepository()
    repo.internal_candidates = [
        {
            "url": "https://project.example/products/battery",
            "title": "Battery systems",
            "description": "Home battery products",
            "candidate_kind": "business_page",
        }
    ]
    key_pages = [
        {
            "url": "https://project.example/products/battery",
            "title": "Battery systems",
            "description": "Home battery products",
        }
    ]

    outcome = asyncio.run(
        collection._collect_internal(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"domain": "project.example", "profile": {"key_pages": key_pages}},
        )
    )

    assert outcome == (None, 1)
    assert repo.internal_candidate_requests == [
        {
            "keyword": "solar battery",
            "profile_key_pages": key_pages,
            "limit": 30,
        }
    ]


def test_internal_collection_keeps_all_available_candidates() -> None:
    repo = FakeSourceRepository()
    repo.internal_candidates = [
        {
            "url": "https://project.example/services/install",
            "title": "Installation",
            "candidate_kind": "business_page",
        },
        {
            "url": "https://project.example/blog/battery-cost",
            "title": "Battery cost guide",
            "candidate_kind": "published_article",
        },
    ]

    outcome = asyncio.run(
        collection._collect_internal(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"domain": "project.example"},
        )
    )

    assert outcome == (None, 2)
    assert [item["status"] for item in repo.sources] == ["available", "available"]
    assert all(item["content_ref"] is None for item in repo.sources)


def test_internal_collection_degrades_when_no_page_exists() -> None:
    repo = FakeSourceRepository()

    outcome = asyncio.run(
        collection._collect_internal(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"domain": "project.example"},
        )
    )

    assert outcome == ("internal_sources_unavailable", 0)
    assert repo.sources == []


def test_internal_collection_replaces_stale_candidates_on_retry() -> None:
    repo = FakeSourceRepository()
    repo.internal_candidates = [
        {
            "url": "https://project.example/old-guide",
            "title": "Old guide",
            "candidate_kind": "published_article",
        }
    ]
    asyncio.run(
        collection._collect_internal(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"domain": "project.example"},
        )
    )

    repo.internal_candidates = [
        {
            "url": "https://project.example/new-guide",
            "title": "New guide",
            "candidate_kind": "published_article",
        }
    ]
    asyncio.run(
        collection._collect_internal(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"domain": "project.example"},
        )
    )

    internal_urls = [
        item["url"]
        for item in repo.sources
        if item.get("source_type") == "internal"
    ]
    assert internal_urls == ["https://project.example/new-guide"]


@pytest.mark.parametrize("failure", ["not_configured", "request_failed", "empty_result"])
def test_serp_collection_degrades_for_configuration_request_and_empty_failures(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    repo = FakeSourceRepository()

    async def search(*_: Any, **__: Any) -> SERPResult:
        raise DataForSEOError(f"dataforseo_{failure}")

    monkeypatch.setattr(collection.DataForSEOClient, "search", search)
    monkeypatch.setattr(collection, "get_redis", lambda: None)

    outcome = asyncio.run(
        collection._collect_serp(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == ("dataforseo_unavailable", 0)
    assert repo.sources[0]["status"] == "failed"
    assert repo.sources[0]["metadata"]["error_code"] == f"dataforseo_{failure}"


def test_serp_raw_storage_failure_keeps_normalized_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeSourceRepository()
    result = parse_serp_response(serp_response(), "solar battery")

    async def search(*_: Any, **__: Any) -> SERPResult:
        return result

    async def write_json(*_: Any, **__: Any) -> str:
        raise ObjectWriteError("storage unavailable")

    monkeypatch.setattr(collection.DataForSEOClient, "search", search)
    monkeypatch.setattr(collection.S3JSONWriter, "write_json", write_json)
    monkeypatch.setattr(collection, "get_redis", lambda: None)

    outcome = asyncio.run(
        collection._collect_serp(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert repo.sources[0]["status"] == "available"
    assert repo.sources[0]["content_ref"] is None
    assert repo.sources[0]["metadata"]["raw_response_storage_error"] == (
        "object_write_failed"
    )


def test_collection_only_collects_internal_and_serp_before_brand_research(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def internal(*_: Any, **__: Any) -> tuple[str, int]:
        return "internal_sources_unavailable", 0

    async def serp(*_: Any, **__: Any) -> tuple[str, int]:
        return "dataforseo_unavailable", 0

    monkeypatch.setattr(collection, "_collect_internal", internal)
    monkeypatch.setattr(collection, "_collect_serp", serp)

    async def research(*_: Any, **__: Any) -> tuple[str, int]:
        raise AssertionError("brand research must run after competitor collection")

    monkeypatch.setattr(collection, "_collect_research", research)

    repo = FakeSourceRepository()

    result = asyncio.run(
        collection.collect_sources(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            {
                "run_id": "run",
                "primary_keyword": "solar battery",
                "project_snapshot": {},
            },
        )
    )

    assert [item["code"] for item in result["warnings"]] == [
        "internal_sources_unavailable",
        "dataforseo_unavailable",
    ]
    assert result["summary"] == {
        "internal_sources_unavailable": 0,
        "dataforseo_unavailable": 0,
    }


def test_collection_runs_internal_and_serp_in_parallel_without_early_research(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    serp_started = asyncio.Event()
    internal_started = asyncio.Event()
    release_serp = asyncio.Event()

    async def internal(*_: Any, **__: Any) -> tuple[str | None, int]:
        internal_started.set()
        return None, 0

    async def serp(*_: Any, **__: Any) -> tuple[str | None, int]:
        serp_started.set()
        await release_serp.wait()
        return None, 0

    async def research(*_: Any, **__: Any) -> tuple[str | None, int]:
        raise AssertionError("brand research must run after competitor collection")

    monkeypatch.setattr(collection, "_collect_internal", internal)
    monkeypatch.setattr(collection, "_collect_serp", serp)
    monkeypatch.setattr(collection, "_collect_research", research)

    async def scenario() -> dict[str, Any]:
        task = asyncio.create_task(
            collection.collect_sources(
                FakeSourceRepository(),  # type: ignore[arg-type]
                Settings(app_env="test"),
                {
                    "run_id": "run",
                    "primary_keyword": "solar battery",
                    "project_snapshot": {},
                },
            )
        )
        await asyncio.wait_for(serp_started.wait(), timeout=1)
        await asyncio.wait_for(internal_started.wait(), timeout=1)
        assert not task.done()
        release_serp.set()
        return await task

    result = asyncio.run(scenario())

    assert result["warnings"] == []


def test_collection_reports_dataforseo_actual_cost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def internal(*_: Any, **__: Any) -> tuple[str | None, int]:
        return None, 0

    async def serp(repo: FakeSourceRepository, *_: Any, **__: Any) -> tuple[str | None, int]:
        await repo.upsert_source(
            "run",
            source_type="serp",
            metadata={
                "request_cost_usd": 0.002,
                "provider_request_id": "dataforseo-task-1",
            },
        )
        return None, 10

    async def research(*_: Any, **__: Any) -> tuple[str | None, int]:
        return None, 0

    monkeypatch.setattr(collection, "_collect_internal", internal)
    monkeypatch.setattr(collection, "_collect_serp", serp)
    monkeypatch.setattr(collection, "_collect_research", research)

    result = asyncio.run(
        collection.collect_sources(
            FakeSourceRepository(),  # type: ignore[arg-type]
            Settings(app_env="test"),
            {
                "run_id": "run",
                "primary_keyword": "solar battery",
                "project_snapshot": {},
            },
        )
    )

    assert result["usage"] == {
        "reported_cost": 0.002,
        "estimated_cost": None,
        "cost_currency": "USD",
        "estimation_basis": {},
        "provider_request_ids": ["dataforseo-task-1"],
    }


def test_research_gateway_uses_fallback_after_primary_failure() -> None:
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("responses", "https://fallback", "key", "fallback"),
        10,
    )

    def request(config: ResearchProviderConfig, _request: ResearchRequest) -> ResearchResult:
        if config.model == "primary":
            raise RuntimeError("primary unavailable")
        return ResearchResult(
            "supported answer",
            [ResearchCitation("https://authority.example/source", "Source")],
            config.provider,
            config.model,
        )

    gateway._request = request  # type: ignore[method-assign]
    result = asyncio.run(gateway.research(ResearchRequest("keyword", "US", "en")))

    assert result.model == "fallback"


def test_research_request_requires_opened_page_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class Response:
        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *_: Any) -> None:
            return None

        def read(self) -> bytes:
            return b'{"output_text":"supported evidence"}'

    def urlopen(request: Any, **_: Any) -> Response:
        captured.update(json.loads(request.data))
        return Response()

    monkeypatch.setattr("app.modules.content.research_gateway.urlopen", urlopen)
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://provider.example/v1", "key", "model"),
        ResearchProviderConfig("", "", "", ""),
        10,
    )

    gateway._request(
        gateway.primary,
        ResearchRequest("solar battery", "US", "en", ["official warranty"]),
    )

    prompt = json.loads(captured["input"])
    instructions = prompt["instructions"]
    assert captured["include"] == ["web_search_call.action.sources"]
    assert "open useful result pages" in instructions
    assert "EXACT_QUOTE" in instructions
    assert "untrusted data" not in instructions
    assert "number, price, date, or strong conclusion" not in instructions
    assert "Return at most three" not in instructions


def test_research_gateway_limits_fixed_question_concurrency() -> None:
    request = ResearchRequest("solar battery", "US", "en")
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
        max_concurrency=2,
    )
    active = 0
    max_active = 0
    two_started = asyncio.Event()
    release = asyncio.Event()

    async def research_question(
        _request: ResearchRequest, question: str
    ) -> ResearchResult:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        if active == 2:
            two_started.set()
        try:
            await release.wait()
            return ResearchResult(
                question,
                [
                    ResearchCitation(
                        f"https://authority.example/{abs(hash(question))}",
                        excerpt=question,
                    )
                ],
                "responses",
                "primary",
                [question],
            )
        finally:
            active -= 1

    gateway._research_question = research_question  # type: ignore[method-assign]

    async def scenario() -> ResearchResult:
        task = asyncio.create_task(
            gateway.research(request)
        )
        await asyncio.wait_for(two_started.wait(), timeout=1)
        await asyncio.sleep(0)
        assert max_active == 2
        release.set()
        return await task

    result = asyncio.run(scenario())

    assert len(result.queries) == len(research_questions(request))
    assert max_active == 2


@pytest.mark.parametrize(
    ("code", "retryable"),
    [
        ("research_http_429", True),
        ("research_http_503", True),
        ("research_network_error", True),
    ],
)
def test_research_gateway_retries_only_bounded_transient_failures(
    code: str, retryable: bool
) -> None:
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
        max_retries=2,
        retry_initial_seconds=0,
    )
    calls = 0

    def request(*_: Any) -> ResearchResult:
        nonlocal calls
        calls += 1
        raise ResearchProviderError(code, retryable=retryable)

    gateway._request = request  # type: ignore[method-assign]

    with pytest.raises(Exception):
        asyncio.run(
            gateway._research_question(
                ResearchRequest("solar battery", "US", "en"), "official facts"
            )
        )

    assert calls == 3


def test_research_gateway_limits_timeout_to_one_retry() -> None:
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        90,
        max_retries=2,
        timeout_max_retries=1,
        retry_initial_seconds=0,
    )
    calls = 0

    def request(*_: Any) -> ResearchResult:
        nonlocal calls
        calls += 1
        raise ResearchProviderError("research_network_timeout", retryable=True)

    gateway._request = request  # type: ignore[method-assign]

    with pytest.raises(Exception):
        asyncio.run(
            gateway._research_question(
                ResearchRequest("solar battery", "US", "en"), "official facts"
            )
        )

    assert calls == 2


def test_research_gateway_caps_retry_after_delay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
        max_retries=1,
        retry_initial_seconds=0.5,
        retry_max_seconds=5,
    )
    calls = 0
    delays: list[float] = []

    def request(*_: Any) -> ResearchResult:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ResearchProviderError(
                "research_http_429",
                retryable=True,
                retry_after_seconds=300,
            )
        return ResearchResult(
            "supported answer",
            [ResearchCitation("https://authority.example/source", excerpt="evidence")],
            "responses",
            "primary",
        )

    async def sleep(delay: float) -> None:
        delays.append(delay)

    gateway._request = request  # type: ignore[method-assign]
    monkeypatch.setattr(asyncio, "sleep", sleep)

    result = asyncio.run(
        gateway._research_question(
            ResearchRequest("solar battery", "US", "en"), "official facts"
        )
    )

    assert result.answer == "supported answer"
    assert calls == 2
    assert delays == [5]


@pytest.mark.parametrize("status", [400, 401, 403])
def test_research_gateway_does_not_retry_permanent_http_failures(status: int) -> None:
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
        max_retries=2,
        retry_initial_seconds=0,
    )
    calls = 0

    def request(*_: Any) -> ResearchResult:
        nonlocal calls
        calls += 1
        raise ResearchProviderError(f"research_http_{status}", retryable=False)

    gateway._request = request  # type: ignore[method-assign]

    with pytest.raises(Exception):
        asyncio.run(
            gateway._research_question(
                ResearchRequest("solar battery", "US", "en"), "official facts"
            )
        )

    assert calls == 1


def test_research_gateway_opens_primary_circuit_and_keeps_fallback_results() -> None:
    research_request = ResearchRequest("solar battery", "US", "en")
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("responses", "https://fallback", "key", "fallback"),
        10,
        max_concurrency=1,
        max_retries=0,
        circuit_failure_threshold=2,
    )
    calls = {"primary": 0, "fallback": 0}

    def request(
        config: ResearchProviderConfig, research: ResearchRequest
    ) -> ResearchResult:
        calls[config.model] += 1
        if config.model == "primary":
            raise ResearchProviderError("research_http_503", retryable=True)
        question = research.questions[0]
        return ResearchResult(
            question,
            [
                ResearchCitation(
                    f"https://authority.example/{calls['fallback']}",
                    excerpt=question,
                )
            ],
            config.provider,
            config.model,
        )

    gateway._request = request  # type: ignore[method-assign]
    result = asyncio.run(gateway.research(research_request))

    question_count = len(research_questions(research_request))
    assert calls == {"primary": min(2, question_count), "fallback": question_count}
    assert result.failed_queries == []
    assert result.model == "fallback"


def test_research_gateway_keeps_successful_questions_when_one_fails() -> None:
    research_request = ResearchRequest("solar battery", "US", "en")
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
    )
    questions = research_questions(research_request)
    failed_question = questions[1]

    async def research_question(
        _request: ResearchRequest, question: str
    ) -> ResearchResult:
        if question == failed_question:
            raise RuntimeError("one query failed")
        return ResearchResult(
            question,
            [ResearchCitation(f"https://authority.example/{len(question)}", excerpt=question)],
            "responses",
            "primary",
            [question],
        )

    gateway._research_question = research_question  # type: ignore[method-assign]
    result = asyncio.run(gateway.research(research_request))

    assert result.failed_queries == [failed_question]
    assert len(result.queries) == len(questions)
    assert result.citations


def test_research_gateway_retains_sanitized_primary_and_fallback_failures() -> None:
    research_request = ResearchRequest("solar battery", "US", "en")
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "primary-secret", "primary"),
        ResearchProviderConfig("responses", "https://fallback", "fallback-secret", "fallback"),
        10,
        max_concurrency=1,
        max_retries=0,
        circuit_failure_threshold=10,
    )

    def request(
        config: ResearchProviderConfig, _request: ResearchRequest
    ) -> ResearchResult:
        code = "research_http_503" if config.model == "primary" else "research_http_429"
        raise ResearchProviderError(code, retryable=True)

    gateway._request = request  # type: ignore[method-assign]

    with pytest.raises(ResearchError) as captured:
        asyncio.run(gateway.research(research_request))

    error = captured.value
    assert error.code == "research_providers_failed"
    details = error.failure_details()
    question_count = len(research_questions(research_request))
    assert len(details) == question_count
    assert [item["providers"][0]["code"] for item in details] == [
        "research_http_503"
    ] * question_count
    assert [item["providers"][1]["code"] for item in details] == [
        "research_http_429"
    ] * question_count
    assert all(
        provider["attempts"] == 1
        for item in details
        for provider in item["providers"]
    )
    assert "secret" not in json.dumps(details)


def test_research_gateway_partial_success_retains_failure_details() -> None:
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
    )
    failed_question = research_questions(ResearchRequest("solar battery", "US", "en"))[1]

    async def research_question(
        _request: ResearchRequest, question: str
    ) -> ResearchResult:
        if question == failed_question:
            raise ResearchError(
                "research_query_failed",
                failures=(
                    ResearchFailure(
                        question,
                        (
                            ProviderFailure(
                                "responses", "primary", "research_network_timeout", 2
                            ),
                        ),
                    ),
                ),
            )
        return ResearchResult(
            question,
            [ResearchCitation(f"https://authority.example/{len(question)}", excerpt=question)],
            "responses",
            "primary",
            [question],
        )

    gateway._research_question = research_question  # type: ignore[method-assign]
    result = asyncio.run(gateway.research(ResearchRequest("solar battery", "US", "en")))

    assert result.failed_queries == [failed_question]
    assert result.research_failures == [
        {
            "query": failed_question,
            "providers": [
                {
                    "provider": "responses",
                    "model": "primary",
                    "code": "research_network_timeout",
                    "attempts": 2,
                    "circuit_open": False,
                }
            ],
        }
    ]


def test_collect_research_persists_bounded_sanitized_failure_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeSourceRepository()
    failure = ResearchFailure(
        "What official evidence supports solar battery?",
        (
            ProviderFailure(
                "responses", "gpt-research", "research_network_timeout", 2
            ),
        ),
    )

    async def research(*_: Any, **__: Any) -> ResearchResult:
        raise ResearchError("research_providers_failed", failures=(failure,))

    monkeypatch.setattr(collection.ResearchGateway, "research", research)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == ("research_unavailable", 0)
    metadata = repo.sources[0]["metadata"]
    assert metadata["error_code"] == "research_providers_failed"
    assert metadata["source"] == "web_research"
    assert metadata["verification_status"] == "research_failed"
    assert metadata["research_failures"] == [failure.as_dict()]
    serialized = json.dumps(metadata)
    assert "api_key" not in serialized
    assert "Authorization" not in serialized


def test_collect_research_retries_copied_failure_instead_of_treating_it_as_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeUpsertSourceRepository()
    repo.sources.append(
        {
            "source_type": "authority",
            "url": "research://web/parent-run",
            "status": "failed",
            "metadata": {
                "source": "web_research",
                "verification_status": "research_failed",
                "error_code": "research_not_configured",
                "copied_from_run_id": "parent-run",
            },
        }
    )
    citation = ResearchCitation(
        "https://authority.example/source",
        "Official source",
        "A supported fact.",
        claim="A supported fact.",
        exact_quote="A supported fact.",
    )
    calls = 0

    async def research(*_: Any, **__: Any) -> ResearchResult:
        nonlocal calls
        calls += 1
        return ResearchResult("Supported answer", [citation], "responses", "model")

    async def verify(*_: Any, **__: Any) -> list[tuple[ResearchCitation, dict[str, Any]]]:
        return [
            (
                citation,
                {
                    "source_tier": "tier_1",
                    "verification_status": "unreachable",
                    "verification_method": "crawler_page_unavailable_v1",
                    "independent_source": False,
                },
            )
        ]

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection, "_verify_research_sources", verify)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(
                app_env="test",
                article_research_provider="responses",
                article_research_base_url="https://research.example/v1",
                article_research_api_key="key",
                article_research_model="model",
            ),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert calls == 1
    assert outcome == (None, 1)
    assert any(
        item["url"] == citation.url and item["status"] == "available"
        for item in repo.sources
    )


def test_collect_research_reuses_available_web_research_without_verification_label(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeSourceRepository()
    repo.sources.append(
        {
            "source_type": "authority",
            "url": "https://research.example/useful-page",
            "status": "available",
            "summary": {"research_answer": "Useful research already collected."},
            "metadata": {"source": "web_research"},
        }
    )

    async def research(*_: Any, **__: Any) -> ResearchResult:
        raise AssertionError("available web research must be reused")

    monkeypatch.setattr(collection.ResearchGateway, "research", research)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)


def test_research_questions_include_observed_paa_and_related_searches() -> None:
    questions = research_questions(
        ResearchRequest(
            "solar battery",
            "US",
            "en",
            ["How long do batteries last?", "solar battery price"],
        )
    )

    assert len(questions) == 4
    assert questions[0] == "solar battery"
    assert "How long do batteries last?" in questions
    assert "solar battery price" in questions
    assert any("official" in question.casefold() for question in questions)


def test_research_gateway_sends_exact_queries_without_broad_expansion() -> None:
    query = "What is the current federal tax credit?"
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
    )
    observed: list[str] = []

    async def research_question(
        _request: ResearchRequest, question: str
    ) -> ResearchResult:
        observed.append(question)
        return ResearchResult(
            question,
            [ResearchCitation("https://irs.gov/credit", excerpt=question)],
            "responses",
            "primary",
            [question],
        )

    gateway._research_question = research_question  # type: ignore[method-assign]
    result = asyncio.run(
        gateway.research(
            ResearchRequest("solar battery", "US", "en", [query], exact_queries=True)
        )
    )

    assert observed == [query]
    assert result.queries == [query]


def test_collect_research_runs_brand_tasks_in_parallel_and_keeps_partial_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeUpsertSourceRepository()
    tasks = [
        f"Research the brand Brand {index} in GB as one complete brand profile."
        for index in range(1, 5)
    ]
    observed: dict[str, Any] = {}
    citation = ResearchCitation(
        "https://brand1.example/plans",
        "Brand 1 plans",
        "Brand 1 publishes its current plans.",
        queries=(tasks[0],),
        claim="Brand 1 publishes its current plans.",
        exact_quote="Brand 1 publishes its current plans.",
    )

    class Gateway:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            observed["timeout_seconds"] = args[2]
            observed["max_concurrency"] = kwargs["max_concurrency"]
            observed["timeout_max_retries"] = kwargs["timeout_max_retries"]

        async def research(self, request: ResearchRequest) -> ResearchResult:
            observed["request"] = request
            return ResearchResult(
                "Brand 1 research succeeded.",
                [citation],
                "responses",
                "research-model",
                queries=tasks,
                failed_queries=[tasks[-1]],
                research_failures=[
                    {
                        "query": tasks[-1],
                        "providers": [
                            {
                                "provider": "responses",
                                "model": "research-model",
                                "code": "research_network_timeout",
                                "attempts": 1,
                                "circuit_open": False,
                            }
                        ],
                    }
                ],
            )

    async def verify(*_: Any, **__: Any) -> list[tuple[ResearchCitation, dict[str, Any]]]:
        return [
            (
                citation,
                {
                    "source_tier": "tier_1",
                    "verification_status": "verified",
                    "verification_method": "page_text_match_v1",
                    "research_excerpt": citation.exact_quote,
                    "verified_url": citation.url,
                    "independent_source": True,
                },
            )
        ]

    monkeypatch.setattr(collection, "ResearchGateway", Gateway)
    monkeypatch.setattr(collection, "_verify_research_sources", verify)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(
                app_env="test",
                article_research_provider="responses",
                article_research_base_url="https://research.example/v1",
                article_research_api_key="key",
                article_research_model="model",
                article_research_timeout_seconds=180,
                article_research_max_concurrency=2,
            ),
            "run",
            "business phone service",
            {"country": "GB", "language": "en"},
            tasks,
        )
    )

    assert observed["max_concurrency"] == 4
    assert observed["timeout_seconds"] == 140
    assert observed["timeout_max_retries"] == 0
    request = observed["request"]
    assert request.questions == tasks
    assert request.exact_queries is True
    assert outcome == (None, 1)
    saved = next(item for item in repo.sources if item["url"] == citation.url)
    assert saved["metadata"]["failed_queries"] == [tasks[-1]]
    assert saved["metadata"]["research_failures"][0]["query"] == tasks[-1]


def test_collect_research_keeps_search_results_when_verification_times_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeUpsertSourceRepository()
    task = "Research the brand North Star in GB as one complete brand profile."
    citation = ResearchCitation(
        "https://northstar.example/plans",
        "North Star plans",
        "North Star publishes its current plans.",
        queries=(task,),
        claim="North Star publishes its current plans.",
        exact_quote="North Star publishes its current plans.",
    )

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "North Star research succeeded.",
            [citation],
            "responses",
            "research-model",
            queries=[task],
        )

    async def slow_verification(*_: Any, **__: Any) -> Any:
        await asyncio.sleep(1)

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection, "_verify_research_sources", slow_verification)
    monkeypatch.setattr(collection, "BRAND_RESEARCH_VERIFICATION_SECONDS", 0.01)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(
                app_env="test",
                article_research_provider="responses",
                article_research_base_url="https://research.example/v1",
                article_research_api_key="key",
                article_research_model="model",
            ),
            "run",
            "business phone service",
            {"country": "GB", "language": "en"},
            [task],
        )
    )

    assert outcome == (None, 1)
    saved = next(item for item in repo.sources if item["url"] == citation.url)
    assert saved["status"] == "available"
    assert saved["metadata"]["verification_status"] == "unreachable"
    assert saved["metadata"]["verification_method"] == "verification_timeout_v1"


def test_research_merge_combines_queries_and_excerpts_for_same_url() -> None:
    first_query = "official definition"
    second_query = "current limitations"
    result = merge_research_results(
        [
            ResearchResult(
                "first answer",
                [
                    ResearchCitation(
                        "https://authority.example/report#overview",
                        "Report",
                        "The official definition.",
                        (first_query,),
                        "responses",
                        "model",
                    )
                ],
                "responses",
                "model",
            ),
            ResearchResult(
                "second answer",
                [
                    ResearchCitation(
                        "https://authority.example/report?utm_source=search&utm_campaign=test",
                        "Report",
                        "The documented limitation.",
                        (second_query,),
                        "responses",
                        "model",
                    )
                ],
                "responses",
                "model",
            ),
        ],
        [first_query, second_query],
        [],
    )

    assert len(result.citations) == 1
    assert result.citations[0].queries == (first_query, second_query)
    assert result.citations[0].excerpt == (
        "The official definition.\nThe documented limitation."
    )
    assert normalize_source_url(
        "https://authority.example/report?record=42&utm_source=search#section"
    ) == "https://authority.example/report?record=42"


def test_research_gateway_cache_hit_avoids_provider_request() -> None:
    question = research_questions(ResearchRequest("solar battery", "US", "en"))[0]
    cached = ResearchResult(
        "cached evidence",
        [
            ResearchCitation(
                "https://authority.example/source",
                "Source",
                "Cached supported claim.",
                (question,),
                "responses",
                "cached-model",
            )
        ],
        "responses",
        "cached-model",
        [question],
    )
    cache = FakeCache()
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
        cache=cache,
    )

    async def scenario() -> ResearchResult:
        cache_key = research_cache_key(
            ResearchRequest("solar battery", "US", "en", [question]), question
        )
        await gateway._cache_set(cache_key, cached)
        cache.value = cache.set_calls[0][1]
        gateway._request = lambda *_: (_ for _ in ()).throw(  # type: ignore[method-assign]
            AssertionError("provider must not be called on cache hit")
        )
        return await gateway._research_question(
            ResearchRequest("solar battery", "US", "en"), question
        )

    result = asyncio.run(scenario())

    assert result.cached_queries == [question]
    assert result.citations[0].url == "https://authority.example/source"


def test_research_gateway_does_not_cache_result_without_citations() -> None:
    cache = FakeCache()
    gateway = ResearchGateway(
        ResearchProviderConfig("responses", "https://primary", "key", "primary"),
        ResearchProviderConfig("", "", "", ""),
        10,
        cache=cache,
    )

    asyncio.run(
        gateway._cache_set(
            "research-key",
            ResearchResult("unsupported answer", [], "responses", "primary"),
        )
    )

    assert cache.set_calls == []


def test_research_response_binds_structured_claim_and_quote_to_annotated_url() -> None:
    claim = "Battery warranties commonly cover ten years."
    quote = "The limited warranty period is 10 years from the installation date."
    url = "https://authority.example/warranty"
    text = (
        "<EVIDENCE>"
        f"<CLAIM>{claim}</CLAIM>"
        f"<EXACT_QUOTE>{quote}</EXACT_QUOTE>"
        f"<SOURCE_URL>{url}?utm_source=search</SOURCE_URL>"
        "<SOURCE_TITLE>Warranty</SOURCE_TITLE>"
        "</EVIDENCE> [1]"
    )
    answer, citations = parse_responses_research(
        {
            "output": [
                {
                    "content": [
                        {
                            "type": "output_text",
                            "text": text,
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": url,
                                    "title": "Warranty",
                                    "start_index": text.rfind("[1]"),
                                    "end_index": len(text),
                                },
                            ],
                        }
                    ]
                }
            ]
        }
    )

    assert answer == text
    assert len(citations) == 1
    assert citations[0].url == url
    assert citations[0].claim == claim
    assert citations[0].exact_quote == quote
    assert citations[0].excerpt == claim


def test_research_response_keeps_multiple_claims_for_one_url_separate() -> None:
    url = "https://authority.example/report?record=42&lang=en"
    text = (
        "<EVIDENCE><CLAIM>The survey included 2,000 households.</CLAIM>"
        "<EXACT_QUOTE>The 2025 survey included 2,000 households.</EXACT_QUOTE>"
        "<SOURCE_URL>https://authority.example/report?record=42&amp;lang=en</SOURCE_URL>"
        "<SOURCE_TITLE>Report</SOURCE_TITLE></EVIDENCE> [1]"
        "<EVIDENCE><CLAIM>The response rate was 72 percent.</CLAIM>"
        "<EXACT_QUOTE>The final response rate was 72 percent.</EXACT_QUOTE>"
        "<SOURCE_URL>https://authority.example/report?record=42&amp;lang=en</SOURCE_URL>"
        "<SOURCE_TITLE>Report</SOURCE_TITLE></EVIDENCE> [2]"
    )
    _, citations = parse_responses_research(
        {
            "output": [
                {
                    "content": [
                        {
                            "type": "output_text",
                            "text": text,
                            "annotations": [
                                {"type": "url_citation", "url": url, "title": "Report"}
                            ],
                        }
                    ]
                }
            ]
        }
    )

    assert [item.claim for item in citations] == [
        "The survey included 2,000 households.",
        "The response rate was 72 percent.",
    ]
    assert [item.exact_quote for item in citations] == [
        "The 2025 survey included 2,000 households.",
        "The final response rate was 72 percent.",
    ]


def test_research_response_does_not_treat_model_text_before_annotation_as_page_quote() -> None:
    text = "A model-written summary that is not page text. [1]"
    _, citations = parse_responses_research(
        {
            "output": [
                {
                    "content": [
                        {
                            "type": "output_text",
                            "text": text,
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://authority.example/report",
                                    "title": "Report",
                                    "start_index": text.rfind("[1]"),
                                    "end_index": len(text),
                                }
                            ],
                        }
                    ]
                }
            ]
        }
    )

    assert citations[0].excerpt == ""
    assert citations[0].claim == ""
    assert citations[0].exact_quote == ""


def test_research_collection_persists_only_each_citations_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            assert urls == [
                "https://authority.example/warranty",
                "https://authority.example/cycles",
            ]
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": "https://authority.example/warranty",
                    "requested_url": "https://authority.example/warranty",
                    "status": "available",
                    "content_ref": "s3://sources/warranty.txt.gz",
                },
                {
                    "url": "https://authority.example/cycles",
                    "requested_url": "https://authority.example/cycles",
                    "status": "available",
                    "content_ref": "s3://sources/cycles.txt.gz",
                },
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "Combined answer that must not be copied to every source.",
            [
                ResearchCitation(
                    "https://authority.example/warranty",
                    "Warranty",
                    "Battery warranties commonly cover ten years.",
                ),
                ResearchCitation(
                    "https://authority.example/cycles",
                    "Cycles",
                    "Cycle limits vary by product and warranty terms.",
                ),
            ],
            "responses",
            "research-model",
        )

    monkeypatch.setattr(collection.ResearchGateway, "research", research)

    async def read_text(_self: Any, reference: str) -> Any:
        if "warranty" in reference:
            return SimpleNamespace(
                text="Battery warranties commonly cover ten years. Terms still vary."
            )
        return SimpleNamespace(
            text="Cycle limits vary by product and warranty terms. Read the contract."
        )

    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 2)
    assert [item["summary"]["research_claim"] for item in repo.sources] == [
        "Battery warranties commonly cover ten years.",
        "Cycle limits vary by product and warranty terms.",
    ]
    assert [item["metadata"]["verification_status"] for item in repo.sources] == [
        "verified",
        "verified",
    ]
    assert repo.sources[0]["summary"]["research_excerpt"] == (
        "Battery warranties commonly cover ten years."
    )


def test_featured_snippet_candidate_does_not_skip_web_research(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeSourceRepository()
    repo.sources.append(
        {
            "source_type": "authority",
            "url": "https://snippet.example/answer",
            "status": "available",
            "summary": {"research_excerpt": "A search result excerpt."},
            "metadata": {
                "source": "featured_snippet",
                "verification_status": "candidate_only",
            },
        }
    )
    calls = 0

    async def research(*_: Any, **__: Any) -> ResearchResult:
        nonlocal calls
        calls += 1
        return ResearchResult(
            "supported answer",
            [
                ResearchCitation(
                    "https://agency.gov/report",
                    "Report",
                    "The agency published the report.",
                )
            ],
            "responses",
            "research-model",
        )

    async def verify(*_: Any, **__: Any) -> list[tuple[ResearchCitation, dict[str, Any]]]:
        citation = ResearchCitation(
            "https://agency.gov/report",
            "Report",
            "The agency published the report.",
        )
        return [
            (
                citation,
                {
                    "source_tier": "tier_1_official_public_or_standards",
                    "verification_status": "verified",
                    "verification_method": "page_text_match_v1",
                    "research_excerpt": "The agency published the report.",
                    "verified_url": citation.url,
                },
            )
        ]

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection, "_verify_research_sources", verify)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert calls == 1
    assert outcome == (None, 1)
    assert any(
        item["metadata"].get("source") == "web_research" for item in repo.sources
    )


def test_research_source_verification_keeps_citation_when_body_crawl_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": "https://agency.gov/report",
                    "requested_url": "https://agency.gov/report",
                    "status": "available",
                    "content_ref": "s3://sources/report.txt.gz",
                },
                {
                    "url": "https://broken.example/report",
                    "requested_url": "https://broken.example/report",
                    "status": "failed",
                    "content_ref": None,
                },
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "candidate evidence",
            [
                ResearchCitation(
                    "https://agency.gov/report",
                    "Report",
                    "The 2025 survey found 43% adoption among US households.",
                ),
                ResearchCitation(
                    "https://broken.example/report",
                    "Broken",
                    "The program began in 2024.",
                ),
            ],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(
            text="The 2025 survey found 43% adoption among US households."
        )

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 2)
    assert [item["metadata"]["verification_status"] for item in repo.sources] == [
        "verified",
        "unreachable",
    ]
    assert [item["status"] for item in repo.sources] == ["available", "available"]
    assert repo.sources[1]["metadata"]["independent_source"] is False
    assert repo.sources[1]["summary"]["research_answer"] == "candidate evidence"
    assert repo.sources[1]["summary"]["research_excerpt"] == ""
    assert repo.sources[1]["summary"]["research_claim"] == "The program began in 2024."
    assert repo.sources[1]["metadata"]["crawler"]["status"] == "failed"


def test_duplicate_evidence_is_marked_as_one_echo_cluster(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
                return [
                    {
                        "url": "https://first.gov/report",
                        "requested_url": "https://first.gov/report",
                        "status": "available",
                        "content_ref": "s3://sources/first.txt.gz",
                    },
                    {
                        "url": "https://second.gov/report",
                        "requested_url": "https://second.gov/report",
                        "status": "available",
                        "content_ref": "s3://sources/second.txt.gz",
                },
            ]

    repo = Repository()
    claim = "The 2025 survey found 43% adoption among US households."

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "candidate evidence",
            [
                ResearchCitation("https://first.gov/report", "First", claim),
                ResearchCitation("https://second.gov/report", "Second", claim),
            ],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(text=claim)

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 2)
    assert [item["metadata"]["verification_status"] for item in repo.sources] == [
        "verified",
        "echo_duplicate",
    ]
    assert repo.sources[0]["metadata"]["echo_cluster_id"] == (
        repo.sources[1]["metadata"]["echo_cluster_id"]
    )


def test_unsourced_numeric_explainer_remains_available_for_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cited_url = "https://blog.example/adoption-statistics"
    claim = "The 2025 survey found 43% adoption among US households."

    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": cited_url,
                    "requested_url": cited_url,
                    "status": "available",
                    "content_ref": "s3://sources/blog.txt.gz",
                    "outbound_links": [],
                }
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            claim,
            [ResearchCitation(cited_url, "Statistics roundup", claim)],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(text=claim)

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert repo.sources[0]["status"] == "available"
    assert repo.sources[0]["metadata"]["verification_status"] == "rejected_source"
    assert repo.sources[0]["metadata"]["source_rejection_reason"] == (
        "missing_source_trail"
    )


def test_claims_from_multiple_recaps_merge_under_one_verified_upstream_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_cited = "https://news-one.example/energy-study"
    second_cited = "https://news-two.example/energy-study"
    upstream_url = "https://agency.gov/reports/energy-study"
    first_claim = "The 2025 survey included 2,000 US households."
    second_claim = "The 2025 survey found 43% adoption among US households."

    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            phase = "cited" if len(urls) == 2 else "upstream"
            return SimpleNamespace(run_id=phase, status="completed"), {}

        async def list_competitor_pages(self, run_id: str) -> list[dict[str, Any]]:
            if run_id == "cited":
                return [
                    {
                        "url": url,
                        "requested_url": url,
                        "status": "available",
                        "content_ref": f"s3://sources/cited-{index}.txt.gz",
                        "outbound_links": [
                            {
                                "url": upstream_url,
                                "text": "Original survey report",
                                "placement": "body",
                                "is_internal": False,
                            }
                        ],
                    }
                    for index, url in enumerate((first_cited, second_cited), 1)
                ]
            return [
                {
                    "url": upstream_url,
                    "requested_url": upstream_url,
                    "title": "Energy adoption survey",
                    "status": "available",
                    "content_ref": "s3://sources/upstream.txt.gz",
                    "outbound_links": [],
                }
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "candidate evidence",
            [
                ResearchCitation(first_cited, "First recap", first_claim),
                ResearchCitation(second_cited, "Second recap", second_claim),
            ],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, reference: str) -> Any:
        assert reference == "s3://sources/upstream.txt.gz"
        return SimpleNamespace(text=f"{first_claim} {second_claim}")

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert len(repo.sources) == 1
    assert repo.sources[0]["url"] == upstream_url
    assert repo.sources[0]["metadata"]["cited_urls"] == [first_cited, second_cited]
    assert len(repo.sources[0]["summary"]["verification_claims"]) == 2
    assert first_claim in repo.sources[0]["summary"]["research_claim"]
    assert second_claim in repo.sources[0]["summary"]["research_claim"]


def test_different_claims_sharing_one_page_evidence_are_not_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_url = "https://agency.gov/reports/energy-study"
    first_claim = "The survey included 2,000 households."
    second_claim = "The response rate was 72 percent."
    shared_paragraph = f"{first_claim} {second_claim}"

    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": source_url,
                    "requested_url": source_url,
                    "status": "available",
                    "content_ref": "s3://sources/report.txt.gz",
                    "outbound_links": [],
                }
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "candidate evidence",
            [
                ResearchCitation(source_url, "Report", first_claim, claim=first_claim),
                ResearchCitation(source_url, "Report", second_claim, claim=second_claim),
            ],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(text=shared_paragraph)

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert len(repo.sources) == 1
    assert len(repo.sources[0]["summary"]["verification_claims"]) == 2
    assert first_claim in repo.sources[0]["summary"]["research_claim"]
    assert second_claim in repo.sources[0]["summary"]["research_claim"]


def test_failed_claim_on_same_url_does_not_overwrite_verified_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_url = "https://agency.gov/reports/energy-study"
    verified_claim = "The survey included 2,000 households."
    rejected_claim = "The survey guaranteed a 90 percent outcome."

    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": source_url,
                    "requested_url": source_url,
                    "status": "available",
                    "content_ref": "s3://sources/report.txt.gz",
                    "outbound_links": [],
                }
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "candidate evidence",
            [
                ResearchCitation(
                    source_url,
                    "Report",
                    verified_claim,
                    claim=verified_claim,
                    exact_quote=verified_claim,
                ),
                ResearchCitation(
                    source_url,
                    "Report",
                    rejected_claim,
                    claim=rejected_claim,
                    exact_quote=rejected_claim,
                ),
            ],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(text=verified_claim)

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert len(repo.sources) == 1
    assert repo.sources[0]["status"] == "available"
    assert repo.sources[0]["metadata"]["verification_status"] == "verified"
    assert repo.sources[0]["summary"]["research_excerpt"] == verified_claim
    assert [
        item["status"]
        for item in repo.sources[0]["summary"]["verification_claims"]
    ] == ["verified", "not_found"]


def test_supplemental_unverified_claim_is_kept_with_existing_verified_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_url = "https://agency.gov/reports/energy-study"
    verified_claim = "The survey included 2,000 households."
    rejected_claim = "The survey guaranteed a 90 percent outcome."

    class Repository(FakeUpsertSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": source_url,
                    "requested_url": source_url,
                    "title": "Energy study",
                    "status": "available",
                    "content_ref": "s3://sources/report.txt.gz",
                    "outbound_links": [],
                }
            ]

    results = iter(
        [
            ResearchResult(
                "initial evidence",
                [
                    ResearchCitation(
                        source_url,
                        "Energy study",
                        verified_claim,
                        claim=verified_claim,
                        exact_quote=verified_claim,
                    )
                ],
                "responses",
                "research-model",
            ),
            ResearchResult(
                "supplemental evidence",
                [
                    ResearchCitation(
                        source_url,
                        "Energy study",
                        rejected_claim,
                        claim=rejected_claim,
                        exact_quote=rejected_claim,
                    )
                ],
                "responses",
                "research-model",
            ),
        ]
    )

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return next(results)

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(text=verified_claim)

    repo = Repository()
    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    first_outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )
    supplemental_outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
            ["Does the study guarantee a 90 percent outcome?"],
        )
    )

    assert first_outcome == (None, 1)
    assert supplemental_outcome == (None, 1)
    assert len(repo.sources) == 1
    assert repo.sources[0]["status"] == "available"
    assert repo.sources[0]["metadata"]["verification_status"] == "verified"
    assert {
        (item["claim"], item["status"])
        for item in repo.sources[0]["summary"]["verification_claims"]
    } == {(verified_claim, "verified"), (rejected_claim, "not_found")}


def test_supplemental_verified_claim_is_merged_with_existing_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_url = "https://agency.gov/reports/energy-study"
    first_claim = "The survey included 2,000 households."
    second_claim = "The response rate was 72 percent."

    class Repository(FakeUpsertSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": source_url,
                    "requested_url": source_url,
                    "title": "Energy study",
                    "status": "available",
                    "content_ref": "s3://sources/report.txt.gz",
                    "outbound_links": [],
                }
            ]

    results = iter(
        ResearchResult(
            "candidate evidence",
            [
                ResearchCitation(
                    source_url,
                    "Energy study",
                    claim,
                    claim=claim,
                    exact_quote=claim,
                )
            ],
            "responses",
            "research-model",
        )
        for claim in (first_claim, second_claim)
    )

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return next(results)

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(text=f"{first_claim} {second_claim}")

    repo = Repository()
    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )
    supplemental_outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
            ["What was the survey response rate?"],
        )
    )

    assert supplemental_outcome == (None, 1)
    assert len(repo.sources) == 1
    assert first_claim in repo.sources[0]["summary"]["research_excerpt"]
    assert second_claim in repo.sources[0]["summary"]["research_excerpt"]
    assert {
        (item["claim"], item["status"])
        for item in repo.sources[0]["summary"]["verification_claims"]
    } == {(first_claim, "verified"), (second_claim, "verified")}


def test_third_claim_is_compared_with_every_claim_from_the_same_upstream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    citations = [
        ResearchCitation(
            "https://news-one.example/energy-study",
            "First recap",
            "The 2025 survey included 2,000 US households.",
        ),
        ResearchCitation(
            "https://news-two.example/energy-study",
            "Second recap",
            "The 2025 survey found 43% adoption among US households.",
        ),
        ResearchCitation(
            "https://news-three.example/energy-study",
            "Third recap",
            "The 2025 survey found 43% adoption among US households.",
        ),
    ]
    upstream_url = "https://agency.gov/reports/energy-study"

    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            phase = "cited" if len(urls) == 3 else "upstream"
            return SimpleNamespace(run_id=phase, status="completed"), {}

        async def list_competitor_pages(self, run_id: str) -> list[dict[str, Any]]:
            if run_id == "cited":
                return [
                    {
                        "url": citation.url,
                        "requested_url": citation.url,
                        "status": "available",
                        "content_ref": f"s3://sources/cited-{index}.txt.gz",
                        "outbound_links": [
                            {
                                "url": upstream_url,
                                "text": "Original survey report",
                                "placement": "body",
                                "is_internal": False,
                            }
                        ],
                    }
                    for index, citation in enumerate(citations, 1)
                ]
            return [
                {
                    "url": upstream_url,
                    "requested_url": upstream_url,
                    "status": "available",
                    "content_ref": "s3://sources/upstream.txt.gz",
                    "outbound_links": [],
                }
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "candidate evidence", citations, "responses", "research-model"
        )

    async def read_text(_self: Any, reference: str) -> Any:
        assert reference == "s3://sources/upstream.txt.gz"
        return SimpleNamespace(
            text=" ".join(dict.fromkeys(item.excerpt for item in citations))
        )

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 2)
    assert [item["status"] for item in repo.sources] == ["available", "available"]
    assert repo.sources[0]["url"] == upstream_url
    assert len(repo.sources[0]["summary"]["verification_claims"]) == 2
    assert repo.sources[1]["metadata"]["verification_status"] == "echo_duplicate"
    assert repo.sources[1]["metadata"]["echo_cluster_id"] == (
        repo.sources[0]["metadata"]["echo_cluster_id"]
    )


def test_secondary_source_is_replaced_by_verified_primary_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cited_url = "https://news.example/energy-study"
    upstream_url = "https://agency.gov/reports/energy-study"
    claim = "The 2025 survey found 43% adoption among US households."

    class Repository(FakeSourceRepository):
        def __init__(self) -> None:
            super().__init__()
            self.crawl_requests: list[list[str]] = []

        async def ensure_source_verification_crawl(
            self, _run_id: str, urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            self.crawl_requests.append(list(urls))
            phase = "cited" if urls == [cited_url] else "upstream"
            return SimpleNamespace(run_id=phase, status="completed"), {}

        async def list_competitor_pages(self, run_id: str) -> list[dict[str, Any]]:
            if run_id == "cited":
                return [
                    {
                        "url": cited_url,
                        "requested_url": cited_url,
                        "title": "News recap",
                        "status": "available",
                        "content_ref": "s3://sources/cited.txt.gz",
                        "outbound_links": [
                            {
                                "url": upstream_url,
                                "text": "Read the original survey report",
                                "placement": "body",
                                "is_internal": False,
                            }
                        ],
                    }
                ]
            return [
                {
                    "url": upstream_url,
                    "requested_url": upstream_url,
                    "title": "Energy adoption survey",
                    "status": "available",
                    "content_ref": "s3://sources/upstream.txt.gz",
                    "outbound_links": [],
                }
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            claim,
            [ResearchCitation(cited_url, "News recap", claim)],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, reference: str) -> Any:
        assert reference == "s3://sources/upstream.txt.gz"
        return SimpleNamespace(text=claim)

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert repo.crawl_requests == [[cited_url], [upstream_url]]
    assert repo.sources[0]["url"] == upstream_url
    assert repo.sources[0]["title"] == "Energy adoption survey"
    assert repo.sources[0]["metadata"]["cited_url"] == cited_url
    assert repo.sources[0]["metadata"]["verified_url"] == upstream_url
    assert repo.sources[0]["metadata"]["source_role"] == "primary_upstream"
    assert repo.sources[0]["metadata"]["source_tier"].startswith("tier_1")


def test_unreachable_primary_source_falls_back_to_verified_secondary_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cited_url = "https://news.example/energy-study"
    upstream_url = "https://agency.gov/reports/energy-study"
    claim = "The 2025 survey found 43% adoption among US households."

    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            phase = "cited" if urls == [cited_url] else "upstream"
            return SimpleNamespace(run_id=phase, status="completed"), {}

        async def list_competitor_pages(self, run_id: str) -> list[dict[str, Any]]:
            if run_id == "cited":
                return [
                    {
                        "url": cited_url,
                        "requested_url": cited_url,
                        "title": "News recap",
                        "status": "available",
                        "content_ref": "s3://sources/cited.txt.gz",
                        "outbound_links": [
                            {
                                "url": upstream_url,
                                "text": "Original report",
                                "placement": "body",
                                "is_internal": False,
                            }
                        ],
                    }
                ]
            return [
                {
                    "url": upstream_url,
                    "requested_url": upstream_url,
                    "status": "failed",
                    "content_ref": None,
                    "outbound_links": [],
                }
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            claim,
            [ResearchCitation(cited_url, "News recap", claim)],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, reference: str) -> Any:
        assert reference == "s3://sources/cited.txt.gz"
        return SimpleNamespace(text=claim)

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 1)
    assert repo.sources[0]["url"] == cited_url
    assert repo.sources[0]["metadata"]["source_role"] == "cited_page"
    assert repo.sources[0]["metadata"]["upstream_candidates"] == [upstream_url]


def test_upstream_source_link_selection_prefers_primary_tiers_and_body_links() -> None:
    links = [
        {
            "url": "https://news.example/navigation",
            "text": "Report",
            "placement": "navigation",
            "is_internal": False,
        },
        {
            "url": "https://agency.gov/report",
            "text": "Data",
            "placement": "body",
            "is_internal": False,
        },
        {
            "url": "https://publisher.example/original-study",
            "text": "Original study",
            "placement": "body",
            "is_internal": False,
        },
        {
            "url": "https://unrelated.example/page",
            "text": "More details",
            "placement": "body",
            "is_internal": False,
        },
    ]

    selected = select_upstream_source_links(
        "https://news.example/article", links
    )

    assert selected == [
        "https://agency.gov/report",
        "https://publisher.example/original-study",
    ]


def test_research_source_verification_keeps_diagnostics_without_rejecting_citations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Repository(FakeSourceRepository):
        async def ensure_source_verification_crawl(
            self, _run_id: str, _urls: list[str]
        ) -> tuple[Any, dict[str, Any]]:
            return SimpleNamespace(run_id="verify", status="completed"), {}

        async def list_competitor_pages(self, _run_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "url": "https://agency.gov/report",
                    "requested_url": "https://agency.gov/report",
                    "status": "available",
                    "content_ref": "s3://sources/report.txt.gz",
                },
                {
                    "url": "https://broken.example/report",
                    "requested_url": "https://broken.example/report",
                    "status": "failed",
                    "content_ref": None,
                },
            ]

    repo = Repository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        return ResearchResult(
            "candidate evidence",
            [
                ResearchCitation(
                    "https://agency.gov/report",
                    "Report",
                    "The 2025 survey found that 43% of households adopted batteries.",
                ),
                ResearchCitation(
                    "https://broken.example/report",
                    "Broken",
                    "The program began in 2024.",
                ),
            ],
            "responses",
            "research-model",
        )

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(
            text="The 2025 survey found that 31% of households adopted batteries."
        )

    monkeypatch.setattr(collection.ResearchGateway, "research", research)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == (None, 2)
    assert [item["metadata"]["verification_status"] for item in repo.sources] == [
        "not_found",
        "unreachable",
    ]
    assert [item["status"] for item in repo.sources] == ["available", "available"]
    assert [item["metadata"]["usage_status"] for item in repo.sources] == [
        "collected",
        "collected",
    ]


def test_source_verification_matches_exact_numbers_and_rejects_changed_context() -> None:
    verified = verify_source_claims(
        "The 2025 survey found 43% adoption among US households.",
        "Methods used a US household panel. The 2025 survey found 43% adoption among US households.",
    )
    wrong_year = verify_source_claims(
        "The 2025 survey found 43% adoption among US households.",
        "The 2024 survey found 43% adoption among US households.",
    )
    wrong_geography = verify_source_claims(
        "The 2025 survey found 43% adoption among US households.",
        "The 2025 survey found 43% adoption among UK households.",
    )
    wrong_population = verify_source_claims(
        "The 2025 survey found 43% adoption among US households.",
        "The 2025 survey found 43% adoption among US businesses.",
    )
    wrong_method = verify_source_claims(
        "The 2025 survey found 43% adoption among US households.",
        "The 2025 census found 43% adoption among US households.",
    )

    assert verified.status == "verified"
    assert verified.claims[0].numeric_tokens == ("2025", "43%")
    assert wrong_year.status == "not_found"
    assert wrong_geography.status == "not_found"
    assert wrong_population.status == "not_found"
    assert wrong_method.status == "not_found"
    assert wrong_geography.claims[0].context_mismatches == ("geography:us",)
    assert classify_source_tier("https://agency.gov/report").startswith("tier_1")
    assert classify_source_tier("https://www.reddit.com/r/solar").startswith("tier_4")


def test_source_verification_uses_exact_quote_only_when_it_exists_on_page() -> None:
    claim = "The warranty lasts ten years."
    quote = "The limited warranty period is ten years from installation."

    verified = verify_source_claim_with_quote(
        claim,
        quote,
        f"Warranty terms. {quote} Additional exclusions apply.",
    )
    missing = verify_source_claim_with_quote(
        claim,
        quote,
        "The limited warranty period is five years from installation.",
    )

    assert verified.status == "verified"
    assert verified.method == "page_exact_quote_match_v1"
    assert verified.evidence == quote
    assert verified.claims[0].claim == quote
    assert verified.claims[0].evidence == quote
    assert missing.status == "not_found"


def test_source_verification_does_not_promote_model_paraphrase_over_exact_quote() -> None:
    claim = "The credit is unavailable for property placed in service in 2026."
    quote = (
        "The credit will not be allowed for any property placed in service after "
        "December 31, 2025."
    )

    verified = verify_source_claim_with_quote(claim, quote, f"FAQ answer. {quote}")

    assert verified.status == "verified"
    assert verified.evidence == quote
    assert verified.claims[0].claim == quote
    assert verified.claims[0].numeric_tokens == ("31", "2025.")


def test_source_verification_rejects_opposite_polarity_and_direction() -> None:
    negated = verify_source_claims(
        "The warranty does not cover installation labor.",
        "The warranty covers installation labor.",
    )
    reversed_direction = verify_source_claims(
        "Adoption increased in 2025.",
        "Adoption decreased in 2025.",
    )

    assert negated.status == "not_found"
    assert negated.claims[0].context_mismatches == ("polarity:negation",)
    assert reversed_direction.status == "not_found"
    assert reversed_direction.claims[0].context_mismatches == (
        "direction:increase",
    )


def test_source_verification_processes_all_unique_urls_and_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    citations: list[ResearchCitation] = []
    page_text_by_ref: dict[str, str] = {}
    for index in range(1, 14):
        url = f"https://agency{index}.gov/report"
        claim = f"Official report {index} supports result {index}."
        citations.append(
            ResearchCitation(url, f"Report {index}", claim, claim=claim, exact_quote=claim)
        )
        page_text_by_ref[f"s3://sources/{index}.txt.gz"] = claim
        if index == 1:
            second_claim = "Official report one also supports a second result."
            citations.append(
                ResearchCitation(
                    url,
                    "Report 1",
                    second_claim,
                    claim=second_claim,
                    exact_quote=second_claim,
                )
            )
            page_text_by_ref["s3://sources/1.txt.gz"] += f" {second_claim}"

    crawled_urls: list[str] = []

    async def crawl(
        _repo: Any,
        _settings: Settings,
        _run_id: str,
        urls: list[str],
    ) -> list[dict[str, Any]]:
        crawled_urls.extend(urls)
        return [
            {
                "url": url,
                "requested_url": url,
                "status": "available",
                "content_ref": f"s3://sources/{url.split('agency', 1)[1].split('.', 1)[0]}.txt.gz",
                "outbound_links": [],
            }
            for url in urls
        ]

    async def read_text(_self: Any, reference: str) -> Any:
        return SimpleNamespace(text=page_text_by_ref[reference])

    monkeypatch.setattr(collection, "_crawl_source_verification_pages", crawl)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcomes = asyncio.run(
        collection._verify_research_sources(
            FakeSourceRepository(),  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            ResearchResult("candidate evidence", citations, "responses", "model"),
        )
    )

    assert len(crawled_urls) == 13
    assert len(set(crawled_urls)) == 13
    assert crawled_urls[-1] == "https://agency13.gov/report"
    assert len(outcomes) == 14
    assert any("agency13.gov" in citation.url for citation, _ in outcomes)


def test_authority_verification_retries_missing_pages_with_full_rendering(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    url = "https://dynamic.example/report"
    calls: list[str] = []

    async def crawl(
        _repo: Any,
        _settings: Settings,
        _run_id: str,
        urls: list[str],
        *,
        rendering: str = "auto",
    ) -> list[dict[str, Any]]:
        calls.append(rendering)
        if rendering == "auto":
            return [
                {
                    "url": url,
                    "requested_url": url,
                    "status": "failed",
                    "content_ref": None,
                }
            ]
        return [
            {
                "url": url,
                "requested_url": url,
                "status": "available",
                "content_ref": "s3://sources/dynamic.txt.gz",
                "outbound_links": [],
            }
        ]

    async def read_text(_self: Any, _reference: str) -> Any:
        return SimpleNamespace(text="The dynamic report contains the requested fact.")

    monkeypatch.setattr(collection, "_crawl_source_verification_pages", crawl)
    monkeypatch.setattr(collection.S3TextReader, "read_text", read_text)

    outcomes = asyncio.run(
        collection._verify_research_sources(
            FakeSourceRepository(),  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            ResearchResult(
                "answer",
                [
                    ResearchCitation(
                        url,
                        "Dynamic report",
                        "The dynamic report contains the requested fact.",
                    )
                ],
                "responses",
                "model",
            ),
        )
    )

    assert calls == ["auto", "all"]
    assert outcomes[0][1]["verification_status"] == "verified"


def test_research_collection_degrades_when_primary_and_fallback_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeSourceRepository()

    async def research(*_: Any, **__: Any) -> ResearchResult:
        raise RuntimeError("all research providers unavailable")

    monkeypatch.setattr(collection.ResearchGateway, "research", research)

    outcome = asyncio.run(
        collection._collect_research(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            "run",
            "solar battery",
            {"country": "US", "language": "en"},
        )
    )

    assert outcome == ("research_unavailable", 0)
    assert repo.sources[0]["status"] == "failed"


class FakeCompetitorRepository(FakeSourceRepository):
    def __init__(self, pages: list[dict[str, Any]], crawl_status: str = "completed") -> None:
        super().__init__()
        self.pages = pages
        self.crawl_status = crawl_status
        self.competitor_urls: list[str] = []
        self.competitor_crawls: list[tuple[list[str], str]] = []

    async def ensure_competitor_crawl(
        self, _run_id: str, urls: list[str]
    ) -> tuple[Any, dict[str, Any]]:
        self.competitor_urls = list(urls)
        self.competitor_crawls.append((list(urls), "auto"))
        return (
            SimpleNamespace(
                run_id="crawl",
                status=self.crawl_status,
                temporal_workflow_id="crawler:content_research:crawl",
            ),
            {"run_id": "crawl", "type": "content_research"},
        )

    async def list_competitor_pages(self, _crawl_run_id: str) -> list[dict[str, Any]]:
        return self.pages

    async def ensure_source_verification_crawl(
        self, _run_id: str, urls: list[str], *, rendering: str = "auto"
    ) -> tuple[Any, dict[str, Any]]:
        self.competitor_crawls.append((list(urls), rendering))
        return (
            SimpleNamespace(
                run_id=f"crawl-{len(self.competitor_crawls)}",
                status="completed",
                temporal_workflow_id=f"crawler:source-verification:{len(self.competitor_crawls)}",
            ),
            {
                "run_id": f"crawl-{len(self.competitor_crawls)}",
                "type": "source_verification",
                "rendering": rendering,
            },
        )


class InterruptingCompetitorRepository(FakeCompetitorRepository):
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        super().__init__(pages)
        self.fail_after_first_competitor_write = True
        self.competitor_write_count = 0

    async def upsert_source(self, _run_id: str, **source: Any) -> None:
        if source["source_type"] != "competitor":
            await super().upsert_source(_run_id, **source)
            return

        self.competitor_write_count += 1
        if self.fail_after_first_competitor_write and self.competitor_write_count == 2:
            raise RuntimeError("worker interrupted during competitor source sync")

        existing = next(
            (
                item
                for item in self.sources
                if item["source_type"] == "competitor" and item["url"] == source["url"]
            ),
            None,
        )
        if existing is None:
            self.sources.append(source)
        else:
            existing.update(source)


class ActivityCompetitorRepository(InterruptingCompetitorRepository):
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        super().__init__(pages)
        self.completed: list[dict[str, Any]] = []

    async def get_run_context(self, _run_id: str) -> dict[str, Any]:
        return {
            "run_id": "run",
            "status": "running",
            "primary_keyword": "solar battery",
            "project_snapshot": {"domain": "project.example"},
            "soft_deadline_at": datetime.now(UTC) + timedelta(minutes=5),
            "hard_deadline_at": datetime.now(UTC) + timedelta(minutes=10),
        }

    async def claim_step(
        self, _run_id: str, _step_key: str, _worker_id: str, lease_seconds: int
    ) -> tuple[str, None]:
        assert lease_seconds > 0
        return "claimed", None

    async def set_stage(self, _run_id: str, _step_key: str, _progress: int) -> None:
        return None

    async def complete_step(self, *args: Any, **kwargs: Any) -> None:
        self.completed.append(kwargs)


class PermanentlyFailingCompetitorRepository(ActivityCompetitorRepository):
    async def upsert_source(self, _run_id: str, **source: Any) -> None:
        if source["source_type"] == "competitor" and source["url"].startswith(
            "https://two.example/"
        ):
            self.competitor_write_count += 1
            raise RuntimeError("competitor source database unavailable")
        await super().upsert_source(_run_id, **source)


def competitor_serp_source() -> dict[str, Any]:
    return {
        "source_type": "serp",
        "status": "available",
        "summary": {
            "organic_results": [
                {"url": "https://one.example/article"},
                {"url": "https://two.example/article"},
            ]
        },
    }


def test_serp_reference_results_keep_mixed_content_types_in_result_order() -> None:
    payload = {
        "organic_results": [
            {"url": "https://one.example/tool", "title": "Interactive tool"},
            {"url": "https://two.example/video", "title": "Video result"},
            {"url": "https://three.example/guide", "title": "Written guide"},
        ]
    }
    analysis = {
        "dominant_content_type": "How-To Guide",
        "classified_results": [
            {"url": "https://one.example/tool", "content_type": "Tool"},
            {"url": "https://two.example/video", "content_type": "Video"},
            {"url": "https://three.example/guide", "content_type": "How-To Guide"},
        ],
    }

    results = collection._serp_reference_results(
        payload,
        analysis,
        project_domain="project.example",
        limit=12,
    )

    assert [item["content_type"] for item in results] == [
        "Tool",
        "Video",
        "How-To Guide",
    ]


@pytest.mark.parametrize(
    ("pages", "warning_code", "available", "failed"),
    [
        (
            [
                {
                    "url": "https://one.example/article",
                    "title": "One",
                    "status": "available",
                    "error_type": None,
                    "content_ref": "s3://bucket/one.txt.gz",
                    "word_count": 900,
                },
                {
                    "url": "https://two.example/article",
                    "title": "Two",
                    "status": "failed",
                    "error_type": "timeout",
                    "content_ref": None,
                    "word_count": 0,
                },
            ],
            "competitor_sources_partial",
            1,
            1,
        ),
        (
            [
                {
                    "url": "https://one.example/article",
                    "title": "One",
                    "status": "failed",
                    "error_type": "timeout",
                    "content_ref": None,
                    "word_count": 0,
                }
            ],
            "competitor_sources_unavailable",
            0,
            1,
        ),
    ],
)
def test_competitor_collection_keeps_partial_and_total_failure_warnings(
    pages: list[dict[str, Any]],
    warning_code: str,
    available: int,
    failed: int,
) -> None:
    repo = FakeCompetitorRepository(pages)
    repo.sources.append(competitor_serp_source())

    result = asyncio.run(
        collection.collect_competitors(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            {"run_id": "run", "project_snapshot": {"domain": "project.example"}},
        )
    )

    assert result["summary"] == {"available": available, "failed": failed}
    assert result["warnings"][0]["code"] == warning_code


def test_competitor_collection_uses_later_serp_sources_when_a_body_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages = [
        {
            "url": f"https://source-{index}.example/article",
            "requested_url": f"https://source-{index}.example/article",
            "title": f"Source {index}",
            "status": "available",
            "error_type": None,
            "content_ref": None if index == 1 else f"s3://bucket/source-{index}.txt.gz",
            "word_count": 200 if index == 1 else 800,
        }
        for index in range(1, 13)
    ]
    repo = FakeCompetitorRepository(pages)
    repo.sources.append(
        {
            "source_type": "serp",
            "status": "available",
            "summary": {
                "organic_results": [
                    {
                        "url": f"https://source-{index}.example/article",
                        "content_type": "article",
                    }
                    for index in range(1, 13)
                ],
                "serp_analysis": {
                    "dominant_content_type": "article",
                    "classified_results": [
                        {
                            "url": f"https://source-{index}.example/article",
                            "content_type": "article",
                        }
                        for index in range(1, 13)
                    ],
                },
            },
        }
    )
    result = asyncio.run(
        collection.collect_competitors(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            {"run_id": "run", "project_snapshot": {"domain": "project.example"}},
        )
    )

    stored = {
        source["url"]: source
        for source in repo.sources
        if source["source_type"] == "competitor"
    }
    assert repo.competitor_urls == [
        f"https://source-{index}.example/article" for index in range(1, 13)
    ]
    assert stored["https://source-1.example/article"]["status"] == "failed"
    assert result["summary"] == {"available": 8, "failed": 0}
    assert result["warnings"] == []


def test_competitor_collection_does_not_expand_beyond_reused_serp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_urls = [f"https://initial-{index}.example/article" for index in range(1, 9)]
    pages_by_crawl = {
        "crawl": [
            {
                "url": url,
                "requested_url": url,
                "title": url,
                "status": "available",
                "error_type": None,
                "content_ref": None if index == 1 else f"s3://bucket/initial-{index}.txt.gz",
                "word_count": 200 if index == 1 else 800,
            }
            for index, url in enumerate(initial_urls, 1)
        ],
        "crawl-2": [
            {
                "url": initial_urls[0],
                "requested_url": initial_urls[0],
                "title": "Initial 1 rendered",
                "status": "available",
                "error_type": None,
                "content_ref": None,
                "word_count": 200,
            }
        ],
    }

    class Repo(FakeCompetitorRepository):
        async def list_competitor_pages(self, crawl_run_id: str) -> list[dict[str, Any]]:
            return pages_by_crawl.get(crawl_run_id, [])

    repo = Repo(pages_by_crawl["crawl"])
    repo.sources.append(
        {
            "source_type": "serp",
            "status": "available",
            "summary": {
                "keyword": "live tv streaming sports",
                "organic_results": [{"url": url} for url in initial_urls],
            },
        }
    )

    async def search(*_: Any, **__: Any) -> Any:
        raise AssertionError("competitor collection must reuse the existing SERP")

    monkeypatch.setattr(collection.DataForSEOClient, "search", search)
    result = asyncio.run(
        collection.collect_competitors(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            {
                "run_id": "run",
                "primary_keyword": "live tv streaming sports",
                "project_snapshot": {
                    "domain": "project.example",
                    "country": "South Africa",
                    "language": "en",
                },
            },
        )
    )

    assert result["summary"] == {"available": 7, "failed": 1}
    assert any(rendering == "all" for _, rendering in repo.competitor_crawls)
    assert all(set(urls) <= set(initial_urls) for urls, _ in repo.competitor_crawls)


def test_competitor_activity_retries_partial_source_sync_without_replaying_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages = [
        {
            "url": "https://one.example/article",
            "title": "One",
            "status": "available",
            "error_type": None,
            "content_ref": "s3://bucket/one.txt.gz",
            "word_count": 900,
        },
        {
            "url": "https://two.example/article",
            "title": "Two",
            "status": "available",
            "error_type": None,
            "content_ref": "s3://bucket/two.txt.gz",
            "word_count": 800,
        },
    ]
    repo = ActivityCompetitorRepository(pages)
    repo.sources.append(competitor_serp_source())
    monkeypatch.setattr(content_activities, "repository", lambda: repo)

    result = asyncio.run(
        content_activities.execute_stage(
            {"run_id": "run", "step_key": "competitor_research", "progress": 30}
        )
    )

    competitors = [
        source for source in repo.sources if source["source_type"] == "competitor"
    ]
    assert {source["url"] for source in competitors} == {
        "https://one.example/article",
        "https://two.example/article",
    }
    assert repo.competitor_write_count == 3
    assert result["result"] == {"available": 2, "failed": 0}
    assert result["warnings"] == []
    assert repo.completed[0]["warning_code"] is None


def test_competitor_activity_keeps_partial_sources_when_retry_still_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pages = [
        {
            "url": "https://one.example/article",
            "title": "One",
            "status": "available",
            "error_type": None,
            "content_ref": "s3://bucket/one.txt.gz",
            "word_count": 900,
        },
        {
            "url": "https://two.example/article",
            "title": "Two",
            "status": "available",
            "error_type": None,
            "content_ref": "s3://bucket/two.txt.gz",
            "word_count": 800,
        },
    ]
    repo = PermanentlyFailingCompetitorRepository(pages)
    repo.fail_after_first_competitor_write = False
    repo.sources.append(competitor_serp_source())
    monkeypatch.setattr(content_activities, "repository", lambda: repo)

    result = asyncio.run(
        content_activities.execute_stage(
            {"run_id": "run", "step_key": "competitor_research", "progress": 30}
        )
    )

    competitors = [
        source for source in repo.sources if source["source_type"] == "competitor"
    ]
    assert [source["url"] for source in competitors] == ["https://one.example/article"]
    assert repo.competitor_write_count == 3
    assert result["status"] == "completed"
    assert result["result"] == {"available": 1, "failed": 1}
    assert result["warnings"][0]["code"] == "competitor_sources_partial"
    assert repo.completed[0]["warning_code"] == "competitor_sources_partial"


def test_competitor_collection_degrades_when_crawler_worker_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = FakeCompetitorRepository([], crawl_status="queued")
    repo.sources.append(competitor_serp_source())

    class UnavailableLauncher:
        async def ensure_started(self) -> None:
            raise RuntimeError("crawler worker unavailable")

    monkeypatch.setattr(
        collection, "get_crawler_worker_launcher", lambda: UnavailableLauncher()
    )

    result = asyncio.run(
        collection.collect_competitors(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            {"run_id": "run", "project_snapshot": {"domain": "project.example"}},
        )
    )

    assert result["summary"] == {"available": 0, "failed": 0}
    assert result["warnings"][0]["code"] == "competitor_sources_unavailable"


def test_competitor_collection_crawls_mixed_serp_types_in_result_order() -> None:
    repo = FakeCompetitorRepository([])
    repo.sources.append(
        {
            "source_type": "serp",
            "status": "available",
            "summary": {
                "keyword": "solar battery",
                "organic_results": [
                    {
                        "position": 1,
                        "url": "https://one.example/how-to",
                        "title": "How to Choose a Solar Battery",
                    },
                    {
                        "position": 2,
                        "url": "https://definition.example/article",
                        "title": "What Is a Solar Battery?",
                    },
                    {
                        "position": 3,
                        "url": "https://project.example/tutorial",
                        "title": "Solar Battery Tutorial",
                    },
                    {
                        "position": 4,
                        "url": "https://two.example/guide",
                        "title": "Guide to Solar Batteries",
                    },
                ],
            },
        }
    )

    asyncio.run(
        collection.collect_competitors(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            {
                "run_id": "run",
                "primary_keyword": "solar battery",
                "project_snapshot": {"domain": "project.example"},
            },
        )
    )

    assert repo.competitor_urls == [
        "https://one.example/how-to",
        "https://definition.example/article",
        "https://two.example/guide",
    ]


def test_competitor_redirect_keeps_selected_serp_type_metadata() -> None:
    repo = FakeCompetitorRepository(
        [
            {
                "url": "https://one.example/final-guide/",
                "requested_url": "https://one.example/how-to",
                "title": "Final guide",
                "status": "available",
                "error_type": None,
                "content_ref": "s3://bucket/guide.txt.gz",
                "html_ref": "s3://bucket/guide.html.gz",
                "word_count": 900,
                "h2": ["Choose a battery", "Installation"],
                "h3": ["Compare usable capacity"],
                "headings": [
                    "Choose a battery",
                    "Compare usable capacity",
                    "Installation",
                ],
            }
        ]
    )
    repo.sources.append(
        {
            "source_type": "serp",
            "status": "available",
            "summary": {
                "serp_analysis": {
                    "dominant_content_type": "How-To Guide",
                    "top_results": [
                        {
                            "position": 1,
                            "url": "https://one.example/how-to",
                            "title": "How to Choose a Solar Battery",
                            "content_type": "How-To Guide",
                        }
                    ],
                }
            },
        }
    )

    asyncio.run(
        collection.collect_competitors(
            repo,  # type: ignore[arg-type]
            Settings(app_env="test"),
            {"run_id": "run", "project_snapshot": {"domain": "project.example"}},
        )
    )

    competitor = repo.sources[-1]
    assert competitor["summary"]["serp_position"] == 1
    assert competitor["summary"]["organic_position"] is None
    assert competitor["summary"]["content_type"] == "How-To Guide"
    assert competitor["summary"]["html_ref"] == "s3://bucket/guide.html.gz"
    assert competitor["summary"]["heading_structure"] == [
        {"level": 2, "heading": "Choose a battery"},
        {"level": 3, "heading": "Compare usable capacity"},
        {"level": 2, "heading": "Installation"},
    ]


def test_project_snapshot_warning_is_preserved_on_replay() -> None:
    assert project_snapshot_warnings({"profile_status": "missing"}) == [
        "project_profile_missing"
    ]
    assert project_snapshot_warnings({"profile_status": "incomplete"}) == [
        "project_profile_incomplete"
    ]


def test_project_profile_overrides_take_precedence() -> None:
    profile, status = merge_project_profile(
        SimpleNamespace(
            profile_json={
                "business_name": "Detected",
                "business_type": "Software",
                "products_services": ["SEO platform"],
                "target_audiences": ["Marketing teams"],
                "value_propositions": ["Clear recommendations"],
            },
            user_overrides={"business_name": "Confirmed"},
        )
    )

    assert status == "available"
    assert profile == {
        "business_name": "Confirmed",
        "business_type": "Software",
        "products_services": ["SEO platform"],
        "target_audiences": ["Marketing teams"],
        "value_propositions": ["Clear recommendations"],
    }


def test_missing_and_empty_project_profiles_have_distinct_snapshot_statuses() -> None:
    assert merge_project_profile(None) == ({}, "missing")
    assert merge_project_profile(
        SimpleNamespace(profile_json={}, user_overrides={})
    ) == ({}, "incomplete")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("business_name", "  "),
        ("business_type", ""),
        ("products_services", []),
        ("target_audiences", []),
        ("value_propositions", ["  "]),
    ],
)
def test_project_profile_is_incomplete_when_a_required_field_is_empty(
    field: str, value: object
) -> None:
    profile_json = {
        "business_name": "Example",
        "business_type": "Software",
        "products_services": ["SEO platform"],
        "target_audiences": ["Marketing teams"],
        "value_propositions": ["Clear recommendations"],
    }
    profile_json[field] = value

    profile, status = merge_project_profile(
        SimpleNamespace(profile_json=profile_json, user_overrides={})
    )

    assert profile == profile_json
    assert status == "incomplete"
