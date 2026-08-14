import asyncio
from datetime import UTC, datetime
from hashlib import sha256
from types import SimpleNamespace

from app.core.config import Settings
from app.modules.content.models import ContentAsset, PublicationAssetMapping
from app.modules.content.publication import (
    WordPressMediaResult,
    WordPressPublishError,
    WordPressPublishResult,
)
from app.modules.content.publication_orchestrator import PublicationOrchestrator
from app.modules.content.publication_repository import PublicationExecutionContext
from app.modules.settings.service_connections import WordPressConnectionRecord
from app.modules.settings.service_connections import (
    ServiceConnectionError,
    WordPressVerificationResult,
)


BODY = b"frozen-image"
BODY_HASH = sha256(BODY).hexdigest()


def context(*, post_id=None, checkpoint_json=None) -> PublicationExecutionContext:
    document = {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "image",
                "attrs": {
                    "node_id": "image-1",
                    "asset_id": "asset-1",
                    "alt": "Evidence image",
                    "caption": "Verified evidence",
                    "display": "regular",
                },
            }
        ],
    }
    publication = SimpleNamespace(
        id="publication-1",
        project_id="project-1",
        version_number=4,
        payload_hash="a" * 64,
        remote_post_id=post_id,
        checkpoint_json=checkpoint_json or {},
    )
    checkpoint = SimpleNamespace(
        id="checkpoint-1",
        asset_id="asset-1",
        node_id="image-1",
        item_id=None,
        binding_role="image",
        variant_hash=BODY_HASH,
    )
    asset = ContentAsset(
        id="asset-1",
        project_id="project-1",
        asset_type="image",
        status="ready",
        original_filename="evidence.jpg",
        mime_type="image/jpeg",
        detected_mime_type="image/jpeg",
        byte_size=len(BODY),
        content_hash=BODY_HASH,
        storage_key="assets/evidence.jpg",
        source_type="upload",
        created_by="editor-1",
    )
    version = SimpleNamespace(
        document_snapshot=document,
        content_json={"title": "Frozen title"},
        metadata_snapshot={
            "title": "Frozen title",
            "slug": "frozen-title",
            "meta_description": "Frozen description",
            "focus_keyword": "frozen",
            "secondary_keywords": ["evidence"],
            "indexing": "index/follow",
        },
    )
    return PublicationExecutionContext(
        publication=publication,
        article=SimpleNamespace(primary_keyword="frozen"),
        version=version,
        target=SimpleNamespace(id="target-1"),
        checkpoints=[checkpoint],
        assets={"asset-1": asset},
    )


class Repository:
    def __init__(self, execution_context, *, mapping_status="new") -> None:
        self.context = execution_context
        self.mapping_status = mapping_status
        self.mapping = PublicationAssetMapping(
            id="mapping-1",
            target_id="target-1",
            asset_id="asset-1",
            variant_hash=BODY_HASH,
            remote_slug="growthos-existing",
            status="ready" if mapping_status == "ready" else "uploading",
            remote_media_id=31 if mapping_status == "ready" else None,
            remote_source_url=(
                "https://wordpress.example/media/existing.jpg"
                if mapping_status == "ready"
                else None
            ),
        )
        self.calls: list[tuple] = []
        self.capabilities: dict[str, bool] = {}

    async def recheck_gate(self, publication_id, worker_id):
        self.calls.append(("gate", publication_id, worker_id))
        operation = "update" if self.context.publication.remote_post_id else "create"
        required = "post_update_by_remote_id" if operation == "update" else "post_create"
        if self.capabilities and self.capabilities.get(required) is not True:
            raise ValueError(f"publication_target_capability_missing:{required}")
        if self.capabilities and self.capabilities.get("post_reconcile") is not True:
            raise ValueError("publication_target_capability_missing:post_reconcile")

    async def execution_context(self, publication_id, worker_id):
        self.calls.append(("context", publication_id, worker_id))
        return self.context

    async def renew_publication_lease(self, publication_id, worker_id, *, lease_seconds):
        self.calls.append(("renew", publication_id, worker_id, lease_seconds))

    async def claim_mapping(self, **values):
        self.calls.append(("claim_mapping", values["worker_id"]))
        if self.mapping_status == "ready":
            return self.mapping, False
        if self.mapping_status == "uncertain":
            self.mapping.status = "uncertain"
            return self.mapping, False
        self.mapping.status = "uploading"
        return self.mapping, True

    async def start_checkpoint(self, checkpoint_id):
        self.calls.append(("start_checkpoint", checkpoint_id))

    async def complete_mapping(self, mapping_id, **values):
        self.calls.append(("complete_mapping", mapping_id, values["remote_media_id"]))
        self.mapping.status = "ready"
        self.mapping.remote_media_id = values["remote_media_id"]
        self.mapping.remote_source_url = values["remote_source_url"]
        return self.mapping

    async def complete_checkpoint(self, checkpoint_id, mapping_id):
        self.calls.append(("complete_checkpoint", checkpoint_id, mapping_id))

    async def mark_mapping(self, mapping_id, **values):
        self.calls.append(("mark_mapping", mapping_id, values["status"]))
        self.mapping.status = values["status"]
        self.mapping_status = "new"
        return self.mapping

    async def fail_checkpoint(self, checkpoint_id, **values):
        self.calls.append(("fail_checkpoint", checkpoint_id, values["uncertain"]))

    async def stage_remote_submission(self, publication_id, **values):
        self.calls.append(("stage", publication_id, values["published_snapshot"]))

    async def finish_publication(self, publication_id, **values):
        self.calls.append(("finish", publication_id, values))

    async def fail_publication(self, publication_id, **values):
        self.calls.append(("fail", publication_id, values))

    async def set_target_status(self, target_id, *, status):
        self.calls.append(("target", target_id, status))

    async def set_target_capabilities(self, target_id, capabilities):
        self.capabilities = dict(capabilities)
        self.calls.append(("capabilities", target_id, dict(capabilities)))


class ConnectionTester:
    def __init__(
        self,
        capabilities: dict[str, bool] | None = None,
        error: ServiceConnectionError | None = None,
    ) -> None:
        self.capabilities = capabilities or {
            "media_upload": True,
            "media_lookup": True,
            "post_create": True,
            "post_update_by_remote_id": True,
            "post_reconcile": True,
            "theme_preview": False,
        }
        self.error = error
        self.calls = 0

    async def test(self, connection):
        del connection
        self.calls += 1
        if self.error is not None:
            raise self.error
        return WordPressVerificationResult(
            verified_user="publisher", capabilities=self.capabilities
        )


class Connections:
    async def get_wordpress(self, project_id, encryption_key, allow_plaintext):
        del project_id, encryption_key, allow_plaintext
        return WordPressConnectionRecord(
            "https://wordpress.example",
            "publisher",
            "secret",
            verified_at=datetime.now(UTC),
        )


class Store:
    async def read_bytes(self, storage_key, maximum_bytes):
        assert storage_key == "assets/evidence.jpg"
        assert maximum_bytes == len(BODY) + 1
        return BODY


class Transport:
    def __init__(self) -> None:
        self.uploads = 0
        self.publications: list[tuple[dict, int | None]] = []
        self.media_exists = True
        self.reconciled_media = None
        self.reconciled_post = None
        self.post_lookups: list[tuple[str, int | str]] = []
        self.publish_error: Exception | None = None

    async def upload_media(self, connection, **values):
        del connection
        self.uploads += 1
        assert values["body"] == BODY
        assert values["alt_text"] == "Evidence image"
        assert values["caption"] == "Verified evidence"
        return WordPressMediaResult(41, "https://wordpress.example/media/evidence.jpg", values["slug"])

    async def get_media(self, connection, media_id):
        del connection, media_id
        if not self.media_exists:
            return None
        return WordPressMediaResult(31, "https://wordpress.example/media/existing.jpg", "existing")

    async def find_media_by_slug(self, connection, slug):
        del connection, slug
        return self.reconciled_media

    async def get_post(self, connection, post_id):
        del connection
        self.post_lookups.append(("id", post_id))
        return self.reconciled_post

    async def find_post_by_slug(self, connection, slug):
        del connection
        self.post_lookups.append(("slug", slug))
        return self.reconciled_post

    async def publish(self, connection, payload, *, post_id):
        del connection
        self.publications.append((payload, post_id))
        if self.publish_error:
            raise self.publish_error
        return WordPressPublishResult(71, "https://wordpress.example/frozen-title", "publish")


def orchestrator(
    repository, transport, connection_tester: ConnectionTester | None = None
) -> PublicationOrchestrator:
    return PublicationOrchestrator(
        Settings(app_env="test"),
        repository,
        Connections(),
        transport,
        Store(),
        worker_id="worker-p5",
        lease_seconds=60,
        connection_tester=connection_tester or ConnectionTester(),
    )


def test_first_publication_uploads_media_stages_snapshot_then_creates_post() -> None:
    async def scenario() -> None:
        repository = Repository(context())
        transport = Transport()
        await orchestrator(repository, transport).execute("publication-1")
        assert transport.uploads == 1
        payload, post_id = transport.publications[0]
        assert post_id is None
        assert "growthos-publication:publication-1:" + "a" * 64 in payload["content"]
        assert "https://wordpress.example/media/evidence.jpg" in payload["content"]
        assert payload["slug"] == "frozen-title"
        stage_index = next(i for i, call in enumerate(repository.calls) if call[0] == "stage")
        finish_index = next(i for i, call in enumerate(repository.calls) if call[0] == "finish")
        assert stage_index < finish_index
        assert repository.calls[finish_index][2]["published_snapshot"]["version_number"] == 4

    asyncio.run(scenario())


def test_update_uses_remote_post_id_and_ready_mapping_avoids_duplicate_upload() -> None:
    async def scenario() -> None:
        repository = Repository(context(post_id=91), mapping_status="ready")
        transport = Transport()
        await orchestrator(repository, transport).execute("publication-1")
        assert transport.uploads == 0
        assert transport.publications[0][1] == 91
        assert any(call[0] == "complete_checkpoint" for call in repository.calls)

    asyncio.run(scenario())


def test_deleted_remote_media_is_marked_stale_and_reuploaded() -> None:
    async def scenario() -> None:
        repository = Repository(context(), mapping_status="ready")
        transport = Transport()
        transport.media_exists = False
        await orchestrator(repository, transport).execute("publication-1")
        assert transport.uploads == 1
        assert ("mark_mapping", "mapping-1", "stale") in repository.calls

    asyncio.run(scenario())


def test_uncertain_media_is_reconciled_by_stable_slug_without_upload() -> None:
    async def scenario() -> None:
        repository = Repository(context(), mapping_status="uncertain")
        transport = Transport()
        transport.reconciled_media = WordPressMediaResult(
            51, "https://wordpress.example/media/reconciled.jpg", "growthos-existing"
        )
        await orchestrator(repository, transport).execute("publication-1")
        assert transport.uploads == 0
        assert transport.publications
        assert ("complete_mapping", "mapping-1", 51) in repository.calls

    asyncio.run(scenario())


def test_wordpress_timeout_marks_publication_uncertain_and_does_not_finish() -> None:
    async def scenario() -> None:
        repository = Repository(context())
        transport = Transport()
        transport.publish_error = WordPressPublishError(
            "wordpress_publish_uncertain", "request timed out", uncertain=True
        )
        await orchestrator(repository, transport).execute("publication-1")
        failure = next(call for call in repository.calls if call[0] == "fail")
        assert failure[2]["uncertain"] is True
        assert failure[2]["error_code"] == "wordpress_publish_uncertain"
        assert not any(call[0] == "finish" for call in repository.calls)

    asyncio.run(scenario())


def test_revoked_post_permission_is_rechecked_before_any_remote_side_effect() -> None:
    async def scenario() -> None:
        repository = Repository(context())
        transport = Transport()
        tester = ConnectionTester(
            capabilities={
                "media_upload": True,
                "media_lookup": True,
                "post_create": False,
                "post_update_by_remote_id": True,
                "post_reconcile": True,
            }
        )

        await orchestrator(repository, transport, tester).execute("publication-1")

        assert tester.calls == 1
        assert transport.uploads == 0
        assert transport.publications == []
        failure = next(call for call in repository.calls if call[0] == "fail")
        assert failure[2]["uncertain"] is False
        assert failure[2]["error_code"] == "publication_target_capability_missing"

    asyncio.run(scenario())


def test_pending_remote_submission_probe_failure_is_uncertain_and_never_republished() -> None:
    async def scenario() -> None:
        repository = Repository(
            context(
                checkpoint_json={
                    "remote_submission_stage": "pending",
                    "published_snapshot": {"version_number": 4},
                }
            )
        )
        transport = Transport()
        tester = ConnectionTester(
            error=ServiceConnectionError("无法连接 WordPress")
        )

        await orchestrator(repository, transport, tester).execute("publication-1")

        assert transport.post_lookups == []
        assert transport.publications == []
        failure = next(call for call in repository.calls if call[0] == "fail")
        assert failure[2]["uncertain"] is True
        assert failure[2]["error_code"] == "wordpress_capability_probe_failed"

    asyncio.run(scenario())


def test_expired_remote_submission_lease_reconciles_matching_post_without_republishing() -> None:
    async def scenario() -> None:
        published_snapshot = {"version_number": 4, "html": "<p>Frozen</p>"}
        repository = Repository(
            context(
                checkpoint_json={
                    "remote_submission_stage": "pending",
                    "published_snapshot": published_snapshot,
                }
            )
        )
        transport = Transport()
        transport.reconciled_post = WordPressPublishResult(
            71,
            "https://wordpress.example/frozen-title",
            "publish",
            "a" * 64,
        )

        await orchestrator(repository, transport).execute("publication-1")

        assert transport.publications == []
        assert transport.uploads == 0
        assert transport.post_lookups == [("slug", "frozen-title")]
        finish = next(call for call in repository.calls if call[0] == "finish")
        assert finish[2]["remote_post_id"] == 71
        assert finish[2]["published_snapshot"] == published_snapshot
        assert not any(call[0] == "stage" for call in repository.calls)
        assert not any(call[0] == "fail" for call in repository.calls)

    asyncio.run(scenario())


def test_expired_remote_submission_lease_marks_mismatched_post_uncertain() -> None:
    async def scenario() -> None:
        repository = Repository(
            context(
                checkpoint_json={
                    "remote_submission_stage": "pending",
                    "published_snapshot": {"version_number": 4},
                }
            )
        )
        transport = Transport()
        transport.reconciled_post = WordPressPublishResult(
            71,
            "https://wordpress.example/frozen-title",
            "publish",
            "b" * 64,
        )

        await orchestrator(repository, transport).execute("publication-1")

        assert transport.publications == []
        failure = next(call for call in repository.calls if call[0] == "fail")
        assert failure[2]["uncertain"] is True
        assert failure[2]["error_code"] == "publication_remote_payload_mismatch"
        assert not any(call[0] == "finish" for call in repository.calls)

    asyncio.run(scenario())
