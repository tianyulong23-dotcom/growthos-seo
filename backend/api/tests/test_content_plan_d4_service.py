from __future__ import annotations

import asyncio
import os
from collections import Counter
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.dataforseo import (
    DataForSEOEmptyResult,
    DataForSEOError,
    DataForSEOOutcomeUnknown,
    OrganicResult,
    SERPResult,
    SerpTaskReceipt,
)
from app.modules.content_plan.d4_service import (
    ContentPlanD4Service,
    PlanItemConflictError,
    validate_preview_output,
)
from app.modules.content_plan.models import (
    ContentPlanExternalRequest,
    ContentPlanItem,
    ContentPlanPreparation,
)
from app.modules.content_plan.repository import ContentPlanRepository
from app.modules.content_plan.service import AICallResult
from app.modules.projects.models import Project

pytestmark = pytest.mark.anyio


def database_url() -> str:
    value = os.getenv("CONTENT_PLAN_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("CONTENT_PLAN_TEST_DATABASE_URL is required")
    url = make_url(value.replace("postgresql://", "postgresql+asyncpg://", 1))
    if not (url.database or "").startswith("seo_content_plan_d2_test"):
        pytest.fail("Content-plan tests require a dedicated seo_content_plan_d2_test database")
    return url.render_as_string(hide_password=False)


@pytest.fixture
async def d4_database():
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
    project_id = f"content-plan-d4-project-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            Project(
                id=project_id,
                organization_id="content-plan-test-org",
                name="Content plan D4",
                domain=f"{uuid4().hex}.example.test",
                country="US",
                language="en",
            )
        )
        await session.commit()
    repository = ContentPlanRepository(sessions)
    await repository.upsert_settings(
        project_id=project_id,
        cadence="weekly_5",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    try:
        yield repository, sessions, project_id
    finally:
        async with sessions() as session:
            await session.execute(delete(Project).where(Project.id == project_id))
            await session.commit()
        await engine.dispose()


async def create_pack_ready_batch(
    repository: ContentPlanRepository,
    sessions: async_sessionmaker[AsyncSession],
    project_id: str,
):
    suffix = uuid4().hex
    batch = await repository.create_batch(
        batch_id=f"batch-{suffix}",
        organization_id="content-plan-test-org",
        project_id=project_id,
        source="automatic",
        workflow_id=f"workflow-{suffix}",
        idempotency_key=f"request-{suffix}",
        request_hash=f"hash-{suffix}",
        country="US",
        language="en",
        timezone="America/New_York",
    )
    candidates = await repository.save_candidates(
        batch.id,
        [
            {
                "id": f"candidate-{suffix}-{index}",
                "keyword_id": None,
                "keyword": f"seed topic {index:02d}",
                "normalized_keyword": f"seed topic {index:02d}",
                "source_rank": index,
                "priority_score_snapshot": 1000 - index,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
                "selected_plan_order": index,
            }
            for index in range(1, 31)
        ],
    )
    for index, candidate in enumerate(candidates, start=1):
        preparation = await repository.create_preparation(
            preparation_id=f"preparation-{suffix}-{index}",
            batch_id=batch.id,
            candidate_id=candidate.id,
            plan_order=index,
            seed_keyword=candidate.keyword,
            normalized_seed_keyword=candidate.normalized_keyword,
            source_round="initial",
            workflow_id=f"prepare-{suffix}-{index}",
            state="pack_ready",
        )
        primary_id = f"primary-{suffix}-{index}"
        await repository.save_preparation_keywords(
            preparation.id,
            [
                {
                    "id": primary_id,
                    "candidate_id": f"q-primary-{index}",
                    "source": "related",
                    "raw_keyword": f"primary topic {index:02d}",
                    "normalized_keyword": f"primary topic {index:02d}",
                    "provider_position": 1,
                    "search_volume": 100 + index,
                    "keyword_difficulty": 20,
                    "relevance": "same_topic",
                    "keyword_type": "informational",
                    "primary_fit": "strong",
                    "reason_code": "answers_definition",
                    "classifier_version": "classifier-v2",
                    "coverage_status": "uncovered",
                    "selected_role": "primary",
                    "package_position": 1,
                },
                {
                    "id": f"secondary-{suffix}-{index}",
                    "candidate_id": f"q-secondary-{index}",
                    "source": "related",
                    "raw_keyword": f"secondary topic {index:02d}",
                    "normalized_keyword": f"secondary topic {index:02d}",
                    "provider_position": 2,
                    "search_volume": 50 + index,
                    "keyword_difficulty": 10,
                    "relevance": "same_topic",
                    "keyword_type": "informational",
                    "primary_fit": "acceptable",
                    "reason_code": "same_article_subquestion",
                    "classifier_version": "classifier-v2",
                    "coverage_status": "uncovered",
                    "selected_role": "secondary",
                    "package_position": 2,
                },
            ],
        )
        async with sessions() as session:
            await session.execute(
                update(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == preparation.id)
                .values(selected_primary_candidate_id=primary_id)
            )
            await session.commit()
    return batch


class CountingSerpGateway:
    def __init__(
        self,
        *,
        fail_once: set[str] | None = None,
        empty: set[str] | None = None,
        cached: set[str] | None = None,
        invalid_cached_cost: set[str] | None = None,
        paa_only: set[str] | None = None,
        provider_empty: set[str] | None = None,
        outcome_unknown: set[str] | None = None,
    ) -> None:
        self.fail_once = fail_once or set()
        self.empty = empty or set()
        self.cached = cached or set()
        self.invalid_cached_cost = invalid_cached_cost or set()
        self.paa_only = paa_only or set()
        self.provider_empty = provider_empty or set()
        self.outcome_unknown = outcome_unknown or set()
        self.calls: list[str] = []
        self.active = 0
        self.max_active = 0

    async def search(
        self, keyword: str, country: str, language: str, device: str = "desktop"
    ) -> SERPResult:
        self.calls.append(keyword)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0.003)
            if keyword in self.fail_once and self.calls.count(keyword) == 1:
                raise DataForSEOError("temporary_serp_failure")
            if keyword in self.outcome_unknown:
                raise DataForSEOOutcomeUnknown("dataforseo_request_outcome_unknown")
            if keyword in self.provider_empty:
                raise DataForSEOEmptyResult(
                    SERPResult(
                        keyword=keyword,
                        request_cost_usd=0.004,
                        provider_request_id=f"serp-{keyword}",
                        raw_response={"keyword": keyword, "items": []},
                    )
                )
            if keyword in self.empty:
                return SERPResult(keyword=keyword)
            organic_results = (
                []
                if keyword in self.paa_only
                else [
                    OrganicResult(
                        position=index,
                        url=f"https://example.test/{keyword.replace(' ', '-')}/{index}",
                        domain="example.test",
                        title=f"Result {index} for {keyword}",
                        description=f"Description {index}",
                    )
                    for index in range(1, 13)
                ]
            )
            return SERPResult(
                keyword=keyword,
                organic_results=organic_results,
                features=["people_also_ask", "related_searches"],
                people_also_ask=[f"Question {index} about {keyword}?" for index in range(1, 13)],
                related_searches=[f"Related {index} for {keyword}" for index in range(1, 13)],
                cached=keyword in self.cached,
                request_cost_usd=(
                    0.004
                    if keyword in self.invalid_cached_cost
                    else 0
                    if keyword in self.cached
                    else 0.004
                ),
                provider_request_id=None if keyword in self.cached else f"serp-{keyword}",
                raw_response={"keyword": keyword, "raw": True},
            )
        finally:
            self.active -= 1


class StandardSerpGateway:
    def __init__(
        self,
        *,
        submission_unknown_task_id: bool = False,
        submission_error_task_id: bool = False,
        submission_unknown_without_task_id: bool = False,
        ready_after_checks: int | None = None,
    ) -> None:
        self.submissions: list[str] = []
        self.task_keywords: dict[str, str] = {}
        self.submission_unknown_task_id = submission_unknown_task_id
        self.submission_error_task_id = submission_error_task_id
        self.submission_unknown_without_task_id = submission_unknown_without_task_id
        self.ready_after_checks = ready_after_checks
        self.ready_checks = 0

    async def submit_serp_task(
        self,
        keyword: str,
        country: str,
        language: str,
        device: str = "desktop",
        *,
        tag: str,
    ) -> SerpTaskReceipt:
        del country, language, device
        self.submissions.append(keyword)
        task_id = f"standard-task-{len(self.submissions)}"
        self.task_keywords[task_id] = keyword
        if self.submission_unknown_task_id:
            self.submission_unknown_task_id = False
            raise DataForSEOOutcomeUnknown(
                "dataforseo_request_outcome_unknown",
                task_id=task_id,
                cost_usd=0.0035,
            )
        if self.submission_error_task_id:
            self.submission_error_task_id = False
            raise DataForSEOError(
                "dataforseo_task_failed",
                status_code=50301,
                status_message="Temporary provider failure.",
                task_id=task_id,
                cost_usd=0.0035,
                retryable=False,
            )
        if self.submission_unknown_without_task_id:
            self.submission_unknown_without_task_id = False
            raise DataForSEOOutcomeUnknown("dataforseo_request_outcome_unknown")
        return SerpTaskReceipt(
            task_id=task_id,
            tag=tag,
            cost_usd=0.0035,
            status_code=20100,
            status_message="Task Created.",
        )

    async def get_serp_task(self, task_id: str, keyword: str) -> SERPResult:
        assert self.task_keywords[task_id] == keyword
        return SERPResult(
            keyword=keyword,
            organic_results=[
                OrganicResult(
                    position=index,
                    url=f"https://example.test/{keyword.replace(' ', '-')}/{index}",
                    domain="example.test",
                    title=f"Result {index} for {keyword}",
                    description=f"Description {index}",
                )
                for index in range(1, 13)
            ],
            people_also_ask=[f"Question about {keyword}?"],
            related_searches=[f"Related {keyword}"],
            request_cost_usd=0,
            provider_request_id=task_id,
        )

    async def find_ready_serp_task(self, tag: str) -> str | None:
        del tag
        self.ready_checks += 1
        if self.ready_after_checks is None or self.ready_checks < self.ready_after_checks:
            return None
        return next(reversed(self.task_keywords), None)


class PreviewGateway:
    def __init__(
        self,
        *,
        invalid_keywords: set[str] | None = None,
        malformed_once: set[str] | None = None,
    ) -> None:
        self.invalid_keywords = invalid_keywords or set()
        self.malformed_once = malformed_once or set()
        self.calls: list[dict] = []

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
        self.calls.append(
            {
                "primary_keyword": primary_keyword,
                "secondary_keywords": list(secondary_keywords),
                "evidence": evidence,
                "validation_error": validation_error,
            }
        )
        if primary_keyword in self.malformed_once and validation_error is None:
            outputs = []
        else:
            outputs = [
                (
                    {
                        "title": f"Guide to {primary_keyword}",
                        "writing_direction": "H2: Introduction\n1. First section\n2. Second section",
                        "evidence_ids": ["organic-1"],
                        "outline": ["Introduction", "Details"],
                    }
                    if primary_keyword in self.invalid_keywords
                    else {
                        "title": f"Guide to {primary_keyword}",
                        "writing_direction": "Explain the key choices and answer the common questions.",
                        "evidence_ids": [
                            item["evidence_id"]
                            for group in ("organic", "paa", "related_searches")
                            for item in evidence[group][:1]
                        ][:2],
                    }
                )
            ]
        return AICallResult(
            output=outputs,
            provider="test-ai",
            model="preview-v1",
            request_id=f"preview-{len(self.calls)}",
            input_tokens=100,
            output_tokens=30,
            cost_usd=0.001,
        )


def service(
    repository: ContentPlanRepository,
    serp: CountingSerpGateway,
    preview: PreviewGateway,
) -> ContentPlanD4Service:
    return ContentPlanD4Service(
        repository,
        serp_gateway=serp,
        preview_gateway=preview,
        serp_concurrency=5,
        clock=lambda: datetime(2026, 8, 6, 12, tzinfo=UTC),
    )


async def batch_items(
    sessions: async_sessionmaker[AsyncSession], batch_id: str
) -> list[ContentPlanItem]:
    async with sessions() as session:
        return list(
            (
                await session.scalars(
                    select(ContentPlanItem)
                    .where(ContentPlanItem.batch_id == batch_id)
                    .order_by(ContentPlanItem.plan_order)
                )
            ).all()
        )


async def test_d4_queries_only_30_primary_keywords_and_atomically_creates_items(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    serp = CountingSerpGateway(cached={"primary topic 01"})
    preview = PreviewGateway()
    d4 = service(repository, serp, preview)

    result = await d4.run(batch.id)
    first_items = await batch_items(sessions, batch.id)
    replay = await d4.run(batch.id)

    assert result.status == replay.status == "completed"
    assert result.preview_ready_count == result.plan_item_count == 30
    assert [item.plan_order for item in first_items] == list(range(1, 31))
    assert all(item.status == "scheduled" for item in first_items)
    assert all(item.publish_local_date is not None for item in first_items)
    assert min(item.publish_local_date for item in first_items) > date(2026, 8, 6)
    assert len(await batch_items(sessions, batch.id)) == 30
    assert len(serp.calls) == 30
    assert set(serp.calls) == {f"primary topic {index:02d}" for index in range(1, 31)}
    assert not any("secondary" in keyword for keyword in serp.calls)
    assert 2 <= serp.max_active <= 5
    assert len(preview.calls) == 30
    assert all(len(call["evidence"]["organic"]) == 10 for call in preview.calls)
    assert all(len(call["evidence"]["paa"]) == 10 for call in preview.calls)
    assert all(len(call["evidence"]["related_searches"]) == 10 for call in preview.calls)
    cached_bundle = await repository.get_preparation_bundle(
        (await repository.get_current_preparations(batch.id))[0].id
    )
    assert cached_bundle is not None
    assert cached_bundle.serp_snapshots[0].cache_hit is True
    assert float(cached_bundle.serp_snapshots[0].cost_usd) == 0


async def test_d4_retries_only_the_failed_serp_group(d4_database) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    failed_keyword = "primary topic 07"
    serp = CountingSerpGateway(fail_once={failed_keyword})
    preview = PreviewGateway()
    d4 = service(repository, serp, preview)

    first = await d4.run(batch.id)
    assert first.status == "needs_attention"
    assert await batch_items(sessions, batch.id) == []

    second = await d4.run(batch.id)

    assert second.status == "completed"
    assert Counter(serp.calls)[failed_keyword] == 2
    assert all(
        count == (2 if keyword == failed_keyword else 1)
        for keyword, count in Counter(serp.calls).items()
    )
    assert Counter(call["primary_keyword"] for call in preview.calls)[failed_keyword] == 1
    assert len(await batch_items(sessions, batch.id)) == 30
    failed_bundle = await repository.get_preparation_bundle(
        (await repository.get_current_preparations(batch.id))[6].id
    )
    assert failed_bundle is not None
    assert [snapshot.snapshot_version for snapshot in failed_bundle.serp_snapshots] == [2, 1]
    assert [snapshot.is_current for snapshot in failed_bundle.serp_snapshots] == [True, False]
    assert failed_bundle.serp_snapshots[0].error_code is None
    assert failed_bundle.serp_snapshots[1].error_code == "serp_request_failed"


async def test_d4_replaces_unrecoverable_legacy_serp_without_repaying_ready_groups(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    serp = StandardSerpGateway()
    preview = PreviewGateway()
    d4 = service(repository, serp, preview)
    preparations = await repository.get_current_preparations(batch.id)

    for preparation in preparations[:29]:
        result = await d4.process_preparation(preparation.id)
        assert result.success is True

    successful_requests = {}
    for preparation in preparations[:29]:
        request_key = f"serp:{batch.id}:{preparation.id}:1"
        request = await repository.get_external_request(request_key)
        assert request is not None
        successful_requests[request_key] = (
            request.status,
            request.attempt_count,
            float(request.cost_usd),
            list(request.provider_request_ids),
        )

    failed = preparations[29]
    old_request_key = f"serp:{batch.id}:{failed.id}:1"
    await repository.prepare_external_request(
        batch_id=batch.id,
        preparation_id=failed.id,
        plan_item_id=None,
        request_key=old_request_key,
        provider="dataforseo",
        endpoint="serp/google/organic/live/advanced",
        request_hash=d4._hash(
            {
                "keyword": "primary topic 30",
                "country": batch.country,
                "language": batch.language,
                "device": "desktop",
            }
        ),
        round_number=0,
    )
    await repository.claim_external_request(
        old_request_key,
        claim_token="legacy-live-claim",
        lease_until=datetime.now(UTC) - timedelta(seconds=1),
    )
    await repository.fail_external_request(
        old_request_key,
        claim_token="legacy-live-claim",
        status="uncertain",
        error_code="serp_request_outcome_unknown",
        error_detail="legacy Live SERP request cannot be reconciled",
    )
    await repository.set_preparation_state(
        failed.id,
        state="preview_failed",
        error_code="serp_request_outcome_unknown",
        error_detail="legacy Live SERP request cannot be reconciled",
    )

    result = await d4.run(batch.id)

    assert result.status == "completed"
    assert len(await batch_items(sessions, batch.id)) == 30
    assert "primary topic 30" not in serp.submissions
    assert Counter(serp.submissions)["secondary topic 30"] == 1
    assert len(serp.submissions) == 30
    for request_key, expected in successful_requests.items():
        request = await repository.get_external_request(request_key)
        assert request is not None
        assert (
            request.status,
            request.attempt_count,
            float(request.cost_usd),
            list(request.provider_request_ids),
        ) == expected
    old_request = await repository.get_external_request(old_request_key)
    assert old_request is not None
    assert old_request.status == "uncertain"
    assert old_request.attempt_count == 1
    replacement_request = await repository.get_external_request(f"{old_request_key}:package:2")
    assert replacement_request is not None
    assert replacement_request.status == "completed"
    assert replacement_request.attempt_count == 1
    assert float(replacement_request.cost_usd) == 0.0035
    failed_bundle = await repository.get_preparation_bundle(failed.id)
    assert failed_bundle is not None
    assert failed_bundle.preparation.package_version == 2
    assert failed_bundle.preparation.state == "preview_ready"
    assert [
        row.raw_keyword for row in failed_bundle.keywords if row.selected_role == "primary"
    ] == ["secondary topic 30"]


async def test_d4_records_a_task_id_from_an_unknown_standard_post_response(
    d4_database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    serp = StandardSerpGateway(submission_unknown_task_id=True)
    monkeypatch.setattr("app.modules.content_plan.d4_service.asyncio.sleep", AsyncMock())
    d4 = service(repository, serp, PreviewGateway())
    preparation = (await repository.get_current_preparations(batch.id))[0]

    result = await d4.process_preparation(preparation.id)

    assert result.success is True
    assert serp.submissions == ["primary topic 01"]
    request = await repository.get_external_request(f"serp:{batch.id}:{preparation.id}:1")
    assert request is not None
    assert request.status == "completed"
    assert request.attempt_count == 1
    assert request.provider_request_ids == ["standard-task-1"]
    assert float(request.cost_usd) == 0.0035


async def test_d4_records_a_task_id_from_a_standard_post_provider_error(
    d4_database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    serp = StandardSerpGateway(submission_error_task_id=True)
    monkeypatch.setattr("app.modules.content_plan.d4_service.asyncio.sleep", AsyncMock())
    d4 = service(repository, serp, PreviewGateway())
    preparation = (await repository.get_current_preparations(batch.id))[0]

    result = await d4.process_preparation(preparation.id)

    assert result.success is True
    assert serp.submissions == ["primary topic 01"]
    request = await repository.get_external_request(f"serp:{batch.id}:{preparation.id}:1")
    assert request is not None
    assert request.status == "completed"
    assert request.attempt_count == 1
    assert request.provider_request_ids == ["standard-task-1"]
    assert float(request.cost_usd) == 0.0035


async def test_d4_recovers_an_unknown_standard_post_by_tag_without_resubmitting(
    d4_database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    serp = StandardSerpGateway(
        submission_unknown_without_task_id=True,
        ready_after_checks=2,
    )
    monkeypatch.setattr("app.modules.content_plan.d4_service.asyncio.sleep", AsyncMock())
    d4 = service(repository, serp, PreviewGateway())
    preparation = (await repository.get_current_preparations(batch.id))[0]

    result = await d4.process_preparation(preparation.id)

    assert result.success is True
    assert serp.submissions == ["primary topic 01"]
    assert serp.ready_checks == 2
    request = await repository.get_external_request(f"serp:{batch.id}:{preparation.id}:1")
    assert request is not None
    assert request.status == "completed"
    assert request.attempt_count == 1
    assert request.provider_request_ids == ["standard-task-1"]


async def test_d4_keeps_reconciling_an_unknown_standard_post_without_resubmitting(
    d4_database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    serp = StandardSerpGateway(submission_unknown_without_task_id=True)
    monkeypatch.setattr("app.modules.content_plan.d4_service.asyncio.sleep", AsyncMock())
    d4 = service(repository, serp, PreviewGateway())
    preparation = (await repository.get_current_preparations(batch.id))[0]

    first = await d4.process_preparation(preparation.id)
    replay = await d4.process_preparation(preparation.id)

    assert first.success is replay.success is False
    assert first.error_code == replay.error_code == "serp_request_failed"
    assert serp.submissions == ["primary topic 01"]
    request = await repository.get_external_request(f"serp:{batch.id}:{preparation.id}:1")
    assert request is not None
    assert request.status == "uncertain"
    assert request.attempt_count == 1
    assert request.provider_request_ids == []


async def test_d4_empty_serp_promotes_the_next_package_candidate(d4_database) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    empty_keyword = "primary topic 30"
    serp = CountingSerpGateway(empty={empty_keyword})
    preview = PreviewGateway()
    d4 = service(repository, serp, preview)

    first = await d4.run(batch.id)
    replay = await d4.run(batch.id)

    assert first.status == replay.status == "completed"
    assert Counter(serp.calls)[empty_keyword] == 1
    assert Counter(serp.calls)["secondary topic 30"] == 1
    assert len(await batch_items(sessions, batch.id)) == 30
    failed = (await repository.get_current_preparations(batch.id))[-1]
    assert failed.state == "preview_ready"
    assert failed.package_version == 2
    bundle = await repository.get_preparation_bundle(failed.id)
    assert bundle is not None and len(bundle.keywords) == 2
    assert [row.error_code for row in bundle.serp_snapshots] == [
        None,
        "serp_empty_result",
    ]


async def test_d4_provider_empty_result_is_not_retried_as_a_technical_failure(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    empty_keyword = "primary topic 30"
    serp = CountingSerpGateway(provider_empty={empty_keyword})
    d4 = service(repository, serp, PreviewGateway())

    first = await d4.run(batch.id)
    replay = await d4.run(batch.id)

    assert first.status == replay.status == "completed"
    assert Counter(serp.calls)[empty_keyword] == 1
    assert Counter(serp.calls)["secondary topic 30"] == 1
    assert len(await batch_items(sessions, batch.id)) == 30
    failed = (await repository.get_current_preparations(batch.id))[-1]
    assert failed.package_version == 2
    bundle = await repository.get_preparation_bundle(failed.id)
    assert bundle is not None
    charged_snapshot = next(
        row for row in bundle.serp_snapshots if row.error_code == "serp_empty_result"
    )
    assert float(charged_snapshot.cost_usd) == 0.004
    request = await repository.get_external_request(
        f"serp:{batch.id}:{failed.id}:{failed.preparation_version}"
    )
    assert request is not None
    assert request.status == "charged_failed"
    assert float(request.cost_usd) == 0.004
    assert request.provider_request_ids == [f"serp-{empty_keyword}"]
    assert request.response_metadata_json["raw_response"] == {
        "keyword": empty_keyword,
        "items": [],
    }


async def test_d4_stops_only_after_all_eligible_package_candidates_fail(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    failed_keywords = {"primary topic 30", "secondary topic 30"}
    serp = CountingSerpGateway(empty=failed_keywords)
    d4 = service(repository, serp, PreviewGateway())

    first = await d4.run(batch.id)
    replay = await d4.run(batch.id)

    assert first.status == replay.status == "needs_attention"
    assert first.error_code == replay.error_code == "serp_primary_candidates_exhausted"
    assert Counter(serp.calls)["primary topic 30"] == 1
    assert Counter(serp.calls)["secondary topic 30"] == 1
    assert await batch_items(sessions, batch.id) == []
    failed = (await repository.get_current_preparations(batch.id))[-1]
    assert failed.package_version == 2
    assert failed.state == "invalid"
    assert failed.error_code == "serp_primary_candidates_exhausted"
    bundle = await repository.get_preparation_bundle(failed.id)
    assert bundle is not None
    assert all(row.exclusion_reason == "serp_primary_failed" for row in bundle.keywords)


async def test_d4_rejects_outline_after_one_structural_repair(d4_database) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    invalid_keyword = "primary topic 12"
    serp = CountingSerpGateway()
    preview = PreviewGateway(invalid_keywords={invalid_keyword})

    result = await service(repository, serp, preview).run(batch.id)

    assert result.status == "needs_attention"
    calls = [call for call in preview.calls if call["primary_keyword"] == invalid_keyword]
    assert len(calls) == 2
    assert calls[0]["validation_error"] is None
    assert calls[1]["validation_error"] is not None
    assert await batch_items(sessions, batch.id) == []
    failed = (await repository.get_current_preparations(batch.id))[11]
    assert failed.state == "preview_failed"
    bundle = await repository.get_preparation_bundle(failed.id)
    assert bundle is not None
    assert bundle.serp_snapshots[0].error_code == "preview_contract_invalid"


async def test_d4_repairs_a_malformed_preview_response_once(d4_database) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    keyword = "primary topic 09"
    preview = PreviewGateway(malformed_once={keyword})

    result = await service(repository, CountingSerpGateway(), preview).run(batch.id)

    assert result.status == "completed"
    calls = [call for call in preview.calls if call["primary_keyword"] == keyword]
    assert len(calls) == 2
    assert calls[0]["validation_error"] is None
    assert calls[1]["validation_error"] == ("preview response must contain exactly one object")
    assert len(await batch_items(sessions, batch.id)) == 30


async def test_d4_replays_paid_results_after_crash_before_snapshot_save(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    serp = CountingSerpGateway()
    preview = PreviewGateway()
    d4 = service(repository, serp, preview)
    original = repository.add_serp_snapshot
    crashed = False

    async def crash_once(**kwargs):
        nonlocal crashed
        if kwargs["primary_keyword"] == "primary topic 07" and not crashed:
            crashed = True
            raise RuntimeError("crash after paid responses")
        return await original(**kwargs)

    repository.add_serp_snapshot = crash_once
    with pytest.raises(RuntimeError, match="crash after paid responses"):
        await d4.run(batch.id)
    serp_calls = Counter(serp.calls)
    preview_calls = Counter(call["primary_keyword"] for call in preview.calls)

    repository.add_serp_snapshot = original
    result = await d4.run(batch.id)

    assert result.status == "completed"
    assert Counter(serp.calls) == serp_calls
    assert Counter(call["primary_keyword"] for call in preview.calls) == preview_calls
    assert len(await batch_items(sessions, batch.id)) == 30


async def test_atomic_creation_rolls_back_when_one_preparation_is_incomplete(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    result = await service(repository, CountingSerpGateway(), PreviewGateway()).run(batch.id)
    assert result.status == "completed"

    async with sessions() as session:
        await session.execute(delete(ContentPlanItem).where(ContentPlanItem.batch_id == batch.id))
        await session.execute(
            update(ContentPlanPreparation)
            .where(ContentPlanPreparation.batch_id == batch.id)
            .values(plan_item_id=None)
        )
        last = await session.scalar(
            select(ContentPlanPreparation)
            .where(ContentPlanPreparation.batch_id == batch.id)
            .order_by(ContentPlanPreparation.plan_order.desc())
            .limit(1)
        )
        assert last is not None
        last.current_serp_snapshot_id = None
        await session.commit()

    with pytest.raises(ValueError, match="current SERP snapshot"):
        await repository.create_automatic_plan_items(batch.id)

    assert await batch_items(sessions, batch.id) == []


async def test_d4_marks_batch_for_attention_when_item_validation_fails(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    d4 = service(repository, CountingSerpGateway(), PreviewGateway())
    previews = await d4.build_previews(batch.id)
    assert previews.status == "preview_ready"

    async with sessions() as session:
        last = await session.scalar(
            select(ContentPlanPreparation)
            .where(ContentPlanPreparation.batch_id == batch.id)
            .order_by(ContentPlanPreparation.plan_order.desc())
            .limit(1)
        )
        assert last is not None
        last.current_serp_snapshot_id = None
        await session.commit()

    result = await d4.run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "formal_plan_item_validation_failed"
    assert "current SERP snapshot" in (result.error_detail or "")
    assert await batch_items(sessions, batch.id) == []


async def test_atomic_creation_returns_the_conflicting_active_plan_id(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    await service(repository, CountingSerpGateway(), PreviewGateway()).build_previews(batch.id)
    preparations = await repository.get_current_preparations(batch.id)
    conflict_preparation = preparations[0]
    conflict_snapshot = await repository.get_preparation_bundle(conflict_preparation.id)
    assert conflict_snapshot is not None

    manual = await repository.create_batch(
        batch_id=f"manual-{uuid4().hex}",
        organization_id="content-plan-test-org",
        project_id=project_id,
        source="manual",
        workflow_id=f"manual-workflow-{uuid4().hex}",
        idempotency_key=f"manual-request-{uuid4().hex}",
        request_hash=f"manual-hash-{uuid4().hex}",
        country="US",
        language="en",
        timezone="America/New_York",
    )
    manual_preparation = await repository.create_preparation(
        preparation_id=f"manual-preparation-{uuid4().hex}",
        batch_id=manual.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword=conflict_preparation.seed_keyword,
        normalized_seed_keyword=conflict_preparation.normalized_seed_keyword,
        source_round="manual",
        workflow_id=f"manual-prepare-{uuid4().hex}",
        state="preview_ready",
    )
    manual_snapshot = await repository.add_serp_snapshot(
        snapshot_id=f"manual-serp-{uuid4().hex}",
        preparation_id=manual_preparation.id,
        primary_keyword="manual primary",
        country="US",
        language="en",
        provider="dataforseo",
        request_key=f"manual-serp-request-{uuid4().hex}",
        cache_hit=True,
        cost_usd=0,
        organic_summary=[{"evidence_id": "organic-1", "title": "Manual"}],
        paa=[],
        related_searches=[],
        provisional_title="Manual title",
        provisional_direction="Explain the manual topic.",
    )
    conflict_id = f"conflict-item-{uuid4().hex}"
    await repository.create_plan_item(
        item_id=conflict_id,
        batch_id=manual.id,
        project_id=project_id,
        source="manual",
        seed_keyword=conflict_preparation.seed_keyword,
        normalized_seed_keyword=conflict_preparation.normalized_seed_keyword,
        source_rank=None,
        plan_order=None,
        primary_keyword="manual primary",
        title="Manual title",
        writing_direction="Explain the manual topic.",
        current_preparation_id=manual_preparation.id,
        current_serp_snapshot_id=manual_snapshot.id,
        keywords=[
            {
                "id": f"manual-keyword-{uuid4().hex}",
                "keyword": "manual primary",
                "normalized_keyword": "manual primary",
                "role": "primary",
                "keyword_type": "informational",
                "source": "user",
                "position": 1,
            }
        ],
    )

    with pytest.raises(PlanItemConflictError) as exc_info:
        await repository.create_automatic_plan_items(batch.id)

    assert exc_info.value.conflict_plan_id == conflict_id
    assert await batch_items(sessions, batch.id) == []


async def test_d4_preserves_features_when_serp_has_only_paa_evidence(d4_database) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    keywords = {f"primary topic {index:02d}" for index in range(1, 31)}

    result = await service(
        repository,
        CountingSerpGateway(paa_only=keywords),
        PreviewGateway(),
    ).run(batch.id)

    assert result.status == "completed"
    bundle = await repository.get_preparation_bundle(
        (await repository.get_current_preparations(batch.id))[0].id
    )
    assert bundle is not None
    snapshot = bundle.serp_snapshots[0]
    assert snapshot.organic_summary_json == []
    assert snapshot.serp_features_json == ["people_also_ask", "related_searches"]
    assert len(snapshot.paa_json) == 10


async def test_d4_rejects_cached_serp_with_nonzero_cost(d4_database) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    keyword = "primary topic 04"
    serp = CountingSerpGateway(
        cached={keyword},
        invalid_cached_cost={keyword},
    )

    result = await service(repository, serp, PreviewGateway()).run(batch.id)
    replay = await service(repository, serp, PreviewGateway()).run(batch.id)

    assert result.status == "needs_attention"
    assert result.error_code == "serp_request_outcome_unknown"
    assert replay.status == "completed"
    assert Counter(serp.calls)[keyword] == 1
    assert Counter(serp.calls)["secondary topic 04"] == 1
    assert len(await batch_items(sessions, batch.id)) == 30


async def test_d4_does_not_resubmit_a_serp_request_with_unknown_outcome(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    keyword = "primary topic 04"
    serp = CountingSerpGateway(outcome_unknown={keyword})

    first = await service(repository, serp, PreviewGateway()).run(batch.id)
    replay = await service(repository, serp, PreviewGateway()).run(batch.id)

    assert first.status == replay.status == "completed"
    assert Counter(serp.calls)[keyword] == 1
    assert Counter(serp.calls)["secondary topic 04"] == 1
    async with sessions() as session:
        request = await session.scalar(
            select(ContentPlanExternalRequest).where(
                ContentPlanExternalRequest.batch_id == batch.id,
                ContentPlanExternalRequest.provider == "dataforseo",
                ContentPlanExternalRequest.status == "uncertain",
            )
        )
    assert request is not None
    assert request.error_code == "serp_request_outcome_unknown"
    assert request.attempt_count == 1
    assert len(await batch_items(sessions, batch.id)) == 30


async def test_d4_rejects_29_current_preparations(d4_database) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    async with sessions() as session:
        last = await session.scalar(
            select(ContentPlanPreparation)
            .where(ContentPlanPreparation.batch_id == batch.id)
            .order_by(ContentPlanPreparation.plan_order.desc())
            .limit(1)
        )
        assert last is not None
        await session.delete(last)
        await session.commit()

    with pytest.raises(ValueError, match="exactly 30 current preparations"):
        await service(repository, CountingSerpGateway(), PreviewGateway()).run(batch.id)


async def test_atomic_creation_rejects_an_existing_incomplete_item_set(
    d4_database,
) -> None:
    repository, sessions, project_id = d4_database
    batch = await create_pack_ready_batch(repository, sessions, project_id)
    result = await service(repository, CountingSerpGateway(), PreviewGateway()).run(batch.id)
    assert result.status == "completed"

    async with sessions() as session:
        last_preparation = await session.scalar(
            select(ContentPlanPreparation)
            .where(ContentPlanPreparation.batch_id == batch.id)
            .order_by(ContentPlanPreparation.plan_order.desc())
            .limit(1)
        )
        assert last_preparation is not None
        last_preparation.plan_item_id = None
        await session.execute(
            delete(ContentPlanItem).where(
                ContentPlanItem.batch_id == batch.id,
                ContentPlanItem.plan_order == 30,
            )
        )
        await session.commit()

    with pytest.raises(ValueError, match="incomplete formal plan item set"):
        await repository.create_automatic_plan_items(batch.id)

    assert len(await batch_items(sessions, batch.id)) == 29


@pytest.mark.parametrize(
    "value, error",
    [
        (
            {
                "title": "Valid title",
                "writing_direction": "Explain the topic clearly.",
                "evidence_ids": ["organic-2"],
            },
            "reference this SERP group",
        ),
        (
            {
                "title": "Valid title",
                "writing_direction": "First point. Second point. Third point. Fourth point.",
                "evidence_ids": ["organic-1"],
            },
            "1 to 3 sentences",
        ),
        (
            {
                "title": "Valid title",
                "writing_direction": "x" * 601,
                "evidence_ids": ["organic-1"],
            },
            "1 to 600 characters",
        ),
    ],
)
async def test_preview_contract_rejects_invalid_evidence_and_direction(
    value: dict,
    error: str,
) -> None:
    with pytest.raises(ValueError, match=error):
        validate_preview_output(value, {"organic-1"})
