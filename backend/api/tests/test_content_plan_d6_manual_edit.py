from __future__ import annotations

import asyncio
import os
from collections.abc import Sequence
from datetime import UTC, date, datetime, time
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.dataforseo import DataForSEOError, OrganicResult, SERPResult
from app.modules.content.models import Article
from app.modules.content.repository import ContentRepository
from app.modules.content_plan.d4_service import ContentPlanD4Service
from app.modules.content_plan.d6_service import (
    ContentPlanD6Service,
    ContentPlanWorkflowError,
)
from app.modules.content_plan.models import (
    ContentPlanBatch,
    ContentPlanItem,
    ContentPlanSettings,
)
from app.modules.content_plan.providers import current_content_plan_organization
from app.modules.content_plan.repository import ContentPlanRepository
from app.modules.content_plan.schemas import (
    CreateManualPlanItemRequest,
    UpdateContentPlanItemRequest,
)
from app.modules.content_plan.service import (
    AICallResult,
    BusinessContext,
    ContentPlanD3Service,
    ExpansionResult,
    ExpansionRow,
)
from app.modules.crawling.models import CrawlRun
from app.modules.keywords.schemas import (
    KeywordCoverageBatchRequest,
    KeywordCoverageBatchResponse,
    KeywordCoverageResult,
)
from app.modules.projects.models import Project, SiteProfile

pytestmark = pytest.mark.anyio


def database_url() -> str:
    value = os.getenv("CONTENT_PLAN_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("CONTENT_PLAN_TEST_DATABASE_URL is required")
    url = make_url(value.replace("postgresql://", "postgresql+asyncpg://", 1))
    if not (url.database or "").startswith("seo_content_plan_d2_test"):
        pytest.fail("Content-plan tests require a dedicated seo_content_plan_d2_test database")
    return url.render_as_string(hide_password=False)


class UnusedSeedGateway:
    async def decide(self, *args, **kwargs):
        raise AssertionError("manual preparation must not select a replacement seed")


class ExpansionGateway:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def expand(self, seeds, *, country: str, language: str):
        self.calls.extend(seed.keyword for seed in seeds)
        return [
            ExpansionResult(
                preparation_id=seed.preparation_id,
                status="completed",
                rows=(
                    ExpansionRow(
                        keyword=f"how much does {seed.keyword} cost",
                        provider_position=1,
                        search_volume=500,
                        keyword_difficulty=22,
                    ),
                    ExpansionRow(
                        keyword=f"{seed.keyword} checklist",
                        provider_position=2,
                        search_volume=200,
                        keyword_difficulty=15,
                    ),
                ),
                provider_request_id=f"related-{seed.preparation_id}",
                cost_usd=0.01,
            )
            for seed in seeds
        ]


class ClassificationGateway:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def classify(
        self,
        seed_keyword: str,
        candidates,
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult:
        del business_context, country, language, validation_error
        self.calls.append([row.keyword for row in candidates])
        primary = next(
            (row for row in candidates if row.keyword.startswith("how much")),
            candidates[0],
        )
        secondaries = tuple(
            row.candidate_id for row in candidates if row.candidate_id != primary.candidate_id
        )
        return AICallResult(
            output=[
                {
                    "candidate_id": row.candidate_id,
                    "relevance": "same_topic",
                    "keyword_type": "informational",
                    "primary_fit": "strong" if row is primary else "acceptable",
                    "secondary_candidate_ids": (
                        list(secondaries) if row is primary else []
                    ),
                    "reason_code": "answers_definition",
                }
                for row in candidates
            ],
            provider="test-ai",
            model="classification-v1",
            request_id=f"classification-{len(self.calls)}",
            input_tokens=40,
            output_tokens=20,
            cost_usd=0.001,
        )


class ControllableClassificationGateway(ClassificationGateway):
    def __init__(self) -> None:
        super().__init__()
        self.unrelated: set[str] = set()
        self.types: dict[str, str] = {}
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.pause = False

    async def classify(self, seed_keyword: str, candidates, **kwargs) -> AICallResult:
        if self.pause:
            self.started.set()
            await self.release.wait()
        result = await super().classify(seed_keyword, candidates, **kwargs)
        output = []
        primary_id = candidates[0].candidate_id
        for row in result.output:
            value = dict(row)
            candidate = next(
                candidate
                for candidate in candidates
                if candidate.candidate_id == value["candidate_id"]
            )
            if candidate.keyword in self.unrelated:
                value["relevance"] = "unrelated"
                value["reason_code"] = "different_topic"
                for primary in output:
                    if primary["candidate_id"] == primary_id:
                        primary["secondary_candidate_ids"] = [
                            item
                            for item in primary["secondary_candidate_ids"]
                            if item != candidate.candidate_id
                        ]
            value["keyword_type"] = self.types.get(
                candidate.keyword, value["keyword_type"]
            )
            if value["keyword_type"] != "informational":
                value["primary_fit"] = "ineligible"
            output.append(value)
        return AICallResult(
            output=output,
            provider=result.provider,
            model=result.model,
            request_id=result.request_id,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cost_usd=result.cost_usd,
        )


class OrganizationAwareClassificationGateway(ClassificationGateway):
    def __init__(self) -> None:
        super().__init__()
        self.organizations: list[str] = []

    async def classify(self, seed_keyword: str, candidates, **kwargs) -> AICallResult:
        self.organizations.append(current_content_plan_organization())
        return await super().classify(seed_keyword, candidates, **kwargs)


class FailingOnceClassificationGateway(ClassificationGateway):
    def __init__(self) -> None:
        super().__init__()
        self.failures_remaining = 1

    async def classify(self, seed_keyword: str, candidates, **kwargs) -> AICallResult:
        if self.failures_remaining:
            self.failures_remaining -= 1
            raise RuntimeError("temporary_ai_failure")
        return await super().classify(seed_keyword, candidates, **kwargs)


class UncoveredQuery:
    def __init__(self) -> None:
        self.calls: list[KeywordCoverageBatchRequest] = []

    async def query(self, request: KeywordCoverageBatchRequest):
        self.calls.append(request)
        return KeywordCoverageBatchResponse(
            results=[
                KeywordCoverageResult(
                    request_id=row.request_id,
                    normalized_keyword=row.keyword,
                    status="uncovered",
                )
                for row in request.keywords
            ]
        )


class SerpGateway:
    def __init__(self, *, empty: set[str] | None = None) -> None:
        self.calls: list[str] = []
        self.empty = empty or set()
        self.failures_remaining = 0

    async def search(
        self, keyword: str, country: str, language: str, device: str = "desktop"
    ) -> SERPResult:
        del country, language, device
        self.calls.append(keyword)
        if self.failures_remaining:
            self.failures_remaining -= 1
            raise DataForSEOError("temporary_serp_failure")
        if keyword in self.empty:
            return SERPResult(keyword=keyword)
        return SERPResult(
            keyword=keyword,
            organic_results=[
                OrganicResult(
                    position=1,
                    url="https://example.test/result",
                    domain="example.test",
                    title=f"Result for {keyword}",
                    description="Evidence",
                )
            ],
            people_also_ask=[f"What is {keyword}?"],
            related_searches=[f"{keyword} guide"],
            request_cost_usd=0.004,
            provider_request_id=f"serp-{len(self.calls)}",
        )


class PreviewGateway:
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
        del secondary_keywords, country, language, validation_error
        self.calls.append(primary_keyword)
        evidence_id = evidence["organic"][0]["evidence_id"]
        return AICallResult(
            output=[
                {
                    "title": f"Guide to {primary_keyword}",
                    "writing_direction": "Explain the choices and answer common questions.",
                    "evidence_ids": [evidence_id],
                }
            ],
            provider="test-ai",
            model="preview-v1",
            request_id=f"preview-{len(self.calls)}",
            input_tokens=50,
            output_tokens=20,
            cost_usd=0.001,
        )


class FailingDispatcher:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def dispatch(self, preparation_id: str) -> None:
        self.calls.append(preparation_id)
        raise RuntimeError("temporal_unavailable")


@pytest.fixture
async def d6_database():
    engine = create_async_engine(
        database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform, crawling",
                "app.current_organization_id": "content-plan-test-org",
            }
        },
    )
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    project_id = f"content-plan-d6-project-{uuid4().hex}"
    crawl_id = f"content-plan-d6-crawl-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            Project(
                id=project_id,
                organization_id="content-plan-test-org",
                name="Content plan D6",
                domain=f"{uuid4().hex}.example.test",
                country="US",
                language="en",
            )
        )
        await session.flush()
        session.add(
            CrawlRun(
                run_id=crawl_id,
                organization_id="content-plan-test-org",
                project_id=project_id,
                task_type="site_understanding",
                status="completed",
                config_snapshot={},
                summary={},
            )
        )
        await session.flush()
        session.add(
            SiteProfile(
                project_id=project_id,
                source_run_id=crawl_id,
                profile_json={
                    "business_name": "Detail Lab",
                    "business_type": "local service",
                    "business_summary": "Car detailing service.",
                    "target_audiences": ["car owners"],
                    "products_services": ["car detailing"],
                },
                user_overrides={},
                confidence=0.9,
            )
        )
        session.add(
            ContentPlanSettings(
                project_id=project_id,
                cadence="weekly_5",
                paused=False,
                timezone="America/New_York",
                default_publish_local_time=time(10),
            )
        )
        await session.commit()
    repository = ContentPlanRepository(sessions)
    expansion = ExpansionGateway()
    classification = ClassificationGateway()
    coverage = UncoveredQuery()
    serp = SerpGateway()
    preview = PreviewGateway()
    d3 = ContentPlanD3Service(
        repository,
        seed_gateway=UnusedSeedGateway(),
        expansion_gateway=expansion,
        classification_gateway=classification,
        coverage_query=coverage,
    )
    d4 = ContentPlanD4Service(
        repository,
        serp_gateway=serp,
        preview_gateway=preview,
        clock=lambda: datetime(2026, 8, 6, 12, tzinfo=UTC),
    )
    generated: list[tuple[str, int]] = []

    async def generate_now(item_id: str, version: int) -> None:
        generated.append((item_id, version))

    service = ContentPlanD6Service(
        repository,
        d3_service=d3,
        d4_service=d4,
        generate_now=generate_now,
        clock=lambda: datetime(2026, 8, 6, 12, tzinfo=UTC),
    )
    try:
        yield service, repository, sessions, project_id, expansion, serp, generated
    finally:
        async with sessions() as session:
            await session.execute(delete(Project).where(Project.id == project_id))
            await session.commit()
        await engine.dispose()


async def create_manual_item(d6_database, seed: str = "car detailing"):
    service, repository, _sessions, project_id, _expansion, _serp, _generated = d6_database
    accepted = await service.create_manual(
        "content-plan-test-org",
        project_id,
        CreateManualPlanItemRequest(seed_keyword=seed),
        idempotency_key=f"manual-{uuid4().hex}",
    )
    completed = await service.process_preparation(accepted.preparation_id)
    assert completed.item_id is not None
    bundle = await repository.get_plan_item_bundle(completed.item_id)
    assert bundle is not None
    return bundle


async def create_scheduled_automatic_items(
    repository: ContentPlanRepository,
    project_id: str,
) -> list[ContentPlanItem]:
    suffix = uuid4().hex
    batch = await repository.create_batch(
        batch_id=f"automatic-batch-{suffix}",
        organization_id="content-plan-test-org",
        project_id=project_id,
        source="automatic",
        workflow_id=f"automatic-workflow-{suffix}",
        idempotency_key=f"automatic-request-{suffix}",
        request_hash=f"automatic-hash-{suffix}",
        country="US",
        language="en",
        timezone="America/New_York",
    )
    for index in range(1, 31):
        preparation = await repository.create_preparation(
            preparation_id=f"automatic-preparation-{suffix}-{index}",
            batch_id=batch.id,
            candidate_id=None,
            plan_order=index,
            seed_keyword=f"automatic seed {index:02d}",
            normalized_seed_keyword=f"automatic seed {index:02d}",
            source_round="initial",
            workflow_id=f"automatic-prepare-{suffix}-{index}",
        )
        snapshot = await repository.add_serp_snapshot(
            snapshot_id=f"automatic-serp-{suffix}-{index}",
            preparation_id=preparation.id,
            primary_keyword=f"automatic topic {index:02d}",
            country="US",
            language="en",
            provider="dataforseo",
            request_key=f"automatic-serp-request-{suffix}-{index}",
            cache_hit=True,
            cost_usd=0,
            provisional_title=f"Automatic title {index:02d}",
            provisional_direction="Explain the automatic topic.",
        )
        await repository.create_plan_item(
            item_id=f"automatic-plan-item-{suffix}-{index}",
            batch_id=batch.id,
            project_id=project_id,
            source="automatic",
            seed_keyword=f"automatic seed {index:02d}",
            normalized_seed_keyword=f"automatic seed {index:02d}",
            source_rank=index,
            plan_order=index,
            primary_keyword=f"automatic topic {index:02d}",
            title=f"Automatic title {index:02d}",
            writing_direction="Explain the automatic topic.",
            current_preparation_id=preparation.id,
            current_serp_snapshot_id=snapshot.id,
            keywords=[
                {
                    "id": f"automatic-plan-keyword-{suffix}-{index}",
                    "preparation_keyword_id": None,
                    "keyword_id": None,
                    "keyword": f"automatic topic {index:02d}",
                    "normalized_keyword": f"automatic topic {index:02d}",
                    "role": "primary",
                    "keyword_type": "informational",
                    "source": "related",
                    "position": 1,
                }
            ],
        )
    return await repository.schedule_batch(
        batch.id, now=datetime(2026, 8, 6, 12, tzinfo=UTC)
    )


async def test_manual_item_becomes_31st_without_moving_automatic_plan(
    d6_database,
) -> None:
    service, repository, sessions, project_id, _expansion, _serp, _generated = (
        d6_database
    )
    automatic = await create_scheduled_automatic_items(repository, project_id)
    before = [
        (item.id, item.plan_order, item.publish_local_date, item.status, item.version)
        for item in automatic
    ]

    accepted = await service.create_manual(
        "content-plan-test-org",
        project_id,
        CreateManualPlanItemRequest(seed_keyword="extra detailing topic"),
        idempotency_key="manual-item-31",
    )
    completed = await service.process_preparation(accepted.preparation_id)

    async with sessions() as session:
        stored = list(
            (
                await session.scalars(
                    select(ContentPlanItem)
                    .where(ContentPlanItem.project_id == project_id)
                    .order_by(ContentPlanItem.source, ContentPlanItem.plan_order)
                )
            ).all()
        )
    stored_automatic = [item for item in stored if item.source == "automatic"]
    stored_manual = [item for item in stored if item.source == "manual"]

    assert len(stored) == 31
    assert len(stored_automatic) == 30
    assert [
        (item.id, item.plan_order, item.publish_local_date, item.status, item.version)
        for item in stored_automatic
    ] == before
    assert [item.plan_order for item in stored_automatic] == list(range(1, 31))
    assert len(stored_manual) == 1
    assert stored_manual[0].id == completed.item_id
    assert stored_manual[0].publish_local_date not in {
        item.publish_local_date for item in stored_automatic
    }


async def test_manual_request_is_idempotent_and_runs_the_full_preparation(d6_database) -> None:
    service, repository, sessions, project_id, expansion, serp, _generated = d6_database
    request = CreateManualPlanItemRequest(seed_keyword="car detailing")

    first = await service.create_manual(
        "content-plan-test-org", project_id, request, idempotency_key="manual-one"
    )
    replay = await service.create_manual(
        "content-plan-test-org", project_id, request, idempotency_key="manual-one"
    )

    assert first == replay
    assert expansion.calls == []
    assert serp.calls == []
    completed = await service.process_preparation(first.preparation_id)
    assert completed.status == "completed"
    assert expansion.calls == ["car detailing"]
    assert serp.calls == ["how much does car detailing cost"]
    bundle = await repository.get_plan_item_bundle(completed.item_id)
    assert bundle is not None
    assert bundle.item.source == "manual"
    assert bundle.item.status == "scheduled"
    assert [row.role for row in bundle.keywords] == ["primary", "secondary", "secondary"]
    async with sessions() as session:
        assert await session.scalar(
            select(func.count(ContentPlanBatch.id)).where(
                ContentPlanBatch.project_id == project_id,
                ContentPlanBatch.source == "manual",
            )
        ) == 1
        assert await session.scalar(
            select(func.count(ContentPlanItem.id)).where(
                ContentPlanItem.project_id == project_id
            )
        ) == 1


async def test_manual_retry_resumes_after_d3_without_repeating_paid_calls(
    d6_database,
) -> None:
    service, repository, _sessions, project_id, expansion, serp, _generated = d6_database
    accepted = await service.create_manual(
        "content-plan-test-org",
        project_id,
        CreateManualPlanItemRequest(seed_keyword="paint protection film"),
        idempotency_key="manual-resume-after-d3",
    )
    serp.failures_remaining = 1

    with pytest.raises(ContentPlanWorkflowError) as raised:
        await service.process_preparation(accepted.preparation_id)

    assert raised.value.retryable is True
    failed = await repository.get_preparation_bundle(accepted.preparation_id)
    assert failed is not None
    assert failed.preparation.state == "preview_failed"
    classification = service.d3_service.classification_gateway
    paid_d3_calls = (list(expansion.calls), list(classification.calls))

    completed = await service.process_preparation(accepted.preparation_id)

    assert completed.status == "completed"
    assert (expansion.calls, classification.calls) == paid_d3_calls
    assert serp.calls == [
        "how much does paint protection film cost",
        "how much does paint protection film cost",
    ]


async def test_manual_request_returns_accepted_when_dispatch_fails(
    d6_database,
) -> None:
    service, repository, _sessions, project_id, _expansion, _serp, _generated = (
        d6_database
    )
    dispatcher = FailingDispatcher()
    service.dispatcher = dispatcher

    accepted = await service.create_manual(
        "content-plan-test-org",
        project_id,
        CreateManualPlanItemRequest(seed_keyword="dispatch recovery topic"),
        idempotency_key="manual-dispatch-recovery",
    )

    assert dispatcher.calls == [accepted.preparation_id]
    bundle = await repository.get_preparation_bundle(accepted.preparation_id)
    assert bundle is not None
    assert bundle.preparation.batch_id == accepted.batch_id
    assert bundle.preparation.id == accepted.preparation_id


async def test_concurrent_manual_request_creates_one_batch_and_preparation(
    d6_database,
) -> None:
    service, _repository, sessions, project_id, _expansion, _serp, _generated = (
        d6_database
    )
    request = CreateManualPlanItemRequest(seed_keyword="concurrent detailing")

    first, second = await asyncio.gather(
        service.create_manual(
            "content-plan-test-org", project_id, request, idempotency_key="same-key"
        ),
        service.create_manual(
            "content-plan-test-org", project_id, request, idempotency_key="same-key"
        ),
    )

    assert first == second
    async with sessions() as session:
        assert await session.scalar(
            select(func.count(ContentPlanBatch.id)).where(
                ContentPlanBatch.project_id == project_id,
                ContentPlanBatch.idempotency_key == "same-key",
            )
        ) == 1


async def test_manual_idempotency_key_rejects_different_request_body(
    d6_database,
) -> None:
    service, _repository, _sessions, project_id, _expansion, _serp, _generated = (
        d6_database
    )
    await service.create_manual(
        "content-plan-test-org",
        project_id,
        CreateManualPlanItemRequest(seed_keyword="first request"),
        idempotency_key="reused-key",
    )

    with pytest.raises(ContentPlanWorkflowError) as raised:
        await service.create_manual(
            "content-plan-test-org",
            project_id,
            CreateManualPlanItemRequest(seed_keyword="different request"),
            idempotency_key="reused-key",
        )

    assert raised.value.code == "idempotency_key_conflict"


async def test_manual_conflict_is_rejected_before_paid_expansion(d6_database) -> None:
    service, _repository, _sessions, project_id, expansion, serp, _generated = d6_database
    existing = await create_manual_item(d6_database)
    paid_calls = (list(expansion.calls), list(serp.calls))

    with pytest.raises(ContentPlanWorkflowError) as raised:
        await service.create_manual(
            "content-plan-test-org",
            project_id,
            CreateManualPlanItemRequest(seed_keyword=existing.item.seed_keyword),
            idempotency_key="manual-conflict",
        )

    assert raised.value.code == "plan_keyword_conflict"
    assert raised.value.conflict_id == existing.item.id
    assert (expansion.calls, serp.calls) == paid_calls


async def test_secondary_edit_is_atomic_ordered_and_does_not_query_serp(d6_database) -> None:
    service, repository, _sessions, _project_id, _expansion, serp, _generated = d6_database
    bundle = await create_manual_item(d6_database)
    original = [row.keyword for row in bundle.keywords]
    original_serp_calls = list(serp.calls)

    with pytest.raises(ContentPlanWorkflowError) as raised:
        await service.update_item(
            "content-plan-test-org",
            bundle.item.project_id,
            bundle.item.id,
            UpdateContentPlanItemRequest(
                version=bundle.item.version,
                secondary_keywords=[f"secondary {index}" for index in range(9)],
            ),
        )
    assert raised.value.code == "secondary_keyword_limit_exceeded"
    unchanged = await repository.get_plan_item_bundle(bundle.item.id)
    assert unchanged is not None
    assert [row.keyword for row in unchanged.keywords] == original

    updated = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=unchanged.item.version,
            secondary_keywords=[f"user secondary {index}" for index in range(8)],
        ),
    )
    assert updated.version == unchanged.item.version + 1
    final = await repository.get_plan_item_bundle(bundle.item.id)
    assert final is not None
    assert [row.keyword for row in final.keywords[1:]] == [
        f"user secondary {index}" for index in range(8)
    ]
    assert serp.calls == original_serp_calls


async def test_secondary_edit_rejects_unrelated_keyword_and_keeps_old_package(
    d6_database,
) -> None:
    service, repository, _sessions, _project_id, _expansion, serp, _generated = d6_database
    bundle = await create_manual_item(d6_database)
    original = [row.keyword for row in bundle.keywords]
    original_serp_calls = list(serp.calls)
    gateway = ControllableClassificationGateway()
    gateway.unrelated.add("unrelated accounting software")
    service.d3_service.classification_gateway = gateway

    with pytest.raises(ContentPlanWorkflowError) as raised:
        await service.update_item(
            "content-plan-test-org",
            bundle.item.project_id,
            bundle.item.id,
            UpdateContentPlanItemRequest(
                version=bundle.item.version,
                secondary_keywords=["paint care tips", "unrelated accounting software"],
            ),
        )

    assert raised.value.code == "secondary_keyword_invalid"
    unchanged = await repository.get_plan_item_bundle(bundle.item.id)
    assert unchanged is not None
    assert [row.keyword for row in unchanged.keywords] == original
    assert serp.calls == original_serp_calls


async def test_secondary_edit_saves_ai_keyword_types(d6_database) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, _generated = d6_database
    bundle = await create_manual_item(d6_database)
    gateway = ControllableClassificationGateway()
    gateway.types = {
        "paint protection service": "service",
        "ceramic coating product": "product",
    }
    service.d3_service.classification_gateway = gateway

    await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            secondary_keywords=[
                "paint protection service",
                "ceramic coating product",
            ],
        ),
    )

    stored = await repository.get_plan_item_bundle(bundle.item.id)
    assert stored is not None
    assert [row.keyword_type for row in stored.keywords[1:]] == ["service", "product"]


async def test_secondary_edit_binds_and_resets_organization_context(
    d6_database,
) -> None:
    service, _repository, _sessions, _project_id, _expansion, _serp, _generated = (
        d6_database
    )
    bundle = await create_manual_item(d6_database)
    gateway = OrganizationAwareClassificationGateway()
    service.d3_service.classification_gateway = gateway

    await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            secondary_keywords=["paint care guide"],
        ),
    )

    assert gateway.organizations == ["content-plan-test-org"]
    with pytest.raises(RuntimeError, match="content_plan_organization_not_bound"):
        current_content_plan_organization()


async def test_secondary_edit_can_change_input_after_uncertain_ai_failure(
    d6_database,
) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, _generated = (
        d6_database
    )
    bundle = await create_manual_item(d6_database)
    service.d3_service.classification_gateway = FailingOnceClassificationGateway()

    with pytest.raises(ContentPlanWorkflowError) as failed:
        await service.update_item(
            "content-plan-test-org",
            bundle.item.project_id,
            bundle.item.id,
            UpdateContentPlanItemRequest(
                version=bundle.item.version,
                secondary_keywords=["first paint care guide"],
            ),
        )
    assert failed.value.code == "ai_request_outcome_unknown"

    updated = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            secondary_keywords=["revised paint care guide"],
        ),
    )

    assert updated.version == bundle.item.version + 1
    stored = await repository.get_plan_item_bundle(bundle.item.id)
    assert stored is not None
    assert [row.keyword for row in stored.keywords[1:]] == [
        "revised paint care guide"
    ]


async def test_stale_version_and_schedule_conflict_roll_back(d6_database) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, _generated = d6_database
    first = await create_manual_item(d6_database, "first detailing topic")
    second = await create_manual_item(d6_database, "second detailing topic")

    with pytest.raises(ContentPlanWorkflowError) as stale:
        await service.update_item(
            "content-plan-test-org",
            first.item.project_id,
            first.item.id,
            UpdateContentPlanItemRequest(version=999, title="Stale title"),
        )
    assert stale.value.code == "stale_version"
    assert stale.value.current_version == first.item.version

    with pytest.raises(ContentPlanWorkflowError) as conflict:
        await service.update_item(
            "content-plan-test-org",
            second.item.project_id,
            second.item.id,
            UpdateContentPlanItemRequest(
                version=second.item.version,
                publish_local_date=first.item.publish_local_date,
            ),
        )
    assert conflict.value.code == "schedule_date_conflict"
    assert conflict.value.conflict_id == first.item.id
    unchanged = await repository.get_plan_item_bundle(second.item.id)
    assert unchanged is not None
    assert unchanged.item.publish_local_date == second.item.publish_local_date


async def test_today_or_tomorrow_schedule_triggers_after_commit(d6_database) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, generated = d6_database
    bundle = await create_manual_item(d6_database)
    generated.clear()

    updated = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            publish_local_date=date(2026, 8, 7),
        ),
    )

    assert generated == [(bundle.item.id, updated.version)]
    stored = await repository.get_plan_item_bundle(bundle.item.id)
    assert stored is not None and stored.item.date_user_pinned is True


async def test_repreparation_due_tomorrow_triggers_by_plan_timezone(
    d6_database,
) -> None:
    service, _repository, _sessions, _project_id, _expansion, _serp, generated = (
        d6_database
    )
    bundle = await create_manual_item(d6_database)
    dated = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            publish_local_date=date(2026, 8, 7),
        ),
    )
    generated.clear()
    accepted = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=dated.version,
            primary_keyword="how to protect car paint",
        ),
    )

    completed = await service.process_preparation(accepted.pending_preparation_id)

    assert completed.status == "completed"
    assert generated == [(bundle.item.id, accepted.version + 1)]


async def test_secondary_validation_cannot_overwrite_a_newer_item_version(
    d6_database,
) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, _generated = (
        d6_database
    )
    bundle = await create_manual_item(d6_database)
    old_keywords = [row.keyword for row in bundle.keywords]
    gateway = ControllableClassificationGateway()
    gateway.pause = True
    service.d3_service.classification_gateway = gateway
    pending = asyncio.create_task(
        service.update_item(
            "content-plan-test-org",
            bundle.item.project_id,
            bundle.item.id,
            UpdateContentPlanItemRequest(
                version=bundle.item.version,
                secondary_keywords=["paint care guide"],
            ),
        )
    )
    await gateway.started.wait()
    updated = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            title="Newer title",
        ),
    )
    gateway.release.set()

    with pytest.raises(ContentPlanWorkflowError) as raised:
        await pending

    assert raised.value.code == "stale_version"
    assert raised.value.current_version == updated.version
    stored = await repository.get_plan_item_bundle(bundle.item.id)
    assert stored is not None
    assert [row.keyword for row in stored.keywords] == old_keywords


async def test_primary_edit_reprepares_and_preserves_user_title(d6_database) -> None:
    service, repository, _sessions, _project_id, expansion, serp, _generated = d6_database
    bundle = await create_manual_item(d6_database)
    titled = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(version=bundle.item.version, title="My locked title"),
    )
    expansion_count = len(expansion.calls)

    accepted = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=titled.version,
            primary_keyword="how to protect car paint",
        ),
    )
    assert accepted.edit_state == "repreparing"
    completed = await service.process_preparation(accepted.pending_preparation_id)
    assert completed.status == "completed"
    assert len(expansion.calls) == expansion_count
    assert serp.calls[-1] == "how to protect car paint"
    final = await repository.get_plan_item_bundle(bundle.item.id)
    assert final is not None
    assert final.item.primary_keyword == "how to protect car paint"
    assert final.item.title == "My locked title"
    assert final.item.title_user_edited is True


async def test_primary_edit_returns_accepted_when_dispatch_fails(d6_database) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, _generated = (
        d6_database
    )
    bundle = await create_manual_item(d6_database)
    dispatcher = FailingDispatcher()
    service.dispatcher = dispatcher

    accepted = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            primary_keyword="how to recover a dispatch",
        ),
    )

    assert dispatcher.calls == [accepted.pending_preparation_id]
    stored = await repository.get_plan_item_bundle(bundle.item.id)
    assert stored is not None
    assert stored.item.edit_state == "repreparing"
    assert stored.item.pending_preparation_id == accepted.pending_preparation_id
    assert stored.pending_preparation is not None


async def test_late_preparation_cannot_override_newer_edit(d6_database) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, _generated = d6_database
    bundle = await create_manual_item(d6_database)
    v2 = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            seed_keyword="ceramic coating service",
        ),
    )
    v3 = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=v2.version,
            seed_keyword="paint protection film",
        ),
    )

    with pytest.raises(ContentPlanWorkflowError) as superseded:
        await service.process_preparation(v2.pending_preparation_id)
    assert superseded.value.code == "preparation_superseded"
    await service.process_preparation(v3.pending_preparation_id)
    final = await repository.get_plan_item_bundle(bundle.item.id)
    assert final is not None
    assert final.item.seed_keyword == "paint protection film"


async def test_cancelled_pending_edit_cannot_return_late(d6_database) -> None:
    service, repository, _sessions, _project_id, _expansion, _serp, _generated = d6_database
    bundle = await create_manual_item(d6_database)
    accepted = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            seed_keyword="mobile detailing guide",
        ),
    )
    cancelled = await service.cancel_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        expected_version=accepted.version,
    )
    assert cancelled.status == "cancelled"

    with pytest.raises(ContentPlanWorkflowError) as superseded:
        await service.process_preparation(accepted.pending_preparation_id)
    assert superseded.value.code == "preparation_superseded"
    final = await repository.get_plan_item_bundle(bundle.item.id)
    assert final is not None and final.item.status == "cancelled"


async def test_failed_repreparation_keeps_old_content_and_is_not_claimable(
    d6_database,
) -> None:
    service, repository, sessions, _project_id, _expansion, _serp, _generated = d6_database
    bundle = await create_manual_item(d6_database)
    accepted = await service.update_item(
        "content-plan-test-org",
        bundle.item.project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            primary_keyword="how to fail preview",
        ),
    )
    service.d4_service.serp_gateway.empty.add("how to fail preview")

    failed = await service.process_preparation(accepted.pending_preparation_id)

    assert failed.status == "reprepare_failed"
    final = await repository.get_plan_item_bundle(bundle.item.id)
    assert final is not None
    assert final.item.primary_keyword == bundle.item.primary_keyword
    assert final.item.edit_state == "reprepare_failed"
    async with sessions() as session:
        stored = await session.get(ContentPlanItem, bundle.item.id)
        stored.generation_at = datetime(2026, 8, 5, 12, tzinfo=UTC)
        await session.commit()
    claimed = await ContentRepository(sessions).claim_due_plan_items(
        now=datetime(2026, 8, 6, 12, tzinfo=UTC)
    )
    assert all(item.id != bundle.item.id for item, _organization_id in claimed)


async def test_item_detail_reads_snapshot_pending_edit_and_article_review(
    d6_database,
) -> None:
    service, _repository, sessions, project_id, _expansion, _serp, _generated = (
        d6_database
    )
    bundle = await create_manual_item(d6_database)
    titled = await service.update_item(
        "content-plan-test-org",
        project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=bundle.item.version,
            title="My reviewed title",
        ),
    )
    article_id = f"article-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            Article(
                id=article_id,
                organization_id="content-plan-test-org",
                project_id=project_id,
                plan_item_id=bundle.item.id,
                primary_keyword=bundle.item.primary_keyword,
                title="Generated article",
                status="completed",
                publication_status="publish_ready",
                review_status="pending_review",
                review_version=2,
                publication_blocked_reason="awaiting_review",
            )
        )
        await session.commit()
        stored_item = await session.get(ContentPlanItem, bundle.item.id)
        assert stored_item is not None
        stored_item.article_id = article_id
        await session.commit()

    accepted = await service.update_item(
        "content-plan-test-org",
        project_id,
        bundle.item.id,
        UpdateContentPlanItemRequest(
            version=titled.version,
            primary_keyword="how to protect a detailed car",
        ),
    )
    detail = await service.get_item(
        "content-plan-test-org", project_id, bundle.item.id
    )

    assert detail.title == "My reviewed title"
    assert detail.title_source == "user"
    assert detail.writing_direction_source == "system"
    assert detail.current_serp_snapshot is not None
    assert detail.current_serp_snapshot.id == detail.current_serp_snapshot_id
    assert detail.current_serp_snapshot.provider == "dataforseo"
    assert detail.pending_preparation is not None
    assert detail.pending_preparation.id == accepted.pending_preparation_id
    assert detail.pending_preparation.preparation_version == 2
    assert detail.pending_preparation.state == "expanded"
    assert detail.article_id == article_id
    assert detail.publication_status == "publish_ready"
    assert detail.review_status == "pending_review"
    assert detail.review_version == 2
    assert detail.publication_blocked_reason == "awaiting_review"
