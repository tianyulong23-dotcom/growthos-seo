from __future__ import annotations

import json
import os
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.keywords.service import (
    KeywordCompetitorAnalysisAlreadyRunningError,
    KeywordCompetitorOpportunityUnavailableError,
    KeywordGSCRequiredError,
    SQLAlchemyKeywordRepository,
)
from app.modules.keywords.schemas import (
    KeywordCompetitorAnalysisRequest,
    KeywordCompetitorOpportunityBatchRequest,
)

pytestmark = pytest.mark.anyio


def _database_url() -> str:
    value = os.getenv("KEYWORD_API_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("KEYWORD_API_TEST_DATABASE_URL is required for PostgreSQL tests")
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


async def test_initial_workflow_orphan_recovery_is_capped_atomically() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"workflow-recovery-org-{token}"
    project_id = f"workflow-recovery-project-{token}"
    run_id = f"workflow-recovery-run-{token}"
    workflow_id = f"keywords:build:{run_id}:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Recovery cap test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status, recovery_count
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'running', 'selecting_seeds', 'not_requested', 3)
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_workflow_dispatches (
                        run_id, workflow_id, task_payload, status
                    )
                    VALUES (
                        :run_id, :workflow_id, CAST(:task_payload AS jsonb), 'dispatched'
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "workflow_id": workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_recovery_count": 3,
                            "_orphan_recovery_count": 3,
                        }
                    ),
                },
            )
            await session.commit()

        recovered = await repository.requeue_orphaned_workflow(
            run_id,
            expected_workflow_id=workflow_id,
            max_recoveries=3,
        )

        assert recovered is False
        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT r.status, r.stage, r.error_code, r.next_retry_at,
                               d.workflow_id, d.status AS dispatch_status
                        FROM keyword_build_runs r
                        JOIN keyword_workflow_dispatches d ON d.run_id = r.id
                        WHERE r.id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.status == "blocked"
        assert row.stage == "waiting_for_recovery"
        assert row.error_code == "workflow_recovery_exhausted"
        assert row.next_retry_at is not None
        assert row.workflow_id == workflow_id
        assert row.dispatch_status == "dispatched"
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_competitor_recovery_and_operator_resolution_are_durable() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"competitor-recovery-org-{token}"
    project_id = f"competitor-recovery-project-{token}"
    run_id = f"competitor-recovery-run-{token}"
    workflow_id = f"keywords:competitor-analysis:{run_id}:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Competitor recovery',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitor_analysis_runs (
                        id, organization_id, project_id, workflow_id,
                        target_domain, country, language, status, stage,
                        competitor_limit, keyword_limit
                    )
                    VALUES (
                        :run_id, :organization_id, :project_id, :workflow_id,
                        :domain, 'US', 'en', 'running', 'discovering_competitors',
                        5, 100
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "workflow_id": workflow_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitor_analysis_dispatches (
                        run_id, workflow_id, task_payload, status, dispatched_at
                    )
                    VALUES (
                        :run_id, :workflow_id, CAST(:payload AS jsonb),
                        'dispatched', now()
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "workflow_id": workflow_id,
                    "payload": json.dumps(
                        {
                            "organization_id": organization_id,
                            "project_id": project_id,
                            "run_id": run_id,
                        }
                    ),
                },
            )
            await session.commit()

        assert await repository.requeue_orphaned_competitor_analysis_workflow(
            run_id,
            expected_workflow_id=workflow_id,
            max_recoveries=3,
        )
        async with sessions() as session:
            recovered = (
                await session.execute(
                    text(
                        """
                        SELECT run.status, run.recovery_count, run.workflow_id,
                               dispatch.status AS dispatch_status,
                               dispatch.task_payload
                        FROM keyword_competitor_analysis_runs AS run
                        JOIN keyword_competitor_analysis_dispatches AS dispatch
                          ON dispatch.run_id = run.id
                        WHERE run.id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
            await session.execute(
                text(
                    """
                    UPDATE keyword_competitor_analysis_runs
                    SET status = 'running', recovery_count = 3
                    WHERE id = :run_id
                    """
                ),
                {"run_id": run_id},
            )
            await session.execute(
                text(
                    """
                    UPDATE keyword_competitor_analysis_dispatches
                    SET status = 'dispatched'
                    WHERE run_id = :run_id
                    """
                ),
                {"run_id": run_id},
            )
            await session.commit()
        assert recovered.status == "queued"
        assert recovered.recovery_count == 1
        assert recovered.dispatch_status == "pending"
        assert recovered.task_payload["_recovery_count"] == 1
        recovered_workflow_id = recovered.workflow_id

        assert not await repository.requeue_orphaned_competitor_analysis_workflow(
            run_id,
            expected_workflow_id=recovered_workflow_id,
            max_recoveries=3,
        )
        async with sessions() as session:
            request_id = await session.scalar(
                text(
                    """
                    INSERT INTO keyword_external_requests (
                        organization_id, project_id, competitor_analysis_run_id,
                        request_key, provider, endpoint, request_hash, status,
                        cost_usd, response_metadata, finished_at
                    )
                    VALUES (
                        :organization_id, :project_id, :run_id, :request_key,
                        'dataforseo', 'domain_intersection', :request_hash,
                        'uncertain', 0.012, CAST('{"payload": {}}' AS jsonb), now()
                    )
                    RETURNING id
                    """
                ),
                {
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": run_id,
                    "request_key": f"competitor-recovery-{token}",
                    "request_hash": token,
                },
            )
            exhausted = (
                await session.execute(
                    text(
                        """
                        SELECT status, error_code
                        FROM keyword_competitor_analysis_runs
                        WHERE id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
            await session.commit()
        assert exhausted.status == "failed"
        assert exhausted.error_code == "competitor_analysis_recovery_exhausted"

        health = await repository.operational_health(
            organization_id,
            task_queue="keyword-build",
            worker_stale_seconds=60,
        )
        assert health.uncertain_requests == 1

        resolved = await repository.accept_external_issue_as_empty(
            organization_id,
            project_id,
            int(request_id),
        )
        assert resolved.status == "completed"
        async with sessions() as session:
            resumed = (
                await session.execute(
                    text(
                        """
                        SELECT run.status, run.error_code,
                               dispatch.status AS dispatch_status,
                               request.result_count, request.response_metadata,
                               request.expires_at > request.finished_at AS cache_bounded
                        FROM keyword_competitor_analysis_runs AS run
                        JOIN keyword_competitor_analysis_dispatches AS dispatch
                          ON dispatch.run_id = run.id
                        JOIN keyword_external_requests AS request
                          ON request.competitor_analysis_run_id = run.id
                        WHERE run.id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert resumed.status == "queued"
        assert resumed.error_code is None
        assert resumed.dispatch_status == "pending"
        assert resumed.result_count == 0
        assert resumed.response_metadata["rows"] == []
        assert resumed.response_metadata["data"] == []
        assert resumed.response_metadata["operator_resolution"] == "accepted_empty"
        assert resumed.cache_bounded is True
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_operator_resolution_does_not_requeue_an_old_run_over_an_active_run() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"competitor-resolution-org-{token}"
    project_id = f"competitor-resolution-project-{token}"
    old_run_id = f"competitor-resolution-old-{token}"
    active_run_id = f"competitor-resolution-active-{token}"
    old_workflow_id = f"keywords:competitor-analysis:{old_run_id}"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Resolution conflict',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            for run_id, workflow_id, status in (
                (old_run_id, old_workflow_id, "partial"),
                (
                    active_run_id,
                    f"keywords:competitor-analysis:{active_run_id}",
                    "queued",
                ),
            ):
                await session.execute(
                    text(
                        """
                        INSERT INTO keyword_competitor_analysis_runs (
                            id, organization_id, project_id, workflow_id,
                            target_domain, country, language, status, stage,
                            competitor_limit, keyword_limit
                        )
                        VALUES (
                            :run_id, :organization_id, :project_id, :workflow_id,
                            :domain, 'US', 'en', :status, :status, 5, 100
                        )
                        """
                    ),
                    {
                        "run_id": run_id,
                        "organization_id": organization_id,
                        "project_id": project_id,
                        "workflow_id": workflow_id,
                        "domain": f"{token}.example.test",
                        "status": status,
                    },
                )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitor_analysis_dispatches (
                        run_id, workflow_id, task_payload, status, dispatched_at
                    )
                    VALUES (
                        :run_id, :workflow_id, CAST(:payload AS jsonb),
                        'dispatched', now()
                    )
                    """
                ),
                {
                    "run_id": old_run_id,
                    "workflow_id": old_workflow_id,
                    "payload": json.dumps(
                        {
                            "organization_id": organization_id,
                            "project_id": project_id,
                            "run_id": old_run_id,
                        }
                    ),
                },
            )
            request_id = await session.scalar(
                text(
                    """
                    INSERT INTO keyword_external_requests (
                        organization_id, project_id, competitor_analysis_run_id,
                        request_key, provider, endpoint, request_hash, status,
                        response_metadata, finished_at
                    )
                    VALUES (
                        :organization_id, :project_id, :run_id, :request_key,
                        'dataforseo', 'domain_intersection', :request_hash,
                        'uncertain', CAST('{}' AS jsonb), now()
                    )
                    RETURNING id
                    """
                ),
                {
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": old_run_id,
                    "request_key": f"old-resolution-{token}",
                    "request_hash": token,
                },
            )
            await session.commit()

        resolved = await repository.accept_external_issue_as_empty(
            organization_id,
            project_id,
            int(request_id),
        )
        assert resolved.status == "completed"
        async with sessions() as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT old_run.status AS old_status,
                               active_run.status AS active_status,
                               dispatch.status AS dispatch_status,
                               request.response_metadata,
                               request.expires_at > request.finished_at AS cache_bounded
                        FROM keyword_competitor_analysis_runs AS old_run
                        JOIN keyword_competitor_analysis_runs AS active_run
                          ON active_run.id = :active_run_id
                        JOIN keyword_competitor_analysis_dispatches AS dispatch
                          ON dispatch.run_id = old_run.id
                        JOIN keyword_external_requests AS request
                          ON request.competitor_analysis_run_id = old_run.id
                        WHERE old_run.id = :old_run_id
                        """
                    ),
                    {
                        "old_run_id": old_run_id,
                        "active_run_id": active_run_id,
                    },
                )
            ).one()
        assert rows.old_status == "partial"
        assert rows.active_status == "queued"
        assert rows.dispatch_status == "dispatched"
        assert rows.response_metadata["workflow_recovery"] == "deferred"
        assert rows.response_metadata["workflow_recovery_reason"] == "newer_analysis_active"
        assert rows.cache_bounded is True

        replacement_workflow_id = f"{old_workflow_id}:replacement"
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    UPDATE keyword_competitor_analysis_dispatches
                    SET workflow_id = :workflow_id, status = 'pending',
                        dispatched_at = NULL
                    WHERE run_id = :run_id
                    """
                ),
                {
                    "run_id": old_run_id,
                    "workflow_id": replacement_workflow_id,
                },
            )
            await session.commit()
        claimed = await repository.claim_pending_competitor_analysis_dispatches(100)
        claimed_record = next(row for row in claimed if row.run_id == old_run_id)
        assert claimed_record.workflow_id == replacement_workflow_id
        claimed_again = await repository.claim_pending_competitor_analysis_dispatches(100)
        assert all(row.run_id != old_run_id for row in claimed_again)
        await repository.mark_competitor_analysis_dispatch_succeeded(
            old_run_id,
            expected_workflow_id=old_workflow_id,
        )
        async with sessions() as session:
            stale_ack = (
                await session.execute(
                    text(
                        """
                        SELECT workflow_id, status
                        FROM keyword_competitor_analysis_dispatches
                        WHERE run_id = :run_id
                        """
                    ),
                    {"run_id": old_run_id},
                )
            ).one()
        assert stale_ack.workflow_id == replacement_workflow_id
        assert stale_ack.status == "dispatching"
        await repository.record_competitor_analysis_dispatch_failure(
            old_run_id,
            expected_workflow_id=replacement_workflow_id,
            message="temporal unavailable",
        )
        async with sessions() as session:
            retry_status = await session.scalar(
                text(
                    """
                    SELECT status
                    FROM keyword_competitor_analysis_dispatches
                    WHERE run_id = :run_id
                    """
                ),
                {"run_id": old_run_id},
            )
        assert retry_status == "pending"
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_competitor_analysis_is_fixed_to_five_by_one_hundred_and_aggregates_rankings() -> (
    None
):
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"competitor-org-{token}"
    project_id = f"competitor-project-{token}"
    competitor_id = f"competitor-{token}"
    opportunity_id = f"opportunity-{token}"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Competitor test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.commit()

        with pytest.raises(KeywordGSCRequiredError):
            await repository.create_competitor_analysis(
                organization_id,
                project_id,
                KeywordCompetitorAnalysisRequest(mode="auto"),
            )

        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO gsc_connections (
                        project_id, organization_id, site_url,
                        google_account_id, refresh_token_encrypted, scopes
                    )
                    VALUES (
                        :project_id, :organization_id, :site_url,
                        'google-account-test', decode('00', 'hex'),
                        'https://www.googleapis.com/auth/webmasters.readonly'
                    )
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "site_url": "sc-domain:unrelated.example.test",
                },
            )
            await session.commit()

        with pytest.raises(KeywordGSCRequiredError, match="项目域名匹配"):
            await repository.create_competitor_analysis(
                organization_id,
                project_id,
                KeywordCompetitorAnalysisRequest(mode="auto"),
            )

        async with sessions() as session:
            await session.execute(
                text(
                    """
                    UPDATE gsc_connections
                    SET site_url = :site_url
                    WHERE project_id = :project_id
                    """
                ),
                {
                    "project_id": project_id,
                    "site_url": f"sc-domain:{token}.example.test",
                },
            )
            await session.commit()

        run = await repository.create_competitor_analysis(
            organization_id,
            project_id,
            KeywordCompetitorAnalysisRequest(mode="auto"),
        )
        assert run.competitor_limit == 5
        assert run.keyword_limit == 100
        assert run.mode == "auto"
        assert run.requested_competitor_domains == []
        with pytest.raises(ValueError, match="不能与当前网站相同"):
            await repository.create_competitor_analysis(
                organization_id,
                project_id,
                KeywordCompetitorAnalysisRequest(
                    mode="manual",
                    competitor_domains=[f"{token}.example.test"],
                ),
            )
        with pytest.raises(ValueError, match="自动发现不能同时指定"):
            await repository.create_competitor_analysis(
                organization_id,
                project_id,
                KeywordCompetitorAnalysisRequest(
                    mode="auto",
                    competitor_domains=["manual.test"],
                ),
            )
        with pytest.raises(KeywordCompetitorAnalysisAlreadyRunningError):
            await repository.create_competitor_analysis(
                organization_id,
                project_id,
                KeywordCompetitorAnalysisRequest(mode="auto"),
            )

        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitors (
                        id, organization_id, project_id, analysis_run_id,
                        domain, provider_rank, status, keyword_count, cost_usd
                    )
                    VALUES (
                        :competitor_id, :organization_id, :project_id, :run_id,
                        'competitor.example', 1, 'completed', 1, 0.024
                    )
                    """
                ),
                {
                    "competitor_id": competitor_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": run.run_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitor_opportunities (
                        id, organization_id, project_id, analysis_run_id,
                        keyword, normalized_keyword, best_competitor_rank,
                        competitor_count, opportunity_score, search_volume,
                        competition_level, keyword_difficulty, intent,
                        metrics_fetched_at
                    )
                    VALUES (
                        :opportunity_id, :organization_id, :project_id, :run_id,
                        'solar panel installation', 'solar panel installation',
                        4, 1, 72.5, 2400, 'HIGH', 42, 'commercial',
                        now() - interval '2 hours'
                    )
                    """
                ),
                {
                    "opportunity_id": opportunity_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": run.run_id,
                    "competitor_id": competitor_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitor_opportunity_rankings (
                        id, organization_id, project_id, analysis_run_id,
                        competitor_id, opportunity_id, competitor_rank
                    )
                    VALUES (
                        :ranking_id, :organization_id, :project_id, :run_id,
                        :competitor_id, :opportunity_id, 4
                    )
                    """
                ),
                {
                    "ranking_id": f"ranking-{token}",
                    "opportunity_id": opportunity_id,
                    "competitor_id": competitor_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": run.run_id,
                },
            )
            await session.execute(
                text(
                    """
                    UPDATE keyword_competitor_analysis_runs
                    SET status = 'completed', stage = 'completed',
                        finished_at = now()
                    WHERE id = :run_id
                    """
                ),
                {"run_id": run.run_id},
            )
            await session.commit()

        result = await repository.list_competitor_opportunities(
            organization_id,
            project_id,
            page=1,
            page_size=50,
        )
        assert result.total == 1
        assert result.items[0].best_competitor_rank == 4
        assert result.items[0].competitor_count == 1
        assert result.items[0].competition_level == "HIGH"
        assert result.items[0].metrics_fetched_at is not None

        dismissed = await repository.batch_competitor_opportunities(
            organization_id,
            project_id,
            KeywordCompetitorOpportunityBatchRequest(
                opportunity_ids=[opportunity_id], action="dismiss"
            ),
        )
        assert dismissed.updated == 1
        dismissed_result = await repository.list_competitor_opportunities(
            organization_id,
            project_id,
            page=1,
            page_size=50,
            opportunity_status="dismissed",
        )
        assert dismissed_result.total == 1
        assert dismissed_result.items[0].keyword_id is None

        restored = await repository.batch_competitor_opportunities(
            organization_id,
            project_id,
            KeywordCompetitorOpportunityBatchRequest(
                opportunity_ids=[opportunity_id], action="restore"
            ),
        )
        assert restored.updated == 1
        restored_result = await repository.list_competitor_opportunities(
            organization_id,
            project_id,
            page=1,
            page_size=50,
            opportunity_status="new",
        )
        assert restored_result.total == 1
        assert restored_result.items[0].keyword_id is None

        queued_refresh = await repository.create_competitor_analysis(
            organization_id,
            project_id,
            KeywordCompetitorAnalysisRequest(
                mode="manual",
                competitor_domains=["https://WWW.Manual.test/"],
            ),
        )
        assert queued_refresh.status == "queued"
        assert queued_refresh.mode == "manual"
        assert queued_refresh.requested_competitor_domains == ["manual.test"]
        assert queued_refresh.competitor_limit == 1
        preserved = await repository.list_competitor_opportunities(
            organization_id,
            project_id,
            page=1,
            page_size=50,
            competitor_domain="competitor.example",
            min_volume=1000,
            max_difficulty=50,
        )
        assert preserved.run_id == run.run_id
        assert preserved.total == 1

        async with sessions() as session:
            build_run_id = f"build-{token}"
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, result_version
                    )
                    VALUES (
                        :id, :organization_id, :project_id, 'initial', 1,
                        'completed', 'completed', 1
                    )
                    """
                ),
                {
                    "id": build_run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitor_opportunities (
                        id, organization_id, project_id, analysis_run_id,
                        keyword, normalized_keyword, search_volume, status
                    )
                    VALUES (
                        :id, :organization_id, :project_id, :run_id,
                        'solar panel installation', 'solar panel installation',
                        2400, 'new'
                    )
                    """
                ),
                {
                    "id": f"refresh-opportunity-{token}",
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": queued_refresh.run_id,
                },
            )
            await session.commit()
        accepted = await repository.batch_competitor_opportunities(
            organization_id,
            project_id,
            KeywordCompetitorOpportunityBatchRequest(
                opportunity_ids=[opportunity_id], action="accept"
            ),
        )
        assert accepted.updated == 1
        assert accepted.added_to_library == 1
        async with sessions() as session:
            lifecycle_rows = (
                await session.execute(
                    text(
                        """
                        SELECT status, keyword_id
                        FROM keyword_competitor_opportunities
                        WHERE project_id = :project_id
                          AND normalized_keyword = 'solar panel installation'
                        ORDER BY analysis_run_id
                        """
                    ),
                    {"project_id": project_id},
                )
            ).all()
            decision_row = (
                await session.execute(
                    text(
                        """
                        SELECT status, keyword_id
                        FROM keyword_competitor_opportunity_decisions
                        WHERE project_id = :project_id
                          AND country = 'US' AND language = 'en'
                          AND normalized_keyword = 'solar panel installation'
                        """
                    ),
                    {"project_id": project_id},
                )
            ).one()
            keyword_row = (
                await session.execute(
                    text(
                        """
                        SELECT keyword.status, keyword.metrics_status,
                               metric.search_volume, source.source
                        FROM keywords AS keyword
                        JOIN keyword_metrics AS metric
                          ON metric.keyword_id = keyword.id
                        JOIN keyword_sources AS source
                          ON source.keyword_id = keyword.id
                        WHERE keyword.project_id = :project_id
                          AND keyword.normalized_keyword = 'solar panel installation'
                        """
                    ),
                    {"project_id": project_id},
                )
            ).one()
        assert len(lifecycle_rows) == 2
        assert all(row.status == "accepted" for row in lifecycle_rows)
        assert len({row.keyword_id for row in lifecycle_rows}) == 1
        assert decision_row.status == "accepted"
        assert decision_row.keyword_id == lifecycle_rows[0].keyword_id
        assert keyword_row.status == "active"
        assert keyword_row.metrics_status == "fresh"
        assert keyword_row.search_volume == 2400
        assert keyword_row.source == "competitor_opportunity"

        async with sessions() as session:
            await session.execute(
                text(
                    """
                    UPDATE keyword_competitor_opportunities
                    SET status = 'new', keyword_id = NULL
                    WHERE project_id = :project_id
                      AND normalized_keyword = 'solar panel installation'
                    """
                ),
                {"project_id": project_id},
            )
            await session.execute(
                text(
                    """
                    UPDATE keyword_metrics AS metric
                    SET search_volume = 9900,
                        cpc = 9.9,
                        monthly_searches = CAST(
                            '[{"year": 2026, "month": 8, "search_volume": 9900}]'
                            AS jsonb
                        ),
                        raw_payload = CAST('{"source": "newer_overview"}' AS jsonb),
                        fetched_at = now() - interval '1 hour'
                    FROM keywords AS keyword
                    WHERE metric.keyword_id = keyword.id
                      AND keyword.project_id = :project_id
                      AND keyword.normalized_keyword = 'solar panel installation'
                    """
                ),
                {"project_id": project_id},
            )
            await session.commit()
        effective_accepted = await repository.list_competitor_opportunities(
            organization_id,
            project_id,
            page=1,
            page_size=50,
            opportunity_status="accepted",
        )
        effective_new = await repository.list_competitor_opportunities(
            organization_id,
            project_id,
            page=1,
            page_size=50,
            opportunity_status="new",
        )
        assert effective_accepted.total == 1
        assert effective_accepted.items[0].status == "accepted"
        assert effective_accepted.items[0].keyword_id == decision_row.keyword_id
        assert effective_new.total == 0

        async with sessions() as session:
            await session.execute(
                text(
                    """
                    UPDATE keywords
                    SET status = 'archived', metrics_status = 'stale',
                        archived_at = now()
                    WHERE project_id = :project_id
                      AND normalized_keyword = 'solar panel installation'
                    """
                ),
                {"project_id": project_id},
            )
            await session.commit()
        reaccepted = await repository.batch_competitor_opportunities(
            organization_id,
            project_id,
            KeywordCompetitorOpportunityBatchRequest(
                opportunity_ids=[opportunity_id], action="accept"
            ),
        )
        assert reaccepted.updated == 1
        assert reaccepted.added_to_library == 0
        assert reaccepted.already_in_library == 1
        async with sessions() as session:
            reactivated_keyword = (
                await session.execute(
                    text(
                        """
                        SELECT keyword.status, keyword.metrics_status,
                               keyword.archived_at, metric.search_volume,
                               metric.cpc, metric.monthly_searches,
                               metric.raw_payload
                        FROM keywords AS keyword
                        JOIN keyword_metrics AS metric
                          ON metric.keyword_id = keyword.id
                        WHERE keyword.project_id = :project_id
                          AND keyword.normalized_keyword = 'solar panel installation'
                        """
                    ),
                    {"project_id": project_id},
                )
            ).one()
        assert reactivated_keyword.status == "active"
        assert reactivated_keyword.metrics_status == "stale"
        assert reactivated_keyword.archived_at is None
        assert reactivated_keyword.search_volume == 9900
        assert reactivated_keyword.cpc == 9.9
        assert reactivated_keyword.monthly_searches == [
            {"year": 2026, "month": 8, "search_volume": 9900}
        ]
        assert reactivated_keyword.raw_payload == {"source": "newer_overview"}
        for action in ("dismiss", "restore"):
            with pytest.raises(KeywordCompetitorOpportunityUnavailableError):
                await repository.batch_competitor_opportunities(
                    organization_id,
                    project_id,
                    KeywordCompetitorOpportunityBatchRequest(
                        opportunity_ids=[opportunity_id], action=action
                    ),
                )

        null_metric_opportunity_id = f"null-metric-opportunity-{token}"
        null_metric_keyword_id = f"null-metric-keyword-{token}"
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_competitor_opportunities (
                        id, organization_id, project_id, analysis_run_id,
                        keyword, normalized_keyword, search_volume,
                        competition_level, metrics_fetched_at, status
                    )
                    VALUES (
                        :id, :organization_id, :project_id, :run_id,
                        'provider null difficulty', 'provider null difficulty',
                        120, 'LOW', now(), 'new'
                    )
                    """
                ),
                {
                    "id": null_metric_opportunity_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": queued_refresh.run_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keywords (
                        id, organization_id, project_id, country, language,
                        keyword, normalized_keyword, metrics_status,
                        first_build_run_id, last_build_run_id
                    )
                    VALUES (
                        :id, :organization_id, :project_id, 'US', 'en',
                        'provider null difficulty', 'provider null difficulty', 'stale',
                        :build_run_id, :build_run_id
                    )
                    """
                ),
                {
                    "id": null_metric_keyword_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "build_run_id": build_run_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_metrics (
                        keyword_id, provider, search_volume, cpc, competition,
                        keyword_difficulty, intent, monthly_searches,
                        raw_payload, fetched_at
                    )
                    VALUES (
                        :keyword_id, 'dataforseo', 999, 4.5, 0.8,
                        67, 'commercial',
                        CAST('[{"year": 2025, "month": 1, "search_volume": 999}]' AS jsonb),
                        CAST('{"source": "older_overview"}' AS jsonb),
                        now() - interval '1 day'
                    )
                    """
                ),
                {"keyword_id": null_metric_keyword_id},
            )
            await session.commit()
        null_metric_accepted = await repository.batch_competitor_opportunities(
            organization_id,
            project_id,
            KeywordCompetitorOpportunityBatchRequest(
                opportunity_ids=[null_metric_opportunity_id], action="accept"
            ),
        )
        assert null_metric_accepted.added_to_library == 0
        assert null_metric_accepted.already_in_library == 1
        async with sessions() as session:
            null_metric_row = (
                await session.execute(
                    text(
                        """
                        SELECT keyword.metrics_status, metric.search_volume,
                               metric.cpc, metric.competition,
                               metric.competition_level,
                               metric.keyword_difficulty, metric.intent,
                               metric.monthly_searches,
                               metric.fetched_at, metric.raw_payload,
                               (
                                   SELECT count(*)
                                   FROM keyword_metric_refresh_jobs AS refresh
                                   WHERE refresh.project_id = keyword.project_id
                               ) AS refresh_jobs
                        FROM keywords AS keyword
                        JOIN keyword_metrics AS metric
                          ON metric.keyword_id = keyword.id
                        WHERE keyword.project_id = :project_id
                          AND keyword.normalized_keyword = 'provider null difficulty'
                        """
                    ),
                    {"project_id": project_id},
                )
            ).one()
        assert null_metric_row.metrics_status == "fresh"
        assert null_metric_row.search_volume == 120
        assert null_metric_row.cpc is None
        assert null_metric_row.competition is None
        assert null_metric_row.competition_level == "LOW"
        assert null_metric_row.keyword_difficulty is None
        assert null_metric_row.intent is None
        assert null_metric_row.monthly_searches == []
        assert null_metric_row.fetched_at is not None
        assert null_metric_row.refresh_jobs == 0
        assert (
            null_metric_row.raw_payload["competitor_opportunity"]["provider_request_completed"]
            is True
        )
        assert (
            "keyword_difficulty"
            in null_metric_row.raw_payload["competitor_opportunity"]["provider_null_fields"]
        )
        assert (
            "search_volume"
            not in null_metric_row.raw_payload["competitor_opportunity"]["provider_null_fields"]
        )

        async with sessions() as session:
            await session.execute(
                text(
                    """
                    DELETE FROM keyword_competitor_opportunities
                    WHERE analysis_run_id = :run_id
                    """
                ),
                {"run_id": queued_refresh.run_id},
            )
            await session.execute(
                text(
                    """
                    UPDATE keyword_competitor_analysis_runs
                    SET status = 'completed', stage = 'completed',
                        finished_at = now()
                    WHERE id = :run_id
                    """
                ),
                {"run_id": queued_refresh.run_id},
            )
            await session.commit()
        empty_latest = await repository.list_competitor_opportunities(
            organization_id,
            project_id,
            page=1,
            page_size=50,
        )
        empty_competitors = await repository.list_competitors(
            organization_id,
            project_id,
        )
        assert empty_latest.run_id == queued_refresh.run_id
        assert empty_latest.total == 0
        assert empty_competitors.run_id == queued_refresh.run_id
        assert empty_competitors.items == []
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_orphaned_metric_workflow_replays_without_spending_an_attempt() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"metric-requeue-org-{token}"
    project_id = f"metric-requeue-project-{token}"
    run_id = f"metric-requeue-run-{token}"
    old_workflow_id = f"keyword-metrics:{run_id}:2:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Metric replay test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'completed', 'completed', 'not_requested')
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_metric_refresh_jobs (
                        run_id, organization_id, project_id, workflow_id,
                        task_payload, status, attempt_count, next_attempt_at
                    )
                    VALUES (
                        :run_id, :organization_id, :project_id, :workflow_id,
                        CAST(:task_payload AS jsonb), 'running', 2, now()
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "workflow_id": old_workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_metric_workflow_id": old_workflow_id,
                        }
                    ),
                },
            )
            await session.commit()

        assert await repository.requeue_orphaned_metric_workflow(
            run_id,
            expected_workflow_id=old_workflow_id,
        )

        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT workflow_id, task_payload, status, attempt_count,
                               orphan_replay_count
                        FROM keyword_metric_refresh_jobs
                        WHERE run_id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.status == "pending"
        assert row.attempt_count == 1
        assert row.orphan_replay_count == 1
        assert row.workflow_id.startswith(f"keyword-metrics:{run_id}:2:")
        assert row.task_payload["_metric_workflow_id"] == row.workflow_id
        health = await repository.operational_health(
            organization_id,
            task_queue="keyword-build",
            worker_stale_seconds=60,
        )
        assert health.metric_refresh_waiting == 1
        assert health.metric_refresh_running == 0
        assert health.metric_refresh_exhausted == 0
        assert health.failed_metrics == 0
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_dispatched_metric_workflow_requeues_before_attempt_starts() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"metric-dispatch-org-{token}"
    project_id = f"metric-dispatch-project-{token}"
    run_id = f"metric-dispatch-run-{token}"
    old_workflow_id = f"keyword-metrics:{run_id}:1:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Metric dispatch test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'completed', 'completed', 'not_requested')
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_metric_refresh_jobs (
                        run_id, organization_id, project_id, workflow_id,
                        task_payload, status, attempt_count, next_attempt_at
                    )
                    VALUES (
                        :run_id, :organization_id, :project_id, :workflow_id,
                        CAST(:task_payload AS jsonb), 'dispatched', 0, now()
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "workflow_id": old_workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_metric_workflow_id": old_workflow_id,
                        }
                    ),
                },
            )
            await session.commit()

        assert await repository.requeue_orphaned_metric_workflow(
            run_id,
            expected_workflow_id=old_workflow_id,
        )

        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT workflow_id, status, attempt_count,
                               orphan_replay_count
                        FROM keyword_metric_refresh_jobs
                        WHERE run_id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.status == "pending"
        assert row.attempt_count == 0
        assert row.orphan_replay_count == 1
        assert row.workflow_id.startswith(f"keyword-metrics:{run_id}:1:")
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_third_orphaned_metric_workflow_is_settled_without_requeue() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"metric-exhaust-org-{token}"
    project_id = f"metric-exhaust-project-{token}"
    run_id = f"metric-exhaust-run-{token}"
    keyword_id = f"metric-exhaust-keyword-{token}"
    workflow_id = f"keyword-metrics:{run_id}:3:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Metric exhaust test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status, result_version, finished_at
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'partial', 'partial', 'not_requested', 1,
                            '2026-08-03T01:00:00Z')
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keywords (
                        id, organization_id, project_id, country, language,
                        keyword, normalized_keyword, metrics_status,
                        first_build_run_id, last_build_run_id
                    )
                    VALUES (
                        :keyword_id, :organization_id, :project_id, 'US', 'en',
                        'metric exhaust keyword', 'metric exhaust keyword', 'pending',
                        :run_id, :run_id
                    )
                    """
                ),
                {
                    "keyword_id": keyword_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": run_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_metric_refresh_jobs (
                        run_id, organization_id, project_id, workflow_id,
                        task_payload, status, attempt_count, orphan_replay_count,
                        next_attempt_at
                    )
                    VALUES (
                        :run_id, :organization_id, :project_id, :workflow_id,
                        CAST(:task_payload AS jsonb), 'running', 3, 2, now()
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "workflow_id": workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_metric_workflow_id": workflow_id,
                        }
                    ),
                },
            )
            await session.commit()

        assert await repository.requeue_orphaned_metric_workflow(
            run_id,
            expected_workflow_id=workflow_id,
        )

        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT
                            job.status AS job_status,
                            job.orphan_replay_count,
                            keyword.metrics_status,
                            run.status AS run_status,
                            run.result_version,
                            run.finished_at
                        FROM keyword_metric_refresh_jobs AS job
                        JOIN keyword_build_runs AS run ON run.id = job.run_id
                        JOIN keywords AS keyword ON keyword.last_build_run_id = run.id
                        WHERE job.run_id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.job_status == "exhausted"
        assert row.orphan_replay_count == 3
        assert row.metrics_status == "failed"
        assert row.run_status == "partial"
        assert row.result_version == 2
        assert row.finished_at.isoformat() == "2026-08-03T01:00:00+00:00"
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()
