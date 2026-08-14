import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.ai_edit_repository import AIEditRepository, AIEditRepositoryError
from app.modules.content.models import Article, ArticleAIEditOperation, ContentAuditEvent
from app.modules.content.repository import ContentAuditContext
from app.modules.projects.models import Project


ORGANIZATION_ID = "ai-edit-test-org"


def ai_edit_test_database_url() -> str:
    value = os.getenv("CONTENT_WORKFLOW_TEST_DATABASE_URL", "")
    if not value:
        pytest.skip("CONTENT_WORKFLOW_TEST_DATABASE_URL is not configured")
    if make_url(value).database != "seo_content_stage2_test":
        pytest.fail("P6 AI edit tests may only use seo_content_stage2_test")
    return value


def create_ai_edit_test_engine():
    return create_async_engine(
        ai_edit_test_database_url(),
        pool_pre_ping=True,
        connect_args={"server_settings": {"search_path": "public, platform, crawling, audit"}},
    )


def audit(actor_id: str = "editor-p6") -> ContentAuditContext:
    return ContentAuditContext(
        actor_id=actor_id,
        effective_role="content_editor",
        request_id=f"request-{actor_id}",
        correlation_id=f"correlation-{actor_id}",
        policy_version="article-ai-edit.v1",
    )


def operation_values(
    project_id: str,
    article_id: str,
    *,
    operation_id: str | None = None,
    idempotency_key: str | None = None,
    request_hash: str | None = None,
) -> dict:
    return {
        "id": operation_id or f"operation-{uuid4().hex}",
        "organization_id": ORGANIZATION_ID,
        "project_id": project_id,
        "article_id": article_id,
        "parent_operation_id": None,
        "created_by": "editor-p6",
        "command": "rewrite",
        "scope": "selection",
        "status": "queued",
        "base_review_version": 1,
        "document_hash": "d" * 64,
        "anchor_node_id": "paragraph-p6",
        "selection_from": 0,
        "selection_to": 8,
        "selected_text_hash": "s" * 64,
        "input_payload_json": {"selected_text": "Original"},
        "prompt_version": "article-ai-edit.v1",
        "model_config_json": {
            "provider": "deterministic_fake",
            "model": "article-ai-edit-fixture-v1",
            "base_url_hash": "b" * 64,
        },
        "input_hash": "i" * 64,
        "candidate_kind": "text",
        "allowed_modes_json": ["replace"],
        "stream_expires_at": datetime.now(UTC) + timedelta(minutes=10),
        "idempotency_key": idempotency_key or f"create-{uuid4().hex}",
        "request_hash": request_hash or f"request-{uuid4().hex}",
    }


async def seed_article(
    sessions: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    project_id = f"project-{uuid4().hex}"
    article_id = f"article-{uuid4().hex}"
    async with sessions() as session, session.begin():
        session.add(
            Project(
                id=project_id,
                organization_id=ORGANIZATION_ID,
                name="P6 AI edit repository test",
                domain=f"{project_id}.example.test",
                country="US",
                language="en",
            )
        )
        await session.flush()
        session.add(
            Article(
                id=article_id,
                organization_id=ORGANIZATION_ID,
                project_id=project_id,
                primary_keyword="article ai",
                title="Article AI",
                document_json={"type": "doc", "schema_version": 2, "content": []},
                current_content_hash="d" * 64,
                current_version_number=1,
                review_version=1,
                status="completed",
                publication_status="complete_draft",
            )
        )
    return project_id, article_id


async def cleanup_projects(
    sessions: async_sessionmaker[AsyncSession], project_ids: list[str]
) -> None:
    async with sessions() as session, session.begin():
        await session.execute(delete(Project).where(Project.id.in_(project_ids)))


async def create_operation(
    repository: AIEditRepository,
    values: dict,
    *,
    token: str | None = None,
    active_limit: int = 50,
    hourly_limit: int = 1000,
    monthly_token_limit: int = 2_000_000,
):
    return await repository.create(
        values=values,
        stream_token=token or f"stream-{uuid4().hex}",
        audit=audit(),
        active_limit=active_limit,
        hourly_limit=hourly_limit,
        monthly_token_limit=monthly_token_limit,
    )


def test_create_idempotency_limits_quota_and_secret_exclusion() -> None:
    async def scenario() -> None:
        engine = create_ai_edit_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AIEditRepository(sessions)
        projects: list[str] = []
        try:
            project_id, article_id = await seed_article(sessions)
            projects.append(project_id)
            values = operation_values(
                project_id,
                article_id,
                idempotency_key="stable-create-key",
                request_hash="stable-request-hash",
            )
            first_token = f"first-{uuid4().hex}"
            rotated_token = f"rotated-{uuid4().hex}"
            created, is_new = await create_operation(repository, values, token=first_token)
            assert is_new is True

            repeated, is_new = await create_operation(repository, values, token=rotated_token)
            assert is_new is False and repeated.id == created.id
            with pytest.raises(AIEditRepositoryError, match="ai_edit_stream_token_invalid"):
                await repository.get_by_stream_token(
                    project_id, article_id, created.id, first_token
                )
            assert (
                await repository.get_by_stream_token(
                    project_id, article_id, created.id, rotated_token
                )
            ).id == created.id

            conflicting = {**values, "request_hash": "different-request-hash"}
            with pytest.raises(AIEditRepositoryError, match="ai_edit_idempotency_conflict"):
                await create_operation(repository, conflicting)

            with pytest.raises(AIEditRepositoryError, match="ai_edit_concurrency_limit"):
                await create_operation(
                    repository,
                    operation_values(project_id, article_id),
                    active_limit=1,
                )

            rate_project, rate_article = await seed_article(sessions)
            projects.append(rate_project)
            await create_operation(repository, operation_values(rate_project, rate_article))
            with pytest.raises(AIEditRepositoryError, match="ai_edit_rate_limit"):
                await create_operation(
                    repository,
                    operation_values(rate_project, rate_article),
                    hourly_limit=1,
                )

            quota_project, quota_article = await seed_article(sessions)
            projects.append(quota_project)
            quota_operation, _ = await create_operation(
                repository, operation_values(quota_project, quota_article)
            )
            async with sessions() as session, session.begin():
                await session.execute(
                    update(ArticleAIEditOperation)
                    .where(ArticleAIEditOperation.id == quota_operation.id)
                    .values(status="ready", input_tokens=7, output_tokens=5)
                )
            with pytest.raises(AIEditRepositoryError, match="ai_edit_quota_exhausted"):
                await create_operation(
                    repository,
                    operation_values(quota_project, quota_article),
                    monthly_token_limit=10,
                )

            async with sessions() as session:
                operations = list(
                    await session.scalars(
                        select(ArticleAIEditOperation).where(
                            ArticleAIEditOperation.project_id.in_(projects)
                        )
                    )
                )
                events = list(
                    await session.scalars(
                        select(ContentAuditEvent).where(ContentAuditEvent.project_id.in_(projects))
                    )
                )
            serialized = repr(
                [
                    {
                        "input": row.input_payload_json,
                        "model": row.model_config_json,
                        "error": row.error_detail,
                    }
                    for row in operations
                ]
                + [{"before": row.before_state, "after": row.after_state} for row in events]
            )
            assert "api_key" not in serialized
            assert rotated_token not in serialized
        finally:
            if projects:
                await cleanup_projects(sessions, projects)
            await engine.dispose()

    asyncio.run(scenario())


def test_current_editing_snapshot_can_create_and_accept_candidate() -> None:
    async def scenario() -> None:
        engine = create_ai_edit_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AIEditRepository(sessions)
        project_id, article_id = await seed_article(sessions)
        try:
            values = {
                **operation_values(project_id, article_id),
                "document_hash": "e" * 64,
            }
            operation, created = await create_operation(repository, values)
            assert created is True
            await repository.worker_start(operation.id, provider="fake", model="fixture")
            await repository.worker_complete(
                operation.id,
                candidate_text="Rewritten autosave",
                candidate_metadata=None,
                candidate_slice=None,
                output_hash="o" * 64,
                input_tokens=2,
                output_tokens=2,
                latency_ms=5,
            )

            accepted, changed = await repository.accept(
                ORGANIZATION_ID,
                project_id,
                article_id,
                operation.id,
                mode="replace",
                request_hash="accept-autosave-request",
                idempotency_key="accept-autosave-key",
                actor_id="editor-p6",
                current_review_version=1,
                current_document_hash="e" * 64,
                result={"kind": "text", "text": "Rewritten autosave"},
                audit=audit(),
            )

            assert changed is True
            assert accepted.status == "accepted"
            async with sessions() as session:
                persisted_article = await session.get(Article, article_id)
            assert persisted_article is not None
            assert persisted_article.current_content_hash == "d" * 64
        finally:
            await cleanup_projects(sessions, [project_id])
            await engine.dispose()

    asyncio.run(scenario())


def test_stream_token_scope_expiry_and_tenant_isolation() -> None:
    async def scenario() -> None:
        engine = create_ai_edit_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AIEditRepository(sessions)
        project_id, article_id = await seed_article(sessions)
        other_project, other_article = await seed_article(sessions)
        try:
            values = operation_values(project_id, article_id)
            valid_token = f"valid-{uuid4().hex}"
            operation, _ = await create_operation(repository, values, token=valid_token)
            with pytest.raises(AIEditRepositoryError, match="ai_edit_not_found"):
                await repository.get("other-org", project_id, article_id, operation.id)
            with pytest.raises(AIEditRepositoryError, match="ai_edit_not_found"):
                await repository.get(ORGANIZATION_ID, other_project, article_id, operation.id)
            with pytest.raises(AIEditRepositoryError, match="ai_edit_not_found"):
                await repository.get_by_stream_token(
                    other_project, other_article, operation.id, valid_token
                )
            with pytest.raises(AIEditRepositoryError, match="ai_edit_stream_token_invalid"):
                await repository.get_by_stream_token(
                    project_id, article_id, operation.id, "wrong-token"
                )
            async with sessions() as session, session.begin():
                await session.execute(
                    update(ArticleAIEditOperation)
                    .where(ArticleAIEditOperation.id == operation.id)
                    .values(stream_expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
            with pytest.raises(AIEditRepositoryError, match="ai_edit_stream_token_expired"):
                await repository.get_by_stream_token(
                    project_id, article_id, operation.id, valid_token
                )
        finally:
            await cleanup_projects(sessions, [project_id, other_project])
            await engine.dispose()

    asyncio.run(scenario())


def test_worker_cancel_retry_and_failure_audit_are_race_safe() -> None:
    async def scenario() -> None:
        engine = create_ai_edit_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AIEditRepository(sessions)
        project_id, article_id = await seed_article(sessions)
        try:
            cancelled, _ = await create_operation(
                repository, operation_values(project_id, article_id)
            )
            assert await repository.worker_start(cancelled.id, provider="fake", model="fixture")
            await repository.cancel(
                ORGANIZATION_ID,
                project_id,
                article_id,
                cancelled.id,
                audit=audit(),
            )
            assert not await repository.worker_complete(
                cancelled.id,
                candidate_text="late candidate",
                candidate_metadata=None,
                candidate_slice=None,
                output_hash="o" * 64,
                input_tokens=1,
                output_tokens=1,
                latency_ms=10,
            )
            assert not await repository.worker_fail(
                cancelled.id, code="late_failure", detail="late failure"
            )
            assert (await repository.get_for_worker(cancelled.id)).status == "cancelled"

            retrying, _ = await create_operation(
                repository, operation_values(project_id, article_id)
            )
            async with sessions() as session, session.begin():
                await session.execute(
                    update(ArticleAIEditOperation)
                    .where(ArticleAIEditOperation.id == retrying.id)
                    .values(
                        status="streaming",
                        candidate_text="partial secret-free candidate",
                        candidate_metadata_json={"old": True},
                        candidate_slice_json={"old": True},
                        output_hash="o" * 64,
                    )
                )
            retried = await repository.worker_start(
                retrying.id, provider="fake", model="fixture", retry=True
            )
            assert retried is not None
            assert retried.candidate_text is None
            assert retried.candidate_metadata_json is None
            assert retried.candidate_slice_json is None
            assert retried.output_hash is None

            failed, _ = await create_operation(repository, operation_values(project_id, article_id))
            assert await repository.worker_fail(
                failed.id,
                code="ai_edit_provider_failed",
                detail="API key was not included",
            )
            async with sessions() as session:
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.target_id == failed.id,
                        ContentAuditEvent.action == "article.ai_edit_failed",
                    )
                )
            assert event is not None
            assert event.before_state == {"status": "queued"}
            assert event.after_state == {
                "status": "failed",
                "error_code": "ai_edit_provider_failed",
            }
        finally:
            await cleanup_projects(sessions, [project_id])
            await engine.dispose()

    asyncio.run(scenario())


def test_accept_is_idempotent_and_stale_accept_is_audited() -> None:
    async def scenario() -> None:
        engine = create_ai_edit_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AIEditRepository(sessions)
        project_id, article_id = await seed_article(sessions)
        try:
            accepted, _ = await create_operation(
                repository, operation_values(project_id, article_id)
            )
            await repository.worker_start(accepted.id, provider="fake", model="fixture")
            await repository.worker_complete(
                accepted.id,
                candidate_text="Rewritten",
                candidate_metadata=None,
                candidate_slice=None,
                output_hash="o" * 64,
                input_tokens=2,
                output_tokens=2,
                latency_ms=5,
            )
            result = {"kind": "text", "text": "Rewritten"}
            row, changed = await repository.accept(
                ORGANIZATION_ID,
                project_id,
                article_id,
                accepted.id,
                mode="replace",
                request_hash="accept-request",
                idempotency_key="accept-key",
                actor_id="editor-p6",
                current_review_version=1,
                current_document_hash="d" * 64,
                result=result,
                audit=audit(),
            )
            assert changed is True and row.accepted_result_json == result
            _, changed = await repository.accept(
                ORGANIZATION_ID,
                project_id,
                article_id,
                accepted.id,
                mode="replace",
                request_hash="accept-request",
                idempotency_key="accept-key",
                actor_id="editor-p6",
                current_review_version=1,
                current_document_hash="d" * 64,
                result=result,
                audit=audit(),
            )
            assert changed is False
            with pytest.raises(AIEditRepositoryError, match="ai_edit_accept_idempotency_conflict"):
                await repository.accept(
                    ORGANIZATION_ID,
                    project_id,
                    article_id,
                    accepted.id,
                    mode="replace",
                    request_hash="different-accept-request",
                    idempotency_key="accept-key",
                    actor_id="editor-p6",
                    current_review_version=1,
                    current_document_hash="d" * 64,
                    result=result,
                    audit=audit(),
                )

            stale, _ = await create_operation(repository, operation_values(project_id, article_id))
            await repository.worker_start(stale.id, provider="fake", model="fixture")
            await repository.worker_complete(
                stale.id,
                candidate_text="Old candidate",
                candidate_metadata=None,
                candidate_slice=None,
                output_hash="x" * 64,
                input_tokens=1,
                output_tokens=1,
                latency_ms=5,
            )
            async with sessions() as session, session.begin():
                await session.execute(
                    update(Article)
                    .where(Article.id == article_id)
                    .values(review_version=2)
                )
            with pytest.raises(AIEditRepositoryError, match="ai_edit_stale"):
                await repository.accept(
                    ORGANIZATION_ID,
                    project_id,
                    article_id,
                    stale.id,
                    mode="replace",
                    request_hash="stale-accept-request",
                    idempotency_key="stale-accept-key",
                    actor_id="editor-p6",
                    current_review_version=1,
                    current_document_hash="d" * 64,
                    result={"kind": "text", "text": "Old candidate"},
                    audit=audit(),
                )
            persisted = await repository.get_for_worker(stale.id)
            assert persisted.status == "stale"
            async with sessions() as session:
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.target_id == stale.id,
                        ContentAuditEvent.action == "article.ai_edit_stale",
                    )
                )
            assert event is not None
            assert event.before_state == {"status": "ready"}
            assert event.after_state == {"status": "stale"}
        finally:
            await cleanup_projects(sessions, [project_id])
            await engine.dispose()

    asyncio.run(scenario())
