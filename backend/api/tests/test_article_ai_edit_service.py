import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from app.core.config import Settings
from app.modules.content.ai_edit import AIEditValidationError, sha256_text
from app.modules.content.ai_edit_repository import AIEditRepositoryError
from app.modules.content.ai_edit_schemas import (
    AcceptAIEditRequest,
    AIEditSelection,
    CreateAIEditRequest,
)
from app.modules.content.ai_edit_service import AIEditService
from app.modules.content.document import document_content_hash
from app.modules.content.models import Article, ArticleAIEditOperation
from app.modules.content.repository import ContentAuditContext, article_metadata_snapshot


def article_document(text: str = "Original text") -> dict:
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [
            {
                "type": "paragraph",
                "attrs": {"node_id": "paragraph-1"},
                "content": [{"type": "text", "text": text}],
            }
        ],
    }


def article() -> Article:
    value = Article(
        id="article-p6",
        organization_id="org-p6",
        project_id="project-p6",
        primary_keyword="article ai",
        title="Article AI",
        document_json=article_document(),
        status="completed",
        publication_status="complete_draft",
        review_version=1,
        current_version_number=1,
    )
    value.secondary_keywords_json = []
    value.seo_field_states_json = {}
    value.indexing = "index/follow"
    value.current_content_hash = document_content_hash(
        value.document_json, article_metadata_snapshot(value)
    )
    return value


def operation(base: Article, *, status: str = "ready") -> ArticleAIEditOperation:
    now = datetime.now(UTC)
    return ArticleAIEditOperation(
        id="operation-p6",
        organization_id=base.organization_id,
        project_id=base.project_id,
        article_id=base.id,
        parent_operation_id=None,
        created_by="editor-p6",
        command="rewrite",
        scope="selection",
        status=status,
        base_review_version=base.review_version,
        document_hash=base.current_content_hash,
        anchor_node_id="paragraph-1",
        selection_from=0,
        selection_to=8,
        selected_text_hash=sha256_text("Original"),
        input_payload_json={},
        prompt_version="article-ai-edit.v1",
        model_config_json={},
        input_hash="input-hash",
        candidate_kind="text",
        candidate_text="Rewritten text",
        allowed_modes_json=["replace"],
        stream_token_hash="token-hash",
        stream_expires_at=now,
        stream_revision=2,
        idempotency_key="create-key",
        request_hash="request-hash",
        input_tokens=10,
        output_tokens=4,
        created_at=now,
        completed_at=now,
    )


def selection(text: str = "Original") -> AIEditSelection:
    return AIEditSelection(
        anchor_node_id="paragraph-1",
        **{"from": 0},
        to=8,
        selected_text_hash=sha256_text(text),
    )


def request(base: Article, *, document=None, supplied_hash=None) -> AcceptAIEditRequest:
    current_document = document or base.document_json
    metadata = article_metadata_snapshot(base)
    return AcceptAIEditRequest(
        current_review_version=base.review_version,
        current_document_hash=supplied_hash or document_content_hash(current_document, metadata),
        current_document=current_document,
        current_metadata=metadata,
        current_selection=selection(),
        mode="replace",
    )


class Repository:
    def __init__(self, base: Article, row: ArticleAIEditOperation) -> None:
        self.article = base
        self.operation = row
        self.stale_codes: list[str] = []
        self.accept_calls: list[dict] = []

    async def get(self, *args):
        del args
        return self.operation

    async def get_article(self, *args):
        del args
        return self.article

    async def mark_stale(self, *args, code, audit):
        del args, audit
        self.stale_codes.append(code)
        self.operation.status = "stale"
        return self.operation

    async def accept(self, *args, **values):
        del args
        self.accept_calls.append(values)
        self.operation.status = "accepted"
        self.operation.accepted_mode = values["mode"]
        self.operation.accepted_result_json = values["result"]
        self.operation.accept_idempotency_key = values["idempotency_key"]
        self.operation.accept_request_hash = values["request_hash"]
        return self.operation, True


def audit() -> ContentAuditContext:
    return ContentAuditContext("editor-p6", "content_editor", "request-p6", "correlation-p6")


def service(repository: Repository) -> AIEditService:
    return AIEditService(
        Settings(app_env="test", article_ai_edit_provider_mode="deterministic_fake"),
        repository,
        controller=SimpleNamespace(),
    )


def test_accept_rejects_self_inconsistent_hash_without_marking_operation_stale() -> None:
    async def scenario() -> None:
        base = article()
        repository = Repository(base, operation(base))
        with pytest.raises(AIEditValidationError, match="ai_edit_document_hash_invalid"):
            await service(repository).accept(
                base.organization_id,
                base.project_id,
                base.id,
                repository.operation.id,
                request(base, supplied_hash="f" * 64),
                idempotency_key="accept-key",
                actor_id="editor-p6",
                audit=audit(),
            )
        assert repository.operation.status == "ready"
        assert repository.stale_codes == []

    asyncio.run(scenario())


def test_accept_marks_valid_but_changed_document_stale() -> None:
    async def scenario() -> None:
        base = article()
        repository = Repository(base, operation(base))
        changed = article_document("Original changed")
        with pytest.raises(AIEditRepositoryError, match="ai_edit_stale"):
            await service(repository).accept(
                base.organization_id,
                base.project_id,
                base.id,
                repository.operation.id,
                request(base, document=changed),
                idempotency_key="accept-key",
                actor_id="editor-p6",
                audit=audit(),
            )
        assert repository.operation.status == "stale"
        assert repository.stale_codes == ["ai_edit_document_stale"]
        assert repository.accept_calls == []

    asyncio.run(scenario())


def test_accept_returns_candidate_without_mutating_article_document() -> None:
    async def scenario() -> None:
        base = article()
        original = base.document_json
        repository = Repository(base, operation(base))
        response = await service(repository).accept(
            base.organization_id,
            base.project_id,
            base.id,
            repository.operation.id,
            request(base),
            idempotency_key="accept-key",
            actor_id="editor-p6",
            audit=audit(),
        )
        assert response.operation.status == "accepted"
        assert response.operation.accepted_result == {
            "kind": "text",
            "text": "Rewritten text",
        }
        assert response.from_ == 0 and response.to == 8
        assert base.document_json is original
        assert base.document_json == article_document()

    asyncio.run(scenario())


def test_invalid_article_metadata_is_a_stable_ai_validation_error() -> None:
    base = article()
    with pytest.raises(AIEditValidationError, match="article_metadata_indexing_invalid"):
        AIEditService._validate_snapshot(
            base,
            base.document_json,
            {**article_metadata_snapshot(base), "indexing": "invalid"},
            base.current_content_hash,
            selection(),
        )


class LifecycleRepository:
    def __init__(self, base: Article, row: ArticleAIEditOperation) -> None:
        self.article = base
        self.operation = row
        self.fail_calls: list[dict] = []

    async def get_article(self, *args):
        del args
        return self.article

    async def create(self, **kwargs):
        del kwargs
        return self.operation, True

    async def worker_fail(self, operation_id: str, **kwargs):
        assert operation_id == self.operation.id
        self.fail_calls.append(kwargs)
        self.operation.status = "failed"
        self.operation.error_code = kwargs["code"]
        self.operation.error_detail = kwargs["detail"]
        return True

    async def get(self, *args):
        del args
        return self.operation

    async def cancel(self, *args, **kwargs):
        del args, kwargs
        self.operation.status = "cancelled"
        return self.operation


class Controller:
    def __init__(self, *, fail_start: bool = False, fail_cancel: bool = False) -> None:
        self.fail_start = fail_start
        self.fail_cancel = fail_cancel
        self.started: list[str] = []
        self.cancelled: list[str] = []

    async def start(self, operation_id: str) -> None:
        self.started.append(operation_id)
        if self.fail_start:
            raise RuntimeError("dispatch secret must not escape")

    async def cancel(self, operation_id: str) -> None:
        self.cancelled.append(operation_id)
        if self.fail_cancel:
            raise RuntimeError("cancel controller unavailable")


def create_request(base: Article) -> CreateAIEditRequest:
    return CreateAIEditRequest(
        base_review_version=base.review_version,
        document_hash=base.current_content_hash,
        document=base.document_json,
        metadata=article_metadata_snapshot(base),
        command="rewrite",
        scope="selection",
        selection=selection(),
    )


def test_dispatch_failure_is_persisted_without_leaking_controller_detail() -> None:
    async def scenario() -> None:
        base = article()
        row = operation(base, status="queued")
        repository = LifecycleRepository(base, row)
        controller = Controller(fail_start=True)
        current = AIEditService(
            Settings(app_env="test", article_ai_edit_provider_mode="deterministic_fake"),
            repository,
            controller=controller,
        )

        response = await current.create(
            base.organization_id,
            base.project_id,
            base.id,
            create_request(base),
            idempotency_key="dispatch-create-key",
            actor_id="editor-p6",
            audit=audit(),
        )

        assert controller.started == [row.id]
        assert response.operation.status == "failed"
        assert repository.fail_calls == [
            {
                "code": "ai_edit_dispatch_failed",
                "detail": "AI edit workflow could not be dispatched",
            }
        ]
        assert "dispatch secret" not in repr(repository.fail_calls)

    asyncio.run(scenario())


def test_cancel_controller_failure_does_not_restore_cancelled_operation() -> None:
    async def scenario() -> None:
        base = article()
        row = operation(base, status="streaming")
        repository = LifecycleRepository(base, row)
        controller = Controller(fail_cancel=True)
        current = AIEditService(
            Settings(app_env="test", article_ai_edit_provider_mode="deterministic_fake"),
            repository,
            controller=controller,
        )

        response = await current.cancel(
            base.organization_id,
            base.project_id,
            base.id,
            row.id,
            audit=audit(),
        )

        assert controller.cancelled == [row.id]
        assert response.status == "cancelled"
        assert repository.operation.status == "cancelled"

    asyncio.run(scenario())
