from unittest.mock import AsyncMock

import pytest
from temporalio.exceptions import ApplicationError

from seo_workers.keywords.activities import KeywordActivities
from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.domain import RawKeyword
from seo_workers.keywords.providers import (
    AIProviderConfig,
    AIResult,
    DataForSEOBilling,
    DataForSEOClient,
    DataForSEOProviderConfig,
    OpenAICompatibleClient,
)
from seo_workers.keywords.repository import (
    KeywordCommitResult,
    ExternalRequestRecord,
    KeywordRepository,
    KeywordRunContext,
    ProfilePollResult,
    StagedKeyword,
)


def approved_initial_filter_payload(candidate_count: int) -> dict[str, list[str]]:
    return {"decisions": ["keep"] * candidate_count}


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
        assert [candidate.keyword for candidate in kwargs["candidates"]] == [
            "solar installation"
        ]
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
    assert any(
        failure.get("source") == "seed_topic_ai"
        for failure in repository.partial_failures
    )
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
async def test_seed_preparation_uses_valid_competitor_only_after_site_sources_are_empty(
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

    result = await activities.prepare_seeds({})

    assert result["competitor_supplemented"] is True
    assert result["competitor_status"] == "confirmed"
    assert result["candidate_count"] == 1
    assert result["selected_topic_count"] == 1


@pytest.mark.anyio
async def test_seed_preparation_uses_valid_competitor_with_usable_site_keywords(
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

    fetch.assert_awaited_once_with({})
    validate.assert_awaited_once_with({})
    assert result["competitor_supplemented"] is True
    assert result["competitor_status"] == "confirmed"
    assert result["candidate_count"] == 3
    assert result["selected_topic_count"] == 3


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
