from __future__ import annotations

import asyncio
import os
from datetime import UTC, date, datetime, time, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings
from app.modules.content import collection
from app.modules.content.models import (
    Article,
    ArticleReviewDecision,
    ArticleRun,
    ArticleSource,
)
from app.modules.content.repository import ContentRepository
from app.modules.content_plan.models import (
    ContentPlanBatch,
    ContentPlanCandidate,
    ContentPlanExternalRequest,
    ContentPlanItem,
    ContentPlanItemKeyword,
    ContentPlanPreparation,
    ContentPlanPreparationKeyword,
    ContentPlanPreparationRelation,
    ContentPlanSettings,
)
from app.modules.content_plan.repository import (
    ActiveAutomaticBatchError,
    ContentPlanRepository,
)
from app.modules.content_plan.scheduling import make_slot
from app.modules.keywords.models import Keyword, KeywordBuildRun
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
async def repository() -> tuple[ContentPlanRepository, async_sessionmaker[AsyncSession], str]:
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
    project_id = f"content-plan-project-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            Project(
                id=project_id,
                organization_id="content-plan-test-org",
                name="Content plan D2",
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


async def create_batch(
    repository: ContentPlanRepository,
    project_id: str,
    *,
    suffix: str = "1",
    source: str = "automatic",
) -> ContentPlanBatch:
    return await repository.create_batch(
        batch_id=f"batch-{uuid4().hex}",
        organization_id="content-plan-test-org",
        project_id=project_id,
        source=source,
        workflow_id=f"content-plan-workflow-{uuid4().hex}",
        idempotency_key=f"content-plan-request-{suffix}-{uuid4().hex}",
        request_hash=f"hash-{suffix}",
        country="US",
        language="en",
        timezone="America/New_York",
    )


async def create_keyword_build_run(
    sessions: async_sessionmaker[AsyncSession], project_id: str
) -> KeywordBuildRun:
    run = KeywordBuildRun(
        id=f"keyword-run-{uuid4().hex}",
        organization_id="content-plan-test-org",
        project_id=project_id,
        kind="initial",
        round_number=1,
        status="completed",
        stage="completed",
    )
    async with sessions() as session:
        session.add(run)
        await session.commit()
    return run


def keyword_row(
    *,
    project_id: str,
    run_id: str,
    index: int,
    priority_score: float | None,
    status: str = "active",
    review_status: str = "approved",
    country: str = "US",
    language: str = "en",
) -> Keyword:
    value = f"keyword {index:03d}"
    return Keyword(
        id=f"keyword-{uuid4().hex}",
        organization_id="content-plan-test-org",
        project_id=project_id,
        country=country,
        language=language,
        keyword=value,
        normalized_keyword=value,
        priority_score=priority_score,
        status=status,
        review_status=review_status,
        first_build_run_id=run_id,
        last_build_run_id=run_id,
    )


async def create_plan_item_dependencies(
    repository: ContentPlanRepository,
    project_id: str,
    *,
    suffix: str,
) -> tuple[ContentPlanBatch, str, str]:
    batch = await create_batch(repository, project_id, suffix=suffix, source="manual")
    preparation = await repository.create_preparation(
        preparation_id=f"preparation-{suffix}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="content planning",
        normalized_seed_keyword="content planning",
        source_round="manual",
        workflow_id=f"prepare:{suffix}",
    )
    snapshot = await repository.add_serp_snapshot(
        snapshot_id=f"serp-{suffix}",
        preparation_id=preparation.id,
        primary_keyword="content planning",
        country="US",
        language="en",
        provider="dataforseo",
        request_key=f"serp-{suffix}",
        cache_hit=True,
        cost_usd=0,
        provisional_title="Content Planning",
        provisional_direction="Explain the workflow.",
    )
    return batch, preparation.id, snapshot.id


def plan_item(
    *,
    item_id: str,
    batch_id: str,
    project_id: str,
    preparation_id: str,
    snapshot_id: str,
) -> ContentPlanItem:
    return ContentPlanItem(
        id=item_id,
        batch_id=batch_id,
        project_id=project_id,
        source="manual",
        seed_keyword="content planning",
        normalized_seed_keyword=f"content planning {item_id}",
        primary_keyword="content planning",
        title="Content Planning",
        writing_direction="Explain the workflow.",
        current_preparation_id=preparation_id,
        current_serp_snapshot_id=snapshot_id,
    )


def item_keyword(
    *,
    keyword_id: str,
    item_id: str,
    role: str,
    position: int,
) -> ContentPlanItemKeyword:
    return ContentPlanItemKeyword(
        id=keyword_id,
        plan_item_id=item_id,
        keyword=keyword_id,
        normalized_keyword=keyword_id,
        role=role,
        keyword_type="informational",
        source="user",
        position=position,
    )


async def test_repository_reads_back_each_d2_record(repository) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id)
    candidates = await repo.save_candidates(
        batch.id,
        [
            {
                "id": "candidate-1",
                "keyword_id": None,
                "keyword": "solar panel cost",
                "normalized_keyword": "solar panel cost",
                "source_rank": 1,
                "priority_score_snapshot": 91.2,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
                "selected_plan_order": 1,
            },
            {
                "id": "candidate-2",
                "keyword_id": None,
                "keyword": "solar installation price",
                "normalized_keyword": "solar installation price",
                "source_rank": 2,
                "priority_score_snapshot": 80.0,
                "coverage_status_snapshot": "unknown",
                "decision": "pending",
            },
        ],
    )
    assert [row.source_rank for row in candidates] == [1, 2]

    preparation = await repo.create_preparation(
        preparation_id="preparation-1",
        batch_id=batch.id,
        candidate_id="candidate-1",
        plan_order=1,
        seed_keyword="solar panel cost",
        normalized_seed_keyword="solar panel cost",
        source_round="initial",
        workflow_id="prepare:1",
    )
    keywords = await repo.save_preparation_keywords(
        preparation.id,
        [
            {
                "id": "prep-keyword-primary",
                "candidate_id": "q001",
                "source": "related",
                "raw_keyword": "solar panel cost guide",
                "normalized_keyword": "solar panel cost guide",
                "relevance": "same_topic",
                "keyword_type": "informational",
                "primary_fit": "strong",
                "coverage_status": "uncovered",
                "selected_role": "primary",
                "package_position": 1,
            },
            {
                "id": "prep-keyword-secondary",
                "candidate_id": "q002",
                "source": "related",
                "raw_keyword": "solar tax credit",
                "normalized_keyword": "solar tax credit",
                "relevance": "same_topic",
                "keyword_type": "informational",
                "primary_fit": "acceptable",
                "coverage_status": "unknown",
                "selected_role": "secondary",
                "package_position": 2,
            },
        ],
    )
    relation = await repo.add_preparation_relation(
        relation_id="relation-1",
        preparation_id=preparation.id,
        primary_candidate_id=keywords[0].id,
        secondary_candidate_id=keywords[1].id,
        classifier_version="classifier-v1",
    )
    snapshot = await repo.add_serp_snapshot(
        snapshot_id="serp-1",
        preparation_id=preparation.id,
        primary_keyword="solar panel cost guide",
        country="US",
        language="en",
        provider="dataforseo",
        provider_request_id="provider-serp-1",
        request_key="serp-request-1",
        cache_hit=False,
        cost_usd=0.004,
        provisional_title="Solar Panel Cost Guide",
        provisional_direction="Explain costs and incentives.",
    )
    bundle = await repo.get_preparation_bundle(preparation.id)
    assert bundle is not None
    assert [row.id for row in bundle.keywords] == [
        "prep-keyword-primary",
        "prep-keyword-secondary",
    ]
    assert [row.id for row in bundle.relations] == [relation.id]
    assert bundle.serp_snapshots[0].id == snapshot.id

    item = await repo.create_plan_item(
        item_id="plan-item-1",
        batch_id=batch.id,
        project_id=project_id,
        source="automatic",
        seed_keyword="solar panel cost",
        normalized_seed_keyword="solar panel cost",
        source_rank=1,
        plan_order=1,
        primary_keyword="solar panel cost guide",
        title="Solar Panel Cost Guide",
        writing_direction="Explain costs and incentives.",
        current_preparation_id=preparation.id,
        current_serp_snapshot_id=snapshot.id,
        keywords=[
            {
                "id": "item-keyword-primary",
                "preparation_keyword_id": keywords[0].id,
                "keyword": "solar panel cost guide",
                "normalized_keyword": "solar panel cost guide",
                "role": "primary",
                "keyword_type": "informational",
                "source": "related",
                "position": 1,
            },
            {
                "id": "item-keyword-secondary",
                "preparation_keyword_id": keywords[1].id,
                "keyword": "solar tax credit",
                "normalized_keyword": "solar tax credit",
                "role": "secondary",
                "keyword_type": "informational",
                "source": "related",
                "position": 2,
            },
        ],
    )
    item_bundle = await repo.get_plan_item_bundle(item.id)
    assert item_bundle is not None
    assert item_bundle.item.current_preparation_id == preparation.id
    assert [row.role for row in item_bundle.keywords] == ["primary", "secondary"]

    external = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=preparation.id,
        plan_item_id=item.id,
        request_key="related:batch-1:1",
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="related-hash-1",
        round_number=0,
    )
    claimed = await repo.claim_external_request(
        external.request_key,
        claim_token="claim-1",
        lease_until=datetime.now(UTC) + timedelta(minutes=5),
    )
    assert claimed is not None and claimed.status == "submitted"
    completed = await repo.complete_external_request(
        external.request_key,
        claim_token="claim-1",
        cost_usd=0.011,
        result_count=12,
        provider_request_ids=["provider-related-1"],
    )
    assert completed is not None and completed.status == "completed"
    assert completed.provider_request_ids == ["provider-related-1"]

    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_2_3",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10, 0),
        cadence_anchor_week=date(2026, 8, 3),
        expected_version=0,
    )
    assert settings.version == 1
    assert (await repo.get_settings(project_id)).timezone == "America/New_York"


async def test_repository_reads_persisted_preparation_dispatch_target(repository) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    preparation = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="recover persisted workflow",
        normalized_seed_keyword="recover persisted workflow",
        source_round="manual",
        workflow_id="content-plan:persisted:workflow-id",
        state="expanding",
    )

    target = await repo.get_preparation_dispatch_target(preparation.id)

    assert target is not None
    assert target.preparation_id == preparation.id
    assert target.workflow_id == "content-plan:persisted:workflow-id"
    assert target.organization_id == "content-plan-test-org"
    assert target.project_id == project_id


async def test_recovery_lists_only_current_recoverable_preparations(repository) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    recoverable = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="temporary failure",
        normalized_seed_keyword="temporary failure",
        source_round="manual",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="preview_failed",
    )
    await repo.set_preparation_state(
        recoverable.id,
        state="preview_failed",
        error_code="serp_retryable_failed",
        error_detail="temporary provider failure",
    )
    superseded = await repo.create_replacement_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        old_preparation_id=recoverable.id,
        candidate_id=None,
        seed_keyword_id=None,
        seed_keyword="newer edit",
        normalized_seed_keyword="newer edit",
        source_round="manual",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="expanding",
    )
    permanent = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=(await create_batch(repo, project_id, source="manual")).id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="empty serp",
        normalized_seed_keyword="empty serp",
        source_round="manual",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="preview_failed",
    )
    await repo.set_preparation_state(
        permanent.id,
        state="preview_failed",
        error_code="serp_empty_result",
        error_detail="no results",
    )

    targets = await repo.list_recoverable_preparations(limit=100)

    target_ids = {target.preparation_id for target in targets}
    assert superseded.id in target_ids
    assert recoverable.id not in target_ids
    assert permanent.id not in target_ids


async def test_manual_recovery_does_not_dispatch_automatic_preparations(repository) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="automatic")
    preparation = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="automatic preparation",
        normalized_seed_keyword="automatic preparation",
        source_round="initial",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="expanding",
    )

    targets = await repo.list_recoverable_preparations(limit=100)

    assert preparation.id not in {target.preparation_id for target in targets}


async def test_concurrent_automatic_batch_replay_creates_one_batch(repository) -> None:
    repo, _sessions, project_id = repository
    suffix = uuid4().hex

    async def create(index: int):
        return await repo.create_automatic_batch(
            batch_id=f"batch-{suffix}-{index}",
            organization_id="content-plan-test-org",
            project_id=project_id,
            workflow_id=f"content-plan:automatic:{suffix}:{index}",
            idempotency_key=f"automatic-key-{suffix}",
            request_hash="same-request-hash",
            country="US",
            language="en",
            timezone="America/New_York",
            business_context={"business_name": "Test"},
        )

    first, second = await asyncio.gather(create(1), create(2))

    assert first.id == second.id


async def test_automatic_batch_rejects_same_key_with_different_request(repository) -> None:
    repo, _sessions, project_id = repository
    suffix = uuid4().hex
    values = {
        "organization_id": "content-plan-test-org",
        "project_id": project_id,
        "idempotency_key": f"automatic-key-{suffix}",
        "country": "US",
        "language": "en",
        "timezone": "America/New_York",
        "business_context": {"business_name": "Test"},
    }
    await repo.create_automatic_batch(
        batch_id=f"batch-{suffix}-1",
        workflow_id=f"content-plan:automatic:{suffix}:1",
        request_hash="first-request-hash",
        **values,
    )

    with pytest.raises(ValueError, match="idempotency_key_conflict"):
        await repo.create_automatic_batch(
            batch_id=f"batch-{suffix}-2",
            workflow_id=f"content-plan:automatic:{suffix}:2",
            request_hash="different-request-hash",
            **values,
        )


async def test_automatic_batch_rejects_second_active_batch(repository) -> None:
    repo, _sessions, project_id = repository
    first = await create_batch(repo, project_id, source="automatic")

    with pytest.raises(ActiveAutomaticBatchError) as exc_info:
        await repo.create_automatic_batch(
            batch_id=f"batch-{uuid4().hex}",
            organization_id="content-plan-test-org",
            project_id=project_id,
            workflow_id=f"content-plan:automatic:{uuid4().hex}",
            idempotency_key=f"automatic-key-{uuid4().hex}",
            request_hash="another-request",
            country="US",
            language="en",
            timezone="America/New_York",
            business_context={"business_name": "Test"},
        )

    assert exc_info.value.batch_id == first.id


@pytest.mark.parametrize(
    ("status", "error_code", "recoverable"),
    [
        ("completed", None, False),
        ("needs_attention", "external_request_outcome_unknown", False),
        ("needs_attention", "expansion_charged_failed", False),
        ("needs_attention", "expansion_failed", True),
        ("needs_attention", "content_plan_scheduling_failed", True),
        ("needs_attention", "classification_failed", False),
    ],
)
async def test_automatic_batch_recovery_filters_paid_request_outcomes(
    repository,
    status: str,
    error_code: str | None,
    recoverable: bool,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="automatic")
    async with sessions() as session:
        row = await session.get(ContentPlanBatch, batch.id)
        assert row is not None
        row.status = status
        row.error_code = error_code
        await session.commit()

    targets = await repo.list_recoverable_automatic_batches(limit=100)

    assert (batch.id in {target.batch_id for target in targets}) is recoverable


@pytest.mark.parametrize(
    ("error_code", "retryable"),
    [
        ("content_plan_technical_retry_exhausted", True),
        ("content_plan_scheduling_failed", True),
        ("serp_request_outcome_unknown", True),
        ("serp_primary_candidates_exhausted", True),
        ("ai_request_outcome_unknown", True),
        ("ai_request_retry_exhausted", True),
        ("pack_shortage", True),
        ("seed_decision_contract_invalid", True),
        ("external_request_outcome_unknown", False),
        ("expansion_charged_failed", False),
    ],
)
async def test_manual_batch_retry_preserves_paid_request_safety(
    repository, error_code: str, retryable: bool
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="automatic")
    async with sessions() as session:
        row = await session.get(ContentPlanBatch, batch.id)
        assert row is not None
        row.status = "needs_attention"
        row.error_code = error_code
        row.error_detail = "failed"
        await session.commit()

    if not retryable:
        with pytest.raises(ValueError, match="content_plan_batch_not_retryable"):
            await repo.prepare_batch_retry_scoped(
                "content-plan-test-org", project_id, batch.id
            )
        return

    target = await repo.prepare_batch_retry_scoped(
        "content-plan-test-org", project_id, batch.id
    )
    assert target is not None
    reopened = target.batch
    assert target.preparation_id is None
    assert reopened.status == "queued"
    assert reopened.error_code is None
    assert reopened.error_detail is None


async def test_automatic_classification_retry_reopens_only_failed_preparation(
    repository,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="automatic")
    failed = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="failed classification",
        normalized_seed_keyword="failed classification",
        source_round="initial",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="classification_failed",
    )
    ready = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=2,
        seed_keyword="completed package",
        normalized_seed_keyword="completed package",
        source_round="initial",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="pack_ready",
    )
    async with sessions() as session:
        stored_batch = await session.get(ContentPlanBatch, batch.id)
        stored_failed = await session.get(ContentPlanPreparation, failed.id)
        assert stored_batch is not None and stored_failed is not None
        stored_batch.status = "needs_attention"
        stored_batch.stage = "d3_failed"
        stored_batch.error_code = "classification_failed"
        stored_batch.error_detail = "classification_contract_invalid: ids"
        stored_failed.error_code = "classification_failed"
        stored_failed.error_detail = "classification_contract_invalid: ids"
        await session.commit()

    target = await repo.prepare_batch_retry_scoped(
        "content-plan-test-org", project_id, batch.id
    )

    assert target is not None
    assert target.batch.status == "queued"
    assert target.preparation_id is None
    failed_bundle = await repo.get_preparation_bundle(failed.id)
    ready_bundle = await repo.get_preparation_bundle(ready.id)
    assert failed_bundle is not None and ready_bundle is not None
    assert failed_bundle.preparation.state == "expanded"
    assert failed_bundle.preparation.package_version == failed.package_version + 1
    assert failed_bundle.preparation.error_code is None
    assert failed_bundle.preparation.error_detail is None
    assert ready_bundle.preparation.state == "pack_ready"
    assert ready_bundle.preparation.package_version == ready.package_version


async def test_manual_batch_cannot_retry_automatic_pack_shortage(repository) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    async with sessions() as session:
        row = await session.get(ContentPlanBatch, batch.id)
        assert row is not None
        row.status = "needs_attention"
        row.error_code = "pack_shortage"
        await session.commit()

    with pytest.raises(ValueError, match="content_plan_batch_not_retryable"):
        await repo.prepare_batch_retry_scoped(
            "content-plan-test-org", project_id, batch.id
        )


@pytest.mark.parametrize(
    ("error_code", "retryable"),
    [
        ("content_plan_technical_retry_exhausted", True),
        ("expansion_failed", True),
        ("external_request_outcome_unknown", False),
        ("expansion_charged_failed", False),
        ("content_plan_provider_not_configured", False),
    ],
)
async def test_failed_manual_batch_retries_only_safe_preparation(
    repository, error_code: str, retryable: bool
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    preparation = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="manual retry",
        normalized_seed_keyword="manual retry",
        source_round="manual",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="expansion_failed",
    )
    async with sessions() as session:
        stored_batch = await session.get(ContentPlanBatch, batch.id)
        stored_preparation = await session.get(ContentPlanPreparation, preparation.id)
        assert stored_batch is not None and stored_preparation is not None
        stored_batch.status = "needs_attention"
        stored_batch.error_code = error_code
        stored_batch.error_detail = "failed"
        stored_batch.finished_at = datetime.now(UTC)
        stored_preparation.error_code = error_code
        stored_preparation.error_detail = "failed"
        await session.commit()

    if not retryable:
        with pytest.raises(ValueError, match="content_plan_batch_not_retryable"):
            await repo.prepare_batch_retry_scoped(
                "content-plan-test-org", project_id, batch.id
            )
        return

    target = await repo.prepare_batch_retry_scoped(
        "content-plan-test-org", project_id, batch.id
    )

    assert target is not None
    assert target.batch.status == "queued"
    assert target.batch.finished_at is None
    assert target.preparation_id == preparation.id
    refreshed = await repo.get_preparation_bundle(preparation.id)
    assert refreshed is not None
    assert refreshed.preparation.state == "expansion_failed"
    assert refreshed.preparation.error_code is None
    assert refreshed.preparation.error_detail is None


async def test_batch_list_is_project_scoped_and_returns_recent_batches(repository) -> None:
    repo, sessions, project_id = repository
    older = await create_batch(repo, project_id, suffix="older", source="manual")
    newer = await create_batch(repo, project_id, suffix="newer", source="manual")
    other_project_id = f"content-plan-other-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            Project(
                id=other_project_id,
                organization_id="content-plan-test-org",
                name="Other project",
                domain=f"{uuid4().hex}.example.test",
                country="US",
                language="en",
            )
        )
        await session.commit()
    try:
        other = await create_batch(repo, other_project_id, suffix="other", source="manual")
        async with sessions() as session:
            old_row = await session.get(ContentPlanBatch, older.id)
            new_row = await session.get(ContentPlanBatch, newer.id)
            assert old_row is not None and new_row is not None
            old_row.created_at = datetime(2026, 8, 1, tzinfo=UTC)
            new_row.created_at = datetime(2026, 8, 2, tzinfo=UTC)
            await session.commit()

        rows = await repo.list_batch_progress_scoped(
            "content-plan-test-org", project_id, limit=20
        )

        ids = [row.batch.id for row in rows]
        assert ids[:2] == [newer.id, older.id]
        assert other.id not in ids
        assert all(row.batch.project_id == project_id for row in rows)
    finally:
        async with sessions() as session:
            await session.execute(delete(Project).where(Project.id == other_project_id))
            await session.commit()


async def test_manual_permanent_failure_is_persisted_without_plan_item(repository) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    preparation = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="missing provider",
        normalized_seed_keyword="missing provider",
        source_round="manual",
        workflow_id=f"content-plan:{uuid4().hex}",
        state="expanding",
    )

    await repo.fail_manual_preparation(
        preparation.id,
        error_code="content_plan_provider_not_configured",
        error_detail="provider configuration is required",
    )

    stored = await repo.get_preparation_bundle(preparation.id)
    assert stored is not None
    assert stored.preparation.state == "expansion_failed"
    assert stored.preparation.error_code == "content_plan_provider_not_configured"
    failed_batch = await repo.get_batch(batch.id)
    assert failed_batch is not None
    assert failed_batch.status == "needs_attention"
    assert failed_batch.error_code == "content_plan_provider_not_configured"
    async with sessions() as session:
        assert await session.scalar(
            select(func.count(ContentPlanItem.id)).where(
                ContentPlanItem.batch_id == batch.id
            )
        ) == 0


async def test_database_constraints_reject_duplicate_active_records(repository) -> None:
    repo, _sessions, project_id = repository
    await create_batch(repo, project_id, suffix="first")
    with pytest.raises(IntegrityError):
        await create_batch(repo, project_id, suffix="second")


@pytest.mark.parametrize(
    ("source", "invalid_target_count"),
    [("automatic", 1), ("manual", 30)],
)
async def test_database_rejects_target_count_that_does_not_match_batch_source(
    repository,
    source: str,
    invalid_target_count: int,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source=source)

    with pytest.raises(IntegrityError):
        async with sessions() as session:
            row = await session.get(ContentPlanBatch, batch.id)
            assert row is not None
            row.target_count = invalid_target_count
            await session.commit()


async def test_repository_rejects_invalid_iana_timezone(repository) -> None:
    repo, _sessions, project_id = repository

    with pytest.raises(ValueError, match="IANA"):
        await repo.upsert_settings(
            project_id=project_id,
            cadence="weekly_2_3",
            paused=False,
            timezone="Mars/Olympus",
            default_publish_local_time=time(10, 0),
            cadence_anchor_week=date(2026, 8, 3),
            expected_version=0,
        )

    with pytest.raises(ValueError, match="IANA"):
        await repo.create_batch(
            batch_id=f"batch-{uuid4().hex}",
            organization_id="content-plan-test-org",
            project_id=project_id,
            source="manual",
            workflow_id=f"content-plan-workflow-{uuid4().hex}",
            idempotency_key=f"content-plan-request-{uuid4().hex}",
            request_hash="invalid-timezone",
            country="US",
            language="en",
            timezone="Mars/Olympus",
        )


@pytest.mark.parametrize(
    ("cadence", "anchor"),
    [("weekly_2_3", None), ("weekly_1", date(2026, 8, 3))],
)
async def test_repository_rejects_anchor_that_does_not_match_cadence(
    repository,
    cadence: str,
    anchor: date | None,
) -> None:
    repo, _sessions, project_id = repository

    with pytest.raises(ValueError, match="cadence_anchor_week"):
        await repo.upsert_settings(
            project_id=project_id,
            cadence=cadence,
            paused=False,
            timezone="America/New_York",
            default_publish_local_time=time(10, 0),
            cadence_anchor_week=anchor,
            expected_version=0,
        )


@pytest.mark.parametrize(
    ("cadence", "anchor"),
    [("weekly_2_3", None), ("weekly_1", date(2026, 8, 3))],
)
async def test_database_rejects_anchor_that_does_not_match_cadence(
    repository,
    cadence: str,
    anchor: date | None,
) -> None:
    _repo, sessions, project_id = repository

    with pytest.raises(IntegrityError):
        async with sessions() as session:
            session.add(
                ContentPlanSettings(
                    project_id=project_id,
                    cadence=cadence,
                    paused=False,
                    timezone="America/New_York",
                    default_publish_local_time=time(10, 0),
                    cadence_anchor_week=anchor,
                )
            )
            await session.commit()


async def test_candidate_snapshot_requires_contiguous_source_ranks(repository) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")

    with pytest.raises(ValueError, match="source_rank"):
        await repo.save_candidates(
            batch.id,
            [
                {
                    "id": f"candidate-{uuid4().hex}",
                    "keyword_id": None,
                    "keyword": "first",
                    "normalized_keyword": "first",
                    "source_rank": 1,
                    "priority_score_snapshot": 10,
                    "coverage_status_snapshot": "uncovered",
                },
                {
                    "id": f"candidate-{uuid4().hex}",
                    "keyword_id": None,
                    "keyword": "third",
                    "normalized_keyword": "third",
                    "source_rank": 3,
                    "priority_score_snapshot": 8,
                    "coverage_status_snapshot": "uncovered",
                },
            ],
        )

    async with sessions() as session:
        rows = list(
            (
                await session.scalars(
                    select(ContentPlanCandidate).where(
                        ContentPlanCandidate.batch_id == batch.id
                    )
                )
            ).all()
        )
        assert rows == []


@pytest.mark.parametrize(
    "operation", ["insert", "delete", "rerank", "rescore", "recount", "move"]
)
async def test_database_freezes_completed_candidate_snapshot(
    repository,
    operation: str,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    candidate_id = f"candidate-{uuid4().hex}"
    other_batch = None
    if operation == "move":
        other_batch = await create_batch(
            repo,
            project_id,
            suffix="move-target",
            source="manual",
        )
    await repo.save_candidates(
        batch.id,
        [
            {
                "id": candidate_id,
                "keyword_id": None,
                "keyword": "content planning",
                "normalized_keyword": "content planning",
                "source_rank": 1,
                "priority_score_snapshot": 10,
                "coverage_status_snapshot": "uncovered",
            }
        ],
    )

    async with sessions() as session:
        saved_batch = await session.get(ContentPlanBatch, batch.id)
        assert saved_batch is not None
        assert saved_batch.candidate_snapshot_status == "completed"
        assert saved_batch.candidate_snapshot_count == 1

    with pytest.raises(IntegrityError):
        async with sessions() as session:
            if operation == "recount":
                saved_batch = await session.get(ContentPlanBatch, batch.id)
                assert saved_batch is not None
                saved_batch.candidate_snapshot_count = 2
                await session.commit()
                return

            candidate = await session.get(ContentPlanCandidate, candidate_id)
            assert candidate is not None
            if operation == "insert":
                session.add(
                    ContentPlanCandidate(
                        id=f"candidate-{uuid4().hex}",
                        batch_id=batch.id,
                        keyword_id=None,
                        keyword="extra",
                        normalized_keyword="extra",
                        source_rank=2,
                        priority_score_snapshot=9,
                        coverage_status_snapshot="uncovered",
                    )
                )
            elif operation == "delete":
                await session.delete(candidate)
            elif operation == "rerank":
                candidate.source_rank = 2
            elif operation == "move":
                assert other_batch is not None
                candidate.batch_id = other_batch.id
            else:
                candidate.priority_score_snapshot = 9
            await session.commit()


async def test_database_allows_candidate_decisions_after_snapshot_completion(
    repository,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    candidate_id = f"candidate-{uuid4().hex}"
    await repo.save_candidates(
        batch.id,
        [
            {
                "id": candidate_id,
                "keyword_id": None,
                "keyword": "content planning",
                "normalized_keyword": "content planning",
                "source_rank": 1,
                "priority_score_snapshot": 10,
                "coverage_status_snapshot": "uncovered",
            }
        ],
    )

    async with sessions() as session:
        candidate = await session.get(ContentPlanCandidate, candidate_id)
        assert candidate is not None
        candidate.decision = "kept"
        candidate.decision_reason = "selected by CP-02"
        candidate.candidate_window = 1
        await session.commit()


async def test_repository_replaces_an_assigned_seed_without_order_conflict(
    repository,
) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    await repo.save_candidates(
        batch.id,
        [
            {
                "id": "candidate-old",
                "keyword_id": None,
                "keyword": "old seed",
                "normalized_keyword": "old seed",
                "source_rank": 1,
                "priority_score_snapshot": 10,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
                "selected_plan_order": 1,
            },
            {
                "id": "candidate-replacement",
                "keyword_id": None,
                "keyword": "replacement seed",
                "normalized_keyword": "replacement seed",
                "source_rank": 2,
                "priority_score_snapshot": 9,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
            },
        ],
    )

    await repo.replace_seed_for_plan_order(
        batch.id,
        plan_order=1,
        replacement_candidate_id="candidate-replacement",
    )

    selected = await repo.get_selected_candidates(batch.id)
    assert [(row.id, row.selected_plan_order) for row in selected] == [
        ("candidate-replacement", 1)
    ]


async def test_repository_replacement_is_atomic_and_replay_safe_after_order_changes(
    repository,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="automatic")
    await repo.save_candidates(
        batch.id,
        [
            {
                "id": "candidate-old-atomic",
                "keyword_id": None,
                "keyword": "old atomic seed",
                "normalized_keyword": "old atomic seed",
                "source_rank": 1,
                "priority_score_snapshot": 10,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
            },
            {
                "id": "candidate-replacement-atomic",
                "keyword_id": None,
                "keyword": "replacement atomic seed",
                "normalized_keyword": "replacement atomic seed",
                "source_rank": 2,
                "priority_score_snapshot": 9,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
                "selected_plan_order": 1,
            },
        ],
    )
    old = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id="candidate-old-atomic",
        plan_order=1,
        seed_keyword="old atomic seed",
        normalized_seed_keyword="old atomic seed",
        source_round="initial",
        workflow_id=f"content-plan:{batch.id}:prepare:22:1",
        state="invalid",
    )
    colliding_history = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=2,
        seed_keyword="unrelated history",
        normalized_seed_keyword="unrelated history",
        source_round="refill_1",
        workflow_id=f"content-plan:{batch.id}:prepare:1:2",
        state="superseded",
    )
    replacement_workflow_id = f"content-plan:{batch.id}:replace:{old.id}"

    replacement = await repo.replace_preparation_seed(
        preparation_id=f"preparation-{uuid4().hex}",
        old_preparation_id=old.id,
        replacement_candidate_id="candidate-replacement-atomic",
        source_round="refill_2",
        workflow_id=replacement_workflow_id,
    )
    replay = await repo.replace_preparation_seed(
        preparation_id=f"preparation-{uuid4().hex}",
        old_preparation_id=old.id,
        replacement_candidate_id="candidate-replacement-atomic",
        source_round="refill_2",
        workflow_id=replacement_workflow_id,
    )

    assert replay.id == replacement.id
    assert replacement.workflow_id == replacement_workflow_id
    assert replacement.preparation_version == old.preparation_version + 1
    assert replacement.plan_order == 1
    assert replacement.seed_keyword == "replacement atomic seed"
    selected = await repo.get_selected_candidates(batch.id)
    assert [(row.id, row.selected_plan_order) for row in selected] == [
        ("candidate-replacement-atomic", 1)
    ]
    async with sessions() as session:
        preparations = list(
            (
                await session.scalars(
                    select(ContentPlanPreparation).where(
                        ContentPlanPreparation.batch_id == batch.id
                    )
                )
            ).all()
        )
        stored_old_candidate = await session.get(
            ContentPlanCandidate, "candidate-old-atomic"
        )
    assert len(preparations) == 3
    assert colliding_history.id in {row.id for row in preparations}
    assert stored_old_candidate is not None
    assert stored_old_candidate.decision == "dropped"
    assert stored_old_candidate.selected_plan_order is None


async def test_repository_replacement_rolls_back_candidate_swap_when_insert_fails(
    repository,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="automatic")
    await repo.save_candidates(
        batch.id,
        [
            {
                "id": "candidate-old-rollback",
                "keyword_id": None,
                "keyword": "old rollback seed",
                "normalized_keyword": "old rollback seed",
                "source_rank": 1,
                "priority_score_snapshot": 10,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
                "selected_plan_order": 1,
            },
            {
                "id": "candidate-replacement-rollback",
                "keyword_id": None,
                "keyword": "replacement rollback seed",
                "normalized_keyword": "replacement rollback seed",
                "source_rank": 2,
                "priority_score_snapshot": 9,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
            },
        ],
    )
    old = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id="candidate-old-rollback",
        plan_order=1,
        seed_keyword="old rollback seed",
        normalized_seed_keyword="old rollback seed",
        source_round="initial",
        workflow_id=f"content-plan:{batch.id}:prepare:1:1",
        state="invalid",
    )
    duplicate_id = f"preparation-{uuid4().hex}"
    other_batch = await create_batch(repo, project_id, source="manual")
    await repo.create_preparation(
        preparation_id=duplicate_id,
        batch_id=other_batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="existing preparation",
        normalized_seed_keyword="existing preparation",
        source_round="manual",
        workflow_id=f"content-plan:{other_batch.id}:prepare:1:1",
    )

    with pytest.raises(IntegrityError):
        await repo.replace_preparation_seed(
            preparation_id=duplicate_id,
            old_preparation_id=old.id,
            replacement_candidate_id="candidate-replacement-rollback",
            source_round="refill_2",
            workflow_id=f"content-plan:{batch.id}:replace:{old.id}",
        )

    current = await repo.get_current_preparations(batch.id)
    selected = await repo.get_selected_candidates(batch.id)
    assert [row.id for row in current] == [old.id]
    assert current[0].state == "invalid"
    assert [(row.id, row.selected_plan_order) for row in selected] == [
        ("candidate-old-rollback", 1)
    ]
    async with sessions() as session:
        old_candidate = await session.get(ContentPlanCandidate, "candidate-old-rollback")
        replacement_candidate = await session.get(
            ContentPlanCandidate, "candidate-replacement-rollback"
        )
    assert old_candidate is not None and old_candidate.decision == "kept"
    assert replacement_candidate is not None
    assert replacement_candidate.selected_plan_order is None


async def test_related_request_legacy_key_is_reused_only_for_same_preparation(
    repository,
) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="automatic")
    first = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="first request seed",
        normalized_seed_keyword="first request seed",
        source_round="initial",
        workflow_id=f"content-plan:{batch.id}:prepare:1:1",
    )
    second = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=2,
        seed_keyword="second request seed",
        normalized_seed_keyword="second request seed",
        source_round="initial",
        workflow_id=f"content-plan:{batch.id}:prepare:2:1",
    )
    legacy_key = f"related:{batch.id}:0:1:1"
    legacy = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=first.id,
        plan_item_id=None,
        request_key=legacy_key,
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="first-hash",
        round_number=0,
    )

    reused = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=first.id,
        plan_item_id=None,
        request_key=f"related:{batch.id}:0:{first.id}:1",
        legacy_request_key=legacy_key,
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="first-hash",
        round_number=0,
    )
    separate = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=second.id,
        plan_item_id=None,
        request_key=f"related:{batch.id}:0:{second.id}:1",
        legacy_request_key=legacy_key,
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="second-hash",
        round_number=0,
    )

    assert reused.id == legacy.id
    assert reused.request_key == legacy_key
    assert separate.id != legacy.id
    assert separate.preparation_id == second.id
    assert separate.request_key == f"related:{batch.id}:0:{second.id}:1"


async def test_snapshot_completion_blocks_a_concurrent_candidate_insert(
    repository,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")

    first_session = sessions()
    second_session = sessions()
    try:
        await first_session.begin()
        locked_batch = await first_session.scalar(
            select(ContentPlanBatch)
            .where(ContentPlanBatch.id == batch.id)
            .with_for_update()
        )
        assert locked_batch is not None
        first_session.add(
            ContentPlanCandidate(
                id=f"candidate-{uuid4().hex}",
                batch_id=batch.id,
                keyword_id=None,
                keyword="first",
                normalized_keyword="first",
                source_rank=1,
                priority_score_snapshot=10,
                coverage_status_snapshot="uncovered",
            )
        )
        await first_session.flush()
        locked_batch.candidate_snapshot_count = 1
        locked_batch.candidate_snapshot_status = "completed"
        await first_session.flush()

        async def insert_after_completion_started() -> None:
            second_session.add(
                ContentPlanCandidate(
                    id=f"candidate-{uuid4().hex}",
                    batch_id=batch.id,
                    keyword_id=None,
                    keyword="late",
                    normalized_keyword="late",
                    source_rank=2,
                    priority_score_snapshot=9,
                    coverage_status_snapshot="uncovered",
                )
            )
            await second_session.commit()

        late_insert = asyncio.create_task(insert_after_completion_started())
        await asyncio.sleep(0.1)
        assert not late_insert.done()

        await first_session.commit()
        with pytest.raises(IntegrityError):
            await late_insert
    finally:
        await first_session.rollback()
        await second_session.rollback()
        await first_session.close()
        await second_session.close()


async def test_database_accepts_every_documented_workflow_state(repository) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    preparation = await repo.create_preparation(
        preparation_id=f"state-preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="content planning",
        normalized_seed_keyword="content planning",
        source_round="manual",
        workflow_id=f"prepare:{uuid4().hex}",
    )

    async with sessions() as session:
        for status in (
            "queued",
            "selecting_seeds",
            "expanding",
            "building_packs",
            "supplementing",
            "building_previews",
            "creating_items",
            "scheduling",
            "completed",
            "needs_attention",
            "cancelled",
        ):
            row = await session.get(ContentPlanBatch, batch.id)
            row.status = status
            await session.commit()

        for state in (
            "selected",
            "expanding",
            "expanded",
            "classifying",
            "coverage_check",
            "pack_ready",
            "serp_preview",
            "preview_ready",
            "invalid",
            "classification_failed",
            "coverage_check_failed",
            "preview_failed",
            "cancelled",
            "superseded",
        ):
            row = await session.get(ContentPlanPreparation, preparation.id)
            row.state = state
            await session.commit()


async def test_plan_item_keyword_limit_and_transaction_rollback(repository) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id)
    preparation = await repo.create_preparation(
        preparation_id="preparation-limit",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="content planning",
        normalized_seed_keyword="content planning",
        source_round="manual",
        workflow_id="prepare:limit",
    )
    snapshot = await repo.add_serp_snapshot(
        snapshot_id="serp-limit",
        preparation_id=preparation.id,
        primary_keyword="content planning",
        country="US",
        language="en",
        provider="dataforseo",
        request_key="serp-limit",
        cache_hit=True,
        cost_usd=0,
        provisional_title="Content Planning",
        provisional_direction="Explain the workflow.",
    )
    keywords = [
        {
            "id": f"limit-keyword-{index}",
            "keyword": f"keyword {index}",
            "normalized_keyword": f"keyword {index}",
            "role": "primary" if index == 0 else "secondary",
            "keyword_type": "informational",
            "source": "user",
            "position": index + 1,
        }
        for index in range(10)
    ]
    with pytest.raises(ValueError, match="最多 8 个次关键词"):
        await repo.create_plan_item(
            item_id="plan-item-limit",
            batch_id=batch.id,
            project_id=project_id,
            source="manual",
            seed_keyword="content planning",
            normalized_seed_keyword="content planning",
            source_rank=None,
            plan_order=None,
            primary_keyword="content planning",
            title="Content Planning",
            writing_direction="Explain the workflow.",
            current_preparation_id=preparation.id,
            current_serp_snapshot_id=snapshot.id,
            keywords=keywords,
        )
    async with sessions() as session:
        assert await session.get(ContentPlanItemKeyword, "limit-keyword-0") is None


@pytest.mark.parametrize(
    ("roles", "positions"),
    [
        (["secondary"], [1]),
        (["primary", "secondary"], [1, 3]),
        (["primary", *("secondary" for _ in range(9))], list(range(1, 11))),
    ],
    ids=["missing-primary", "non-contiguous-position", "too-many-secondary"],
)
async def test_database_rejects_invalid_plan_item_keyword_packages(
    repository,
    roles: list[str],
    positions: list[int],
) -> None:
    repo, sessions, project_id = repository
    batch, preparation_id, snapshot_id = await create_plan_item_dependencies(
        repo,
        project_id,
        suffix=uuid4().hex,
    )
    item_id = f"invalid-package-{uuid4().hex}"

    with pytest.raises(IntegrityError):
        async with sessions() as session:
            async with session.begin():
                session.add(
                    plan_item(
                        item_id=item_id,
                        batch_id=batch.id,
                        project_id=project_id,
                        preparation_id=preparation_id,
                        snapshot_id=snapshot_id,
                    )
                )
                session.add_all(
                    [
                        item_keyword(
                            keyword_id=f"{item_id}-{index}",
                            item_id=item_id,
                            role=role,
                            position=position,
                        )
                        for index, (role, position) in enumerate(
                            zip(roles, positions, strict=True),
                            start=1,
                        )
                    ]
                )


async def test_database_requires_same_topic_secondary_relation(repository) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id, source="manual")
    preparation = await repo.create_preparation(
        preparation_id=f"relation-preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="content planning",
        normalized_seed_keyword="content planning",
        source_round="manual",
        workflow_id=f"prepare:{uuid4().hex}",
    )

    with pytest.raises(IntegrityError):
        async with sessions() as session:
            async with session.begin():
                session.add_all(
                    [
                        ContentPlanPreparationKeyword(
                            id="relation-primary",
                            preparation_id=preparation.id,
                            candidate_id="relation-primary-candidate",
                            source="related",
                            raw_keyword="content planning",
                            normalized_keyword="content planning",
                            relevance="same_topic",
                            keyword_type="informational",
                            primary_fit="strong",
                            coverage_status="uncovered",
                            selected_role="primary",
                            package_position=1,
                        ),
                        ContentPlanPreparationKeyword(
                            id="relation-secondary",
                            preparation_id=preparation.id,
                            candidate_id="relation-secondary-candidate",
                            source="related",
                            raw_keyword="unrelated service",
                            normalized_keyword="unrelated service",
                            relevance="unrelated",
                            keyword_type="service",
                            primary_fit="ineligible",
                            coverage_status="uncovered",
                            selected_role="excluded",
                        ),
                        ContentPlanPreparationRelation(
                            id="invalid-relation",
                            preparation_id=preparation.id,
                            primary_candidate_id="relation-primary",
                            secondary_candidate_id="relation-secondary",
                            classifier_version="classifier-v1",
                        ),
                    ]
                )


async def test_request_claim_requires_the_matching_lease_token(repository) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id)
    external = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=None,
        plan_item_id=None,
        request_key=f"request-{uuid4().hex}",
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="hash",
        round_number=0,
    )
    claimed = await repo.claim_external_request(
        external.request_key,
        claim_token="owner",
        lease_until=datetime.now(UTC) + timedelta(minutes=5),
    )
    assert claimed is not None
    assert (
        await repo.complete_external_request(
            external.request_key,
            claim_token="wrong-owner",
            cost_usd=0.1,
            result_count=1,
            provider_request_ids=["should-not-save"],
        )
        is None
    )


async def test_repository_builds_an_immutable_ranked_candidate_snapshot(repository) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id)
    run = await create_keyword_build_run(sessions, project_id)
    expected = [
        keyword_row(
            project_id=project_id,
            run_id=run.id,
            index=index,
            priority_score=1000 - index,
        )
        for index in range(55)
    ]
    excluded = [
        keyword_row(
            project_id=project_id,
            run_id=run.id,
            index=101,
            priority_score=2000,
            status="archived",
        ),
        keyword_row(
            project_id=project_id,
            run_id=run.id,
            index=102,
            priority_score=2000,
            review_status="needs_review",
        ),
        keyword_row(
            project_id=project_id,
            run_id=run.id,
            index=103,
            priority_score=None,
        ),
        keyword_row(
            project_id=project_id,
            run_id=run.id,
            index=104,
            priority_score=2000,
            country="GB",
        ),
    ]
    async with sessions() as session:
        session.add_all([*expected, *excluded])
        await session.commit()

    source = await repo.list_candidate_source_keywords(batch.id)
    assert [row.id for row in source] == [row.id for row in expected]
    snapshot = await repo.create_candidate_snapshot(
        batch.id,
        coverage_by_keyword={row.normalized_keyword: "uncovered" for row in source},
    )
    assert [row.source_rank for row in snapshot] == list(range(1, 56))
    assert [row.keyword_id for row in snapshot] == [row.id for row in expected]

    first = await repo.get_candidate_window(batch.id, after_source_rank=0)
    second = await repo.get_candidate_window(
        batch.id, after_source_rank=first.last_source_rank
    )
    assert len(first.candidates) == 50
    assert first.last_source_rank == 50
    assert first.exhausted is False
    assert [row.source_rank for row in second.candidates] == [51, 52, 53, 54, 55]
    assert second.exhausted is True

    async with sessions() as session:
        expected[0].priority_score = -1
        session.add(
            keyword_row(
                project_id=project_id,
                run_id=run.id,
                index=105,
                priority_score=3000,
            )
        )
        await session.merge(expected[0])
        await session.commit()
    repeated = await repo.create_candidate_snapshot(batch.id, coverage_by_keyword={})
    assert [row.keyword_id for row in repeated] == [row.id for row in expected]
    assert [row.source_rank for row in repeated] == list(range(1, 56))


async def test_repository_drops_a_retained_candidate_that_became_unavailable(
    repository,
) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id)
    rows = await repo.save_candidates(
        batch.id,
        [
            {
                "id": f"candidate-{index}",
                "keyword_id": None,
                "keyword": f"candidate {index}",
                "normalized_keyword": f"candidate {index}",
                "source_rank": index,
                "priority_score_snapshot": 100 - index,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
            }
            for index in range(1, 3)
        ],
    )

    await repo.drop_unavailable_candidates(batch.id, {rows[0].id: "covered"})

    retained = await repo.get_retained_candidates(batch.id)
    assert [row.id for row in retained] == [rows[1].id]
    refreshed = await repo.get_batch(batch.id)
    assert refreshed is not None and refreshed.selected_count == 1


async def test_keyword_package_write_rolls_back_as_one_transaction(repository) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id)
    preparation = await repo.create_preparation(
        preparation_id=f"preparation-{uuid4().hex}",
        batch_id=batch.id,
        candidate_id=None,
        plan_order=1,
        seed_keyword="content planning",
        normalized_seed_keyword="content planning",
        source_round="initial",
        workflow_id=f"prepare:{uuid4().hex}",
        state="expanded",
    )
    keywords = await repo.save_expansion_result(
        preparation.id,
        [
            {
                "id": f"preparation-keyword-{uuid4().hex}",
                "candidate_id": "candidate-primary",
                "source": "seed",
                "raw_keyword": "content planning",
                "normalized_keyword": "content planning",
            }
        ],
        request_round=0,
    )

    with pytest.raises(IntegrityError):
        await repo.save_keyword_package(
            preparation.id,
            keyword_values=[
                {
                    "id": keywords[0].id,
                    "relevance": "same_topic",
                    "keyword_type": "informational",
                    "primary_fit": "strong",
                    "reason_code": "answers_definition",
                    "classifier_version": "classifier-v1",
                    "coverage_status": "uncovered",
                    "coverage_checked_at": datetime.now(UTC),
                    "selected_role": "primary",
                    "package_position": 1,
                }
            ],
            relation_values=[
                {
                    "id": f"invalid-relation-{uuid4().hex}",
                    "primary_candidate_id": keywords[0].id,
                    "secondary_candidate_id": "missing-keyword",
                    "classifier_version": "classifier-v1",
                }
            ],
            selected_primary_keyword_id=keywords[0].id,
            state="pack_ready",
        )

    bundle = await repo.get_preparation_bundle(preparation.id)
    assert bundle is not None
    assert bundle.preparation.state == "expanded"
    assert bundle.preparation.selected_primary_candidate_id is None
    assert bundle.keywords[0].selected_role == "excluded"
    assert bundle.relations == []


async def test_external_request_ledger_blocks_repayment_and_limits_retries(
    repository,
) -> None:
    repo, sessions, project_id = repository
    batch = await create_batch(repo, project_id)

    completed = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=None,
        plan_item_id=None,
        request_key=f"completed-{uuid4().hex}",
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="completed-hash",
        round_number=0,
    )
    claim = await repo.claim_external_request(
        completed.request_key,
        claim_token="completed-owner",
        lease_until=datetime.now(UTC) + timedelta(minutes=5),
    )
    assert claim is not None
    await repo.complete_external_request(
        completed.request_key,
        claim_token="completed-owner",
        cost_usd=0.01,
        result_count=1,
        provider_request_ids=["paid-request"],
    )
    assert (
        await repo.claim_external_request(
            completed.request_key,
            claim_token="must-not-repay",
            lease_until=datetime.now(UTC) + timedelta(minutes=5),
        )
        is None
    )

    retrying = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=None,
        plan_item_id=None,
        request_key=f"retrying-{uuid4().hex}",
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="retry-hash",
        round_number=0,
    )
    for attempt in range(1, 4):
        token = f"retry-owner-{attempt}"
        claimed = await repo.claim_external_request(
            retrying.request_key,
            claim_token=token,
            lease_until=datetime.now(UTC) + timedelta(minutes=5),
        )
        assert claimed is not None and claimed.attempt_count == attempt
        await repo.fail_external_request(
            retrying.request_key,
            claim_token=token,
            status="retryable_failed",
            error_code="temporary",
            error_detail="temporary",
        )
    assert (
        await repo.claim_external_request(
            retrying.request_key,
            claim_token="fourth-owner",
            lease_until=datetime.now(UTC) + timedelta(minutes=5),
        )
        is None
    )

    stale = await repo.prepare_external_request(
        batch_id=batch.id,
        preparation_id=None,
        plan_item_id=None,
        request_key=f"stale-{uuid4().hex}",
        provider="dataforseo",
        endpoint="related_keywords/live",
        request_hash="stale-hash",
        round_number=0,
    )
    stale_claim = await repo.claim_external_request(
        stale.request_key,
        claim_token="stale-owner",
        lease_until=datetime.now(UTC) + timedelta(minutes=5),
    )
    assert stale_claim is not None
    async with sessions() as session:
        row = await session.scalar(
            select(ContentPlanExternalRequest).where(
                ContentPlanExternalRequest.request_key == stale.request_key
            )
        )
        assert row is not None
        row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    uncertain = await repo.mark_stale_submitted_request_uncertain(stale.request_key)
    assert uncertain is not None and uncertain.status == "uncertain"
    assert (
        await repo.claim_external_request(
            stale.request_key,
            claim_token="must-not-retry-uncertain",
            lease_until=datetime.now(UTC) + timedelta(minutes=5),
        )
        is None
    )


async def test_final_order_follows_original_candidate_rank_after_replacements(
    repository,
) -> None:
    repo, _sessions, project_id = repository
    batch = await create_batch(repo, project_id)
    candidates = await repo.save_candidates(
        batch.id,
        [
            {
                "id": f"candidate-{index:02d}-{uuid4().hex}",
                "keyword_id": None,
                "keyword": f"candidate {index:02d}",
                "normalized_keyword": f"candidate {index:02d}",
                "source_rank": index,
                "priority_score_snapshot": 100 - index,
                "coverage_status_snapshot": "uncovered",
                "decision": "kept",
                "selected_plan_order": 31 - index,
            }
            for index in range(1, 31)
        ],
    )
    for candidate in candidates:
        await repo.create_preparation(
            preparation_id=f"preparation-{uuid4().hex}",
            batch_id=batch.id,
            candidate_id=candidate.id,
            plan_order=int(candidate.selected_plan_order),
            seed_keyword=candidate.keyword,
            normalized_seed_keyword=candidate.normalized_keyword,
            source_round="refill_2" if candidate.source_rank > 27 else "initial",
            workflow_id=f"prepare:{uuid4().hex}",
            state="pack_ready",
        )

    await repo.finalize_current_preparation_orders(batch.id)

    preparations = await repo.get_current_preparations(batch.id)
    selected = await repo.get_selected_candidates(batch.id)
    assert [row.plan_order for row in preparations] == list(range(1, 31))
    assert [row.normalized_seed_keyword for row in preparations] == [
        f"candidate {index:02d}" for index in range(1, 31)
    ]
    assert [row.source_rank for row in selected] == list(range(1, 31))


async def create_scheduled_plan_item(
    repository: ContentPlanRepository,
    sessions: async_sessionmaker[AsyncSession],
    project_id: str,
    *,
    suffix: str,
    publish_date: date,
    pinned: bool = False,
    status: str = "scheduled",
    timezone: str = "America/New_York",
) -> ContentPlanItem:
    batch, preparation_id, snapshot_id = await create_plan_item_dependencies(
        repository,
        project_id,
        suffix=suffix,
    )
    row = plan_item(
        item_id=f"scheduled-{suffix}-{uuid4().hex}",
        batch_id=batch.id,
        project_id=project_id,
        preparation_id=preparation_id,
        snapshot_id=snapshot_id,
    )
    slot = make_slot(publish_date, time(10), timezone)
    row.publish_local_date = slot.publish_local_date
    row.publish_local_time = slot.publish_local_time
    row.schedule_timezone = slot.schedule_timezone
    row.publish_at = slot.publish_at
    row.generation_at = slot.generation_at
    row.date_user_pinned = pinned
    row.status = status
    async with sessions() as session:
        session.add(row)
        session.add(
            item_keyword(
                keyword_id=f"scheduled-keyword-{suffix}-{uuid4().hex}",
                item_id=row.id,
                role="primary",
                position=1,
            )
        )
        await session.commit()
    return row


async def create_unscheduled_automatic_batch(
    repository: ContentPlanRepository,
    project_id: str,
    *,
    count: int = 30,
) -> tuple[ContentPlanBatch, list[ContentPlanItem]]:
    batch = await create_batch(repository, project_id, source="automatic")
    items = []
    for index in range(1, count + 1):
        suffix = f"schedule-{index:02d}-{uuid4().hex}"
        preparation = await repository.create_preparation(
            preparation_id=f"preparation-{suffix}",
            batch_id=batch.id,
            candidate_id=None,
            plan_order=index,
            seed_keyword=f"schedule seed {index:02d}",
            normalized_seed_keyword=f"schedule seed {index:02d}",
            source_round="initial",
            workflow_id=f"prepare:{suffix}",
        )
        snapshot = await repository.add_serp_snapshot(
            snapshot_id=f"serp-{suffix}",
            preparation_id=preparation.id,
            primary_keyword=f"schedule keyword {index:02d}",
            country="US",
            language="en",
            provider="dataforseo",
            request_key=f"serp-{suffix}",
            cache_hit=True,
            cost_usd=0,
            provisional_title=f"Schedule title {index:02d}",
            provisional_direction="Explain the scheduled topic.",
        )
        item = await repository.create_plan_item(
            item_id=f"plan-item-{suffix}",
            batch_id=batch.id,
            project_id=project_id,
            source="automatic",
            seed_keyword=f"schedule seed {index:02d}",
            normalized_seed_keyword=f"schedule seed {index:02d}",
            source_rank=index,
            plan_order=index,
            primary_keyword=f"schedule keyword {index:02d}",
            title=f"Schedule title {index:02d}",
            writing_direction="Explain the scheduled topic.",
            current_preparation_id=preparation.id,
            current_serp_snapshot_id=snapshot.id,
            keywords=[
                {
                    "id": f"plan-keyword-{suffix}",
                    "preparation_keyword_id": None,
                    "keyword_id": None,
                    "keyword": f"schedule keyword {index:02d}",
                    "normalized_keyword": f"schedule keyword {index:02d}",
                    "role": "primary",
                    "keyword_type": "informational",
                    "source": "user",
                    "position": 1,
                }
            ],
        )
        items.append(item)
    return batch, items


async def test_thirty_item_batch_schedule_is_atomic_and_ordered(repository) -> None:
    repo, sessions, project_id = repository
    await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_2_3",
        paused=False,
        timezone="Asia/Shanghai",
        default_publish_local_time=time(10),
        cadence_anchor_week=date(2026, 8, 3),
        expected_version=0,
    )
    batch, items = await create_unscheduled_automatic_batch(repo, project_id)

    scheduled = await repo.schedule_batch(
        batch.id, now=datetime(2026, 8, 3, 0, tzinfo=UTC)
    )

    assert [row.plan_order for row in scheduled] == list(range(1, 31))
    dates = [row.publish_local_date for row in scheduled]
    assert len(dates) == len(set(dates)) == 30
    assert dates == sorted(dates)
    assert all(row.status == "scheduled" for row in scheduled)
    async with sessions() as session:
        saved_batch = await session.get(ContentPlanBatch, batch.id)
        saved_items = list(
            (
                await session.scalars(
                    select(ContentPlanItem)
                    .where(ContentPlanItem.id.in_([row.id for row in items]))
                    .order_by(ContentPlanItem.plan_order)
                )
            ).all()
        )
        assert saved_batch is not None and saved_batch.status == "completed"
        assert [row.plan_order for row in saved_items] == list(range(1, 31))


async def test_thirty_item_schedule_failure_rolls_back_every_item(
    repository, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, sessions, project_id = repository
    await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=False,
        timezone="Asia/Shanghai",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    batch, items = await create_unscheduled_automatic_batch(repo, project_id)
    applied = 0
    original_apply = repo._apply_slot

    def fail_midway(item: ContentPlanItem, slot: object) -> None:
        nonlocal applied
        applied += 1
        if applied == 16:
            raise RuntimeError("simulated schedule write failure")
        original_apply(item, slot)

    monkeypatch.setattr(repo, "_apply_slot", fail_midway)
    with pytest.raises(RuntimeError, match="simulated schedule write failure"):
        await repo.schedule_batch(
            batch.id, now=datetime(2026, 8, 3, 0, tzinfo=UTC)
        )

    async with sessions() as session:
        saved_batch = await session.get(ContentPlanBatch, batch.id)
        saved_items = list(
            (
                await session.scalars(
                    select(ContentPlanItem).where(
                        ContentPlanItem.id.in_([row.id for row in items])
                    )
                )
            ).all()
        )
        assert saved_batch is not None
        assert saved_batch.status == "needs_attention"
        assert saved_batch.error_code == "content_plan_scheduling_failed"
        assert all(row.status == "unscheduled" for row in saved_items)
        assert all(row.publish_local_date is None for row in saved_items)


async def test_pausing_settings_does_not_rewrite_any_schedule(repository) -> None:
    repo, sessions, project_id = repository
    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_2_3",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=date(2026, 8, 3),
        expected_version=0,
    )
    item = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="pause",
        publish_date=date(2026, 8, 11),
        pinned=True,
    )
    before = (item.publish_at, item.generation_at, item.schedule_attention_reason)

    updated = await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 20, 12, tzinfo=UTC),
        paused=True,
    )

    async with sessions() as session:
        saved = await session.get(ContentPlanItem, item.id)
        assert saved is not None
        assert (saved.publish_at, saved.generation_at, saved.schedule_attention_reason) == before
    assert updated.paused is True
    assert updated.cadence == "weekly_2_3"
    assert updated.cadence_anchor_week == date(2026, 8, 3)


async def test_resuming_moves_only_expired_unpinned_items(repository) -> None:
    repo, sessions, project_id = repository
    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=True,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    expired_movable = await create_scheduled_plan_item(
        repo, sessions, project_id, suffix="expired-movable", publish_date=date(2026, 8, 4)
    )
    expired_pinned = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="expired-pinned",
        publish_date=date(2026, 8, 5),
        pinned=True,
    )
    future = await create_scheduled_plan_item(
        repo, sessions, project_id, suffix="future", publish_date=date(2026, 8, 20)
    )

    await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 10, 12, tzinfo=UTC),
        paused=False,
    )

    async with sessions() as session:
        moved = await session.get(ContentPlanItem, expired_movable.id)
        pinned = await session.get(ContentPlanItem, expired_pinned.id)
        unchanged = await session.get(ContentPlanItem, future.id)
        assert moved is not None and moved.publish_local_date > date(2026, 8, 10)
        assert pinned is not None and pinned.publish_local_date == date(2026, 8, 5)
        assert pinned.schedule_attention_reason == "expired_user_pinned_date"
        assert unchanged is not None and unchanged.publish_local_date == date(2026, 8, 20)


async def test_timezone_change_keeps_local_date_and_recomputes_utc(repository) -> None:
    repo, sessions, project_id = repository
    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_5",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    item = await create_scheduled_plan_item(
        repo, sessions, project_id, suffix="timezone", publish_date=date(2026, 11, 9)
    )

    await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        timezone_name="Europe/Berlin",
    )

    async with sessions() as session:
        saved = await session.get(ContentPlanItem, item.id)
        assert saved is not None
        assert saved.publish_local_date == date(2026, 11, 9)
        assert saved.publish_local_time == time(10)
        assert saved.schedule_timezone == "Europe/Berlin"
        assert saved.publish_at == datetime(2026, 11, 9, 9, tzinfo=UTC)
        assert saved.generation_at == datetime(2026, 11, 8, 9, tzinfo=UTC)


async def test_cadence_and_timezone_change_compute_one_final_schedule(repository) -> None:
    repo, sessions, project_id = repository
    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    pinned = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="combined-pinned",
        publish_date=date(2026, 8, 17),
        pinned=True,
    )
    first = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="combined-first",
        publish_date=date(2026, 8, 18),
    )
    second = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="combined-second",
        publish_date=date(2026, 8, 19),
    )
    async with sessions() as session:
        first_saved = await session.get(ContentPlanItem, first.id)
        second_saved = await session.get(ContentPlanItem, second.id)
        assert first_saved is not None and second_saved is not None
        first_saved.plan_order = 1
        second_saved.plan_order = 2
        await session.commit()

    updated = await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        cadence="weekly_2_3",
        timezone_name="Asia/Shanghai",
    )

    async with sessions() as session:
        pinned_saved = await session.get(ContentPlanItem, pinned.id)
        first_saved = await session.get(ContentPlanItem, first.id)
        second_saved = await session.get(ContentPlanItem, second.id)
        assert pinned_saved is not None
        assert pinned_saved.publish_local_date == date(2026, 8, 17)
        assert pinned_saved.schedule_timezone == "Asia/Shanghai"
        assert first_saved is not None and second_saved is not None
        assert [first_saved.plan_order, second_saved.plan_order] == [1, 2]
        assert first_saved.publish_local_date < second_saved.publish_local_date
        assert first_saved.publish_local_date != pinned_saved.publish_local_date
        assert first_saved.schedule_timezone == second_saved.schedule_timezone == (
            "Asia/Shanghai"
        )
    assert updated.cadence == "weekly_2_3"
    assert updated.timezone == "Asia/Shanghai"
    assert updated.cadence_anchor_week == date(2026, 8, 3)


async def test_cadence_change_keeps_pinned_and_all_other_occupied_dates(repository) -> None:
    repo, sessions, project_id = repository
    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    pinned = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="cadence-pinned",
        publish_date=date(2026, 8, 10),
        pinned=True,
    )
    generated = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="cadence-generated",
        publish_date=date(2026, 8, 11),
        status="generated",
    )
    movable = await create_scheduled_plan_item(
        repo, sessions, project_id, suffix="cadence-movable", publish_date=date(2026, 8, 12)
    )

    await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        cadence="weekly_5",
    )

    async with sessions() as session:
        pinned_saved = await session.get(ContentPlanItem, pinned.id)
        generated_saved = await session.get(ContentPlanItem, generated.id)
        movable_saved = await session.get(ContentPlanItem, movable.id)
        assert pinned_saved is not None and pinned_saved.publish_local_date == date(2026, 8, 10)
        assert generated_saved is not None and generated_saved.publish_local_date == date(2026, 8, 11)
        assert movable_saved is not None
        assert movable_saved.publish_local_date not in {date(2026, 8, 10), date(2026, 8, 11)}


async def test_due_plan_claim_skips_paused_and_attention_items(repository) -> None:
    repo, sessions, project_id = repository
    await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    due = await create_scheduled_plan_item(
        repo, sessions, project_id, suffix="claim-due", publish_date=date(2026, 8, 5)
    )
    attention = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="claim-attention",
        publish_date=date(2026, 8, 4),
        pinned=True,
    )
    async with sessions() as session:
        saved = await session.get(ContentPlanItem, attention.id)
        assert saved is not None
        saved.schedule_attention_reason = "expired_user_pinned_date"
        await session.commit()

    content = ContentRepository(sessions)
    claimed = await content.claim_due_plan_items(
        now=datetime(2026, 8, 6, 12, tzinfo=UTC), limit=10
    )

    assert [(row.id, organization_id) for row, organization_id in claimed] == [
        (due.id, "content-plan-test-org")
    ]
    assert claimed[0][0].status == "triggering"
    assert claimed[0][0].trigger_lease_until == datetime(
        2026, 8, 6, 12, 5, tzinfo=UTC
    )

    settings = await repo.get_settings(project_id)
    assert settings is not None
    await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        paused=True,
    )
    other_due = await create_scheduled_plan_item(
        repo, sessions, project_id, suffix="claim-paused", publish_date=date(2026, 8, 3)
    )
    assert await content.claim_due_plan_items(
        now=datetime(2026, 8, 6, 12, tzinfo=UTC), limit=10
    ) == []
    async with sessions() as session:
        saved = await session.get(ContentPlanItem, other_due.id)
        assert saved is not None and saved.status == "scheduled"


async def test_plan_article_snapshot_is_complete_and_explicit_ignores_pause(
    repository, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, sessions, project_id = repository
    await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=True,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    item = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="explicit-snapshot",
        publish_date=date(2026, 8, 5),
        pinned=True,
    )
    async with sessions() as session:
        saved = await session.get(ContentPlanItem, item.id)
        assert saved is not None
        saved.title = "Locked content plan title"
        saved.writing_direction = "Explain the workflow with a worked example."
        saved.title_user_edited = True
        saved.direction_user_edited = True
        saved.schedule_attention_reason = "expired_user_pinned_date"
        session.add(
            item_keyword(
                keyword_id=f"secondary-{uuid4().hex}",
                item_id=item.id,
                role="secondary",
                position=2,
            )
        )
        await session.commit()

    article, run = await ContentRepository(sessions).create_article_from_plan(
        "content-plan-test-org",
        project_id,
        item.id,
        expected_version=1,
        model_snapshot={"model": "test-model"},
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        explicit=True,
    )

    snapshot = run.plan_input_snapshot_json
    assert article.plan_item_id == item.id
    assert snapshot["primary_keyword"] == "content planning"
    assert len(snapshot["secondary_keywords"]) == 1
    assert snapshot["title"] == {
        "value": "Locked content plan title",
        "policy": "locked",
    }
    assert snapshot["writing_direction"] == {
        "value": "Explain the workflow with a worked example.",
        "policy": "locked",
    }
    assert snapshot["serp_snapshot"]["id"].startswith("serp-explicit-snapshot")
    assert snapshot["schedule"] == {
        "publish_local_date": "2026-08-05",
        "publish_local_time": "10:00:00",
        "timezone": "America/New_York",
        "publish_at": "2026-08-05T14:00:00+00:00",
        "generation_at": "2026-08-04T14:00:00+00:00",
    }
    dataforseo_calls = 0

    async def search(*_args, **_kwargs):
        nonlocal dataforseo_calls
        dataforseo_calls += 1
        raise AssertionError("content-plan SERP must be reused")

    monkeypatch.setattr(collection.DataForSEOClient, "search", search)
    assert await collection._collect_serp(
        ContentRepository(sessions),
        Settings(app_env="test"),
        run.id,
        article.primary_keyword,
        dict(run.project_snapshot_json),
    ) == (None, 0)
    assert dataforseo_calls == 0
    async with sessions() as session:
        saved = await session.get(ContentPlanItem, item.id)
        serp_source = await session.scalar(
            select(ArticleSource).where(
                ArticleSource.run_id == run.id,
                ArticleSource.source_type == "serp",
            )
        )
        assert saved is not None
        assert saved.status == "generating"
        assert saved.schedule_attention_reason is None
        assert serp_source is not None and serp_source.status == "available"
        assert serp_source.metadata_json["reused"] is True


async def test_explicit_generation_cannot_cross_project_or_create_side_effects(
    repository,
) -> None:
    repo, sessions, project_id = repository
    item = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="cross-project",
        publish_date=date(2026, 8, 5),
    )
    other_project_id = f"content-plan-other-{uuid4().hex}"
    async with sessions() as session:
        session.add(
            Project(
                id=other_project_id,
                organization_id="content-plan-test-org",
                name="Other content plan project",
                domain=f"{uuid4().hex}.example.test",
                country="US",
                language="en",
            )
        )
        run_count_before = await session.scalar(select(func.count(ArticleRun.id)))
        await session.commit()

    try:
        with pytest.raises(LookupError, match="content_plan_item_not_found"):
            await ContentRepository(sessions).create_article_from_plan(
                "content-plan-test-org",
                other_project_id,
                item.id,
                expected_version=item.version,
                model_snapshot={"model": "test-model"},
                now=datetime(2026, 8, 6, 12, tzinfo=UTC),
                explicit=True,
            )

        async with sessions() as session:
            saved = await session.get(ContentPlanItem, item.id)
            article_count = await session.scalar(
                select(func.count(Article.id)).where(Article.plan_item_id == item.id)
            )
            run_count_after = await session.scalar(select(func.count(ArticleRun.id)))
            assert saved is not None
            assert saved.status == item.status
            assert saved.article_id is None
            assert saved.version == item.version
            assert article_count == 0
            assert run_count_after == run_count_before
    finally:
        async with sessions() as session:
            await session.execute(
                delete(Project).where(Project.id == other_project_id)
            )
            await session.commit()


async def test_two_workers_create_only_one_article_and_current_run(repository) -> None:
    repo, sessions, project_id = repository
    await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    item = await create_scheduled_plan_item(
        repo, sessions, project_id, suffix="concurrent", publish_date=date(2026, 8, 5)
    )
    content = ContentRepository(sessions)
    first_claim, second_claim = await asyncio.gather(
        content.claim_due_plan_items(
            now=datetime(2026, 8, 6, 12, tzinfo=UTC), limit=1
        ),
        content.claim_due_plan_items(
            now=datetime(2026, 8, 6, 12, tzinfo=UTC), limit=1
        ),
    )
    claimed = first_claim + second_claim
    assert len(claimed) == 1

    article, run = await content.create_article_from_plan(
        "content-plan-test-org",
        project_id,
        item.id,
        expected_version=1,
        model_snapshot={"model": "test-model"},
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        explicit=False,
    )
    replay_article, replay_run = await content.create_article_from_plan(
        "content-plan-test-org",
        project_id,
        item.id,
        expected_version=1,
        model_snapshot={"model": "test-model"},
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        explicit=False,
    )

    assert (replay_article.id, replay_run.id) == (article.id, run.id)
    async with sessions() as session:
        assert len(
            list(
                (
                    await session.scalars(
                        select(Article).where(Article.plan_item_id == item.id)
                    )
                ).all()
            )
        ) == 1
        assert len(
            list(
                (
                    await session.scalars(
                        select(ArticleRun).where(ArticleRun.article_id == article.id)
                    )
                ).all()
            )
        ) == 1


async def create_reviewable_article(
    sessions: async_sessionmaker[AsyncSession],
    project_id: str,
    *,
    suffix: str,
    publication_status: str = "publish_ready",
) -> tuple[Article, ArticleRun]:
    article_id = f"review-article-{suffix}-{uuid4().hex}"
    run_id = f"review-run-{suffix}-{uuid4().hex}"
    article = Article(
        id=article_id,
        organization_id="content-plan-test-org",
        project_id=project_id,
        primary_keyword=f"review keyword {suffix}",
        status="completed",
        publication_status=publication_status,
        review_status="pending_review",
        review_version=1,
        publication_blocked_reason="awaiting_review",
        current_run_id=run_id,
    )
    run = ArticleRun(
        id=run_id,
        article_id=article_id,
        organization_id="content-plan-test-org",
        project_id=project_id,
        workflow_id=f"article-generation:{run_id}",
        status="completed",
        stage="completed",
        progress=100,
    )
    async with sessions() as session:
        session.add_all([article, run])
        await session.commit()
    return article, run


async def test_concurrent_review_keeps_one_immutable_decision(repository) -> None:
    _repo, sessions, project_id = repository
    article, _run = await create_reviewable_article(
        sessions, project_id, suffix="concurrent"
    )
    content = ContentRepository(sessions)

    results = await asyncio.gather(
        content.review_article(
            "content-plan-test-org",
            project_id,
            article.id,
            decision="approved",
            review_note=None,
            expected_version=1,
            reviewed_by="reviewer-a",
        ),
        content.review_article(
            "content-plan-test-org",
            project_id,
            article.id,
            decision="changes_requested",
            review_note="Revise the example",
            expected_version=1,
            reviewed_by="reviewer-b",
        ),
        return_exceptions=True,
    )

    assert sum(not isinstance(result, Exception) for result in results) == 1
    failures = [result for result in results if isinstance(result, Exception)]
    assert len(failures) == 1 and str(failures[0]) == "stale_review_version"
    async with sessions() as session:
        decisions = list(
            (
                await session.scalars(
                    select(ArticleReviewDecision).where(
                        ArticleReviewDecision.article_id == article.id
                    )
                )
            ).all()
        )
        saved = await session.get(Article, article.id)
        assert len(decisions) == 1
        assert saved is not None
        assert decisions[0].decision == saved.review_status
        assert decisions[0].reviewed_by == saved.reviewed_by


async def test_review_requires_note_and_applies_publication_block_priority(repository) -> None:
    repo, sessions, project_id = repository
    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    changes, _ = await create_reviewable_article(
        sessions, project_id, suffix="changes"
    )
    quality, _ = await create_reviewable_article(
        sessions,
        project_id,
        suffix="quality",
        publication_status="complete_draft",
    )
    paused, _ = await create_reviewable_article(
        sessions, project_id, suffix="paused"
    )
    content = ContentRepository(sessions)

    with pytest.raises(ValueError, match="review_note_required"):
        await content.review_article(
            "content-plan-test-org",
            project_id,
            changes.id,
            decision="changes_requested",
            review_note="   ",
            expected_version=1,
            reviewed_by="reviewer",
        )
    changed, _ = await content.review_article(
        "content-plan-test-org",
        project_id,
        changes.id,
        decision="changes_requested",
        review_note="Revise the workflow",
        expected_version=1,
        reviewed_by="reviewer",
    )
    quality_approved, _ = await content.review_article(
        "content-plan-test-org",
        project_id,
        quality.id,
        decision="approved",
        review_note=None,
        expected_version=1,
        reviewed_by="reviewer",
    )
    await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        paused=True,
    )
    paused_approved, _ = await content.review_article(
        "content-plan-test-org",
        project_id,
        paused.id,
        decision="approved",
        review_note=None,
        expected_version=1,
        reviewed_by="reviewer",
    )

    assert changed.publication_blocked_reason == "changes_requested"
    assert quality_approved.publication_blocked_reason == "quality_not_ready"
    assert paused_approved.publication_blocked_reason == "publishing_paused"


async def test_pause_and_resume_recompute_existing_article_delivery_blocks(repository) -> None:
    repo, sessions, project_id = repository
    settings = await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_2_3",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=date(2026, 8, 3),
        expected_version=0,
    )
    changes, _ = await create_reviewable_article(
        sessions, project_id, suffix="pause-sync-changes"
    )
    pending, _ = await create_reviewable_article(
        sessions, project_id, suffix="pause-sync-pending"
    )
    quality, _ = await create_reviewable_article(
        sessions,
        project_id,
        suffix="pause-sync-quality",
        publication_status="complete_draft",
    )
    ready, _ = await create_reviewable_article(
        sessions, project_id, suffix="pause-sync-ready"
    )
    async with sessions() as session:
        changes_saved = await session.get(Article, changes.id)
        quality_saved = await session.get(Article, quality.id)
        ready_saved = await session.get(Article, ready.id)
        assert changes_saved is not None
        assert quality_saved is not None
        assert ready_saved is not None
        changes_saved.review_status = "changes_requested"
        changes_saved.publication_blocked_reason = "changes_requested"
        quality_saved.review_status = "approved"
        quality_saved.publication_blocked_reason = "quality_not_ready"
        ready_saved.review_status = "approved"
        ready_saved.publication_blocked_reason = None
        await session.commit()

    paused_settings = await repo.update_settings(
        project_id,
        expected_version=settings.version,
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        paused=True,
    )
    async with sessions() as session:
        paused_rows = {
            row.id: row.publication_blocked_reason
            for row in (
                await session.scalars(
                    select(Article).where(
                        Article.id.in_([changes.id, pending.id, quality.id, ready.id])
                    )
                )
            ).all()
        }
    assert paused_rows == {
        changes.id: "changes_requested",
        pending.id: "awaiting_review",
        quality.id: "quality_not_ready",
        ready.id: "publishing_paused",
    }

    await repo.update_settings(
        project_id,
        expected_version=paused_settings.version,
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        paused=False,
    )
    async with sessions() as session:
        resumed_rows = {
            row.id: row.publication_blocked_reason
            for row in (
                await session.scalars(
                    select(Article).where(
                        Article.id.in_([changes.id, pending.id, quality.id, ready.id])
                    )
                )
            ).all()
        }
    assert resumed_rows == {
        changes.id: "changes_requested",
        pending.id: "awaiting_review",
        quality.id: "quality_not_ready",
        ready.id: None,
    }


async def test_locked_direction_failure_keeps_generated_plan_as_review_draft(
    repository,
) -> None:
    repo, sessions, project_id = repository
    await repo.upsert_settings(
        project_id=project_id,
        cadence="weekly_7",
        paused=False,
        timezone="America/New_York",
        default_publish_local_time=time(10),
        cadence_anchor_week=None,
        expected_version=0,
    )
    item = await create_scheduled_plan_item(
        repo,
        sessions,
        project_id,
        suffix="locked-failure",
        publish_date=date(2026, 8, 10),
    )
    requirement = "Explain the workflow with one complete worked example."
    async with sessions() as session:
        saved = await session.get(ContentPlanItem, item.id)
        assert saved is not None
        saved.title = "Locked Workflow Title"
        saved.writing_direction = requirement
        saved.title_user_edited = True
        saved.direction_user_edited = True
        await session.commit()

    content = ContentRepository(sessions)
    article, run = await content.create_article_from_plan(
        "content-plan-test-org",
        project_id,
        item.id,
        expected_version=1,
        model_snapshot={"model": "test-model"},
        now=datetime(2026, 8, 6, 12, tzinfo=UTC),
        explicit=True,
    )
    await content.finish_run(
        run.id,
        "completed",
        [],
        artifact={
            "title": "Locked Workflow Title",
            "slug": "locked-workflow-title",
            "meta_title": "Locked Workflow Title",
            "meta_description": "A complete workflow guide.",
            "plan": {"sections": []},
            "sections": [],
            "quality": {
                "passed": True,
                "issues": [],
                "locked_requirement_checks": [
                    {
                        "field": "writing_direction",
                        "requirement": requirement,
                        "passed": False,
                        "evidence": "The draft has no worked example.",
                    }
                ],
            },
            "markdown": "# Locked Workflow Title\n\nDraft without an example.\n",
        },
        html="<h1>Locked Workflow Title</h1><p>Draft without an example.</p>",
        final_content_ref="s3://test/locked-failure.md",
    )

    async with sessions() as session:
        saved_run = await session.get(ArticleRun, run.id)
        saved_article = await session.get(Article, article.id)
        saved_item = await session.get(ContentPlanItem, item.id)
        assert saved_run is not None
        assert saved_run.status == "completed_with_warnings"
        assert {row["code"] for row in saved_run.warnings_json} == {
            "locked_requirement_failed"
        }
        assert saved_article is not None
        assert saved_article.publication_status == "complete_draft"
        assert saved_article.review_status == "pending_review"
        assert saved_article.publication_blocked_reason == "awaiting_review"
        assert saved_item is not None and saved_item.status == "generated"


async def test_new_completed_run_invalidates_approval_and_keeps_review_history(
    repository,
) -> None:
    _repo, sessions, project_id = repository
    article, first_run = await create_reviewable_article(
        sessions, project_id, suffix="new-draft"
    )
    content = ContentRepository(sessions)
    approved, _ = await content.review_article(
        "content-plan-test-org",
        project_id,
        article.id,
        decision="approved",
        review_note="Version one approved",
        expected_version=1,
        reviewed_by="reviewer-v1",
    )
    second_run_id = f"review-run-new-draft-v2-{uuid4().hex}"
    async with sessions() as session:
        saved_article = await session.get(Article, approved.id)
        assert saved_article is not None
        saved_article.current_run_id = second_run_id
        session.add(
            ArticleRun(
                id=second_run_id,
                article_id=saved_article.id,
                organization_id="content-plan-test-org",
                project_id=project_id,
                workflow_id=f"article-generation:{second_run_id}",
                status="queued",
                stage="queued",
                progress=0,
            )
        )
        await session.commit()

    await content.finish_run(
        second_run_id,
        "completed",
        [],
        artifact={
            "title": "Review keyword new draft",
            "slug": "review-keyword-new-draft",
            "meta_title": "Review keyword new draft",
            "meta_description": "Version two.",
            "plan": {"sections": []},
            "sections": [],
            "quality": {"passed": True, "issues": []},
            "markdown": "# Review keyword new draft\n\nVersion two.\n",
        },
        html="<h1>Review keyword new draft</h1><p>Version two.</p>",
        final_content_ref="s3://test/review-v2.md",
    )

    async with sessions() as session:
        saved = await session.get(Article, article.id)
        decisions = list(
            (
                await session.scalars(
                    select(ArticleReviewDecision).where(
                        ArticleReviewDecision.article_id == article.id
                    )
                )
            ).all()
        )
        assert saved is not None
        assert saved.review_version == 2
        assert saved.review_status == "pending_review"
        assert saved.review_note is None
        assert saved.reviewed_at is None
        assert saved.reviewed_by is None
        assert saved.publication_blocked_reason == "awaiting_review"
        assert len(decisions) == 1
        assert decisions[0].article_run_id == first_run.id
        assert decisions[0].decision == "approved"
        assert decisions[0].reviewed_by == "reviewer-v1"
