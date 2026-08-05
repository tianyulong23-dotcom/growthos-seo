from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from time import perf_counter
from uuid import uuid4

import asyncpg
import pytest

from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.domain import MergedCandidate, RawKeyword
from seo_workers.keywords.repository import (
    KeywordCommitResult,
    KeywordRepository,
    KeywordRunContext,
    _configure_connection,
)

pytestmark = pytest.mark.anyio


def _database_url() -> str:
    value = os.getenv("KEYWORD_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("KEYWORD_TEST_DATABASE_URL is required for PostgreSQL tests")
    return value.replace("postgresql+asyncpg://", "postgresql://", 1)


@asynccontextmanager
async def _repository_context() -> AsyncIterator[
    tuple[KeywordRepository, KeywordRunContext, asyncpg.Pool, str]
]:
    database_url = _database_url()
    pool = await asyncpg.create_pool(
        dsn=database_url,
        min_size=1,
        max_size=2,
        command_timeout=30,
        init=_configure_connection,
    )
    token = uuid4().hex
    organization_id = f"keyword-integration-org-{token}"
    project_id = f"keyword-integration-project-{token}"
    run_id = f"keyword-integration-run-{token}"
    seed_id = f"keyword-integration-seed-{token}"
    try:
        async with pool.acquire() as connection, connection.transaction():
            await connection.execute(
                """
                INSERT INTO projects (
                    id, organization_id, name, domain, country, language
                )
                VALUES ($1, $2, $3, $4, 'US', 'en')
                """,
                project_id,
                organization_id,
                "Keyword integration test",
                f"{token}.example.test",
            )
            await connection.execute(
                """
                INSERT INTO keyword_build_runs (
                    id,
                    organization_id,
                    project_id,
                    kind,
                    round_number,
                    status,
                    stage,
                    gap_status
                )
                VALUES ($1, $2, $3, 'initial', 1, 'running', 'commit', 'not_requested')
                """,
                run_id,
                organization_id,
                project_id,
            )
            await connection.execute(
                """
                INSERT INTO keyword_seeds (
                    id,
                    organization_id,
                    project_id,
                    initial_run_id,
                    keyword,
                    normalized_keyword,
                    candidate_rank,
                    decision,
                    ai_rank,
                    expansion_status
                )
                VALUES ($1, $2, $3, $4, 'integration seed', 'integration seed',
                        1, 'selected', 1, 'not_applicable')
                """,
                seed_id,
                organization_id,
                project_id,
                run_id,
            )

        settings = KeywordWorkerSettings(database_url=database_url)
        repository = KeywordRepository(pool, settings)
        context = KeywordRunContext(
            organization_id=organization_id,
            project_id=project_id,
            run_id=run_id,
            kind="initial",
            round_number=1,
            domain=f"{token}.example.test",
            country="US",
            language="en",
            competitor_domain=None,
            profile={},
            profile_source="integration_test",
            profile_version="1",
        )
        yield repository, context, pool, seed_id
    finally:
        async with pool.acquire() as connection:
            await connection.execute("DELETE FROM projects WHERE id = $1", project_id)
        await pool.close()


def _records(
    seed_id: str,
    count: int,
    *,
    metric: dict[str, object] | None = None,
    metrics_status: str | None = None,
    invalid_seed_at: int | None = None,
) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for index in range(count):
        keyword = f"integration keyword {index:04d}"
        record_seed_id = (
            f"missing-seed-{uuid4().hex}" if index == invalid_seed_at else seed_id
        )
        raw = RawKeyword(
            keyword=keyword,
            source="labs_site",
            provider_rank=index + 1,
            source_seed_id=None,
            search_volume=1000 - index,
            raw_payload={"test_index": index},
        )
        candidate = MergedCandidate(
            keyword=keyword,
            normalized_keyword=keyword,
            rows=[raw],
            relevance=1.0,
            included=True,
        )
        records.append(
            {
                "candidate": candidate,
                "business_topic": "integration",
                "classification_confidence": 0.95,
                "review_status": "approved",
                "primary_seed_id": record_seed_id,
                "priority_score": 75.0,
                "priority_confidence": 0.9,
                "priority_details": {"test": True},
                "score_version": "integration-v1",
                "metrics_status": metrics_status or ("fresh" if metric else "pending"),
                "metric": dict(metric) if metric else None,
                "source_seed_ids": [record_seed_id],
                "relations": [(record_seed_id, 1.0, "integration_test")],
            }
        )
    return records


async def _project_counts(pool: asyncpg.Pool, project_id: str) -> dict[str, int]:
    async with pool.acquire() as connection:
        row = await connection.fetchrow(
            """
            SELECT
                (SELECT count(*) FROM keywords WHERE project_id = $1) AS keywords,
                (
                    SELECT count(*)
                    FROM keyword_metrics AS metric
                    JOIN keywords AS keyword ON keyword.id = metric.keyword_id
                    WHERE keyword.project_id = $1
                ) AS metrics,
                (
                    SELECT count(*)
                    FROM keyword_sources AS source
                    JOIN keywords AS keyword ON keyword.id = source.keyword_id
                    WHERE keyword.project_id = $1
                ) AS sources,
                (
                    SELECT count(*)
                    FROM keyword_seed_relations AS relation
                    JOIN keywords AS keyword ON keyword.id = relation.keyword_id
                    WHERE keyword.project_id = $1
                ) AS relations
            """,
            project_id,
        )
    return {name: int(row[name]) for name in ("keywords", "metrics", "sources", "relations")}


async def _metric_refresh_job(
    pool: asyncpg.Pool,
    run_id: str,
) -> asyncpg.Record | None:
    async with pool.acquire() as connection:
        return await connection.fetchrow(
            """
            SELECT status, attempt_count, orphan_replay_count,
                   workflow_id, task_payload
            FROM keyword_metric_refresh_jobs
            WHERE run_id = $1
            """,
            run_id,
        )


async def test_profile_seed_source_can_be_persisted() -> None:
    async with _repository_context() as (repository, context, _pool, _seed_id):
        saved = await repository.save_ideas(
            context,
            [
                RawKeyword(
                    keyword="confirmed profile offering",
                    source="profile_seed",
                    provider_rank=1,
                )
            ],
        )

        rows = await repository.request_ideas(context.run_id, "profile_seed")

        assert saved == 1
        assert [row.keyword for row in rows] == ["confirmed profile offering"]


async def test_commit_500_keywords_is_fast_and_idempotent() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        metric = {
            "search_volume": 500,
            "cpc": 1.25,
            "competition": 0.4,
            "competition_level": "MEDIUM",
            "keyword_difficulty": 35,
            "intent": "informational",
            "monthly_searches": [{"year": 2026, "month": 7, "search_volume": 500}],
            "raw_payload": {"source": "integration_test"},
        }
        records = _records(seed_id, 500, metric=metric)

        started_at = perf_counter()
        first_result = await repository.commit_keywords(context, records)
        elapsed = perf_counter() - started_at
        second_result = await repository.commit_keywords(context, records)

        assert elapsed < 10
        assert first_result == KeywordCommitResult(
            result_version=1,
            keyword_count=500,
            pending_metrics_count=0,
        )
        assert second_result.keyword_count == 500
        assert second_result.pending_metrics_count == 0
        assert await _metric_refresh_job(pool, context.run_id) is None
        assert await _project_counts(pool, context.project_id) == {
            "keywords": 500,
            "metrics": 500,
            "sources": 500,
            "relations": 500,
        }


async def test_failure_in_second_batch_rolls_back_first_batch() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        records = _records(seed_id, 101, invalid_seed_at=100)

        with pytest.raises(asyncpg.ForeignKeyViolationError):
            await repository.commit_keywords(context, records)

        assert await _project_counts(pool, context.project_id) == {
            "keywords": 0,
            "metrics": 0,
            "sources": 0,
            "relations": 0,
        }
        assert await _metric_refresh_job(pool, context.run_id) is None


async def test_pending_metrics_create_one_durable_refresh_job() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        records = _records(seed_id, 3, metrics_status="pending")

        first_result = await repository.commit_keywords(context, records)
        first_job = await _metric_refresh_job(pool, context.run_id)
        assert first_result.keyword_count == 3
        assert first_result.pending_metrics_count == 3
        assert first_job is not None
        assert first_job["status"] == "waiting"
        assert first_job["attempt_count"] == 0
        assert first_job["workflow_id"] == f"keyword-metrics:{context.run_id}:1"
        assert first_job["task_payload"]["run_id"] == context.run_id

        async with pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_metric_refresh_jobs
                SET status = 'running', attempt_count = 1
                WHERE run_id = $1
                """,
                context.run_id,
            )

        second_result = await repository.commit_keywords(context, records)
        second_job = await _metric_refresh_job(pool, context.run_id)
        assert second_result.keyword_count == 3
        assert second_result.pending_metrics_count == 3
        assert second_job is not None
        assert second_job["status"] == "running"
        assert second_job["attempt_count"] == 1


async def test_incomplete_metric_cannot_be_committed_as_fresh() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        incomplete_metric = {
            "search_volume": 500,
            "cpc": 1.25,
            "competition": 0.4,
            "competition_level": "MEDIUM",
            "keyword_difficulty": None,
            "intent": None,
            "monthly_searches": [],
            "raw_payload": {"incomplete": True},
        }

        result = await repository.commit_keywords(
            context,
            _records(
                seed_id,
                1,
                metric=incomplete_metric,
                metrics_status="fresh",
            ),
        )

        async with pool.acquire() as connection:
            metrics_status = await connection.fetchval(
                "SELECT metrics_status FROM keywords WHERE project_id = $1",
                context.project_id,
            )
        assert result.keyword_count == 1
        assert result.pending_metrics_count == 0
        assert metrics_status == "failed"
        assert await _metric_refresh_job(pool, context.run_id) is None


async def test_metric_refresh_job_persists_attempts_and_fences_old_workflows() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        await repository.commit_keywords(
            context,
            _records(seed_id, 1, metrics_status="pending"),
        )
        first_workflow_id = f"keyword-metrics:{context.run_id}:1"
        first_task = {
            "run_id": context.run_id,
            "_metric_workflow_id": first_workflow_id,
        }

        started = await repository.start_metric_refresh_job(first_task)
        assert started == {
            "attempt": 1,
            "status": "running",
            "started": True,
        }
        assert await repository.start_metric_refresh_job(first_task) == started
        async with pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_metric_refresh_jobs
                SET orphan_replay_count = 2
                WHERE run_id = $1
                """,
                context.run_id,
            )

        scheduled = await repository.schedule_metric_refresh_retry(
            context,
            expected_workflow_id=first_workflow_id,
            attempt_count=1,
            code="network_error",
            detail="temporary failure",
        )
        second_workflow_id = str(scheduled["workflow_id"])
        assert scheduled["next_attempt_seconds"] == 1800
        scheduled_job = await _metric_refresh_job(pool, context.run_id)
        assert scheduled_job is not None
        assert scheduled_job["orphan_replay_count"] == 0

        with pytest.raises(RuntimeError, match="状态已经变化"):
            await repository.finish_metric_refresh_job(
                context,
                expected_workflow_id=first_workflow_id,
                exhausted=False,
            )

        second_task = {
            "run_id": context.run_id,
            "_metric_workflow_id": second_workflow_id,
        }
        assert await repository.start_metric_refresh_job(second_task) == {
            "attempt": 2,
            "status": "running",
            "started": True,
        }
        await repository.finish_metric_refresh_job(
            context,
            expected_workflow_id=second_workflow_id,
            exhausted=True,
            code="keyword_metrics_incomplete",
            detail="incomplete",
        )
        terminal = await repository.start_metric_refresh_job(second_task)
        assert terminal == {
            "attempt": 2,
            "status": "exhausted",
            "started": False,
        }

        job = await _metric_refresh_job(pool, context.run_id)
        assert job is not None
        assert job["status"] == "exhausted"
        assert job["attempt_count"] == 2


async def test_incomplete_retry_preserves_fresh_metrics() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        complete_metric = {
            "search_volume": 880,
            "cpc": 2.5,
            "competition": 0.65,
            "competition_level": "HIGH",
            "keyword_difficulty": 48,
            "intent": "commercial",
            "monthly_searches": [{"year": 2026, "month": 7, "search_volume": 880}],
            "raw_payload": {"complete": True},
        }
        await repository.commit_keywords(
            context,
            _records(seed_id, 1, metric=complete_metric),
        )
        await repository.commit_keywords(context, _records(seed_id, 1))

        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT
                    keyword.metrics_status,
                    metric.search_volume,
                    metric.keyword_difficulty,
                    metric.intent,
                    metric.monthly_searches,
                    metric.raw_payload
                FROM keywords AS keyword
                JOIN keyword_metrics AS metric ON metric.keyword_id = keyword.id
                WHERE keyword.project_id = $1
                """,
                context.project_id,
            )

        assert row["metrics_status"] == "fresh"
        assert row["search_volume"] == 880
        assert row["keyword_difficulty"] == 48
        assert row["intent"] == "commercial"
        assert row["monthly_searches"] == [
            {"year": 2026, "month": 7, "search_volume": 880}
        ]
        assert row["raw_payload"] == {"complete": True}


async def test_background_recovery_merges_metrics_and_clears_metric_failure() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        site_metric = {
            "search_volume": 720,
            "cpc": 1.4,
            "competition": 0.35,
            "competition_level": "MEDIUM",
            "keyword_difficulty": None,
            "intent": None,
            "monthly_searches": [{"year": 2026, "month": 7, "search_volume": 720}],
            "raw_payload": {"site_metric": True},
        }
        await repository.commit_keywords(
            context,
            _records(
                seed_id,
                1,
                metric=site_metric,
                metrics_status="pending",
            ),
        )
        other_run_id = f"other-run-{uuid4().hex}"
        other_keyword_id = f"other-keyword-{uuid4().hex}"
        async with pool.acquire() as connection:
            finished_before = await connection.fetchval(
                "SELECT finished_at FROM keyword_build_runs WHERE id = $1",
                context.run_id,
            )
            await connection.execute(
                """
                INSERT INTO keyword_build_runs (
                    id, organization_id, project_id, kind, round_number,
                    status, stage, gap_status
                )
                VALUES ($1, $2, $3, 'initial', 2, 'completed', 'completed',
                        'not_requested')
                """,
                other_run_id,
                context.organization_id,
                context.project_id,
            )
            await connection.execute(
                """
                INSERT INTO keywords (
                    id, organization_id, project_id, country, language,
                    keyword, normalized_keyword, metrics_status,
                    first_build_run_id, last_build_run_id
                )
                VALUES ($1, $2, $3, $4, $5, 'other pending keyword',
                        'other pending keyword', 'pending', $6, $6)
                """,
                other_keyword_id,
                context.organization_id,
                context.project_id,
                context.country,
                context.language,
                other_run_id,
            )
        await repository.record_partial_failure(
            context.run_id,
            source="keyword_overview",
            code="provider_unavailable",
            message="temporary provider failure",
        )

        result = await repository.finish_pending_metrics(
            context,
            ["integration keyword 0000"],
            [
                RawKeyword(
                    keyword="integration keyword 0000",
                    source="keyword_overview",
                    keyword_difficulty=41,
                    intent="informational",
                    raw_payload={"overview_metric": True},
                )
            ],
            failed=False,
        )

        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT
                    keyword.metrics_status,
                    keyword.priority_score,
                    keyword.score_version,
                    metric.search_volume,
                    metric.keyword_difficulty,
                    metric.intent,
                    metric.monthly_searches,
                    metric.raw_payload,
                    run.partial_failures,
                    run.status,
                    run.finished_at
                FROM keywords AS keyword
                JOIN keyword_metrics AS metric ON metric.keyword_id = keyword.id
                JOIN keyword_build_runs AS run ON run.id = keyword.last_build_run_id
                WHERE keyword.project_id = $1
                    AND keyword.normalized_keyword = 'integration keyword 0000'
                """,
                context.project_id,
            )
            project_pending_count = await connection.fetchval(
                """
                SELECT count(*)
                FROM keywords
                WHERE project_id = $1 AND metrics_status = 'pending'
                """,
                context.project_id,
            )

        assert result["updated"] == 1
        assert result["pending_metrics_count"] == 0
        assert project_pending_count == 1
        assert row["metrics_status"] == "fresh"
        assert row["search_volume"] == 720
        assert row["keyword_difficulty"] == 41
        assert row["intent"] == "informational"
        assert row["monthly_searches"] == [
            {"year": 2026, "month": 7, "search_volume": 720}
        ]
        assert row["raw_payload"] == {
            "site_metric": True,
            "overview_metric": True,
        }
        assert row["priority_score"] is not None
        assert row["score_version"] is not None
        assert row["partial_failures"] == []
        assert row["status"] == "completed"
        assert row["finished_at"] == finished_before
