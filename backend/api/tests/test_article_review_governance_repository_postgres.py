import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.document import document_content_hash
from app.modules.content.models import (
    Article,
    ArticleLock,
    ArticleReviewPolicy,
    ArticleReviewTask,
    ArticleRun,
    ArticleVersion,
    ContentAuditEvent,
)
from app.modules.content.repository import (
    ArticleLockConflictError,
    ContentAuditContext,
    ContentRepository,
)
from app.modules.projects.models import Project


def governance_test_database_url() -> str:
    value = os.getenv("CONTENT_WORKFLOW_TEST_DATABASE_URL", "")
    if not value:
        pytest.skip("CONTENT_WORKFLOW_TEST_DATABASE_URL is not configured")
    if make_url(value).database != "seo_content_stage2_test":
        pytest.fail("P4 governance tests may only use seo_content_stage2_test")
    return value


def create_governance_test_engine():
    return create_async_engine(
        governance_test_database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {"search_path": "public, platform, crawling, audit"}
        },
    )


def audit(actor_id: str, role: str = "content_reviewer") -> ContentAuditContext:
    return ContentAuditContext(
        actor_id=actor_id,
        effective_role=role,
        request_id=f"request-{actor_id}",
        correlation_id=f"correlation-{actor_id}",
    )


def document(version_number: int) -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": f"paragraph-v{version_number}"},
                "content": [{"type": "text", "text": f"Version {version_number}"}],
            }
        ],
    }


def metadata(version_number: int) -> dict:
    return {
        "title": f"Governed article v{version_number}",
        "slug": f"governed-article-v{version_number}",
        "meta_title": f"Governed article v{version_number}",
        "meta_description": f"Version {version_number} under review.",
        "focus_keyword": "governed article",
        "secondary_keywords": [],
        "canonical_url": None,
        "indexing": "index/follow",
        "field_states": {},
        "publication_status": "publish_ready",
    }


async def seed_governed_article(
    sessions: async_sessionmaker[AsyncSession],
    *,
    organization_id: str = "test-org",
) -> tuple[str, str, str]:
    project_id, article_id, run_id = str(uuid4()), str(uuid4()), str(uuid4())
    snapshot = document(1)
    metadata_snapshot = metadata(1)
    async with sessions() as session:
        session.add(
            Project(
                id=project_id,
                organization_id=organization_id,
                name="P4 governance test",
                domain=f"{project_id}.example.com",
                country="US",
                language="en",
            )
        )
        await session.flush()
        session.add(
            Article(
                id=article_id,
                organization_id=organization_id,
                project_id=project_id,
                primary_keyword="governed article",
                title=metadata_snapshot["title"],
                slug=metadata_snapshot["slug"],
                document_json=snapshot,
                current_content_hash=document_content_hash(snapshot, metadata_snapshot),
                current_version_number=1,
                review_version=1,
                review_status="pending_review",
                publication_status="publish_ready",
                publication_blocked_reason="awaiting_review",
                status="completed",
                current_run_id=run_id,
            )
        )
        session.add(
            ArticleRun(
                id=run_id,
                article_id=article_id,
                organization_id=organization_id,
                project_id=project_id,
                workflow_id=f"article-generation:{run_id}",
                status="completed",
                stage="completed",
                progress=100,
            )
        )
        session.add(
            ArticleVersion(
                id=str(uuid4()),
                article_id=article_id,
                run_id=run_id,
                version_number=1,
                version_type="manual_edit",
                review_version=1,
                content_json={"document": snapshot, **metadata_snapshot},
                document_snapshot=snapshot,
                metadata_snapshot=metadata_snapshot,
                asset_manifest=[],
                content_hash=document_content_hash(snapshot, metadata_snapshot),
                created_by="editor-1",
            )
        )
        await session.commit()
    return project_id, article_id, run_id


async def add_version(
    sessions: async_sessionmaker[AsyncSession],
    article_id: str,
    run_id: str,
    version_number: int,
) -> None:
    snapshot = document(version_number)
    metadata_snapshot = metadata(version_number)
    async with sessions() as session:
        article = await session.get(Article, article_id)
        assert article is not None
        article.document_json = snapshot
        article.current_content_hash = document_content_hash(snapshot, metadata_snapshot)
        article.current_version_number = version_number
        article.review_version = version_number
        article.review_status = "pending_review"
        article.approved_version_number = None
        article.publication_blocked_reason = "awaiting_review"
        session.add(
            ArticleVersion(
                id=str(uuid4()),
                article_id=article_id,
                run_id=run_id,
                version_number=version_number,
                version_type="manual_edit",
                review_version=version_number,
                content_json={"document": snapshot, **metadata_snapshot},
                document_snapshot=snapshot,
                metadata_snapshot=metadata_snapshot,
                asset_manifest=[],
                content_hash=document_content_hash(snapshot, metadata_snapshot),
                parent_version_number=version_number - 1,
                created_by="editor-1",
            )
        )
        await session.commit()


async def cleanup_project(
    sessions: async_sessionmaker[AsyncSession], project_id: str
) -> None:
    async with sessions() as session:
        await session.execute(delete(Project).where(Project.id == project_id))
        await session.commit()


def test_review_submission_is_idempotent_isolated_and_cancels_stale_tasks() -> None:
    async def scenario() -> None:
        engine = create_governance_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, article_id, run_id = await seed_governed_article(sessions)
        other_project_id, _, _ = await seed_governed_article(sessions)
        try:
            first = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=1,
                assigned_to=None,
                assigned_group="content-reviewers",
                submitted_by="editor-1",
                idempotency_key="submit-v1",
                request_hash="hash-submit-v1",
                audit=audit("editor-1", "content_editor"),
            )
            repeated = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=1,
                assigned_to=None,
                assigned_group="content-reviewers",
                submitted_by="editor-1",
                idempotency_key="submit-v1",
                request_hash="hash-submit-v1",
                audit=audit("editor-1", "content_editor"),
            )
            assert repeated.id == first.id
            with pytest.raises(ValueError, match="review_submission_idempotency_conflict"):
                await repo.submit_article_review(
                    "test-org",
                    project_id,
                    article_id,
                    version_number=1,
                    assigned_to="someone-else",
                    assigned_group=None,
                    submitted_by="editor-1",
                    idempotency_key="submit-v1",
                    request_hash="different-request",
                    audit=audit("editor-1", "content_editor"),
                )

            assert await repo.get_article_review_task(
                "test-org", other_project_id, first.id
            ) is None
            assert await repo.get_article_review_task(
                "other-org", project_id, first.id
            ) is None

            await add_version(sessions, article_id, run_id, 2)
            second = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=2,
                assigned_to="reviewer-2",
                assigned_group=None,
                submitted_by="editor-1",
                idempotency_key="submit-v2",
                request_hash="hash-submit-v2",
                audit=audit("editor-1", "content_editor"),
            )
            async with sessions() as session:
                stale = await session.get(ArticleReviewTask, first.id)
                assert stale is not None and stale.status == "cancelled"
            assert second.status == "pending"
            assert second.version_number == 2
        finally:
            await cleanup_project(sessions, project_id)
            await cleanup_project(sessions, other_project_id)
            await engine.dispose()

    asyncio.run(scenario())


def test_review_claim_decision_and_self_review_policy_are_concurrency_safe() -> None:
    async def scenario() -> None:
        engine = create_governance_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, article_id, run_id = await seed_governed_article(sessions)
        try:
            task = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=1,
                assigned_to=None,
                assigned_group=None,
                submitted_by="editor-1",
                idempotency_key="concurrent-submit-v1",
                request_hash="concurrent-submit-v1-hash",
                audit=audit("editor-1", "content_editor"),
            )
            claims = await asyncio.gather(
                repo.claim_article_review_task(
                    "test-org",
                    project_id,
                    task.id,
                    reviewer_id="reviewer-a",
                    reviewer_groups=set(),
                    audit=audit("reviewer-a"),
                ),
                repo.claim_article_review_task(
                    "test-org",
                    project_id,
                    task.id,
                    reviewer_id="reviewer-b",
                    reviewer_groups=set(),
                    audit=audit("reviewer-b"),
                ),
                return_exceptions=True,
            )
            winners = [result for result in claims if isinstance(result, ArticleReviewTask)]
            failures = [result for result in claims if isinstance(result, Exception)]
            assert len(winners) == 1 and len(failures) == 1
            reviewer_id = winners[0].claimed_by
            assert reviewer_id in {"reviewer-a", "reviewer-b"}

            decisions = await asyncio.gather(
                repo.decide_article_review_task(
                    "test-org",
                    project_id,
                    task.id,
                    reviewer_id=reviewer_id or "",
                    decision="approved",
                    comment="Ready to publish",
                    idempotency_key="decision-approved",
                    request_hash="decision-approved-hash",
                    audit=audit(reviewer_id or ""),
                ),
                repo.decide_article_review_task(
                    "test-org",
                    project_id,
                    task.id,
                    reviewer_id=reviewer_id or "",
                    decision="needs_changes",
                    comment="Conflicting decision",
                    idempotency_key="decision-needs-changes",
                    request_hash="decision-needs-changes-hash",
                    audit=audit(reviewer_id or ""),
                ),
                return_exceptions=True,
            )
            decision_winners = [result for result in decisions if isinstance(result, tuple)]
            decision_failures = [result for result in decisions if isinstance(result, Exception)]
            assert len(decision_winners) == 1 and len(decision_failures) == 1
            decided_task, decided_article = decision_winners[0]
            assert decided_task.status in {"approved", "needs_changes"}
            assert decided_article.review_status in {"approved", "changes_requested"}
            with pytest.raises(ValueError):
                await repo.decide_article_review_task(
                    "test-org",
                    project_id,
                    task.id,
                    reviewer_id=reviewer_id or "",
                    decision=(
                        "needs_changes" if decided_task.status == "approved" else "approved"
                    ),
                    comment="Terminal state cannot change",
                    idempotency_key="terminal-change",
                    request_hash="terminal-change-hash",
                    audit=audit(reviewer_id or ""),
                )

            await add_version(sessions, article_id, run_id, 2)
            self_task = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=2,
                assigned_to="editor-1",
                assigned_group=None,
                submitted_by="editor-1",
                idempotency_key="self-submit-v2",
                request_hash="self-submit-v2-hash",
                audit=audit("editor-1", "content_editor"),
            )
            await repo.claim_article_review_task(
                "test-org",
                project_id,
                self_task.id,
                reviewer_id="editor-1",
                reviewer_groups=set(),
                audit=audit("editor-1"),
            )
            with pytest.raises(PermissionError, match="article_self_review_forbidden"):
                await repo.decide_article_review_task(
                    "test-org",
                    project_id,
                    self_task.id,
                    reviewer_id="editor-1",
                    decision="approved",
                    comment="Self approval disabled",
                    idempotency_key="self-denied",
                    request_hash="self-denied-hash",
                    audit=audit("editor-1"),
                )
            async with sessions() as session:
                session.add(
                    ArticleReviewPolicy(
                        project_id=project_id,
                        allow_self_review=True,
                        version=7,
                        updated_by="policy-admin",
                    )
                )
                await session.commit()
            approved, article = await repo.decide_article_review_task(
                "test-org",
                project_id,
                self_task.id,
                reviewer_id="editor-1",
                decision="approved",
                comment="Policy permits self review",
                idempotency_key="self-approved",
                request_hash="self-approved-hash",
                audit=audit("editor-1"),
            )
            assert approved.status == "approved"
            assert approved.policy_version == "article-review-policy.v7"
            assert article.approved_version_number == 2
            async with sessions() as session:
                event = await session.scalar(
                    select(ContentAuditEvent)
                    .where(
                        ContentAuditEvent.target_id == self_task.id,
                        ContentAuditEvent.action == "article.review_approved",
                    )
                    .order_by(ContentAuditEvent.created_at.desc())
                )
                assert event is not None
                assert event.policy_version == "article-review-policy.v7"
                assert event.after_state["self_review"] is True
        finally:
            await cleanup_project(sessions, project_id)
            await engine.dispose()

    asyncio.run(scenario())


def test_changes_requested_requires_a_new_version_and_reapproval() -> None:
    async def scenario() -> None:
        engine = create_governance_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, article_id, run_id = await seed_governed_article(sessions)
        try:
            first_task = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=1,
                assigned_to="reviewer-1",
                assigned_group=None,
                submitted_by="editor-1",
                idempotency_key="changes-submit-v1",
                request_hash="changes-submit-v1-hash",
                audit=audit("editor-1", "content_editor"),
            )
            await repo.claim_article_review_task(
                "test-org",
                project_id,
                first_task.id,
                reviewer_id="reviewer-1",
                reviewer_groups=set(),
                audit=audit("reviewer-1"),
            )
            returned_task, returned_article = await repo.decide_article_review_task(
                "test-org",
                project_id,
                first_task.id,
                reviewer_id="reviewer-1",
                decision="needs_changes",
                comment="Revise the opening section",
                idempotency_key="changes-decision-v1",
                request_hash="changes-decision-v1-hash",
                audit=audit("reviewer-1"),
            )
            assert returned_task.status == "needs_changes"
            assert returned_article.review_status == "changes_requested"
            assert returned_article.approved_version_number is None

            await add_version(sessions, article_id, run_id, 2)
            second_task = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=2,
                assigned_to="reviewer-2",
                assigned_group=None,
                submitted_by="editor-1",
                idempotency_key="changes-submit-v2",
                request_hash="changes-submit-v2-hash",
                audit=audit("editor-1", "content_editor"),
            )
            assert second_task.id != first_task.id
            assert second_task.version_number == 2
            assert second_task.status == "pending"

            async with sessions() as session:
                article = await session.get(Article, article_id)
                old_task = await session.get(ArticleReviewTask, first_task.id)
                assert article is not None
                assert article.approved_version_number is None
                assert article.review_version == 2
                assert article.review_status == "pending_review"
                assert old_task is not None and old_task.status == "needs_changes"

            await repo.claim_article_review_task(
                "test-org",
                project_id,
                second_task.id,
                reviewer_id="reviewer-2",
                reviewer_groups=set(),
                audit=audit("reviewer-2"),
            )
            approved_task, approved_article = await repo.decide_article_review_task(
                "test-org",
                project_id,
                second_task.id,
                reviewer_id="reviewer-2",
                decision="approved",
                comment="Revision approved",
                idempotency_key="changes-approved-v2",
                request_hash="changes-approved-v2-hash",
                audit=audit("reviewer-2"),
            )
            assert approved_task.status == "approved"
            assert approved_article.approved_version_number == 2
            assert approved_article.review_version == 2
        finally:
            await cleanup_project(sessions, project_id)
            await engine.dispose()

    asyncio.run(scenario())


def test_article_lock_lease_fencing_takeover_and_admin_release_are_durable() -> None:
    async def scenario() -> None:
        engine = create_governance_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, article_id, _ = await seed_governed_article(sessions)
        try:
            first, first_token = await repo.acquire_article_lock(
                "test-org",
                project_id,
                article_id,
                lock_type="edit_lock",
                version_number=1,
                owner_id="editor-a",
                reason="editing",
                lease_seconds=90,
                audit=audit("editor-a", "content_editor"),
            )
            with pytest.raises(ArticleLockConflictError, match="article_lock_already_held"):
                await repo.acquire_article_lock(
                    "test-org",
                    project_id,
                    article_id,
                    lock_type="edit_lock",
                    version_number=1,
                    owner_id="editor-b",
                    reason="conflicting edit",
                    lease_seconds=90,
                    audit=audit("editor-b", "content_editor"),
                )
            renewed = await repo.renew_article_lock(
                "test-org",
                project_id,
                article_id,
                first.id,
                owner_id="editor-a",
                lock_type="edit_lock",
                token=first_token,
                fence=first.fence,
                lease_seconds=120,
                audit=audit("editor-a", "content_editor"),
            )
            assert renewed.expires_at > first.acquired_at + timedelta(seconds=90)
            with pytest.raises(ArticleLockConflictError, match="article_lock_stale_fence"):
                await repo.renew_article_lock(
                    "test-org",
                    project_id,
                    article_id,
                    first.id,
                    owner_id="editor-a",
                    lock_type="edit_lock",
                    token="stale-token-that-is-at-least-thirty-two-characters",
                    fence=first.fence,
                    lease_seconds=90,
                    audit=audit("editor-a", "content_editor"),
                )

            forced = await repo.force_release_article_lock(
                "test-org",
                project_id,
                article_id,
                first.id,
                released_by="lock-admin",
                reason="abandoned browser session",
                audit=audit("lock-admin", "content_lock_admin"),
            )
            assert forced.released_by == "lock-admin"
            assert forced.release_reason == "abandoned browser session"
            second, second_token = await repo.acquire_article_lock(
                "test-org",
                project_id,
                article_id,
                lock_type="edit_lock",
                version_number=1,
                owner_id="editor-b",
                reason="editing after admin recovery",
                lease_seconds=90,
                audit=audit("editor-b", "content_editor"),
            )
            assert second.fence == first.fence + 1
            with pytest.raises(ArticleLockConflictError, match="article_lock_stale_fence"):
                await repo.release_article_lock(
                    "test-org",
                    project_id,
                    article_id,
                    second.id,
                    owner_id="editor-b",
                    lock_type="edit_lock",
                    token=second_token,
                    fence=first.fence,
                    reason="stale release",
                    audit=audit("editor-b", "content_editor"),
                )

            async with sessions() as session:
                stored = await session.get(ArticleLock, second.id)
                assert stored is not None
                stored.acquired_at = datetime.now(UTC) - timedelta(minutes=2)
                stored.renewed_at = stored.acquired_at
                stored.expires_at = datetime.now(UTC) - timedelta(minutes=1)
                await session.commit()
            third, _ = await repo.acquire_article_lock(
                "test-org",
                project_id,
                article_id,
                lock_type="edit_lock",
                version_number=1,
                owner_id="editor-c",
                reason="expired lock takeover",
                lease_seconds=90,
                audit=audit("editor-c", "content_editor"),
            )
            assert third.fence == second.fence + 1
            async with sessions() as session:
                expired = await session.get(ArticleLock, second.id)
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.target_id == first.id,
                        ContentAuditEvent.action == "article.lock_force_released",
                    )
                )
                assert expired is not None
                assert expired.release_reason == "expired_takeover"
                assert event is not None
                assert event.reason == "abandoned browser session"
        finally:
            await cleanup_project(sessions, project_id)
            await engine.dispose()

    asyncio.run(scenario())


def test_review_decision_and_audit_are_atomic_and_audit_events_are_append_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        engine = create_governance_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, article_id, _ = await seed_governed_article(sessions)
        try:
            task = await repo.submit_article_review(
                "test-org",
                project_id,
                article_id,
                version_number=1,
                assigned_to="reviewer-atomic",
                assigned_group=None,
                submitted_by="editor-1",
                idempotency_key="atomic-submit",
                request_hash="atomic-submit-hash",
                audit=audit("editor-1", "content_editor"),
            )
            await repo.claim_article_review_task(
                "test-org",
                project_id,
                task.id,
                reviewer_id="reviewer-atomic",
                reviewer_groups=set(),
                audit=audit("reviewer-atomic"),
            )

            def fail_audit(*args, **kwargs):
                del args, kwargs
                raise RuntimeError("injected audit failure")

            monkeypatch.setattr(repo, "_add_audit_event", fail_audit)
            with pytest.raises(RuntimeError, match="injected audit failure"):
                await repo.decide_article_review_task(
                    "test-org",
                    project_id,
                    task.id,
                    reviewer_id="reviewer-atomic",
                    decision="approved",
                    comment="Must roll back with audit failure",
                    idempotency_key="atomic-decision",
                    request_hash="atomic-decision-hash",
                    audit=audit("reviewer-atomic"),
                )
            async with sessions() as session:
                stored_task = await session.get(ArticleReviewTask, task.id)
                article = await session.get(Article, article_id)
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.target_id == task.id,
                        ContentAuditEvent.action == "article.review_submitted",
                    )
                )
                assert stored_task is not None and stored_task.status == "in_review"
                assert stored_task.decision_idempotency_key is None
                assert article is not None and article.approved_version_number is None
                assert article.review_status == "pending_review"
                assert event is not None
                event_id = event.id

                with pytest.raises(DBAPIError, match="append-only"):
                    await session.execute(
                        update(ContentAuditEvent)
                        .where(ContentAuditEvent.id == event_id)
                        .values(reason="tampered")
                    )
                    await session.commit()
                await session.rollback()
                with pytest.raises(DBAPIError, match="append-only"):
                    await session.execute(
                        delete(ContentAuditEvent).where(ContentAuditEvent.id == event_id)
                    )
                    await session.commit()
                await session.rollback()
        finally:
            await cleanup_project(sessions, project_id)
            await engine.dispose()

    asyncio.run(scenario())
