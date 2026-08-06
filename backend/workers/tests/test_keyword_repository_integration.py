from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from time import perf_counter
from uuid import uuid4

import asyncpg
import pytest

from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.domain import MergedCandidate, RawKeyword
from seo_workers.keywords.repository import (
    CompetitorAnalysisContext,
    KeywordCommitResult,
    KeywordRepository,
    KeywordRunContext,
    _configure_connection,
)
from seo_workers.keywords.providers import CompetitorGap, DiscoveredCompetitor

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
            await connection.execute(
                """
                DELETE FROM keyword_competitor_site_verifications
                WHERE organization_id = $1
                """,
                organization_id,
            )
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
        record_seed_id = f"missing-seed-{uuid4().hex}" if index == invalid_seed_at else seed_id
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


async def test_provider_completed_null_metric_can_be_committed_as_fresh() -> None:
    async with _repository_context() as (repository, context, pool, seed_id):
        completed_null_metric = {
            "search_volume": 500,
            "cpc": 1.25,
            "competition": 0.4,
            "competition_level": "MEDIUM",
            "keyword_difficulty": None,
            "intent": None,
            "monthly_searches": [],
            "raw_payload": {
                "provider_request_completed": True,
                "provider_null_fields": ["keyword_difficulty", "intent"],
            },
        }

        result = await repository.commit_keywords(
            context,
            _records(
                seed_id,
                1,
                metric=completed_null_metric,
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
        assert metrics_status == "fresh"
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
        assert row["monthly_searches"] == [{"year": 2026, "month": 7, "search_volume": 880}]
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
        assert row["monthly_searches"] == [{"year": 2026, "month": 7, "search_volume": 720}]
        assert row["raw_payload"] == {
            "site_metric": True,
            "overview_metric": True,
        }
        assert row["priority_score"] is not None
        assert row["score_version"] is not None
        assert row["partial_failures"] == []
        assert row["status"] == "completed"
        assert row["finished_at"] == finished_before


async def test_competitor_analysis_context_uses_run_market_snapshot() -> None:
    async with _repository_context() as (repository, keyword_context, pool, _):
        analysis_run_id = f"competitor-snapshot-{uuid4().hex}"
        async with pool.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO keyword_competitor_analysis_runs (
                    id, organization_id, project_id, workflow_id,
                    target_domain, country, language,
                    status, stage, competitor_limit, keyword_limit
                )
                VALUES ($1, $2, $3, $4, 'snapshot.example', 'CA', 'fr',
                        'queued', 'queued', 5, 100)
                """,
                analysis_run_id,
                keyword_context.organization_id,
                keyword_context.project_id,
                f"keywords:competitor-analysis:{analysis_run_id}",
            )
            await connection.execute(
                """
                UPDATE projects
                SET domain = 'changed.example', country = 'DE', language = 'de'
                WHERE id = $1
                """,
                keyword_context.project_id,
            )

        context = await repository.load_competitor_analysis_context(
            {
                "organization_id": keyword_context.organization_id,
                "project_id": keyword_context.project_id,
                "run_id": analysis_run_id,
            }
        )

        assert context.domain == "snapshot.example"
        assert context.country == "CA"
        assert context.language == "fr"

        finalized = await repository.finalize_competitor_analysis(context)
        assert finalized["status"] == "completed"
        async with pool.acquire() as connection:
            empty_result = await connection.fetchrow(
                """
                SELECT status, stage, error_code, unique_keyword_count
                FROM keyword_competitor_analysis_runs
                WHERE id = $1
                """,
                analysis_run_id,
            )
        assert empty_result["status"] == "completed"
        assert empty_result["stage"] == "completed"
        assert empty_result["error_code"] is None
        assert empty_result["unique_keyword_count"] == 0


async def test_competitor_analysis_repository_persists_partial_five_by_one_hundred_run() -> None:
    async with _repository_context() as (repository, keyword_context, pool, _):
        analysis_run_id = f"competitor-analysis-{uuid4().hex}"
        async with pool.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO keyword_competitor_analysis_runs (
                    id, organization_id, project_id, workflow_id,
                    target_domain, country, language,
                    status, stage, competitor_limit, keyword_limit
                )
                VALUES ($1, $2, $3, $4, $5, 'US', 'en',
                        'running', 'discovering_competitors', 5, 100)
                """,
                analysis_run_id,
                keyword_context.organization_id,
                keyword_context.project_id,
                f"keywords:competitor-analysis:{analysis_run_id}",
                keyword_context.domain,
            )
        context = CompetitorAnalysisContext(
            organization_id=keyword_context.organization_id,
            project_id=keyword_context.project_id,
            run_id=analysis_run_id,
            domain=keyword_context.domain,
            country="US",
            language="en",
            competitor_limit=5,
            keyword_limit=100,
        )
        discovered = [
            DiscoveredCompetitor(
                domain=f"competitor-{index}.example",
                provider_rank=index,
                avg_position=10 + index,
                median_position=8 + index,
                rating=100 - index,
                etv=20000,
                keywords_count=5,
                visibility=10,
                relevant_serp_items=5,
                keywords_positions={},
                raw_payload={"index": index},
            )
            for index in range(1, 11)
        ]
        competitors = await repository.save_discovered_competitors(
            context,
            discovered,
            cost_usd=0.0126,
        )
        assert len(competitors) == 5

        metric_snapshot_start = datetime(2026, 8, 4, 10, 0, tzinfo=UTC)
        for index, competitor in enumerate(competitors, start=1):
            await repository.mark_competitor_started(context, competitor["id"])
            if index == 5:
                await repository.fail_competitor(
                    context,
                    competitor["id"],
                    code="provider_unavailable",
                    detail="temporary failure",
                    cost_usd=0.024,
                )

        async def save_overlapping_opportunities(index: int, competitor: dict[str, str]) -> int:
            rows = [
                CompetitorGap(
                    keyword=f"solar opportunity keyword {position}",
                    provider_rank=position,
                    competitor_rank=index,
                    own_rank=None,
                    competitor_url=f"https://{competitor['domain']}/solar/{position}",
                    own_url=None,
                    search_volume=None if index == 4 else 2400,
                    cpc=4.2,
                    competition=0.7,
                    competition_level="LOW" if index == 4 else "HIGH",
                    keyword_difficulty=None if index == 4 else 42,
                    intent="commercial",
                    monthly_searches=[],
                    raw_payload={"index": index, "position": position},
                    metrics_fetched_at=metric_snapshot_start + timedelta(minutes=index),
                )
                for position in range(1, 101)
            ]
            if index % 2 == 0:
                rows.reverse()
            return await repository.save_competitor_opportunities(
                context, competitor["id"], rows, cost_usd=0.024
            )

        counts = await asyncio.gather(
            *(
                save_overlapping_opportunities(index, competitor)
                for index, competitor in enumerate(competitors[:4], start=1)
            )
        )
        assert counts == [100, 100, 100, 100]

        result = await repository.finalize_competitor_analysis(context)

        assert result["status"] == "partial"
        assert result["raw_keyword_count"] == 400
        assert result["unique_keyword_count"] == 100
        assert isinstance(result["total_cost_usd"], float)
        assert result["total_cost_usd"] == pytest.approx(0.1326)
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT discovered_count, analyzed_competitor_count,
                       completed_competitors, failed_competitors,
                       raw_keyword_count, unique_keyword_count, total_cost_usd
                FROM keyword_competitor_analysis_runs
                WHERE id = $1
                """,
                analysis_run_id,
            )
            opportunity = await connection.fetchrow(
                """
                SELECT best_competitor_rank, competitor_count, opportunity_score,
                       search_volume, competition_level, keyword_difficulty,
                       metrics_fetched_at
                FROM keyword_competitor_opportunities
                WHERE analysis_run_id = $1
                  AND normalized_keyword = 'solar opportunity keyword 1'
                """,
                analysis_run_id,
            )
            ranking_count = await connection.fetchval(
                """
                SELECT count(*)
                FROM keyword_competitor_opportunity_rankings
                WHERE analysis_run_id = $1
                """,
                analysis_run_id,
            )
            candidate_counts = await connection.fetchrow(
                """
                SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE selected_for_gap)::int AS selected,
                       count(*) FILTER (WHERE status = 'excluded')::int AS excluded
                FROM keyword_competitors
                WHERE analysis_run_id = $1
                """,
                analysis_run_id,
            )
        assert row["discovered_count"] == 10
        assert row["analyzed_competitor_count"] == 5
        assert row["completed_competitors"] == 4
        assert row["failed_competitors"] == 1
        assert float(row["total_cost_usd"]) == pytest.approx(0.1326)
        assert opportunity["best_competitor_rank"] == 1
        assert opportunity["competitor_count"] == 4
        assert opportunity["opportunity_score"] is not None
        assert opportunity["search_volume"] is None
        assert opportunity["competition_level"] == "LOW"
        assert opportunity["keyword_difficulty"] is None
        assert opportunity["metrics_fetched_at"] == metric_snapshot_start + timedelta(minutes=4)
        assert ranking_count == 400
        assert dict(candidate_counts) == {"total": 10, "selected": 5, "excluded": 5}


async def test_competitor_opportunity_lifecycle_is_inherited_across_runs() -> None:
    async with _repository_context() as (repository, keyword_context, pool, _):
        accepted_keyword_id = f"accepted-keyword-{uuid4().hex}"
        first_run_id = f"competitor-lifecycle-first-{uuid4().hex}"
        second_run_id = f"competitor-lifecycle-second-{uuid4().hex}"
        rows = [
            CompetitorGap(
                keyword="accepted recurring opportunity",
                provider_rank=1,
                competitor_rank=3,
                own_rank=None,
                competitor_url="https://competitor.example/accepted",
                own_url=None,
                search_volume=1200,
                cpc=2.5,
                competition=0.6,
                keyword_difficulty=35,
                intent="commercial",
                monthly_searches=[],
                raw_payload={"lifecycle": "accepted"},
            ),
            CompetitorGap(
                keyword="dismissed recurring opportunity",
                provider_rank=2,
                competitor_rank=7,
                own_rank=None,
                competitor_url="https://competitor.example/dismissed",
                own_url=None,
                search_volume=800,
                cpc=1.5,
                competition=0.4,
                keyword_difficulty=25,
                intent="informational",
                monthly_searches=[],
                raw_payload={"lifecycle": "dismissed"},
            ),
        ]

        async def save_run(run_id: str) -> None:
            async with pool.acquire() as connection:
                await connection.execute(
                    """
                    INSERT INTO keyword_competitor_analysis_runs (
                        id, organization_id, project_id, workflow_id,
                        target_domain, country, language, status, stage,
                        competitor_limit, keyword_limit
                    )
                    VALUES ($1, $2, $3, $4, $5, 'US', 'en', 'running',
                            'fetching_opportunities', 5, 100)
                    """,
                    run_id,
                    keyword_context.organization_id,
                    keyword_context.project_id,
                    f"keywords:competitor-analysis:{run_id}",
                    keyword_context.domain,
                )
            context = CompetitorAnalysisContext(
                organization_id=keyword_context.organization_id,
                project_id=keyword_context.project_id,
                run_id=run_id,
                domain=keyword_context.domain,
                country="US",
                language="en",
                competitor_limit=5,
                keyword_limit=100,
            )
            competitors = await repository.save_discovered_competitors(
                context,
                [
                    DiscoveredCompetitor(
                        domain="competitor.example",
                        provider_rank=1,
                        avg_position=8,
                        median_position=7,
                        rating=10,
                        etv=5000,
                        keywords_count=4,
                        visibility=8,
                        relevant_serp_items=4,
                        keywords_positions={},
                        raw_payload={},
                    )
                ],
                cost_usd=0.0126,
            )
            await repository.save_competitor_opportunities(
                context,
                competitors[0]["id"],
                rows,
                cost_usd=0.024,
            )

        await save_run(first_run_id)
        async with pool.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO keywords (
                    id, organization_id, project_id, country, language,
                    keyword, normalized_keyword, metrics_status,
                    first_build_run_id, last_build_run_id
                )
                VALUES ($1, $2, $3, 'US', 'en',
                        'accepted recurring opportunity',
                        'accepted recurring opportunity', 'fresh', $4, $4)
                """,
                accepted_keyword_id,
                keyword_context.organization_id,
                keyword_context.project_id,
                keyword_context.run_id,
            )
            previous_rows = await connection.fetch(
                """
                UPDATE keyword_competitor_opportunities
                SET status = CASE normalized_keyword
                        WHEN 'accepted recurring opportunity' THEN 'accepted'
                        ELSE 'dismissed'
                    END,
                    keyword_id = CASE normalized_keyword
                        WHEN 'accepted recurring opportunity' THEN $2
                        ELSE NULL
                    END,
                    decided_at = now() - interval '1 day',
                    updated_at = now()
                WHERE analysis_run_id = $1
                RETURNING id, normalized_keyword, status, keyword_id, decided_at
                """,
                first_run_id,
                accepted_keyword_id,
            )
            await connection.execute(
                """
                INSERT INTO keyword_competitor_opportunity_decisions (
                    id, organization_id, project_id, country, language,
                    normalized_keyword, status, keyword_id, decided_at
                )
                SELECT md5(
                           opportunity.organization_id || ':' ||
                           opportunity.project_id || ':US:en:' ||
                           opportunity.normalized_keyword
                       ),
                       opportunity.organization_id, opportunity.project_id,
                       'US', 'en', opportunity.normalized_keyword,
                       opportunity.status, opportunity.keyword_id,
                       opportunity.decided_at
                FROM keyword_competitor_opportunities AS opportunity
                WHERE opportunity.analysis_run_id = $1
                """,
                first_run_id,
            )
            await connection.execute(
                """
                UPDATE keyword_competitor_analysis_runs
                SET status = 'completed', stage = 'completed', finished_at = now()
                WHERE id = $1
                """,
                first_run_id,
            )
        previous_by_keyword = {row["normalized_keyword"]: row for row in previous_rows}

        await save_run(second_run_id)
        async with pool.acquire() as connection:
            inherited_rows = await connection.fetch(
                """
                SELECT id, normalized_keyword, status, keyword_id, decided_at
                FROM keyword_competitor_opportunities
                WHERE analysis_run_id = $1
                """,
                second_run_id,
            )
        inherited_by_keyword = {row["normalized_keyword"]: row for row in inherited_rows}

        assert set(inherited_by_keyword) == set(previous_by_keyword)
        for normalized_keyword, inherited in inherited_by_keyword.items():
            previous = previous_by_keyword[normalized_keyword]
            assert inherited["id"] != previous["id"]
            assert inherited["status"] == previous["status"]
            assert inherited["keyword_id"] == previous["keyword_id"]
            assert inherited["decided_at"] == previous["decided_at"]


async def test_competitor_paid_request_ledger_completes_atomically_and_reuses_cache() -> None:
    async with _repository_context() as (repository, keyword_context, pool, _):
        first_run_id = f"competitor-ledger-{uuid4().hex}"
        async with pool.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO keyword_competitor_analysis_runs (
                    id, organization_id, project_id, workflow_id,
                    target_domain, country, language, status, stage,
                    competitor_limit, keyword_limit
                )
                VALUES ($1, $2, $3, $4, $5, 'US', 'en', 'running',
                        'discovering_competitors', 5, 100)
                """,
                first_run_id,
                keyword_context.organization_id,
                keyword_context.project_id,
                f"keywords:competitor-analysis:{first_run_id}",
                keyword_context.domain,
            )
        first_context = CompetitorAnalysisContext(
            organization_id=keyword_context.organization_id,
            project_id=keyword_context.project_id,
            run_id=first_run_id,
            domain=keyword_context.domain,
            country="US",
            language="en",
            competitor_limit=5,
            keyword_limit=100,
        )
        request = await repository.begin_competitor_external_request(
            context=first_context,
            request_key=f"competitor-analysis:{first_run_id}:discover",
            provider="dataforseo",
            endpoint="dataforseo_labs/google/serp_competitors/live",
            request_hash="organic-discovery-hash",
        )
        assert request.should_execute is True
        assert request.build_run_id is None
        assert request.competitor_analysis_run_id == first_run_id
        assert await repository.mark_external_request_submitted(
            request.request_key,
            claim_token=request.claim_token or "",
        )
        rows = [
            DiscoveredCompetitor(
                domain="competitor.example",
                provider_rank=1,
                avg_position=8.5,
                median_position=7,
                rating=20,
                etv=12000,
                keywords_count=5,
                visibility=9,
                relevant_serp_items=5,
                keywords_positions={},
                raw_payload={
                    "domain": "competitor.example",
                    "_landscape": {
                        "domain_type": "direct_product_competitor",
                        "is_seo_competitor": True,
                        "is_business_competitor": True,
                        "classification_confidence": 0.91,
                        "why_they_matter": "Recurring direct competitor",
                        "selected_for_gap": True,
                        "serp_evidence": [{"keyword": "market query", "rank": 2}],
                        "domain_overview": {"organic_keywords": 2000},
                        "ranked_keywords_evidence": [{"keyword": "market query"}],
                        "backlinks_evidence": {"summary": {"backlinks": 300}},
                    },
                },
            )
        ]
        await repository.save_competitor_landscape_evidence(
            first_context,
            gsc_query_evidence=[{"query": "market query", "clicks": 10}],
            query_metrics=[{"keyword": "market query", "search_volume": 1000}],
            serp_snapshots=[{"keyword": "market query", "items": []}],
            cost_breakdown={"serp_competitors": 0.0126},
            landscape_summary={"market_read": "A competitive market"},
            directional_result=True,
        )
        await repository.save_discovered_competitors_and_complete_external_request(
            first_context,
            rows,
            request_key=request.request_key,
            claim_token=request.claim_token or "",
            metadata={"rows": [{"domain": "competitor.example"}]},
            cost_usd=0.0126,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )

        second_run_id = f"competitor-ledger-{uuid4().hex}"
        async with pool.acquire() as connection:
            ledger = await connection.fetchrow(
                """
                SELECT status, build_run_id, competitor_analysis_run_id, cost_usd
                FROM keyword_external_requests
                WHERE request_key = $1
                """,
                request.request_key,
            )
            assert ledger["status"] == "completed"
            assert ledger["build_run_id"] is None
            assert ledger["competitor_analysis_run_id"] == first_run_id
            assert float(ledger["cost_usd"]) == pytest.approx(0.0126)
            landscape_run = await connection.fetchrow(
                """
                SELECT gsc_query_evidence, query_metrics, serp_snapshots,
                       cost_breakdown, landscape_summary, market_summary,
                       directional_result
                FROM keyword_competitor_analysis_runs
                WHERE id = $1
                """,
                first_run_id,
            )
            assert landscape_run["gsc_query_evidence"][0]["query"] == "market query"
            assert landscape_run["query_metrics"][0]["search_volume"] == 1000
            assert landscape_run["serp_snapshots"][0]["keyword"] == "market query"
            assert float(landscape_run["cost_breakdown"]["serp_competitors"]) == pytest.approx(
                0.0126
            )
            assert landscape_run["landscape_summary"]["market_read"] == (
                "A competitive market"
            )
            assert landscape_run["market_summary"] == "A competitive market"
            assert landscape_run["directional_result"] is True
            landscape_competitor = await connection.fetchrow(
                """
                SELECT domain_type, is_seo_competitor, is_business_competitor,
                       classification_confidence, why_they_matter, serp_evidence,
                       domain_overview, ranked_keywords_evidence, backlinks_evidence
                FROM keyword_competitors
                WHERE analysis_run_id = $1
                """,
                first_run_id,
            )
            assert landscape_competitor["domain_type"] == "direct_product_competitor"
            assert landscape_competitor["is_seo_competitor"] is True
            assert landscape_competitor["is_business_competitor"] is True
            assert float(landscape_competitor["classification_confidence"]) == pytest.approx(
                0.91
            )
            assert landscape_competitor["serp_evidence"][0]["rank"] == 2
            assert landscape_competitor["domain_overview"]["organic_keywords"] == 2000
            assert landscape_competitor["ranked_keywords_evidence"][0]["keyword"] == (
                "market query"
            )
            assert landscape_competitor["backlinks_evidence"]["summary"]["backlinks"] == 300
            await connection.execute(
                """
                UPDATE keyword_competitor_analysis_runs
                SET status = 'completed', stage = 'completed', finished_at = now()
                WHERE id = $1
                """,
                first_run_id,
            )
            await connection.execute(
                """
                INSERT INTO keyword_competitor_analysis_runs (
                    id, organization_id, project_id, workflow_id,
                    target_domain, country, language, status, stage,
                    competitor_limit, keyword_limit
                )
                VALUES ($1, $2, $3, $4, $5, 'US', 'en', 'running',
                        'discovering_competitors', 5, 100)
                """,
                second_run_id,
                keyword_context.organization_id,
                keyword_context.project_id,
                f"keywords:competitor-analysis:{second_run_id}",
                keyword_context.domain,
            )
        cached = await repository.begin_competitor_external_request(
            context=CompetitorAnalysisContext(
                organization_id=keyword_context.organization_id,
                project_id=keyword_context.project_id,
                run_id=second_run_id,
                domain=keyword_context.domain,
                country="US",
                language="en",
                competitor_limit=5,
                keyword_limit=100,
            ),
            request_key=f"competitor-analysis:{second_run_id}:discover",
            provider="dataforseo",
            endpoint="dataforseo_labs/google/serp_competitors/live",
            request_hash="organic-discovery-hash",
        )
        assert cached.reusable is True
        assert cached.should_execute is False
        assert cached.request_key == request.request_key


async def test_competitor_site_verification_cache_is_market_scoped_and_uses_checked_at() -> None:
    async with _repository_context() as (repository, keyword_context, pool, _):
        context = CompetitorAnalysisContext(
            organization_id=keyword_context.organization_id,
            project_id=keyword_context.project_id,
            run_id=f"verification-{uuid4().hex}",
            domain=keyword_context.domain,
            country="US",
            language="en",
            competitor_limit=5,
            keyword_limit=100,
        )
        await repository.save_competitor_site_verifications(
            context,
            {
                "competitor.example": {
                    "domain": "competitor.example",
                    "status": "ok",
                    "final_domain": "competitor.example",
                    "checked_at": datetime.now(UTC).isoformat(),
                }
            },
        )

        cached = await repository.load_cached_competitor_site_verifications(
            context, ["competitor.example"]
        )
        assert cached["competitor.example"]["status"] == "ok"

        other_market = CompetitorAnalysisContext(
            **{**context.__dict__, "country": "CA", "language": "fr"}
        )
        assert (
            await repository.load_cached_competitor_site_verifications(
                other_market, ["competitor.example"]
            )
            == {}
        )

        async with pool.acquire() as connection:
            await connection.execute(
                """
                UPDATE keyword_competitor_site_verifications
                SET checked_at = now() - interval '25 hours', updated_at = now()
                WHERE organization_id = $1 AND domain = 'competitor.example'
                """,
                context.organization_id,
            )
        assert (
            await repository.load_cached_competitor_site_verifications(
                context, ["competitor.example"]
            )
            == {}
        )


async def test_failed_competitor_analysis_persists_cost_breakdown() -> None:
    async with _repository_context() as (repository, keyword_context, pool, _):
        run_id = f"competitor-cost-{uuid4().hex}"
        async with pool.acquire() as connection:
            await connection.execute(
                """
                INSERT INTO keyword_competitor_analysis_runs (
                    id, organization_id, project_id, workflow_id,
                    target_domain, country, language, status, stage,
                    competitor_limit, keyword_limit
                )
                VALUES ($1, $2, $3, $4, $5, 'US', 'en', 'running',
                        'discovering_competitors', 5, 100)
                """,
                run_id,
                keyword_context.organization_id,
                keyword_context.project_id,
                f"keywords:competitor-analysis:{run_id}",
                keyword_context.domain,
            )
        await repository.save_competitor_cost_breakdown(
            run_id, {"domain_overviews": 0.04848, "live_serps": 0.003}
        )
        await repository.fail_competitor_analysis(
            run_id,
            code="test_failure",
            detail="failed after paid calls",
            cost_usd=0.05148,
            cost_breakdown={"domain_overviews": 0.04848, "live_serps": 0.003},
        )

        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT status, total_cost_usd, cost_breakdown
                FROM keyword_competitor_analysis_runs
                WHERE id = $1
                """,
                run_id,
            )
        assert row["status"] == "failed"
        assert float(row["total_cost_usd"]) == pytest.approx(0.05148)
        assert float(row["cost_breakdown"]["domain_overviews"]) == pytest.approx(0.04848)
        assert float(row["cost_breakdown"]["live_serps"]) == pytest.approx(0.003)
