import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.document import document_content_hash, extract_asset_manifest
from app.modules.content.models import (
    Article,
    ArticleAssetBinding,
    ArticleAutosave,
    ArticlePublication,
    ArticleRun,
    ArticleRunStep,
    ArticleSource,
    ArticleVersion,
    ContentAsset,
)
from app.modules.content.repository import (
    ArticleIdempotencyConflictError,
    ContentRepository,
    _copied_source_metadata,
)
from app.modules.projects.models import Project


def content_workflow_test_database_url() -> str:
    value = os.getenv("CONTENT_WORKFLOW_TEST_DATABASE_URL", "")
    if not value:
        pytest.skip("CONTENT_WORKFLOW_TEST_DATABASE_URL is not configured")
    if make_url(value).database != "seo_content_stage2_test":
        pytest.fail("Stage 2 tests may only use seo_content_stage2_test")
    return value


def create_content_workflow_test_engine():
    return create_async_engine(
        content_workflow_test_database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform, crawling, audit",
            }
        },
    )


async def create_queued_run(
    sessions: async_sessionmaker[AsyncSession], project_id: str, run_id: str
) -> str:
    article_id = str(uuid4())
    async with sessions() as session:
        session.add(
            Article(
                id=article_id,
                organization_id="test-org",
                project_id=project_id,
                primary_keyword="solar battery payback",
                status="queued",
                current_run_id=run_id,
            )
        )
        await session.flush()
        session.add(
            ArticleRun(
                id=run_id,
                article_id=article_id,
                organization_id="test-org",
                project_id=project_id,
                workflow_id=f"article-generation:{run_id}",
                status="queued",
                stage="queued",
                progress=0,
            )
        )
        await session.commit()
    return article_id


async def make_article_editable(
    sessions: async_sessionmaker[AsyncSession], article_id: str, run_id: str
) -> None:
    async with sessions() as session:
        article = await session.get(Article, article_id)
        run = await session.get(ArticleRun, run_id)
        assert article is not None and run is not None
        article.status = "completed"
        article.document_json = text_document("original", "Original")
        article.document_schema_version = 2
        run.status = "completed"
        run.stage = "completed"
        run.progress = 100
        await session.commit()


def text_document(node_suffix: str, text: str) -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": f"paragraph-{node_suffix}"},
                "content": [{"type": "text", "text": text}],
            }
        ],
    }


def test_copied_serp_source_records_zero_cost_reuse() -> None:
    metadata = _copied_source_metadata(
        "serp",
        {
            "cached": False,
            "request_cost_usd": 0.0035,
            "provider_request_id": "provider-request-1",
        },
        "parent-run",
    )

    assert metadata == {
        "cached": True,
        "reused": True,
        "reuse_method": "persisted_run_source",
        "request_cost_usd": 0.0,
        "copied_from_run_id": "parent-run",
        "original_provider_request_id": "provider-request-1",
    }


def image_document(node_suffix: str, asset_id: str) -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "image",
                "attrs": {
                    "node_id": f"image-{node_suffix}",
                    "asset_id": asset_id,
                    "alt": "Test image",
                    "display": "regular",
                },
            }
        ],
    }


def article_metadata(title: str) -> dict:
    return {
        "title": title,
        "slug": title.lower().replace(" ", "-"),
        "meta_title": title,
        "meta_description": f"Description for {title}",
        "publication_status": "complete_draft",
    }


def content_asset(
    *,
    asset_id: str,
    project_id: str,
    asset_type: str = "image",
    status: str = "ready",
    content_hash: str | None = None,
) -> ContentAsset:
    return ContentAsset(
        id=asset_id,
        project_id=project_id,
        asset_type=asset_type,
        status=status,
        original_filename=f"{asset_id}.bin",
        content_hash=content_hash,
        source_type="upload",
        created_by="asset-test-user",
        ready_at=datetime.now(UTC) if status == "ready" else None,
    )


def test_begin_run_sets_deadlines_once_and_completed_step_survives_restart() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Content workflow test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)

            first = await repo.begin_run(run_id, target_seconds=600, hard_timeout_seconds=1200)
            restarted = await repo.begin_run(run_id, target_seconds=1, hard_timeout_seconds=2)
            assert first is not None and restarted is not None
            assert restarted.started_at == first.started_at
            assert restarted.soft_deadline_at == first.soft_deadline_at
            assert restarted.hard_deadline_at == first.hard_deadline_at
            assert first.soft_deadline_at == first.started_at + timedelta(seconds=600)
            assert first.hard_deadline_at == first.started_at + timedelta(seconds=1200)

            claim, step = await repo.claim_step(run_id, "preparing", "worker-1", lease_seconds=300)
            assert claim == "claimed" and step is not None
            await repo.complete_step(
                run_id,
                "preparing",
                "worker-1",
                summary={"snapshot": "stored"},
                output_ref="s3://bucket/run/preparing.json",
            )

            repeated, completed = await repo.claim_step(
                run_id, "preparing", "worker-after-restart", lease_seconds=300
            )
            assert repeated == "completed"
            assert completed is not None
            assert completed.summary_json == {"snapshot": "stored"}
            assert completed.attempts == 1

            await repo.finish_run(
                run_id,
                "completed",
                [],
                artifact={
                    "title": "Solar battery payback",
                    "slug": "solar-battery-payback",
                    "meta_title": "Solar battery payback",
                    "meta_description": "A practical guide.",
                    "plan": {"sections": []},
                    "quality": {"passed": True},
                    "markdown": "# Solar battery payback\n",
                },
                html="<h1>Solar battery payback</h1>",
                final_content_ref="s3://bucket/run/final/article.md",
            )
            async with sessions() as session:
                run = await session.get(ArticleRun, run_id)
                article = await session.get(Article, article_id)
                assert run is not None and article is not None
                assert run.status == "completed"
                assert run.stage == "completed"
                assert run.progress == 100
                assert article.status == "completed"
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_active_lease_is_busy_and_expired_lease_can_be_taken_over() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Content lease test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            await create_queued_run(sessions, project_id, run_id)
            await repo.begin_run(run_id, target_seconds=600, hard_timeout_seconds=1200)

            claimed, step = await repo.claim_step(
                run_id, "collecting", "worker-1", lease_seconds=300
            )
            assert step is not None and step.lease_expires_at is not None
            original_lease_expiry = step.lease_expires_at
            renewed = await repo.renew_step_lease(
                run_id, "collecting", "worker-1", lease_seconds=900
            )
            stale_renewal = await repo.renew_step_lease(
                run_id, "collecting", "worker-2", lease_seconds=900
            )
            busy, _ = await repo.claim_step(run_id, "collecting", "worker-2", lease_seconds=300)
            async with sessions() as session:
                renewed_step = await session.scalar(
                    select(ArticleRunStep).where(
                        ArticleRunStep.run_id == run_id,
                        ArticleRunStep.step_key == "collecting",
                    )
                )

            assert claimed == "claimed"
            assert renewed is True
            assert stale_renewal is False
            assert renewed_step is not None
            assert renewed_step.lease_expires_at is not None
            assert renewed_step.lease_expires_at > original_lease_expiry
            assert busy == "busy"

            async with sessions() as session:
                await session.execute(
                    update(ArticleRunStep)
                    .where(
                        ArticleRunStep.run_id == run_id,
                        ArticleRunStep.step_key == "collecting",
                    )
                    .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
                await session.commit()

            expired_renewal = await repo.renew_step_lease(
                run_id, "collecting", "worker-1", lease_seconds=900
            )
            recovery_takeover, recovery_step = await repo.force_claim_step(
                run_id, "collecting", "worker-2", lease_seconds=300
            )

            assert expired_renewal is False
            assert recovery_takeover == "claimed"
            assert recovery_step is not None
            assert recovery_step.worker_id == "worker-2"

            active_recovery, _ = await repo.force_claim_step(
                run_id, "collecting", "worker-3", lease_seconds=300
            )
            assert active_recovery == "busy"

            takeover, taken_step = await repo.claim_step(
                run_id, "collecting", "worker-2", lease_seconds=300
            )
            assert takeover == "claimed"
            assert taken_step is not None
            assert taken_step.worker_id == "worker-2"
            assert taken_step.attempts == 3

            with pytest.raises(RuntimeError, match="执行租约已失效"):
                await repo.complete_step(
                    run_id,
                    "collecting",
                    "worker-1",
                    summary={"worker": "stale"},
                )
            completed = await repo.complete_step(
                run_id,
                "collecting",
                "worker-2",
                summary={"worker": "current"},
            )
            assert completed.status == "completed"
            assert completed.summary_json == {"worker": "current"}
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_fail_run_is_idempotent_and_failed_run_is_terminal() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Content failure terminal test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            await repo.begin_run(run_id, target_seconds=600, hard_timeout_seconds=1200)

            await repo.fail_run(
                run_id,
                error_code="article_stage_recovery_exhausted",
                error_detail="writing recovery failed",
                failed_stage="writing",
                retryable=True,
            )
            await repo.fail_run(
                run_id,
                error_code="must_not_overwrite",
                error_detail="must not overwrite the first terminal failure",
                failed_stage="checking",
                retryable=False,
            )

            begin = await repo.begin_run(run_id, target_seconds=1, hard_timeout_seconds=1)
            claim, _ = await repo.claim_step(
                run_id, "checking_1", "worker-after-failure", lease_seconds=30
            )
            recovery, _ = await repo.force_claim_step(
                run_id, "checking_1", "worker-after-failure", lease_seconds=30
            )
            async with sessions() as session:
                run = await session.get(ArticleRun, run_id)
                article = await session.get(Article, article_id)

            assert begin is not None and begin.status == "failed"
            assert claim == "terminal"
            assert recovery == "terminal"
            assert run is not None and article is not None
            assert run.status == "failed"
            assert run.stage == "failed"
            assert run.error_code == "article_stage_recovery_exhausted"
            assert run.error_detail == "writing recovery failed"
            assert run.failed_stage == "writing"
            assert run.retryable is True
            assert run.finished_at is not None
            assert article.status == "failed"
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_concurrent_followup_run_replays_the_same_durable_run() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Concurrent followup test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            await repo.fail_run(
                run_id,
                error_code="provider_timeout",
                error_detail="provider timed out",
                failed_stage="writing",
                retryable=True,
            )

            results = await asyncio.gather(
                *[
                    repo.create_followup_run(
                        "test-org",
                        project_id,
                        article_id,
                        trigger_type="retry",
                        idempotency_key="same-retry-command",
                        request_hash="same-command-hash",
                        model_snapshot=None,
                    )
                    for _ in range(2)
                ]
            )

            assert len({run.id for _article, run in results}) == 1
            followup = results[0][1]
            assert followup.parent_run_id == run_id
            assert followup.trigger_type == "retry"
            async with sessions() as session:
                run_count = await session.scalar(
                    select(func.count())
                    .select_from(ArticleRun)
                    .where(ArticleRun.article_id == article_id)
                )
                article = await session.get(Article, article_id)
            assert run_count == 2
            assert article is not None and article.current_run_id == followup.id
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_finish_run_replay_does_not_duplicate_versions_usage_or_source_bindings() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        source_url = "https://authority.example/solar-payback"
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Content finalization replay test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            await repo.begin_run(run_id, target_seconds=600, hard_timeout_seconds=1200)

            for step_key, usage in (
                (
                    "planning",
                    {
                        "input_tokens": 100,
                        "output_tokens": 20,
                        "reported_cost": 0.01,
                        "estimated_cost": None,
                        "cost_currency": "USD",
                        "estimation_basis": {},
                        "provider_request_ids": ["request-planning"],
                    },
                ),
                (
                    "writing",
                    {
                        "input_tokens": 200,
                        "output_tokens": 80,
                        "reported_cost": None,
                        "estimated_cost": 0.04,
                        "cost_currency": "USD",
                        "estimation_basis": {"method": "token_rate_v1"},
                        "provider_request_ids": ["request-writing"],
                    },
                ),
                (
                    "revising_3",
                    {
                        "input_tokens": 50,
                        "output_tokens": 25,
                        "reported_cost": 0.02,
                        "estimated_cost": None,
                        "cost_currency": "USD",
                        "estimation_basis": {},
                        "provider_request_ids": ["request-revising-3"],
                    },
                ),
                (
                    "checking_4",
                    {
                        "input_tokens": 60,
                        "output_tokens": 20,
                        "reported_cost": None,
                        "estimated_cost": 0.01,
                        "cost_currency": "USD",
                        "estimation_basis": {"method": "token_rate_v1"},
                        "provider_request_ids": ["request-checking-4"],
                    },
                ),
            ):
                claimed, _ = await repo.claim_step(run_id, step_key, "worker-1", lease_seconds=300)
                assert claimed == "claimed"
                await repo.complete_step(
                    run_id,
                    step_key,
                    "worker-1",
                    summary={"usage": usage},
                    output_ref=f"s3://bucket/run/{step_key}.json",
                    duration_ms=100,
                    usage=usage,
                )

            await repo.upsert_source(
                run_id,
                source_type="authority",
                url=source_url,
                status="available",
                title="Solar payback facts",
            )
            plan = {
                "sections": [{"section_id": "section-1", "claim_ids": ["claim-1"]}],
                "claims": [
                    {
                        "claim_id": "claim-1",
                        "claim": "Supported fact",
                        "source_url": source_url,
                        "section_id": "section-1",
                    }
                ],
            }
            await repo.bind_plan_sources(run_id, plan)
            await repo.bind_plan_sources(run_id, plan)

            artifact = {
                "title": "Solar battery payback",
                "slug": "solar-battery-payback",
                "meta_title": "Solar battery payback",
                "meta_description": "A practical guide.",
                "plan": plan,
                "quality": {"passed": True},
                "markdown": "# Solar battery payback\n\nComplete article.\n",
            }
            finish_args = {
                "artifact": artifact,
                "html": "<h1>Solar battery payback</h1><p>Complete article.</p>",
                "final_content_ref": "s3://bucket/run/final/article.md",
            }
            await repo.finish_run(run_id, "completed", [], **finish_args)
            await repo.finish_run(
                run_id,
                "completed_with_warnings",
                [{"code": "replayed", "message": "Must not replace final state"}],
                **finish_args,
            )

            async with sessions() as session:
                run = await session.get(ArticleRun, run_id)
                article = await session.get(Article, article_id)
                versions = list(
                    (
                        await session.scalars(
                            select(ArticleVersion)
                            .where(ArticleVersion.run_id == run_id)
                            .order_by(ArticleVersion.version_number)
                        )
                    ).all()
                )
                source_count = await session.scalar(
                    select(func.count())
                    .select_from(ArticleSource)
                    .where(ArticleSource.run_id == run_id)
                )
                bound_source = await session.scalar(
                    select(ArticleSource).where(ArticleSource.run_id == run_id)
                )

            assert run is not None
            assert article is not None
            assert run.status == "completed"
            assert run.warnings_json == []
            assert run.metrics_json == {
                "stage_count": 4,
                "duration_ms": 400,
                "input_tokens": 410,
                "output_tokens": 145,
                "reported_cost": 0.03,
                "estimated_cost": 0.05,
                "reported_cost_currency": "USD",
                "estimated_cost_currency": "USD",
                "estimation_basis": [
                    {"step_key": "writing", "method": "token_rate_v1"},
                    {"step_key": "checking_4", "method": "token_rate_v1"},
                ],
                "provider_request_ids": [
                    "request-planning",
                    "request-writing",
                    "request-revising-3",
                    "request-checking-4",
                ],
            }
            assert [item.version_type for item in versions] == [
                "outline",
                "draft",
                "revised",
                "final",
            ]
            assert [item.version_number for item in versions] == [1, 2, 3, 4]
            assert versions[2].content_ref == "s3://bucket/run/checking_4.json"
            assert versions[3].metadata_snapshot == {
                "title": "Solar battery payback",
                "slug": "solar-battery-payback",
                "meta_title": "Solar battery payback",
                "meta_description": "A practical guide.",
                "focus_keyword": "solar battery payback",
                "secondary_keywords": [],
                "canonical_url": None,
                "indexing": "index/follow",
                "field_states": {
                    "title": "generated",
                    "slug": "generated",
                    "focus_keyword": "generated",
                    "secondary_keywords": "generated",
                    "meta_title": "generated",
                    "meta_description": "generated",
                    "canonical_url": "generated",
                    "indexing": "generated",
                },
                "publication_status": "publish_ready",
            }
            assert article.current_version_number == 4
            assert article.focus_keyword == article.primary_keyword
            assert article.secondary_keywords_json == []
            assert article.canonical_url is None
            assert article.indexing == "index/follow"
            assert article.seo_field_states_json == versions[3].metadata_snapshot["field_states"]
            assert source_count == 1
            assert bound_source is not None
            assert bound_source.claims_json == plan["claims"]
            assert bound_source.section_ids_json == ["section-1"]
            assert article_id == versions[0].article_id
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_article_document_and_publication_lifecycle_is_durable() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Article publication test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            async with sessions() as session:
                article = await session.get(Article, article_id)
                run = await session.get(ArticleRun, run_id)
                assert article is not None and run is not None
                article.status = "completed"
                article.publication_status = "publish_ready"
                article.review_status = "approved"
                article.review_version = 1
                article.publication_blocked_reason = None
                article.document_json = {
                    "type": "doc",
                    "content": [
                        {"type": "paragraph", "content": [{"type": "text", "text": "Original"}]}
                    ],
                }
                run.status = "completed"
                run.stage = "completed"
                run.progress = 100
                await session.commit()

            document = {
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Edited"}]}],
            }
            saved, _ = await repo.update_article_document(
                "test-org",
                project_id,
                article_id,
                document=document,
                markdown="Edited\n",
                html="<p>Edited</p>",
                metadata=None,
                content_hash=None,
                expected_review_version=1,
                expected_version_number=None,
                autosave_id=None,
                reason=None,
                edited_by="editor-postgres",
            )
            assert saved.review_version == 2
            assert saved.review_status == "pending_review"
            with pytest.raises(ValueError, match="stale_review_version:2"):
                await repo.update_article_document(
                    "test-org",
                    project_id,
                    article_id,
                    document=document,
                    markdown="Stale\n",
                    html="<p>Stale</p>",
                    metadata=None,
                    content_hash=None,
                    expected_review_version=1,
                    expected_version_number=None,
                    autosave_id=None,
                    reason=None,
                )
            async with sessions() as session:
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_type == "manual_edit",
                    )
                )
                article = await session.get(Article, article_id)
                assert version is not None and article is not None
                assert version.content_json == {
                    "title": None,
                    "slug": None,
                    "meta_title": None,
                    "meta_description": None,
                    "publication_status": "publish_ready",
                    "document": document,
                    "markdown": "Edited\n",
                    "html": "<p>Edited</p>",
                }
                assert version.review_version == 2
                assert version.created_by == "editor-postgres"
                article.review_status = "approved"
                article.approved_version_number = version.version_number
                article.publication_blocked_reason = None
                await session.commit()

            claimed_article, claimed_run, first, claimed = await repo.claim_publication(
                "test-org",
                project_id,
                article_id,
                idempotency_key="publish-first",
                request_hash="hash-v2",
                expected_version=2,
            )
            assert claimed is True
            assert claimed_article.id == article_id and claimed_run.id == run_id
            replay = await repo.claim_publication(
                "test-org",
                project_id,
                article_id,
                idempotency_key="publish-first",
                request_hash="hash-v2",
                expected_version=2,
            )
            assert replay[2].id == first.id and replay[3] is False
            with pytest.raises(ArticleIdempotencyConflictError):
                await repo.claim_publication(
                    "test-org",
                    project_id,
                    article_id,
                    idempotency_key="publish-first",
                    request_hash="different-hash",
                    expected_version=2,
                )
            published = await repo.complete_publication(
                first.id,
                wordpress_post_id=321,
                wordpress_url="https://cms.example/posts/321",
                response_summary={"status": "publish"},
            )
            assert published.status == "published"

            async with sessions() as session:
                article = await session.get(Article, article_id)
                assert article is not None
                article.review_status = "approved"
                article.publication_blocked_reason = None
                await session.commit()
            _, _, update_claim, is_new = await repo.claim_publication(
                "test-org",
                project_id,
                article_id,
                idempotency_key="publish-update",
                request_hash="hash-v2-update",
                expected_version=2,
            )
            assert is_new is True
            assert update_claim.wordpress_post_id == 321
            assert update_claim.request_summary_json["operation"] == "update"
            failed = await repo.fail_publication(
                update_claim.id,
                error_code="wordpress_rejected",
                error_detail="permission denied",
                uncertain=False,
            )
            assert failed.status == "failed"

            _, _, uncertain_claim, _ = await repo.claim_publication(
                "test-org",
                project_id,
                article_id,
                idempotency_key="publish-uncertain",
                request_hash="hash-v2-uncertain",
                expected_version=2,
            )
            uncertain = await repo.fail_publication(
                uncertain_claim.id,
                error_code="wordpress_timeout",
                error_detail="response timeout",
                uncertain=True,
            )
            assert uncertain.status == "uncertain"
            with pytest.raises(ValueError, match="article_publication_uncertain"):
                await repo.claim_publication(
                    "test-org",
                    project_id,
                    article_id,
                    idempotency_key="publish-blind-retry",
                    request_hash="hash-v2-retry",
                    expected_version=2,
                )

            async with sessions() as session:
                manual_version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_type == "manual_edit",
                    )
                )
                assert manual_version is not None
                manual_version_id = manual_version.id
                unsafe_snapshot = dict(manual_version.content_json)
                unsafe_snapshot["html"] = "<script>unsafe()</script>"
                manual_version.content_json = unsafe_snapshot
                session.add(
                    ArticleVersion(
                        id=str(uuid4()),
                        article_id=article_id,
                        run_id=run_id,
                        version_number=2,
                        version_type="draft",
                        content_ref="s3://bucket/run/writing.json",
                        outline_json={},
                        quality_json={},
                        content_json={},
                        created_by="system",
                    )
                )
                await session.commit()

            versions = await repo.list_article_versions("test-org", project_id, article_id)
            assert [version.version_number for version in versions] == [2, 1]
            assert (
                await repo.get_article_version("test-org", "other-project", article_id, 1) is None
            )
            with pytest.raises(LookupError, match="article_not_found"):
                await repo.list_article_versions("other-org", project_id, article_id)
            with pytest.raises(ValueError, match="article_version_not_restorable"):
                await repo.restore_article_version(
                    "test-org",
                    project_id,
                    article_id,
                    2,
                    expected_version=2,
                    restored_by="restorer-postgres",
                )
            with pytest.raises(ValueError, match="stale_review_version:2"):
                await repo.restore_article_version(
                    "test-org",
                    project_id,
                    article_id,
                    1,
                    expected_version=1,
                    restored_by="restorer-postgres",
                )

            restored_article, restored_run, restored_version = await repo.restore_article_version(
                "test-org",
                project_id,
                article_id,
                1,
                expected_version=2,
                restored_by="restorer-postgres",
            )
            assert restored_run.id == run_id
            assert restored_article.review_version == 3
            assert restored_article.review_status == "pending_review"
            assert restored_article.publication_blocked_reason == "awaiting_review"
            assert restored_article.markdown == "Edited\n"
            assert restored_article.html == "<p>Edited</p>"
            assert restored_version.version_number == 3
            assert restored_version.version_type == "restored"
            assert restored_version.review_version == 3
            assert restored_version.created_by == "restorer-postgres"
            assert restored_version.restored_from_version_id == manual_version_id
            assert restored_version.content_json["html"] == "<p>Edited</p>"
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_concurrent_publication_claims_have_one_durable_owner() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Concurrent publication test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            async with sessions() as session:
                article = await session.get(Article, article_id)
                run = await session.get(ArticleRun, run_id)
                assert article is not None and run is not None
                article.status = "completed"
                article.publication_status = "publish_ready"
                article.review_status = "approved"
                article.review_version = 1
                article.current_version_number = 1
                article.approved_version_number = 1
                article.publication_blocked_reason = None
                document = text_document("publication-concurrency", "Concurrent")
                metadata = {
                    **article_metadata("Concurrent"),
                    "publication_status": "publish_ready",
                }
                article.document_json = document
                session.add(
                    ArticleVersion(
                        id=str(uuid4()),
                        article_id=article_id,
                        run_id=run_id,
                        version_number=1,
                        version_type="manual_edit",
                        review_version=1,
                        outline_json={},
                        quality_json={},
                        content_json={**metadata, "document": document},
                        schema_version=2,
                        document_snapshot=document,
                        metadata_snapshot=metadata,
                        asset_manifest=[],
                        content_hash=document_content_hash(document, metadata),
                        created_by="test-author",
                    )
                )
                run.status = "completed"
                run.stage = "completed"
                run.progress = 100
                await session.commit()

            same = await asyncio.gather(
                *[
                    repo.claim_publication(
                        "test-org",
                        project_id,
                        article_id,
                        idempotency_key="same-key",
                        request_hash="same-hash",
                        expected_version=1,
                    )
                    for _ in range(2)
                ]
            )
            assert len({row[2].id for row in same}) == 1
            assert sorted(row[3] for row in same) == [False, True]
            await repo.fail_publication(
                same[0][2].id,
                error_code="explicit_failure",
                error_detail="safe to retry",
                uncertain=False,
            )

            results = await asyncio.gather(
                repo.claim_publication(
                    "test-org",
                    project_id,
                    article_id,
                    idempotency_key="different-a",
                    request_hash="hash-a",
                    expected_version=1,
                ),
                repo.claim_publication(
                    "test-org",
                    project_id,
                    article_id,
                    idempotency_key="different-b",
                    request_hash="hash-b",
                    expected_version=1,
                ),
                return_exceptions=True,
            )
            owners = [row for row in results if isinstance(row, tuple)]
            failures = [row for row in results if isinstance(row, Exception)]
            assert len(owners) == 1
            assert len(failures) == 1
            assert str(failures[0]) == "article_publication_submitting"
            async with sessions() as session:
                active_count = await session.scalar(
                    select(func.count())
                    .select_from(ArticlePublication)
                    .where(
                        ArticlePublication.article_id == article_id,
                        ArticlePublication.status.in_({"submitting", "uncertain"}),
                    )
                )
                assert active_count == 1
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_article_autosave_isolated_idempotent_bounded_and_not_a_version() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Article autosave test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            await make_article_editable(sessions, article_id, run_id)

            metadata = article_metadata("Autosave draft")
            first_document = text_document("autosave-2", "Autosave sequence two")
            first_hash = document_content_hash(first_document, metadata)
            first = await repo.save_article_autosave(
                "test-org",
                project_id,
                article_id,
                user_id="author-a",
                client_id="browser-a",
                sequence=2,
                base_version_number=0,
                base_review_version=0,
                document=first_document,
                metadata=metadata,
                content_hash=first_hash,
                idempotency_key="autosave-sequence-2",
            )
            replay = await repo.save_article_autosave(
                "test-org",
                project_id,
                article_id,
                user_id="author-a",
                client_id="browser-a",
                sequence=2,
                base_version_number=0,
                base_review_version=0,
                document=first_document,
                metadata=metadata,
                content_hash=first_hash,
                idempotency_key="autosave-sequence-2",
            )
            assert replay.id == first.id

            changed_document = text_document("changed", "Changed payload")
            with pytest.raises(ValueError, match="idempotency_key_conflict"):
                await repo.save_article_autosave(
                    "test-org",
                    project_id,
                    article_id,
                    user_id="author-a",
                    client_id="browser-a",
                    sequence=3,
                    base_version_number=0,
                    base_review_version=0,
                    document=changed_document,
                    metadata=metadata,
                    content_hash=document_content_hash(changed_document, metadata),
                    idempotency_key="autosave-sequence-2",
                )
            with pytest.raises(ValueError, match="autosave_stale:2"):
                stale_document = text_document("stale", "Late sequence one")
                await repo.save_article_autosave(
                    "test-org",
                    project_id,
                    article_id,
                    user_id="author-a",
                    client_id="browser-a",
                    sequence=1,
                    base_version_number=0,
                    base_review_version=0,
                    document=stale_document,
                    metadata=metadata,
                    content_hash=document_content_hash(stale_document, metadata),
                    idempotency_key="autosave-stale-1",
                )

            for user_id, client_id in (
                ("author-b", "browser-a"),
                ("author-a", "browser-b"),
            ):
                isolated_document = text_document(
                    f"{user_id}-{client_id}", f"Draft for {user_id} on {client_id}"
                )
                await repo.save_article_autosave(
                    "test-org",
                    project_id,
                    article_id,
                    user_id=user_id,
                    client_id=client_id,
                    sequence=1,
                    base_version_number=0,
                    base_review_version=0,
                    document=isolated_document,
                    metadata=metadata,
                    content_hash=document_content_hash(isolated_document, metadata),
                    idempotency_key=f"isolated-{user_id}-{client_id}",
                )

            for sequence in range(3, 8):
                document = text_document(str(sequence), f"Autosave sequence {sequence}")
                await repo.save_article_autosave(
                    "test-org",
                    project_id,
                    article_id,
                    user_id="author-a",
                    client_id="browser-a",
                    sequence=sequence,
                    base_version_number=0,
                    base_review_version=0,
                    document=document,
                    metadata=metadata,
                    content_hash=document_content_hash(document, metadata),
                    idempotency_key=f"autosave-sequence-{sequence}",
                )

            latest = await repo.latest_article_autosave(
                "test-org",
                project_id,
                article_id,
                user_id="author-a",
                client_id="browser-a",
            )
            other_user = await repo.latest_article_autosave(
                "test-org",
                project_id,
                article_id,
                user_id="author-b",
                client_id="browser-a",
            )
            assert latest is not None and latest.sequence == 7
            assert other_user is not None and other_user.sequence == 1

            async with sessions() as session:
                owned_sequences = list(
                    await session.scalars(
                        select(ArticleAutosave.sequence)
                        .where(
                            ArticleAutosave.article_id == article_id,
                            ArticleAutosave.user_id == "author-a",
                            ArticleAutosave.client_id == "browser-a",
                        )
                        .order_by(ArticleAutosave.sequence)
                    )
                )
                version_count = await session.scalar(
                    select(func.count())
                    .select_from(ArticleVersion)
                    .where(ArticleVersion.article_id == article_id)
                )
                article = await session.get(Article, article_id)
            assert owned_sequences == [3, 4, 5, 6, 7]
            assert version_count == 0
            assert article is not None
            assert article.current_version_number == 0
            assert article.review_version == 0
            assert article.review_status is None
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_document_and_autosave_asset_validation_promotion_bindings_and_delete_protection() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, other_project_id, run_id = str(uuid4()), str(uuid4()), str(uuid4())
        ready_id = str(uuid4())
        asset_cases = {
            "cross": (str(uuid4()), other_project_id, "image", "ready", "asset_cross_project"),
            "pending": (str(uuid4()), project_id, "image", "pending", "asset_not_ready"),
            "failed": (str(uuid4()), project_id, "image", "failed", "asset_not_ready"),
            "wrong-type": (str(uuid4()), project_id, "file", "ready", "asset_type_mismatch"),
        }
        try:
            async with sessions() as session:
                session.add_all(
                    [
                        Project(
                            id=project_id,
                            organization_id="test-org",
                            name="Asset binding test",
                            domain=f"{project_id}.example.com",
                            country="US",
                            language="en",
                        ),
                        Project(
                            id=other_project_id,
                            organization_id="test-org",
                            name="Other asset project",
                            domain=f"{other_project_id}.example.com",
                            country="US",
                            language="en",
                        ),
                    ]
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            await make_article_editable(sessions, article_id, run_id)
            async with sessions() as session:
                session.add(content_asset(asset_id=ready_id, project_id=project_id))
                for asset_id, owner_project, asset_type, status, _ in asset_cases.values():
                    session.add(
                        content_asset(
                            asset_id=asset_id,
                            project_id=owner_project,
                            asset_type=asset_type,
                            status=status,
                        )
                    )
                await session.commit()

            metadata = article_metadata("Asset-backed draft")
            pending_id = asset_cases["pending"][0]
            pending_document = image_document("direct-pending", pending_id)
            with pytest.raises(ValueError, match="asset_not_ready"):
                await repo.update_article_document(
                    "test-org",
                    project_id,
                    article_id,
                    document=pending_document,
                    markdown="![Pending image](asset)\n",
                    html="<figure>Pending image</figure>",
                    metadata=metadata,
                    content_hash=document_content_hash(pending_document, metadata),
                    expected_review_version=0,
                    expected_version_number=0,
                    autosave_id=None,
                    reason="direct_pending_asset",
                    edited_by="asset-author",
                )

            for sequence, (case, values) in enumerate(asset_cases.items(), start=1):
                asset_id, _, _, _, expected_error = values
                document = image_document(case, asset_id)
                with pytest.raises(ValueError, match=expected_error):
                    await repo.save_article_autosave(
                        "test-org",
                        project_id,
                        article_id,
                        user_id="asset-author",
                        client_id="asset-browser",
                        sequence=sequence,
                        base_version_number=0,
                        base_review_version=0,
                        document=document,
                        metadata=metadata,
                        content_hash=document_content_hash(document, metadata),
                        idempotency_key=f"asset-case-{case}",
                    )

            document = image_document("ready", ready_id)
            autosave = await repo.save_article_autosave(
                "test-org",
                project_id,
                article_id,
                user_id="asset-author",
                client_id="asset-browser",
                sequence=10,
                base_version_number=0,
                base_review_version=0,
                document=document,
                metadata=metadata,
                content_hash=document_content_hash(document, metadata),
                idempotency_key="asset-ready",
            )
            async with sessions() as session:
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(ArticleVersion)
                        .where(ArticleVersion.article_id == article_id)
                    )
                    == 0
                )
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(ArticleAssetBinding)
                        .where(ArticleAssetBinding.article_id == article_id)
                    )
                    == 0
                )

                asset = await session.get(ContentAsset, ready_id)
                assert asset is not None
                asset.status = "processing"
                await session.commit()

            with pytest.raises(ValueError, match="asset_not_ready"):
                await repo.promote_article_autosave(
                    "test-org",
                    project_id,
                    article_id,
                    autosave.id,
                    user_id="asset-author",
                    base_version_number=0,
                    base_review_version=0,
                    reason="restore_recovered_draft",
                )

            async with sessions() as session:
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(ArticleVersion)
                        .where(ArticleVersion.article_id == article_id)
                    )
                    == 0
                )
                asset = await session.get(ContentAsset, ready_id)
                assert asset is not None
                asset.status = "ready"
                await session.commit()

            promoted, _ = await repo.promote_article_autosave(
                "test-org",
                project_id,
                article_id,
                autosave.id,
                user_id="asset-author",
                base_version_number=0,
                base_review_version=0,
                reason="restore_recovered_draft",
            )
            assert promoted.current_version_number == 1
            assert promoted.review_version == 1
            replay, _ = await repo.promote_article_autosave(
                "test-org",
                project_id,
                article_id,
                autosave.id,
                user_id="asset-author",
                base_version_number=0,
                base_review_version=0,
                reason="restore_recovered_draft",
            )
            assert replay.current_version_number == 1

            async with sessions() as session:
                versions = list(
                    await session.scalars(
                        select(ArticleVersion).where(ArticleVersion.article_id == article_id)
                    )
                )
                bindings = list(
                    await session.scalars(
                        select(ArticleAssetBinding)
                        .where(ArticleAssetBinding.article_id == article_id)
                        .order_by(ArticleAssetBinding.version_number.asc().nulls_first())
                    )
                )
                stored_autosave = await session.get(ArticleAutosave, autosave.id)
            assert len(versions) == 1
            assert versions[0].asset_manifest == [
                {
                    "asset_id": ready_id,
                    "binding_role": "image",
                    "node_id": "image-ready",
                    "item_id": None,
                }
            ]
            assert [(row.version_number, row.asset_id) for row in bindings] == [
                (None, ready_id),
                (1, ready_id),
            ]
            assert stored_autosave is not None
            assert stored_autosave.promoted_version_number == 1

            async with sessions() as session:
                with pytest.raises(IntegrityError):
                    await session.execute(delete(ContentAsset).where(ContentAsset.id == ready_id))
                    await session.commit()
                await session.rollback()
                assert await session.get(ContentAsset, ready_id) is not None
        finally:
            async with sessions() as session:
                await session.execute(
                    delete(ArticleAssetBinding).where(
                        ArticleAssetBinding.article_id == article_id
                    )
                )
                await session.execute(
                    delete(Project).where(Project.id.in_([project_id, other_project_id]))
                )
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_review_and_publication_revalidate_the_immutable_version_assets() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, other_project_id, run_id = str(uuid4()), str(uuid4()), str(uuid4())
        ready_id, other_ready_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add_all(
                    [
                        Project(
                            id=project_id,
                            organization_id="test-org",
                            name="Review asset gate",
                            domain=f"{project_id}.example.com",
                            country="US",
                            language="en",
                        ),
                        Project(
                            id=other_project_id,
                            organization_id="test-org",
                            name="Other review asset project",
                            domain=f"{other_project_id}.example.com",
                            country="US",
                            language="en",
                        ),
                    ]
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            await make_article_editable(sessions, article_id, run_id)
            async with sessions() as session:
                article = await session.get(Article, article_id)
                assert article is not None
                article.review_version = 1
                article.review_status = "pending_review"
                session.add_all(
                    [
                        content_asset(asset_id=ready_id, project_id=project_id),
                        content_asset(
                            asset_id=other_ready_id, project_id=other_project_id
                        ),
                    ]
                )
                await session.commit()

            document = image_document("review-gate", ready_id)
            metadata = {
                **article_metadata("Review asset gate"),
                "publication_status": "publish_ready",
            }
            saved, _ = await repo.update_article_document(
                "test-org",
                project_id,
                article_id,
                document=document,
                markdown="![Test image](asset)\n",
                html="<figure>Test image</figure>",
                metadata=metadata,
                content_hash=document_content_hash(document, metadata),
                expected_review_version=1,
                expected_version_number=0,
                autosave_id=None,
                reason="review_asset_gate",
                edited_by="asset-gate-author",
            )
            assert saved.review_version == 2

            for status in ("processing", "failed", "quarantined", "pending_delete"):
                async with sessions() as session:
                    asset = await session.get(ContentAsset, ready_id)
                    assert asset is not None
                    asset.status = status
                    await session.commit()
                with pytest.raises(ValueError, match="asset_not_ready"):
                    await repo.review_article(
                        "test-org",
                        project_id,
                        article_id,
                        decision="approved",
                        review_note=None,
                            expected_version=2,
                        reviewed_by="asset-gate-reviewer",
                    )

            async with sessions() as session:
                asset = await session.get(ContentAsset, ready_id)
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == 1,
                    )
                )
                assert asset is not None and version is not None
                asset.status = "ready"
                cross_document = image_document("review-cross", other_ready_id)
                version.document_snapshot = cross_document
                version.asset_manifest = extract_asset_manifest(cross_document)
                await session.commit()
            with pytest.raises(ValueError, match="asset_cross_project"):
                await repo.review_article(
                    "test-org",
                    project_id,
                    article_id,
                    decision="approved",
                    review_note=None,
                    expected_version=2,
                    reviewed_by="asset-gate-reviewer",
                )

            missing_document = image_document("review-missing", str(uuid4()))
            async with sessions() as session:
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == 1,
                    )
                )
                assert version is not None
                version.document_snapshot = missing_document
                version.asset_manifest = extract_asset_manifest(missing_document)
                await session.commit()
            with pytest.raises(ValueError, match="asset_not_found"):
                await repo.review_article(
                    "test-org",
                    project_id,
                    article_id,
                    decision="approved",
                    review_note=None,
                    expected_version=2,
                    reviewed_by="asset-gate-reviewer",
                )

            async with sessions() as session:
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == 1,
                    )
                )
                assert version is not None
                version.document_snapshot = document
                version.asset_manifest = []
                await session.commit()
            with pytest.raises(ValueError, match="asset_manifest_mismatch"):
                await repo.review_article(
                    "test-org",
                    project_id,
                    article_id,
                    decision="approved",
                    review_note=None,
                    expected_version=2,
                    reviewed_by="asset-gate-reviewer",
                )

            async with sessions() as session:
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == 1,
                    )
                )
                assert version is not None
                version.asset_manifest = extract_asset_manifest(document)
                await session.commit()
            approved, _ = await repo.review_article(
                "test-org",
                project_id,
                article_id,
                decision="approved",
                review_note=None,
                expected_version=2,
                reviewed_by="asset-gate-reviewer",
            )
            assert approved.approved_version_number == 1

            for status in ("processing", "failed", "quarantined", "pending_delete"):
                async with sessions() as session:
                    asset = await session.get(ContentAsset, ready_id)
                    assert asset is not None
                    asset.status = status
                    await session.commit()
                with pytest.raises(ValueError, match="asset_not_ready"):
                    await repo.claim_publication(
                        "test-org",
                        project_id,
                        article_id,
                        idempotency_key=f"publish-{status}",
                        request_hash=f"hash-{status}",
                        expected_version=2,
                    )

            async with sessions() as session:
                asset = await session.get(ContentAsset, ready_id)
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == 1,
                    )
                )
                assert asset is not None and version is not None
                asset.status = "ready"
                version.document_snapshot = missing_document
                version.asset_manifest = extract_asset_manifest(missing_document)
                await session.commit()
            with pytest.raises(ValueError, match="asset_not_found"):
                await repo.claim_publication(
                    "test-org",
                    project_id,
                    article_id,
                    idempotency_key="publish-missing",
                    request_hash="hash-missing",
                    expected_version=2,
                )

            async with sessions() as session:
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == 1,
                    )
                )
                assert version is not None
                version.document_snapshot = document
                version.asset_manifest = extract_asset_manifest(document)
                await session.commit()
            _, _, publication, claimed = await repo.claim_publication(
                "test-org",
                project_id,
                article_id,
                idempotency_key="publish-ready-version",
                request_hash="hash-ready-version",
                expected_version=2,
            )
            assert claimed is True
            assert publication.request_summary_json["review_version"] == 2
        finally:
            async with sessions() as session:
                await session.execute(
                    delete(Project).where(Project.id.in_([project_id, other_project_id]))
                )
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_content_asset_project_hash_is_unique_under_concurrent_insert() -> None:
    async def scenario() -> None:
        engine = create_content_workflow_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        project_id = str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Asset hash concurrency test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()

            async def insert_once(asset_id: str) -> bool:
                async with sessions() as session:
                    session.add(
                        content_asset(
                            asset_id=asset_id,
                            project_id=project_id,
                            content_hash="same-content-sha256",
                        )
                    )
                    try:
                        await session.commit()
                        return True
                    except IntegrityError:
                        await session.rollback()
                        return False

            results = await asyncio.gather(
                insert_once(str(uuid4())),
                insert_once(str(uuid4())),
            )
            assert sorted(results) == [False, True]
            async with sessions() as session:
                count = await session.scalar(
                    select(func.count())
                    .select_from(ContentAsset)
                    .where(
                        ContentAsset.project_id == project_id,
                        ContentAsset.content_hash == "same-content-sha256",
                    )
                )
            assert count == 1
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())
