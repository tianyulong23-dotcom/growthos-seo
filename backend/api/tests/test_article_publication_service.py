import asyncio
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace

import pytest

from app.core.config import Settings
from app.modules.content.article_diff import build_article_diff
from app.modules.content.models import Article, ArticlePreviewSnapshot, ArticlePublication, ArticleVersion
from app.modules.content.publication import WordPressPublishResult
from app.modules.content.publication_service import PublicationService, publication_allowed_actions
from app.modules.content.repository import ContentAuditContext
from app.modules.content.schemas import CreateArticlePreviewRequest, CreateArticlePublicationRequest
from app.modules.settings.service_connections import (
    ServiceConnectionError,
    WordPressConnectionRecord,
    WordPressVerificationResult,
)


def audit() -> ContentAuditContext:
    return ContentAuditContext("user-p5", "content_publisher", "request-p5", "correlation-p5")


def version(number: int, *, title: str | None = None) -> ArticleVersion:
    document = {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": "paragraph-1"},
                "content": [{"type": "text", "text": title or f"Version {number}"}],
            }
        ],
    }
    metadata = {
        "title": title or f"Article v{number}",
        "slug": "article-slug",
        "meta_description": f"Description v{number}",
        "publication_status": "publish_ready",
    }
    return ArticleVersion(
        id=f"version-{number}",
        article_id="article-p5",
        run_id="run-p5",
        version_number=number,
        version_type="manual_edit",
        content_json={"document": document, "markdown": title or f"Version {number}", **metadata},
        document_snapshot=document,
        metadata_snapshot=metadata,
        asset_manifest=[],
        content_hash=f"hash-{number}",
        created_by="editor-p5",
        created_at=datetime.now(UTC),
    )


def publication(status: str, **overrides) -> ArticlePublication:
    now = datetime.now(UTC)
    values = {
        "id": "publication-p5",
        "article_id": "article-p5",
        "organization_id": "org-p5",
        "project_id": "project-p5",
        "version_id": "version-1",
        "version_number": 1,
        "target_id": "target-p5",
        "mode": "immediate",
        "schedule_at_utc": None,
        "source_timezone": "UTC",
        "idempotency_key": "publication-key",
        "request_hash": "request-hash",
        "payload_hash": "a" * 64,
        "asset_manifest_hash": "b" * 64,
        "status": status,
        "attempt_count": 1,
        "created_by": "publisher-p5",
        "request_summary_json": {"operation": "create"},
        "created_at": now,
        "updated_at": now,
    }
    values.update(overrides)
    return ArticlePublication(**values)


class ServiceRepository:
    def __init__(self) -> None:
        self.preview_values = None
        self.publication_values = None
        self.rows: dict[str, ArticlePublication] = {}
        self.reconciled: str | None = None
        self.target_syncs: list[dict] = []

    async def list_targets(self, organization_id, project_id):
        del organization_id, project_id
        return []

    async def upsert_wordpress_target(self, organization_id, project_id, **values):
        del organization_id, project_id
        self.target_syncs.append(values)
        return SimpleNamespace(
            id="target-p5",
            capabilities_json=values["capabilities"],
            status="verified" if values["verified"] else "disconnected",
        )

    async def set_target_capabilities(self, target_id, capabilities):
        self.target_syncs.append(
            {"target_id": target_id, "capabilities": dict(capabilities)}
        )

    async def create_preview(self, *args, **values):
        del args
        self.preview_values = values
        return ArticlePreviewSnapshot(
            id="preview-p5",
            article_id="article-p5",
            organization_id="org-p5",
            project_id="project-p5",
            source_type=values["source_type"],
            source_version_number=values["version_number"],
            autosave_id=values["autosave_id"],
            document_snapshot={},
            metadata_snapshot={},
            asset_manifest=[],
            target_id=values["target_id"],
            created_by=values["created_by"],
            audience=values["audience"],
            token_hash=values["token_hash"],
            expires_at=values["expires_at"],
        )

    async def create_publication(self, *args, **values):
        del args
        self.publication_values = values
        row = publication(
            "scheduled" if values["mode"] == "scheduled" else "queued",
            mode=values["mode"],
            schedule_at_utc=values["schedule_at_utc"],
            source_timezone=values["source_timezone"],
            parent_publication_id=values["parent_publication_id"],
        )
        self.rows[row.id] = row
        return row

    async def get_publication(self, organization_id, project_id, publication_id):
        del organization_id, project_id
        return self.rows.get(publication_id)

    async def checkpoints(self, publication_id):
        del publication_id
        return []

    async def mark_reconciled_published(self, *args, remote_post_id, remote_url, **kwargs):
        del args, kwargs
        self.reconciled = "published"
        row = self.rows["publication-p5"]
        row.status = "published"
        row.remote_post_id = remote_post_id
        row.remote_url = remote_url
        return row

    async def mark_reconciled_failed(self, *args, **kwargs):
        del args, kwargs
        self.reconciled = "failed"
        row = self.rows["publication-p5"]
        row.status = "failed"
        return row


class ContentRepository:
    def __init__(self) -> None:
        self.versions = {1: version(1), 2: version(2, title="Changed draft")}
        self.article = Article(
            id="article-p5",
            organization_id="org-p5",
            project_id="project-p5",
            primary_keyword="article",
            current_version_number=2,
        )

    async def get_article_version(self, organization_id, project_id, article_id, number):
        del organization_id, project_id, article_id
        return self.versions.get(number)

    async def get_article(self, organization_id, project_id, article_id):
        del organization_id, project_id, article_id
        return self.article, SimpleNamespace()

    async def compare_article_versions(self, organization_id, project_id, article_id, before, after):
        del organization_id, project_id, article_id
        old = self.versions[before]
        new = self.versions[after]
        typed = build_article_diff(
            old.document_snapshot,
            new.document_snapshot,
            old.metadata_snapshot,
            new.metadata_snapshot,
        )
        return old, new, typed


class Connections:
    async def get_wordpress(self, project_id, encryption_key, allow_plaintext):
        del project_id, encryption_key, allow_plaintext
        return WordPressConnectionRecord(
            "https://wordpress.example",
            "publisher",
            "application-password",
            verified_at=datetime.now(UTC),
            capabilities={
                "media_upload": True,
                "media_lookup": True,
                "post_create": True,
                "post_update_by_remote_id": True,
                "post_reconcile": True,
            },
        )


class Transport:
    def __init__(self, remote: WordPressPublishResult | None = None) -> None:
        self.remote = remote
        self.post_ids: list[int] = []
        self.slugs: list[str] = []

    async def get_post(self, connection, post_id):
        del connection
        self.post_ids.append(post_id)
        return self.remote

    async def find_post_by_slug(self, connection, slug):
        del connection
        self.slugs.append(slug)
        return self.remote


class ConnectionTester:
    def __init__(
        self,
        *,
        capabilities: dict[str, bool] | None = None,
        error: ServiceConnectionError | None = None,
    ) -> None:
        self.error = error
        self.capabilities = capabilities or {"post_reconcile": True}

    async def test(self, connection):
        del connection
        if self.error is not None:
            raise self.error
        return WordPressVerificationResult(
            verified_user="publisher",
            capabilities=self.capabilities,
        )


def build_service(
    repository=None,
    content_repository=None,
    transport=None,
    connection_tester=None,
) -> PublicationService:
    return PublicationService(
        Settings(app_env="test"),
        repository or ServiceRepository(),
        content_repository or ContentRepository(),
        Connections(),
        SimpleNamespace(),
        transport or Transport(),
        connection_tester,
    )


def test_preview_exposes_fragment_token_but_persists_only_its_hash() -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        service = build_service(repository=repository)
        response = await service.create_preview(
            "org-p5",
            "project-p5",
            "article-p5",
            CreateArticlePreviewRequest(source_type="autosave", autosave_id="autosave-p5"),
            created_by="user-p5",
            audit=audit(),
        )
        token = response.preview_url.split("#token=", 1)[1]
        assert "?token=" not in response.preview_url
        assert repository.preview_values["token_hash"] == sha256(token.encode()).hexdigest()
        assert token != repository.preview_values["token_hash"]
        assert timedelta(minutes=29) < repository.preview_values["expires_at"] - datetime.now(UTC) <= timedelta(minutes=30)

    asyncio.run(scenario())


def test_immediate_and_scheduled_publications_freeze_version_and_normalize_utc() -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        content_repository = ContentRepository()
        service = build_service(repository=repository, content_repository=content_repository)
        immediate = await service.create_publication(
            "org-p5",
            "project-p5",
            "article-p5",
            CreateArticlePublicationRequest(version_number=1, target_id="target-p5"),
            " immediate-key ",
            created_by="user-p5",
            audit=audit(),
        )
        assert immediate.status == "queued"
        assert repository.publication_values["schedule_at_utc"] is None
        assert repository.publication_values["idempotency_key"] == "immediate-key"
        assert repository.target_syncs[-1]["capabilities"]["post_create"] is True

        schedule = datetime.now(UTC).astimezone().replace(microsecond=0) + timedelta(days=2)
        # Use a literal Shanghai offset so the expected conversion is independent of host timezone.
        schedule = datetime.fromisoformat(schedule.strftime("%Y-%m-%dT10:30:00+08:00"))
        scheduled = await service.create_publication(
            "org-p5",
            "project-p5",
            "article-p5",
            CreateArticlePublicationRequest(
                version_number=1,
                target_id="target-p5",
                mode="scheduled",
                schedule_at=schedule,
                source_timezone="Asia/Shanghai",
            ),
            "scheduled-key",
            created_by="user-p5",
            audit=audit(),
        )
        assert scheduled.status == "scheduled"
        assert repository.publication_values["schedule_at_utc"].hour == 2
        assert repository.publication_values["schedule_at_utc"].tzinfo is UTC
        assert repository.publication_values["payload_hash"] != repository.publication_values["request_hash"]

    asyncio.run(scenario())


def test_schedule_rejects_timezone_mismatch_unknown_timezone_and_past_time() -> None:
    async def scenario() -> None:
        service = build_service()
        cases = [
            (
                CreateArticlePublicationRequest(
                    version_number=1,
                    target_id="target-p5",
                    mode="scheduled",
                    schedule_at=datetime.now(UTC) + timedelta(days=1),
                    source_timezone="Asia/Shanghai",
                ),
                "publication_schedule_timezone_mismatch",
            ),
            (
                CreateArticlePublicationRequest(
                    version_number=1,
                    target_id="target-p5",
                    mode="scheduled",
                    schedule_at=datetime.now(UTC) + timedelta(days=1),
                    source_timezone="Mars/Olympus",
                ),
                "publication_timezone_invalid",
            ),
            (
                CreateArticlePublicationRequest(
                    version_number=1,
                    target_id="target-p5",
                    mode="scheduled",
                    schedule_at=datetime.now(UTC) - timedelta(minutes=1),
                    source_timezone="UTC",
                ),
                "publication_schedule_must_be_future",
            ),
        ]
        for request, code in cases:
            with pytest.raises(ValueError, match=code):
                await service.create_publication(
                    "org-p5", "project-p5", "article-p5", request, code, created_by="user-p5", audit=audit()
                )

    asyncio.run(scenario())


def test_retry_only_accepts_failed_and_links_the_parent_attempt() -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        service = build_service(repository=repository)
        repository.rows["publication-p5"] = publication("uncertain")
        with pytest.raises(ValueError, match="article_publication_retry_not_allowed"):
            await service.retry_publication(
                "org-p5", "project-p5", "publication-p5", "retry-1", created_by="user-p5", audit=audit()
            )

        repository.rows["publication-p5"].status = "failed"
        result = await service.retry_publication(
            "org-p5", "project-p5", "publication-p5", "retry-2", created_by="user-p5", audit=audit()
        )
        assert result.parent_publication_id == "publication-p5"
        assert repository.publication_values["parent_publication_id"] == "publication-p5"

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("remote", "expected_status"),
    [
        (WordPressPublishResult(81, "https://wordpress.example/article", "publish", "a" * 64), "published"),
        (None, "failed"),
    ],
)
def test_uncertain_reconcile_uses_frozen_slug_and_never_republishes(remote, expected_status) -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        repository.rows["publication-p5"] = publication("uncertain")
        transport = Transport(remote)
        service = build_service(repository=repository, transport=transport)
        response = await service.reconcile_publication(
            "org-p5", "project-p5", "publication-p5", audit=audit()
        )
        assert response.status == expected_status
        assert transport.slugs == ["article-slug"]
        assert transport.post_ids == []

    asyncio.run(scenario())


def test_uncertain_reconcile_rejects_remote_payload_mismatch() -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        repository.rows["publication-p5"] = publication("uncertain")
        service = build_service(
            repository=repository,
            transport=Transport(WordPressPublishResult(81, "https://wordpress.example/article", "publish", "c" * 64)),
        )
        with pytest.raises(ValueError, match="publication_remote_payload_mismatch"):
            await service.reconcile_publication(
                "org-p5", "project-p5", "publication-p5", audit=audit()
            )
        assert repository.reconciled is None

    asyncio.run(scenario())


def test_uncertain_reconcile_rechecks_lookup_permission_before_remote_request() -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        repository.rows["publication-p5"] = publication("uncertain")
        transport = Transport()
        service = build_service(
            repository=repository,
            transport=transport,
            connection_tester=ConnectionTester(
                error=ServiceConnectionError("无法连接 WordPress")
            ),
        )

        with pytest.raises(ValueError, match="wordpress_capability_probe_failed"):
            await service.reconcile_publication(
                "org-p5", "project-p5", "publication-p5", audit=audit()
            )

        assert transport.post_ids == []
        assert transport.slugs == []

    asyncio.run(scenario())


def test_uncertain_reconcile_rejects_missing_lookup_permission() -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        repository.rows["publication-p5"] = publication("uncertain")
        transport = Transport()
        service = build_service(
            repository=repository,
            transport=transport,
            connection_tester=ConnectionTester(
                capabilities={"post_reconcile": False}
            ),
        )

        with pytest.raises(
            ValueError,
            match="publication_target_capability_missing:post_reconcile",
        ):
            await service.reconcile_publication(
                "org-p5", "project-p5", "publication-p5", audit=audit()
            )

        assert transport.post_ids == []
        assert transport.slugs == []
        assert repository.target_syncs[-1]["capabilities"]["post_reconcile"] is False

    asyncio.run(scenario())


def test_published_snapshot_reports_structured_diff_against_current_draft() -> None:
    async def scenario() -> None:
        repository = ServiceRepository()
        repository.rows["publication-p5"] = publication(
            "published",
            published_snapshot_json={"version_number": 1, "html": "<p>Version 1</p>"},
            published_at=datetime.now(UTC),
        )
        service = build_service(repository=repository)
        response = await service.publication_snapshot("org-p5", "project-p5", "publication-p5")
        assert response.published_version_number == 1
        assert response.current_draft_version_number == 2
        assert response.current_draft_diff is not None
        assert response.current_draft_diff.block_changes[0].node_id == "paragraph-1"
        assert any(change.field == "title" for change in response.current_draft_diff.metadata_changes)

    asyncio.run(scenario())


def test_publication_actions_are_disjoint_by_terminal_state() -> None:
    assert publication_allowed_actions("queued") == ["cancel"]
    assert publication_allowed_actions("scheduled") == ["cancel"]
    assert publication_allowed_actions("failed") == ["retry"]
    assert publication_allowed_actions("uncertain") == ["reconcile"]
    assert publication_allowed_actions("submitting") == []
    assert publication_allowed_actions("published") == []
    assert publication_allowed_actions("cancelled") == []
