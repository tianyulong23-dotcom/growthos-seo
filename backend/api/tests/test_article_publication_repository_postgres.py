import asyncio
import importlib.util
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import ModuleType
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.document import document_content_hash
from app.modules.content.models import (
    Article,
    ArticlePublication,
    ArticleReviewTask,
    ArticleRun,
    ArticleVersion,
    ContentAsset,
    ContentAuditEvent,
    PublicationAssetMapping,
    PublicationTarget,
)
from app.modules.content.publication_repository import (
    PublicationIdempotencyConflictError,
    PublicationRepository,
)
from app.modules.content.repository import ContentAuditContext
from app.modules.projects.models import Project
from app.modules.settings.models import WordPressProjectConnection


ORGANIZATION_ID = "publication-test-org"
MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations" / "versions"


def load_migration_module(filename: str) -> ModuleType:
    path = MIGRATIONS / filename
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def publication_test_database_url() -> str:
    value = os.getenv("CONTENT_WORKFLOW_TEST_DATABASE_URL", "")
    if not value:
        pytest.skip("CONTENT_WORKFLOW_TEST_DATABASE_URL is not configured")
    if make_url(value).database != "seo_content_stage2_test":
        pytest.fail("P5 publication tests may only use seo_content_stage2_test")
    return value


def create_publication_test_engine():
    return create_async_engine(
        publication_test_database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {"search_path": "public, platform, crawling, audit"}
        },
    )


@pytest.mark.parametrize(
    ("operation", "asset_manifest", "capabilities", "missing"),
    [
        ("create", [], {"post_reconcile": True}, "post_create"),
        (
            "update",
            [],
            {"post_create": True, "post_reconcile": True},
            "post_update_by_remote_id",
        ),
        (
            "create",
            [{"asset_id": "asset-1"}],
            {
                "post_create": True,
                "post_reconcile": True,
                "media_lookup": True,
            },
            "media_upload",
        ),
        (
            "create",
            [{"asset_id": "asset-1"}],
            {
                "post_create": True,
                "post_reconcile": True,
                "media_upload": True,
            },
            "media_lookup",
        ),
    ],
)
def test_publication_target_capability_gate_fails_closed(
    operation: str,
    asset_manifest: list[dict[str, str]],
    capabilities: dict[str, bool],
    missing: str,
) -> None:
    target = PublicationTarget(
        id="target-capability-test",
        organization_id=ORGANIZATION_ID,
        project_id="project-capability-test",
        adapter_type="wordpress",
        site_url="https://wordpress.example.test",
        capabilities_json=capabilities,
        status="verified",
    )
    version = ArticleVersion(asset_manifest=asset_manifest)

    with pytest.raises(
        ValueError, match=f"publication_target_capability_missing:{missing}"
    ):
        PublicationRepository._validate_target_capabilities(
            target, version, operation
        )


def audit(actor_id: str = "publisher-p5") -> ContentAuditContext:
    return ContentAuditContext(
        actor_id=actor_id,
        effective_role="content_publisher",
        request_id=f"request-{actor_id}",
        correlation_id=f"correlation-{actor_id}",
        policy_version="article-publication-policy.v1",
    )


def article_document() -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": "paragraph-publication-p5"},
                "content": [{"type": "text", "text": "Frozen publication body"}],
            }
        ],
    }


def article_metadata() -> dict:
    return {
        "title": "P5 publication article",
        "slug": f"p5-publication-{uuid4().hex}",
        "meta_title": "P5 publication article",
        "meta_description": "A frozen P5 publication snapshot.",
        "focus_keyword": "publication",
        "secondary_keywords": [],
        "canonical_url": None,
        "indexing": "index/follow",
        "field_states": {},
        "publication_status": "publish_ready",
    }


async def reset_publication_projects(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    async with sessions() as session, session.begin():
        await session.execute(
            delete(Project).where(Project.organization_id == ORGANIZATION_ID)
        )


async def seed_approved_article(
    sessions: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str]:
    project_id = f"project-{uuid4().hex}"
    article_id = f"article-{uuid4().hex}"
    run_id = f"run-{uuid4().hex}"
    version_id = f"version-{uuid4().hex}"
    document = article_document()
    metadata = article_metadata()
    async with sessions() as session, session.begin():
        session.add(
            Project(
                id=project_id,
                organization_id=ORGANIZATION_ID,
                name="P5 publication repository test",
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
                primary_keyword="publication",
                title=metadata["title"],
                slug=metadata["slug"],
                meta_title=metadata["meta_title"],
                meta_description=metadata["meta_description"],
                document_json=document,
                current_content_hash=document_content_hash(document, metadata),
                current_version_number=1,
                approved_version_number=1,
                status="completed",
                publication_status="publish_ready",
                review_status="approved",
                review_version=1,
                current_run_id=run_id,
            )
        )
        await session.flush()
        session.add(
            ArticleRun(
                id=run_id,
                article_id=article_id,
                organization_id=ORGANIZATION_ID,
                project_id=project_id,
                workflow_id=f"article-generation:{run_id}",
                status="completed",
                stage="completed",
                progress=100,
            )
        )
        await session.flush()
        session.add(
            ArticleVersion(
                id=version_id,
                article_id=article_id,
                run_id=run_id,
                version_number=1,
                version_type="manual_edit",
                review_version=1,
                content_json={"document": document, **metadata},
                document_snapshot=document,
                metadata_snapshot=metadata,
                asset_manifest=[],
                content_hash=document_content_hash(document, metadata),
                created_by="editor-p5",
            )
        )
        await session.flush()
        session.add(
            ArticleReviewTask(
                id=f"review-{uuid4().hex}",
                article_id=article_id,
                version_id=version_id,
                version_number=1,
                organization_id=ORGANIZATION_ID,
                project_id=project_id,
                status="approved",
                submitted_by="editor-p5",
                claimed_by="reviewer-p5",
                decided_by="reviewer-p5",
                policy_version="article-review-policy.v1",
                submission_idempotency_key=f"review-submit-{uuid4().hex}",
                submission_request_hash="review-request-hash",
                decision_idempotency_key=f"review-decision-{uuid4().hex}",
                decision_request_hash="review-decision-hash",
            )
        )
    return project_id, article_id, version_id


async def create_target(
    repository: PublicationRepository, project_id: str
):
    return await repository.upsert_wordpress_target(
        ORGANIZATION_ID,
        project_id,
        site_url="https://wordpress.example.test",
        verified=True,
        capabilities={
            "media_upload": True,
            "media_lookup": True,
            "post_create": True,
            "post_update_by_remote_id": True,
            "post_reconcile": True,
            "theme_preview": False,
        },
    )


async def create_publication(
    repository: PublicationRepository,
    project_id: str,
    article_id: str,
    target_id: str,
    *,
    idempotency_key: str,
    request_hash: str = "request-hash",
    mode: str = "immediate",
    schedule_at_utc: datetime | None = None,
) -> ArticlePublication:
    return await repository.create_publication(
        ORGANIZATION_ID,
        project_id,
        article_id,
        version_number=1,
        target_id=target_id,
        mode=mode,
        schedule_at_utc=schedule_at_utc,
        source_timezone="Asia/Shanghai" if mode == "scheduled" else "UTC",
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        payload_hash="a" * 64,
        asset_manifest_hash="b" * 64,
        created_by="publisher-p5",
        audit=audit(),
    )


def test_publication_idempotency_and_single_active_attempt_are_serialized() -> None:
    async def scenario() -> None:
        engine = create_publication_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = PublicationRepository(sessions)
        try:
            await reset_publication_projects(sessions)
            project_id, article_id, _ = await seed_approved_article(sessions)
            target = await create_target(repository, project_id)

            repeated = await asyncio.gather(
                *[
                    create_publication(
                        repository,
                        project_id,
                        article_id,
                        target.id,
                        idempotency_key="same-publication-request",
                    )
                    for _ in range(2)
                ]
            )
            assert repeated[0].id == repeated[1].id
            async with sessions() as session:
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(ArticlePublication)
                        .where(ArticlePublication.article_id == article_id)
                    )
                ) == 1

            with pytest.raises(PublicationIdempotencyConflictError):
                await create_publication(
                    repository,
                    project_id,
                    article_id,
                    target.id,
                    idempotency_key="same-publication-request",
                    request_hash="different-request-hash",
                )
            with pytest.raises(ValueError, match="article_publication_active"):
                await create_publication(
                    repository,
                    project_id,
                    article_id,
                    target.id,
                    idempotency_key="second-active-publication",
                )
        finally:
            await reset_publication_projects(sessions)
            await engine.dispose()

    asyncio.run(scenario())


def test_legacy_wordpress_publications_are_backfilled_and_updated_in_place() -> None:
    async def scenario() -> None:
        engine = create_publication_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = PublicationRepository(sessions)
        migration = load_migration_module(
            "20260810_0048_article_preview_publication_orchestration.py"
        )
        try:
            await reset_publication_projects(sessions)
            project_id, article_id, _ = await seed_approved_article(sessions)
            disconnected_project_id, disconnected_article_id, _ = (
                await seed_approved_article(sessions)
            )
            legacy_publication_id = f"legacy-publication-{uuid4().hex}"
            disconnected_publication_id = f"legacy-publication-{uuid4().hex}"
            async with sessions() as session, session.begin():
                session.add(
                    WordPressProjectConnection(
                        project_id=project_id,
                        site_url="https://legacy-wordpress.example.test///",
                        username="legacy-publisher",
                        application_password_encrypted=b"encrypted-test-secret",
                        verified_user="legacy-publisher",
                        verified_at=datetime.now(UTC),
                    )
                )
                session.add_all(
                    [
                        ArticlePublication(
                            id=legacy_publication_id,
                            article_id=article_id,
                            organization_id=ORGANIZATION_ID,
                            project_id=project_id,
                            idempotency_key=f"legacy-{uuid4().hex}",
                            request_hash="legacy-request-hash",
                            status="published",
                            attempt_count=1,
                            remote_post_id=731,
                            remote_url="https://legacy-wordpress.example.test/article",
                            published_at=datetime.now(UTC),
                        ),
                        ArticlePublication(
                            id=disconnected_publication_id,
                            article_id=disconnected_article_id,
                            organization_id=ORGANIZATION_ID,
                            project_id=disconnected_project_id,
                            idempotency_key=f"legacy-{uuid4().hex}",
                            request_hash="legacy-request-hash",
                            status="published",
                            attempt_count=1,
                            remote_post_id=991,
                            remote_url="https://unknown-wordpress.example.test/article",
                            published_at=datetime.now(UTC),
                        ),
                    ]
                )

            async with sessions() as session, session.begin():
                for statement in migration.legacy_wordpress_backfill_statements():
                    await session.execute(statement)

            async with sessions() as session:
                target = await session.scalar(
                    select(PublicationTarget).where(
                        PublicationTarget.project_id == project_id,
                        PublicationTarget.adapter_type == "wordpress",
                    )
                )
                legacy = await session.get(ArticlePublication, legacy_publication_id)
                disconnected = await session.get(
                    ArticlePublication, disconnected_publication_id
                )
                assert target is not None
                assert target.id.startswith("legacy-wordpress-")
                assert target.organization_id == ORGANIZATION_ID
                assert target.site_url == "https://legacy-wordpress.example.test"
                assert target.status == "verified"
                assert target.credential_reference == f"wordpress-project:{project_id}"
                assert legacy is not None and legacy.target_id == target.id
                assert legacy.version_id is None
                assert legacy.version_number is None
                assert legacy.payload_hash == ""
                assert legacy.asset_manifest_hash == ""
                assert disconnected is not None and disconnected.target_id is None

            publication = await create_publication(
                repository,
                project_id,
                article_id,
                target.id,
                idempotency_key="post-migration-update",
            )
            assert publication.request_summary_json["operation"] == "update"
            assert publication.remote_post_id == 731
            assert publication.remote_url == (
                "https://legacy-wordpress.example.test/article"
            )
        finally:
            await reset_publication_projects(sessions)
            await engine.dispose()

    asyncio.run(scenario())


def test_scheduled_claim_is_due_only_once_and_cancel_race_is_determinate() -> None:
    async def scenario() -> None:
        engine = create_publication_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = PublicationRepository(sessions)
        try:
            await reset_publication_projects(sessions)
            project_id, article_id, _ = await seed_approved_article(sessions)
            target = await create_target(repository, project_id)
            scheduled = await create_publication(
                repository,
                project_id,
                article_id,
                target.id,
                idempotency_key="scheduled-publication",
                mode="scheduled",
                schedule_at_utc=datetime.now(UTC) + timedelta(hours=1),
            )
            assert await repository.claim_due("worker-early", lease_seconds=30) == []
            async with sessions() as session, session.begin():
                await session.execute(
                    update(ArticlePublication)
                    .where(ArticlePublication.id == scheduled.id)
                    .values(schedule_at_utc=datetime.now(UTC) - timedelta(seconds=1))
                )

            claims = await asyncio.gather(
                repository.claim_due("worker-a", lease_seconds=30),
                repository.claim_due("worker-b", lease_seconds=30),
            )
            assert sum(result.count(scheduled.id) for result in claims) == 1

            race_project, race_article, _ = await seed_approved_article(sessions)
            race_target = await create_target(repository, race_project)
            cancellable = await create_publication(
                repository,
                race_project,
                race_article,
                race_target.id,
                idempotency_key="cancel-race",
            )
            outcomes = await asyncio.gather(
                repository.claim_due("worker-race", lease_seconds=30),
                repository.cancel_publication(
                    ORGANIZATION_ID,
                    race_project,
                    cancellable.id,
                    cancelled_by="publisher-p5",
                    reason="cancel at dispatch boundary",
                    audit=audit(),
                ),
                return_exceptions=True,
            )
            async with sessions() as session:
                stored = await session.get(ArticlePublication, cancellable.id)
                assert stored is not None
                assert stored.status in {"submitting", "cancelled"}
                if stored.status == "submitting":
                    assert isinstance(outcomes[1], ValueError)
                else:
                    assert cancellable.id not in outcomes[0]
                    assert isinstance(outcomes[1], ArticlePublication)
        finally:
            await reset_publication_projects(sessions)
            await engine.dispose()

    asyncio.run(scenario())


def test_mapping_lease_has_one_uploader_and_expired_owner_is_fenced() -> None:
    async def scenario() -> None:
        engine = create_publication_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = PublicationRepository(sessions)
        try:
            await reset_publication_projects(sessions)
            project_id, _, _ = await seed_approved_article(sessions)
            target = await create_target(repository, project_id)
            asset_id = f"asset-{uuid4().hex}"
            variant_hash = "c" * 64
            async with sessions() as session, session.begin():
                session.add(
                    ContentAsset(
                        id=asset_id,
                        project_id=project_id,
                        asset_type="image",
                        status="ready",
                        original_filename="publication.jpg",
                        mime_type="image/jpeg",
                        detected_mime_type="image/jpeg",
                        byte_size=128,
                        content_hash=variant_hash,
                        storage_key=f"assets/{project_id}/{asset_id}/original",
                        source_type="upload",
                        created_by="publisher-p5",
                    )
                )

            claims = await asyncio.gather(
                repository.claim_mapping(
                    target_id=target.id,
                    asset_id=asset_id,
                    variant_hash=variant_hash,
                    remote_slug="stable-media-slug",
                    worker_id="media-worker-a",
                    lease_seconds=30,
                ),
                repository.claim_mapping(
                    target_id=target.id,
                    asset_id=asset_id,
                    variant_hash=variant_hash,
                    remote_slug="stable-media-slug",
                    worker_id="media-worker-b",
                    lease_seconds=30,
                ),
                return_exceptions=True,
            )
            winners = [result for result in claims if isinstance(result, tuple)]
            failures = [result for result in claims if isinstance(result, Exception)]
            assert len(winners) == 1 and winners[0][1] is True
            assert len(failures) == 1
            mapping = winners[0][0]
            first_owner = mapping.lease_owner
            second_owner = "media-worker-b" if first_owner == "media-worker-a" else "media-worker-a"

            async with sessions() as session, session.begin():
                await session.execute(
                    update(PublicationAssetMapping)
                    .where(PublicationAssetMapping.id == mapping.id)
                    .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
            reclaimed, claimed = await repository.claim_mapping(
                target_id=target.id,
                asset_id=asset_id,
                variant_hash=variant_hash,
                remote_slug="stable-media-slug",
                worker_id=second_owner,
                lease_seconds=30,
            )
            assert claimed is True
            assert reclaimed.lease_owner == second_owner
            assert reclaimed.attempt_count == 2
            with pytest.raises(ValueError, match="publication_asset_mapping_lease_lost"):
                await repository.complete_mapping(
                    mapping.id,
                    worker_id=str(first_owner),
                    remote_media_id=41,
                    remote_source_url="https://wordpress.example.test/media/41.jpg",
                    remote_hash=variant_hash,
                )
            completed = await repository.complete_mapping(
                mapping.id,
                worker_id=second_owner,
                remote_media_id=42,
                remote_source_url="https://wordpress.example.test/media/42.jpg",
                remote_hash=variant_hash,
            )
            assert completed.status == "ready"
            assert completed.remote_media_id == 42
        finally:
            await reset_publication_projects(sessions)
            await engine.dispose()

    asyncio.run(scenario())


def test_publication_asset_reference_allows_project_cascade_but_blocks_asset_delete() -> None:
    async def scenario() -> None:
        engine = create_publication_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = PublicationRepository(sessions)
        try:
            await reset_publication_projects(sessions)
            project_id, _, _ = await seed_approved_article(sessions)
            target = await create_target(repository, project_id)
            asset_id = f"asset-{uuid4().hex}"
            variant_hash = "d" * 64
            async with sessions() as session, session.begin():
                session.add(
                    ContentAsset(
                        id=asset_id,
                        project_id=project_id,
                        asset_type="image",
                        status="ready",
                        original_filename="protected-publication.jpg",
                        mime_type="image/jpeg",
                        detected_mime_type="image/jpeg",
                        byte_size=128,
                        content_hash=variant_hash,
                        storage_key=f"assets/{project_id}/{asset_id}/original",
                        source_type="upload",
                        created_by="publisher-p5",
                    )
                )
            await repository.claim_mapping(
                target_id=target.id,
                asset_id=asset_id,
                variant_hash=variant_hash,
                remote_slug="protected-publication-media",
                worker_id="media-worker-a",
                lease_seconds=30,
            )

            async with sessions() as session:
                await session.execute(delete(ContentAsset).where(ContentAsset.id == asset_id))
                with pytest.raises(IntegrityError):
                    await session.commit()
                await session.rollback()

            async with sessions() as session, session.begin():
                await session.execute(delete(Project).where(Project.id == project_id))
            async with sessions() as session:
                assert await session.get(Project, project_id) is None
                assert await session.get(ContentAsset, asset_id) is None
                mapping_count = await session.scalar(
                    select(func.count())
                    .select_from(PublicationAssetMapping)
                    .where(PublicationAssetMapping.asset_id == asset_id)
                )
                assert mapping_count == 0
        finally:
            await reset_publication_projects(sessions)
            await engine.dispose()

    asyncio.run(scenario())


def test_publication_lease_recovery_fences_stale_worker() -> None:
    async def scenario() -> None:
        engine = create_publication_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = PublicationRepository(sessions)
        try:
            await reset_publication_projects(sessions)
            project_id, article_id, _ = await seed_approved_article(sessions)
            target = await create_target(repository, project_id)
            publication = await create_publication(
                repository,
                project_id,
                article_id,
                target.id,
                idempotency_key="publication-lease-recovery",
            )
            assert await repository.claim_due("publication-worker-a", lease_seconds=30) == [
                publication.id
            ]
            async with sessions() as session, session.begin():
                await session.execute(
                    update(ArticlePublication)
                    .where(ArticlePublication.id == publication.id)
                    .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
            assert await repository.claim_due("publication-worker-b", lease_seconds=30) == [
                publication.id
            ]
            with pytest.raises(ValueError, match="publication_lease_lost"):
                await repository.fail_publication(
                    publication.id,
                    worker_id="publication-worker-a",
                    error_code="stale-worker",
                    error_detail="must not overwrite the new owner",
                    uncertain=False,
                )
            failed = await repository.fail_publication(
                publication.id,
                worker_id="publication-worker-b",
                error_code="verified-failure",
                error_detail="current owner can complete the attempt",
                uncertain=False,
            )
            assert failed.status == "failed"
            assert failed.attempt_count == 2
        finally:
            await reset_publication_projects(sessions)
            await engine.dispose()

    asyncio.run(scenario())


def test_cancel_audit_is_atomic_and_reconcile_restores_staged_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        engine = create_publication_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = PublicationRepository(sessions)
        try:
            await reset_publication_projects(sessions)
            project_id, article_id, _ = await seed_approved_article(sessions)
            target = await create_target(repository, project_id)
            publication = await create_publication(
                repository,
                project_id,
                article_id,
                target.id,
                idempotency_key="atomic-cancel",
            )

            original_audit = repository._audit

            def fail_audit(*args, **kwargs):
                del args, kwargs
                raise RuntimeError("injected publication audit failure")

            monkeypatch.setattr(repository, "_audit", fail_audit)
            with pytest.raises(RuntimeError, match="injected publication audit failure"):
                await repository.cancel_publication(
                    ORGANIZATION_ID,
                    project_id,
                    publication.id,
                    cancelled_by="publisher-p5",
                    reason="must roll back",
                    audit=audit(),
                )
            monkeypatch.setattr(repository, "_audit", original_audit)
            async with sessions() as session:
                stored = await session.get(ArticlePublication, publication.id)
                assert stored is not None and stored.status == "queued"
                assert stored.cancelled_at is None
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(ContentAuditEvent)
                        .where(
                            ContentAuditEvent.target_id == publication.id,
                            ContentAuditEvent.action == "article.publication_cancelled",
                        )
                    )
                ) == 0

            assert await repository.claim_due("reconcile-worker", lease_seconds=30) == [
                publication.id
            ]
            staged_snapshot = {
                "version_number": 1,
                "html": "<p>Frozen remote submission</p>",
                "assets": {},
            }
            await repository.stage_remote_submission(
                publication.id,
                worker_id="reconcile-worker",
                published_snapshot=staged_snapshot,
            )
            uncertain = await repository.fail_publication(
                publication.id,
                worker_id="reconcile-worker",
                error_code="wordpress_publish_uncertain",
                error_detail="remote response timed out",
                uncertain=True,
            )
            assert uncertain.status == "uncertain"
            reconciled = await repository.mark_reconciled_published(
                ORGANIZATION_ID,
                project_id,
                publication.id,
                remote_post_id=81,
                remote_url="https://wordpress.example.test/p5-publication",
                audit=audit("reconciler-p5"),
            )
            assert reconciled.status == "published"
            assert reconciled.published_snapshot_json == staged_snapshot
            async with sessions() as session:
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.target_id == publication.id,
                        ContentAuditEvent.action == "article.publication_reconciled",
                    )
                )
                assert event is not None
                assert event.before_state == {"status": "uncertain"}
                assert event.after_state["remote_post_id"] == 81
        finally:
            await reset_publication_projects(sessions)
            await engine.dispose()

    asyncio.run(scenario())
