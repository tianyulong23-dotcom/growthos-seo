from __future__ import annotations

import os
from collections.abc import Sequence
from datetime import UTC, datetime, time
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.dataforseo import OrganicResult, SERPResult
from app.modules.content_plan.batch_service import ContentPlanBatchService
from app.modules.content_plan.d4_service import ContentPlanD4Service
from app.modules.content_plan.domain import (
    CandidateClassification,
    ClassificationDecision,
    SeedCandidate,
)
from app.modules.content_plan.models import (
    ContentPlanExternalRequest,
    ContentPlanItem,
    ContentPlanPreparation,
)
from app.modules.content_plan.repository import ContentPlanRepository
from app.modules.content_plan.service import (
    AICallResult,
    BusinessContext,
    ContentPlanD3Service,
    ExpansionResult,
    ExpansionRow,
    ExpansionSeed,
)
from app.modules.keywords.models import Keyword, KeywordBuildRun
from app.modules.keywords.schemas import (
    KeywordCoverageBatchRequest,
    KeywordCoverageBatchResponse,
    KeywordCoverageResult,
)
from app.modules.projects.models import Project

pytestmark = pytest.mark.anyio

BUSINESS_CONTEXT = {
    "business_name": "Acme Analytics",
    "business_type": "B2B SEO software",
    "business_summary": "SEO reporting and content workflow software for agencies.",
    "target_audiences": ["SEO agencies", "in-house SEO teams"],
    "products_services": ["keyword research", "content planning"],
}
EXPECTED_BUSINESS_CONTEXT = BusinessContext(
    business_name="Acme Analytics",
    business_type="B2B SEO software",
    business_summary="SEO reporting and content workflow software for agencies.",
    target_audiences=("SEO agencies", "in-house SEO teams"),
    products_services=("keyword research", "content planning"),
)


def ai_result(output, *, request_id: str) -> AICallResult:
    return AICallResult(
        output=output,
        provider="test-ai",
        model="test-model-v1",
        request_id=request_id,
        input_tokens=100,
        output_tokens=50,
        cost_usd=0.001,
    )


def database_url() -> str:
    value = os.getenv("CONTENT_PLAN_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("CONTENT_PLAN_TEST_DATABASE_URL is required")
    url = make_url(value.replace("postgresql://", "postgresql+asyncpg://", 1))
    if not (url.database or "").startswith("seo_content_plan_d2_test"):
        pytest.fail("Content-plan tests require a dedicated seo_content_plan_d2_test database")
    return url.render_as_string(hide_password=False)


@pytest.fixture
async def d3_database():
    engine = create_async_engine(
        database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform",
                "app.current_organization_id": "content-plan-test-org",
            }
        },
    )
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    project_id = f"content-plan-d3-project-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            Project(
                id=project_id,
                organization_id="content-plan-test-org",
                name="Content plan D3",
                domain=f"{uuid4().hex}.example.test",
                country="US",
                language="en",
            )
        )
        await session.commit()
    try:
        yield ContentPlanRepository(sessions), sessions, project_id
    finally:
        async with sessions() as session:
            await session.execute(delete(Project).where(Project.id == project_id))
            await session.commit()
        await engine.dispose()


async def create_automatic_batch(
    repository: ContentPlanRepository,
    project_id: str,
    *,
    include_business_context: bool = True,
):
    return await repository.create_batch(
        batch_id=f"batch-{uuid4().hex}",
        organization_id="content-plan-test-org",
        project_id=project_id,
        source="automatic",
        workflow_id=f"content-plan-workflow-{uuid4().hex}",
        idempotency_key=f"content-plan-request-{uuid4().hex}",
        request_hash=f"hash-{uuid4().hex}",
        country="US",
        language="en",
        timezone="America/New_York",
        config_snapshot=(
            {"business_context": BUSINESS_CONTEXT} if include_business_context else None
        ),
    )


async def add_keywords(
    sessions: async_sessionmaker[AsyncSession], project_id: str, count: int
) -> None:
    run_id = f"keyword-run-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            KeywordBuildRun(
                id=run_id,
                organization_id="content-plan-test-org",
                project_id=project_id,
                kind="initial",
                round_number=1,
                status="completed",
                stage="completed",
            )
        )
        await session.flush()
        session.add_all(
            [
                Keyword(
                    id=f"keyword-{uuid4().hex}",
                    organization_id="content-plan-test-org",
                    project_id=project_id,
                    country="US",
                    language="en",
                    keyword=f"topic {index:03d}",
                    normalized_keyword=f"topic {index:03d}",
                    priority_score=1000 - index,
                    status="active",
                    review_status="approved",
                    first_build_run_id=run_id,
                    last_build_run_id=run_id,
                )
                for index in range(1, count + 1)
            ]
        )
        await session.commit()


class KeepAllSeedGateway:
    def __init__(self, *, repair_first: bool = False) -> None:
        self.calls: list[tuple[int, int, str | None]] = []
        self.context_calls: list[tuple[BusinessContext, str, str]] = []
        self.repair_first = repair_first

    async def decide(
        self,
        candidates: Sequence[SeedCandidate],
        retained: Sequence[SeedCandidate],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append((len(candidates), len(retained), validation_error))
        self.context_calls.append((business_context, country, language))
        if self.repair_first and len(self.calls) == 1:
            return ai_result([], request_id=f"seed-{len(self.calls)}")
        return ai_result(
            [
                {
                    "keyword_id": candidate.candidate_id,
                    "action": "keep",
                    "same_topic_as": None,
                    "reason": "different article topic",
                }
                for candidate in candidates
            ],
            request_id=f"seed-{len(self.calls)}",
        )


class KeepHalfThenAllSeedGateway(KeepAllSeedGateway):
    async def decide(
        self,
        candidates: Sequence[SeedCandidate],
        retained: Sequence[SeedCandidate],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append((len(candidates), len(retained), validation_error))
        self.context_calls.append((business_context, country, language))
        if not retained:
            representative_id = candidates[0].candidate_id
            output = [
                {
                    "keyword_id": candidate.candidate_id,
                    "action": "keep" if index < 25 else "drop",
                    "same_topic_as": None if index < 25 else representative_id,
                    "reason": "same article topic" if index >= 25 else "different topic",
                }
                for index, candidate in enumerate(candidates)
            ]
        else:
            output = [
                {
                    "keyword_id": candidate.candidate_id,
                    "action": "keep",
                    "same_topic_as": None,
                    "reason": "different article topic",
                }
                for candidate in candidates
            ]
        return ai_result(output, request_id=f"seed-{len(self.calls)}")


class InformationalClassificationGateway:
    def __init__(self, *, repair_first: bool = False) -> None:
        self.calls: list[str | None] = []
        self.context_calls: list[tuple[BusinessContext, str, str]] = []
        self.repair_first = repair_first

    async def classify(
        self,
        seed_keyword: str,
        candidates: Sequence[CandidateClassification],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append(validation_error)
        self.context_calls.append((business_context, country, language))
        if self.repair_first and len(self.calls) == 1:
            return ai_result([], request_id=f"classification-{len(self.calls)}")
        secondary_ids = tuple(candidate.candidate_id for candidate in candidates[1:])
        return ai_result(
            [
                ClassificationDecision(
                    candidate_id=candidate.candidate_id,
                    relevance="same_topic",
                    keyword_type="informational",
                    primary_fit="strong" if index == 0 else "acceptable",
                    secondary_candidate_ids=secondary_ids if index == 0 else (),
                    reason_code="answers_definition",
                )
                for index, candidate in enumerate(candidates)
            ],
            request_id=f"classification-{len(self.calls)}",
        )


class UncoveredQuery:
    def __init__(self, *, unknown_keyword: str | None = None) -> None:
        self.unknown_keyword = unknown_keyword
        self.calls: list[KeywordCoverageBatchRequest] = []

    async def query(self, request: KeywordCoverageBatchRequest) -> KeywordCoverageBatchResponse:
        self.calls.append(request)
        return KeywordCoverageBatchResponse(
            results=[
                KeywordCoverageResult(
                    request_id=item.request_id,
                    normalized_keyword=item.keyword,
                    status=("unknown" if item.keyword == self.unknown_keyword else "uncovered"),
                )
                for item in request.keywords
            ]
        )


class ScriptedExpansionGateway:
    def __init__(self, empty_counts: Sequence[int] = ()) -> None:
        self.empty_counts = list(empty_counts)
        self.calls: list[list[str]] = []

    async def expand(
        self,
        seeds: Sequence[ExpansionSeed],
        *,
        country: str,
        language: str,
    ) -> list[ExpansionResult]:
        self.calls.append([seed.keyword for seed in seeds])
        empty_count = self.empty_counts.pop(0) if self.empty_counts else 0
        return [
            ExpansionResult(
                preparation_id=seed.preparation_id,
                status="completed",
                rows=(
                    ()
                    if index < empty_count
                    else (
                        ExpansionRow(
                            keyword=f"{seed.keyword} guide",
                            provider_position=1,
                            search_volume=100,
                        ),
                    )
                ),
                provider_request_id=f"provider-{len(self.calls)}-{index}",
                cost_usd=0.00012,
            )
            for index, seed in enumerate(seeds)
        ]


class SuccessfulSerpGateway:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def search(
        self, keyword: str, country: str, language: str, device: str = "desktop"
    ) -> SERPResult:
        self.calls.append(keyword)
        return SERPResult(
            keyword=keyword,
            organic_results=[
                OrganicResult(
                    position=1,
                    url=f"https://example.test/{keyword.replace(' ', '-')}",
                    domain="example.test",
                    title=f"Reference for {keyword}",
                    description=f"Useful evidence about {keyword}.",
                )
            ],
            provider_request_id=f"serp-{len(self.calls)}",
            request_cost_usd=0.004,
            raw_response={"keyword": keyword},
        )


class SuccessfulPreviewGateway:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def preview(
        self,
        primary_keyword: str,
        secondary_keywords: Sequence[str],
        *,
        evidence: dict,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append(primary_keyword)
        return ai_result(
            [
                {
                    "title": f"Guide to {primary_keyword}",
                    "writing_direction": (
                        "Explain the topic clearly and answer the main search question."
                    ),
                    "evidence_ids": ["organic-1"],
                }
            ],
            request_id=f"preview-{len(self.calls)}",
        )


class RaisingExpansionGateway(ScriptedExpansionGateway):
    async def expand(
        self,
        seeds: Sequence[ExpansionSeed],
        *,
        country: str,
        language: str,
    ) -> list[ExpansionResult]:
        self.calls.append([seed.keyword for seed in seeds])
        raise TimeoutError("provider outcome is unknown")


class MismatchedExpansionGateway(ScriptedExpansionGateway):
    async def expand(
        self,
        seeds: Sequence[ExpansionSeed],
        *,
        country: str,
        language: str,
    ) -> list[ExpansionResult]:
        results = await super().expand(seeds, country=country, language=language)
        return results[:-1]


class FirstGroupFailureGateway(ScriptedExpansionGateway):
    def __init__(self, status: str) -> None:
        super().__init__()
        self.status = status

    async def expand(
        self,
        seeds: Sequence[ExpansionSeed],
        *,
        country: str,
        language: str,
    ) -> list[ExpansionResult]:
        self.calls.append([seed.keyword for seed in seeds])
        return [
            (
                ExpansionResult(
                    preparation_id=seed.preparation_id,
                    status=self.status,
                    provider_request_id=f"failed-{len(self.calls)}",
                    cost_usd=0.00012 if self.status == "charged_failed" else 0,
                    error_code=self.status,
                    error_detail=self.status,
                )
                if index == 0
                else ExpansionResult(
                    preparation_id=seed.preparation_id,
                    status="completed",
                    rows=(
                        ExpansionRow(
                            keyword=f"{seed.keyword} guide",
                            provider_position=1,
                            search_volume=100,
                        ),
                    ),
                    provider_request_id=f"provider-{len(self.calls)}-{index}",
                    cost_usd=0.00012,
                )
            )
            for index, seed in enumerate(seeds)
        ]


class InvalidSeedGateway(KeepAllSeedGateway):
    async def decide(
        self,
        candidates: Sequence[SeedCandidate],
        retained: Sequence[SeedCandidate],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append((len(candidates), len(retained), validation_error))
        self.context_calls.append((business_context, country, language))
        return ai_result([], request_id=f"seed-invalid-{len(self.calls)}")


class RaisingSeedGateway(KeepAllSeedGateway):
    async def decide(
        self,
        candidates: Sequence[SeedCandidate],
        retained: Sequence[SeedCandidate],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append((len(candidates), len(retained), validation_error))
        self.context_calls.append((business_context, country, language))
        raise TimeoutError("AI provider outcome is unknown")


class InvalidClassificationGateway(InformationalClassificationGateway):
    async def classify(
        self,
        seed_keyword: str,
        candidates: Sequence[CandidateClassification],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append(validation_error)
        self.context_calls.append((business_context, country, language))
        return ai_result([], request_id=f"classification-invalid-{len(self.calls)}")


class InvalidFallbackGateway:
    def __init__(self) -> None:
        self.calls: list[str | None] = []
        self.context_calls: list[BusinessContext] = []

    async def generate(
        self,
        seed_keyword: str,
        *,
        business_context: BusinessContext,
        language: str,
        limit: int,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append(validation_error)
        self.context_calls.append(business_context)
        return ai_result(
            [{"keyword": f"{seed_keyword} long tail"}],
            request_id=f"fallback-invalid-{len(self.calls)}",
        )


class PreferAiClassificationGateway(InformationalClassificationGateway):
    async def classify(
        self,
        seed_keyword: str,
        candidates: Sequence[CandidateClassification],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append(validation_error)
        self.context_calls.append((business_context, country, language))
        has_ai_candidate = any(candidate.source == "ai" for candidate in candidates)
        return ai_result(
            [
                ClassificationDecision(
                    candidate_id=candidate.candidate_id,
                    relevance="same_topic",
                    keyword_type="informational",
                    primary_fit=(
                        "strong"
                        if candidate.source == "ai" or not has_ai_candidate
                        else "ineligible"
                    ),
                    secondary_candidate_ids=(
                        tuple(item.candidate_id for item in candidates[1:])
                        if candidate is candidates[0] and not has_ai_candidate
                        else ()
                    ),
                    reason_code="answers_definition",
                )
                for candidate in candidates
            ],
            request_id=f"classification-{len(self.calls)}",
        )


class CoveredFallbackQuery(UncoveredQuery):
    async def query(self, request: KeywordCoverageBatchRequest) -> KeywordCoverageBatchResponse:
        return KeywordCoverageBatchResponse(
            results=[
                KeywordCoverageResult(
                    request_id=item.request_id,
                    normalized_keyword=item.keyword,
                    status=("covered" if item.keyword.startswith("how to") else "uncovered"),
                    covered_url=(
                        "https://example.test/existing"
                        if item.keyword.startswith("how to")
                        else None
                    ),
                )
                for item in request.keywords
            ]
        )


class RepairingFallbackGateway:
    def __init__(self) -> None:
        self.calls: list[str | None] = []
        self.context_calls: list[BusinessContext] = []

    async def generate(
        self,
        seed_keyword: str,
        *,
        business_context: BusinessContext,
        language: str,
        limit: int,
        validation_error: str | None = None,
    ) -> AICallResult:
        self.calls.append(validation_error)
        self.context_calls.append(business_context)
        if len(self.calls) == 1:
            output = [{"keyword": f"{seed_keyword} long tail"}]
        else:
            output = [
                {
                    "keyword": f"how to understand {seed_keyword}",
                    "generation_reason": "Specific informational angle",
                }
            ]
        return ai_result(output, request_id=f"fallback-{len(self.calls)}")


def service(
    repository: ContentPlanRepository,
    *,
    expansion: ScriptedExpansionGateway,
    coverage: UncoveredQuery | None = None,
    seed: KeepAllSeedGateway | None = None,
    classification: InformationalClassificationGateway | None = None,
    fallback: RepairingFallbackGateway | None = None,
) -> ContentPlanD3Service:
    return ContentPlanD3Service(
        repository,
        seed_gateway=seed or KeepAllSeedGateway(),
        expansion_gateway=expansion,
        classification_gateway=classification or InformationalClassificationGateway(),
        coverage_query=coverage or UncoveredQuery(),
        fallback_gateway=fallback,
    )


async def assert_no_formal_plan_items(
    sessions: async_sessionmaker[AsyncSession], batch_id: str
) -> None:
    async with sessions() as session:
        assert (
            list(
                (
                    await session.scalars(
                        select(ContentPlanItem).where(ContentPlanItem.batch_id == batch_id)
                    )
                ).all()
            )
            == []
        )


async def test_d3_produces_30_packs_and_replay_does_not_repay(d3_database) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 60)
    batch = await create_automatic_batch(repository, project_id)
    expansion = ScriptedExpansionGateway()
    seed = KeepAllSeedGateway(repair_first=True)
    classification = InformationalClassificationGateway(repair_first=True)
    d3 = service(
        repository,
        expansion=expansion,
        seed=seed,
        classification=classification,
    )

    first = await d3.run(batch.id)
    replay = await d3.run(batch.id)

    assert first.status == replay.status == "pack_ready"
    assert first.pack_ready_count == replay.pack_ready_count == 30
    assert [len(call) for call in expansion.calls] == [30]
    assert [call[0] for call in seed.calls[:2]] == [50, 50]
    assert seed.calls[1][2] is not None
    assert classification.calls[0] is None
    assert classification.calls[1] is not None
    assert all(
        context == EXPECTED_BUSINESS_CONTEXT and country == "US" and language == "en"
        for context, country, language in seed.context_calls
    )
    assert all(
        context == EXPECTED_BUSINESS_CONTEXT and country == "US" and language == "en"
        for context, country, language in classification.context_calls
    )
    preparations = await repository.get_current_preparations(batch.id)
    assert len(preparations) == 30
    assert all(row.state == "pack_ready" for row in preparations)
    assert [row.plan_order for row in preparations] == list(range(1, 31))
    async with sessions() as session:
        requests = list(
            (
                await session.scalars(
                    select(ContentPlanExternalRequest).where(
                        ContentPlanExternalRequest.batch_id == batch.id
                    )
                )
            ).all()
        )
    dataforseo_requests = [row for row in requests if row.provider == "dataforseo"]
    ai_requests = [row for row in requests if row.provider == "ai"]
    assert len(dataforseo_requests) == 30
    assert all(row.status == "completed" and row.attempt_count == 1 for row in dataforseo_requests)
    assert len(ai_requests) == 33
    assert all(row.status == "completed" and row.attempt_count == 1 for row in ai_requests)
    assert all(row.cost_usd > 0 for row in ai_requests)
    assert all(len(row.provider_request_ids) == 1 for row in ai_requests)
    assert all(
        {
            "model",
            "prompt_version",
            "input_tokens",
            "output_tokens",
            "cache_hit",
            "structural_attempt",
            "output",
        }
        <= row.response_metadata_json.keys()
        for row in ai_requests
    )
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_automatic_batch_runs_full_persisted_pipeline_and_replay_is_a_noop(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await repository.upsert_settings(
        project_id=project_id,
        cadence="weekly_5",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    await add_keywords(sessions, project_id, 60)
    batch = await create_automatic_batch(repository, project_id)
    seed = KeepAllSeedGateway()
    expansion = ScriptedExpansionGateway()
    classification = InformationalClassificationGateway()
    coverage = UncoveredQuery()
    serp = SuccessfulSerpGateway()
    preview = SuccessfulPreviewGateway()
    batch_service = ContentPlanBatchService(
        repository,
        d3_service=ContentPlanD3Service(
            repository,
            seed_gateway=seed,
            expansion_gateway=expansion,
            classification_gateway=classification,
            coverage_query=coverage,
        ),
        d4_service=ContentPlanD4Service(
            repository,
            serp_gateway=serp,
            preview_gateway=preview,
            serp_concurrency=5,
            clock=lambda: datetime(2026, 8, 7, 12, tzinfo=UTC),
        ),
    )

    first = await batch_service.process_batch(batch.id)
    first_call_counts = {
        "seed": len(seed.calls),
        "expansion": len(expansion.calls),
        "classification": len(classification.calls),
        "coverage": len(coverage.calls),
        "serp": len(serp.calls),
        "preview": len(preview.calls),
    }
    replay = await batch_service.process_batch(batch.id)

    assert (
        first
        == replay
        == {
            "batch_id": batch.id,
            "status": "completed",
            "plan_item_count": 30,
        }
    )
    assert first_call_counts == {
        "seed": 1,
        "expansion": 1,
        "classification": 30,
        "coverage": 32,
        "serp": 30,
        "preview": 30,
    }
    assert [len(call) for call in expansion.calls] == [30]
    assert len(set(serp.calls)) == 30
    assert len(set(preview.calls)) == 30
    assert {
        "seed": len(seed.calls),
        "expansion": len(expansion.calls),
        "classification": len(classification.calls),
        "coverage": len(coverage.calls),
        "serp": len(serp.calls),
        "preview": len(preview.calls),
    } == first_call_counts

    refreshed = await repository.get_batch(batch.id)
    assert refreshed is not None
    assert refreshed.status == "completed"
    assert refreshed.stage == "scheduled"
    async with sessions() as session:
        items = list(
            (
                await session.scalars(
                    select(ContentPlanItem)
                    .where(ContentPlanItem.batch_id == batch.id)
                    .order_by(ContentPlanItem.plan_order)
                )
            ).all()
        )
    assert len(items) == 30
    assert [item.plan_order for item in items] == list(range(1, 31))
    assert all(item.status == "scheduled" for item in items)
    assert all(item.generation_at is not None for item in items)
    assert all(item.publish_local_date is not None for item in items)
    assert len({item.publish_local_date for item in items}) == 30


async def test_d3_refills_only_the_missing_groups_in_two_rounds(d3_database) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 60)
    batch = await create_automatic_batch(repository, project_id)
    expansion = ScriptedExpansionGateway(empty_counts=[3, 1, 0])

    result = await service(repository, expansion=expansion).run(batch.id)

    assert result.status == "pack_ready"
    assert result.pack_ready_count == 30
    assert [len(call) for call in expansion.calls] == [30, 3, 1]
    refreshed = await repository.get_batch(batch.id)
    assert refreshed is not None and refreshed.supplement_round == 2
    preparations = await repository.get_current_preparations(batch.id)
    assert [row.plan_order for row in preparations] == list(range(1, 31))
    assert sum(row.source_round == "refill_1" for row in preparations) == 2
    assert sum(row.source_round == "refill_2" for row in preparations) == 1
    async with sessions() as session:
        history = list(
            (
                await session.scalars(
                    select(ContentPlanPreparation).where(
                        ContentPlanPreparation.batch_id == batch.id
                    )
                )
            ).all()
        )
    assert sum(row.source_round == "refill_1" for row in history) == 3
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_runs_one_repaired_ai_fallback_after_two_failed_refills(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 60)
    batch = await create_automatic_batch(repository, project_id)
    expansion = ScriptedExpansionGateway(empty_counts=[1, 1, 1])
    fallback = RepairingFallbackGateway()

    result = await service(
        repository,
        expansion=expansion,
        fallback=fallback,
    ).run(batch.id)

    assert result.status == "pack_ready"
    assert [len(call) for call in expansion.calls] == [30, 1, 1]
    assert len(fallback.calls) == 2
    assert fallback.calls[0] is None and fallback.calls[1] is not None
    assert fallback.context_calls == [
        EXPECTED_BUSINESS_CONTEXT,
        EXPECTED_BUSINESS_CONTEXT,
    ]
    preparations = await repository.get_current_preparations(batch.id)
    fallback_rows = [row for row in preparations if row.source_round == "ai_fallback"]
    assert len(fallback_rows) == 1 and fallback_rows[0].state == "pack_ready"
    bundle = await repository.get_preparation_bundle(fallback_rows[0].id)
    assert bundle is not None
    assert {row.source for row in bundle.keywords} == {"seed", "ai"}
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_missing_business_context_stops_before_external_calls(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(
        repository,
        project_id,
        include_business_context=False,
    )
    expansion = ScriptedExpansionGateway()
    seed = KeepAllSeedGateway()
    classification = InformationalClassificationGateway()
    coverage = UncoveredQuery()

    result = await service(
        repository,
        expansion=expansion,
        seed=seed,
        classification=classification,
        coverage=coverage,
    ).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "business_context_missing"
    assert seed.calls == []
    assert classification.calls == []
    assert expansion.calls == []
    assert coverage.calls == []
    async with sessions() as session:
        requests = list(
            (
                await session.scalars(
                    select(ContentPlanExternalRequest).where(
                        ContentPlanExternalRequest.batch_id == batch.id
                    )
                )
            ).all()
        )
    assert requests == []
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_does_not_expand_when_candidate_pool_is_short(d3_database) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 29)
    batch = await create_automatic_batch(repository, project_id)
    expansion = ScriptedExpansionGateway()

    result = await service(repository, expansion=expansion).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "candidate_pool_exhausted"
    assert result.missing_count == 1
    assert expansion.calls == []
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_coverage_unknown_does_not_advance_cursor_or_refill_round(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    expansion = ScriptedExpansionGateway()

    result = await service(
        repository,
        expansion=expansion,
        coverage=UncoveredQuery(unknown_keyword="topic 001"),
    ).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "coverage_check_failed"
    refreshed = await repository.get_batch(batch.id)
    assert refreshed is not None
    assert refreshed.candidate_cursor_source_rank == 0
    assert refreshed.supplement_round == 0
    assert expansion.calls == []


async def test_d3_reads_the_next_50_candidate_window_after_deduplication(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 60)
    batch = await create_automatic_batch(repository, project_id)
    expansion = ScriptedExpansionGateway()
    seed = KeepHalfThenAllSeedGateway()

    result = await service(
        repository,
        expansion=expansion,
        seed=seed,
    ).run(batch.id)

    assert result.status == "pack_ready"
    assert [call[:2] for call in seed.calls] == [(50, 0), (10, 25)]
    assert [len(call) for call in expansion.calls] == [30]
    selected = await repository.get_selected_candidates(batch.id)
    assert [row.source_rank for row in selected] == [*range(1, 26), *range(51, 56)]
    await assert_no_formal_plan_items(sessions, batch.id)


@pytest.mark.parametrize(
    "expansion_type",
    [RaisingExpansionGateway, MismatchedExpansionGateway],
)
async def test_d3_unknown_provider_outcome_is_not_submitted_again(
    d3_database,
    expansion_type,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    expansion = expansion_type()
    d3 = service(repository, expansion=expansion)

    first = await d3.run(batch.id)
    replay = await d3.run(batch.id)

    assert first.status == replay.status == "needs_attention"
    assert len(expansion.calls) == 1
    async with sessions() as session:
        requests = list(
            (
                await session.scalars(
                    select(ContentPlanExternalRequest).where(
                        ContentPlanExternalRequest.batch_id == batch.id
                    )
                )
            ).all()
        )
    dataforseo_requests = [row for row in requests if row.provider == "dataforseo"]
    assert len(dataforseo_requests) == 30
    assert all(row.status == "uncertain" for row in dataforseo_requests)
    assert all(row.attempt_count == 1 for row in dataforseo_requests)
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_replays_completed_ai_response_without_calling_model_again(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    seed = KeepAllSeedGateway()
    d3 = service(repository, expansion=ScriptedExpansionGateway(), seed=seed)
    original_save = repository.save_candidate_window_decisions
    failed_once = False

    async def fail_after_ai_response(*args, **kwargs):
        nonlocal failed_once
        if not failed_once:
            failed_once = True
            raise RuntimeError("crash after AI response")
        return await original_save(*args, **kwargs)

    repository.save_candidate_window_decisions = fail_after_ai_response
    with pytest.raises(RuntimeError, match="crash after AI response"):
        await d3.run(batch.id)

    assert len(seed.calls) == 1
    result = await d3.run(batch.id)

    assert result.status == "pack_ready"
    assert len(seed.calls) == 1
    seed_request = await repository.get_external_request(
        f"ai:seed:content-plan-seed-v2:{batch.id}:1:1"
    )
    assert seed_request is not None
    assert seed_request.status == "completed"
    assert seed_request.attempt_count == 1
    assert seed_request.response_metadata_json["model"] == "test-model-v1"
    assert seed_request.response_metadata_json["input_tokens"] == 100
    assert seed_request.response_metadata_json["output_tokens"] == 50
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_unknown_ai_outcome_is_not_submitted_again(d3_database) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    seed = RaisingSeedGateway()
    d3 = service(repository, expansion=ScriptedExpansionGateway(), seed=seed)

    first = await d3.run(batch.id)
    replay = await d3.run(batch.id)

    assert first.status == replay.status == "needs_attention"
    assert first.error_code == replay.error_code == "ai_request_outcome_unknown"
    assert len(seed.calls) == 1
    request = await repository.get_external_request(f"ai:seed:content-plan-seed-v2:{batch.id}:1:1")
    assert request is not None
    assert request.status == "uncertain"
    assert request.attempt_count == 1
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_retryable_request_stops_after_three_submissions(d3_database) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    expansion = FirstGroupFailureGateway("retryable_failed")
    d3 = service(repository, expansion=expansion)

    results = [await d3.run(batch.id) for _attempt in range(4)]

    assert all(result.status == "needs_attention" for result in results)
    assert [len(call) for call in expansion.calls] == [30, 1, 1]
    failed_preparation = (await repository.get_current_preparations(batch.id))[0]
    request = await repository.get_external_request(
        f"related:{batch.id}:0:{failed_preparation.plan_order}:"
        f"{failed_preparation.preparation_version}"
    )
    assert request is not None
    assert request.status == "retryable_failed"
    assert request.attempt_count == 3
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_charged_failure_is_not_submitted_again(d3_database) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    expansion = FirstGroupFailureGateway("charged_failed")
    d3 = service(repository, expansion=expansion)

    first = await d3.run(batch.id)
    replay = await d3.run(batch.id)

    assert first.status == replay.status == "needs_attention"
    assert [len(call) for call in expansion.calls] == [30]
    requests = [
        row
        for row in (await repository.get_external_request(f"related:{batch.id}:0:1:1"),)
        if row is not None
    ]
    assert len(requests) == 1
    assert requests[0].status == "charged_failed"
    assert requests[0].attempt_count == 1
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_seed_contract_stops_after_one_structural_repair(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    seed = InvalidSeedGateway()
    expansion = ScriptedExpansionGateway()

    result = await service(
        repository,
        expansion=expansion,
        seed=seed,
    ).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "seed_decision_contract_invalid"
    assert len(seed.calls) == 2
    assert seed.calls[0][2] is None and seed.calls[1][2] is not None
    assert expansion.calls == []
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_classification_contract_stops_after_one_structural_repair(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 30)
    batch = await create_automatic_batch(repository, project_id)
    classification = InvalidClassificationGateway()

    result = await service(
        repository,
        expansion=ScriptedExpansionGateway(),
        classification=classification,
    ).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "classification_failed"
    assert len(classification.calls) == 60
    assert classification.calls[0] is None
    assert classification.calls[1] is not None
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_fallback_contract_stops_after_one_structural_repair(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 60)
    batch = await create_automatic_batch(repository, project_id)
    fallback = InvalidFallbackGateway()

    result = await service(
        repository,
        expansion=ScriptedExpansionGateway(empty_counts=[1, 1, 1]),
        fallback=fallback,
    ).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "fallback_contract_invalid"
    assert len(fallback.calls) == 2
    assert fallback.calls[0] is None and fallback.calls[1] is not None
    await assert_no_formal_plan_items(sessions, batch.id)


async def test_d3_covered_ai_fallback_keyword_cannot_complete_the_pack(
    d3_database,
) -> None:
    repository, sessions, project_id = d3_database
    await add_keywords(sessions, project_id, 60)
    batch = await create_automatic_batch(repository, project_id)

    result = await service(
        repository,
        expansion=ScriptedExpansionGateway(empty_counts=[1, 1, 1]),
        fallback=RepairingFallbackGateway(),
        coverage=CoveredFallbackQuery(),
        classification=PreferAiClassificationGateway(),
    ).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "pack_shortage"
    preparations = await repository.get_current_preparations(batch.id)
    fallback_rows = [row for row in preparations if row.source_round == "ai_fallback"]
    assert len(fallback_rows) == 1
    assert fallback_rows[0].state == "invalid"
    assert fallback_rows[0].error_code == "primary_keyword_unavailable"
    await assert_no_formal_plan_items(sessions, batch.id)
