from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from temporalio.exceptions import WorkflowAlreadyStartedError

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.content.ai_edit import (
    AIEditValidationError,
    allowed_modes,
    candidate_kind,
    canonical_hash,
    safe_input_payload,
    sha256_text,
    validate_selection,
)
from app.modules.content.ai_edit_repository import (
    AIEditRepository,
    AIEditRepositoryError,
)
from app.modules.content.ai_edit_schemas import (
    AcceptAIEditRequest,
    AcceptAIEditResponse,
    AIEditCandidate,
    AIEditOperationResponse,
    AIEditSelection,
    CreateAIEditRequest,
    CreateAIEditResponse,
    RetryAIEditRequest,
)
from app.modules.content.document import document_content_hash, normalize_document
from app.modules.content.models import Article, ArticleAIEditOperation
from app.modules.content.repository import ContentAuditContext, article_metadata_snapshot
from app.modules.settings.service import (
    AIProviderNotConfiguredError,
    AIProviderSettingsRecord,
    build_ai_settings_service,
)
from app.workflows.client import connect_temporal


PROMPT_VERSION = "article-ai-edit.v1"


class AIEditWorkflowController(Protocol):
    async def start(self, operation_id: str) -> None: ...

    async def cancel(self, operation_id: str) -> None: ...


class TemporalAIEditWorkflowController:
    def __init__(self, task_queue: str) -> None:
        self.task_queue = task_queue

    async def start(self, operation_id: str) -> None:
        client = await connect_temporal()
        try:
            await client.start_workflow(
                "ArticleAIEditWorkflow",
                {"operation_id": operation_id},
                id=f"article-ai-edit:{operation_id}",
                task_queue=self.task_queue,
            )
        except WorkflowAlreadyStartedError:
            return

    async def cancel(self, operation_id: str) -> None:
        client = await connect_temporal()
        await client.get_workflow_handle(f"article-ai-edit:{operation_id}").cancel()


class AIEditService:
    def __init__(
        self,
        settings: Settings,
        repository: AIEditRepository,
        *,
        controller: AIEditWorkflowController | None = None,
        ai_settings: Any | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.controller = controller or TemporalAIEditWorkflowController(
            settings.content_task_queue
        )
        self.ai_settings = ai_settings or build_ai_settings_service()

    async def create(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        request: CreateAIEditRequest,
        *,
        idempotency_key: str,
        actor_id: str,
        audit: ContentAuditContext,
        parent_operation_id: str | None = None,
    ) -> CreateAIEditResponse:
        key = self._idempotency_key(idempotency_key)
        article = await self.repository.get_article(organization_id, project_id, article_id)
        document, metadata, content_hash, selected, selection = self._validate_snapshot(
            article,
            request.document,
            request.metadata,
            request.document_hash,
            request.selection,
        )
        self._validate_command_scope(request.command, request.scope, selection)
        provider = await self._provider_record(organization_id)
        payload = safe_input_payload(
            command=request.command,
            selected=selected,
            context=request.context.model_dump(mode="json"),
        )
        model_config = model_config_snapshot(provider)
        if self.settings.article_ai_edit_provider_mode == "deterministic_fake":
            model_config["provider"] = "deterministic_fake"
        request_payload = {
            "base_review_version": request.base_review_version,
            "document_hash": content_hash,
            "command": request.command,
            "scope": request.scope,
            "selection": selection.model_dump(by_alias=True) if selection else None,
            "context": payload,
            "prompt_version": PROMPT_VERSION,
            "model_config": model_config,
            "parent_operation_id": parent_operation_id,
        }
        token = secrets.token_urlsafe(32)
        now = datetime.now(UTC)
        values = {
            "id": str(uuid4()),
            "organization_id": organization_id,
            "project_id": project_id,
            "article_id": article_id,
            "parent_operation_id": parent_operation_id,
            "created_by": actor_id,
            "command": request.command,
            "scope": request.scope,
            "status": "queued",
            "base_review_version": request.base_review_version,
            "document_hash": content_hash,
            "anchor_node_id": selection.anchor_node_id if selection else None,
            "selection_from": selection.from_ if selection else None,
            "selection_to": selection.to if selection else None,
            "selected_text_hash": selection.selected_text_hash if selection else None,
            "input_payload_json": payload,
            "prompt_version": PROMPT_VERSION,
            "model_config_json": model_config,
            "input_hash": canonical_hash(request_payload),
            "candidate_kind": candidate_kind(request.command),
            "allowed_modes_json": allowed_modes(request.command),
            "stream_expires_at": now
            + timedelta(seconds=self.settings.article_ai_edit_stream_ttl_seconds),
            "idempotency_key": key,
            "request_hash": canonical_hash(request_payload),
        }
        operation, created = await self.repository.create(
            values=values,
            stream_token=token,
            audit=audit,
            active_limit=self.settings.article_ai_edit_active_limit,
            hourly_limit=self.settings.article_ai_edit_hourly_limit,
            monthly_token_limit=self.settings.article_ai_edit_monthly_token_limit,
        )
        if created:
            try:
                await self.controller.start(operation.id)
            except Exception:
                await self.repository.worker_fail(
                    operation.id,
                    code="ai_edit_dispatch_failed",
                    detail="AI edit workflow could not be dispatched",
                )
                operation = await self.repository.get(
                    organization_id, project_id, article_id, operation.id
                )
        return CreateAIEditResponse(
            operation=operation_response(operation),
            stream_endpoint=(
                f"/api/v1/projects/{project_id}/articles/{article_id}/"
                f"ai-edits/{operation.id}/stream"
            ),
            stream_token=token,
            stream_expires_at=operation.stream_expires_at,
        )

    async def get(
        self, organization_id: str, project_id: str, article_id: str, operation_id: str
    ) -> AIEditOperationResponse:
        return operation_response(
            await self.repository.get(organization_id, project_id, article_id, operation_id)
        )

    async def get_stream(
        self, project_id: str, article_id: str, operation_id: str, token: str
    ) -> AIEditOperationResponse:
        return operation_response(
            await self.repository.get_by_stream_token(project_id, article_id, operation_id, token)
        )

    async def cancel(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        *,
        audit: ContentAuditContext,
    ) -> AIEditOperationResponse:
        operation = await self.repository.cancel(
            organization_id, project_id, article_id, operation_id, audit=audit
        )
        if operation.status == "cancelled":
            try:
                await self.controller.cancel(operation.id)
            except Exception:
                pass
        return operation_response(operation)

    async def reject(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        *,
        reason: str | None,
        audit: ContentAuditContext,
    ) -> AIEditOperationResponse:
        return operation_response(
            await self.repository.reject(
                organization_id,
                project_id,
                article_id,
                operation_id,
                reason=reason,
                audit=audit,
            )
        )

    async def accept(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        request: AcceptAIEditRequest,
        *,
        idempotency_key: str,
        actor_id: str,
        audit: ContentAuditContext,
    ) -> AcceptAIEditResponse:
        key = self._idempotency_key(idempotency_key)
        operation = await self.repository.get(organization_id, project_id, article_id, operation_id)
        request_hash = canonical_hash(
            {
                "operation_id": operation.id,
                "request": request.model_dump(mode="json", by_alias=True),
            }
        )
        if operation.status == "accepted":
            operation, _ = await self.repository.accept(
                organization_id,
                project_id,
                article_id,
                operation_id,
                mode=request.mode,
                request_hash=request_hash,
                idempotency_key=key,
                actor_id=actor_id,
                current_review_version=request.current_review_version,
                current_document_hash=request.current_document_hash.removeprefix("sha256:"),
                result=operation.accepted_result_json or {},
                audit=audit,
            )
            return self._accept_response(operation)
        article = await self.repository.get_article(organization_id, project_id, article_id)
        try:
            document, _, content_hash, _, current_selection = self._validate_snapshot(
                article,
                request.current_document,
                request.current_metadata,
                request.current_document_hash,
                request.current_selection,
            )
        except AIEditValidationError as exc:
            if str(exc) == "ai_edit_document_hash_invalid":
                raise
            await self._mark_stale(operation, str(exc), audit)
        if content_hash != operation.document_hash:
            await self._mark_stale(operation, "ai_edit_document_stale", audit)
        try:
            self._validate_accept_selection(operation, document, current_selection)
        except (AIEditValidationError, AIEditRepositoryError) as exc:
            await self._mark_stale(operation, str(exc), audit)
        if request.mode not in operation.allowed_modes_json:
            raise AIEditRepositoryError("ai_edit_accept_mode_invalid")
        result = self._accepted_result(operation, request.candidate_index)
        operation, _ = await self.repository.accept(
            organization_id,
            project_id,
            article_id,
            operation_id,
            mode=request.mode,
            request_hash=request_hash,
            idempotency_key=key,
            actor_id=actor_id,
            current_review_version=request.current_review_version,
            current_document_hash=content_hash,
            result=result,
            audit=audit,
        )
        return self._accept_response(operation)

    @staticmethod
    def _accept_response(operation: ArticleAIEditOperation) -> AcceptAIEditResponse:
        result = operation.accepted_result_json or {}
        return AcceptAIEditResponse(
            operation=operation_response(operation),
            canonical_slice=result.get("slice"),
            canonical_metadata=result.get("metadata"),
            anchor_node_id=operation.anchor_node_id,
            from_=operation.selection_from,
            to=operation.selection_to,
        )

    async def retry(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        operation_id: str,
        request: RetryAIEditRequest,
        *,
        idempotency_key: str,
        actor_id: str,
        audit: ContentAuditContext,
    ) -> CreateAIEditResponse:
        parent = await self.repository.get(organization_id, project_id, article_id, operation_id)
        if parent.status not in {"failed", "cancelled", "stale", "rejected"}:
            raise AIEditRepositoryError("ai_edit_not_retryable")
        create_request = CreateAIEditRequest(
            base_review_version=request.base_review_version,
            document_hash=request.document_hash,
            document=request.document,
            metadata=request.metadata,
            command=parent.command,
            scope=parent.scope,
            selection=request.selection,
            context=request.context,
        )
        return await self.create(
            organization_id,
            project_id,
            article_id,
            create_request,
            idempotency_key=idempotency_key,
            actor_id=actor_id,
            audit=audit,
            parent_operation_id=parent.id,
        )

    async def _provider_record(self, organization_id: str) -> AIProviderSettingsRecord:
        if self.settings.article_ai_edit_provider_mode == "deterministic_fake":
            return AIProviderSettingsRecord(
                provider="openai",
                base_url="deterministic://article-ai-edit",
                api_key="not-used",
                model="article-ai-edit-fixture-v1",
                request_timeout_seconds=30,
                max_retries=0,
            )
        try:
            record = await self.ai_settings.effective_record_for_organization(organization_id)
            return record.for_task("content")
        except AIProviderNotConfiguredError as exc:
            raise AIEditRepositoryError("ai_edit_provider_not_configured") from exc

    @staticmethod
    def _validate_snapshot(
        article: Article,
        raw_document: dict[str, Any],
        raw_metadata: dict[str, Any],
        supplied_hash: str,
        selection: AIEditSelection | None,
    ) -> tuple[dict[str, Any], dict[str, Any], str, str, AIEditSelection | None]:
        try:
            document = normalize_document(raw_document)
            metadata = article_metadata_snapshot(article, raw_metadata)
        except ValueError as exc:
            raise AIEditValidationError(str(exc)) from exc
        content_hash = document_content_hash(document, metadata)
        if content_hash != supplied_hash.removeprefix("sha256:"):
            raise AIEditValidationError("ai_edit_document_hash_invalid")
        selected = ""
        if selection is not None:
            selected = validate_selection(
                document,
                selection.anchor_node_id,
                selection.from_,
                selection.to,
                selection.selected_text_hash,
            )
        return document, metadata, content_hash, selected, selection

    @staticmethod
    def _validate_command_scope(
        command: str, scope: str, selection: AIEditSelection | None
    ) -> None:
        if command in {"title", "meta_title", "meta_description"}:
            if scope != "metadata" or selection is not None:
                raise AIEditValidationError("ai_edit_scope_invalid")
            return
        if command == "continue":
            if scope != "cursor" or selection is None or selection.from_ != selection.to:
                raise AIEditValidationError("ai_edit_scope_invalid")
            return
        if command in {"faq", "cta"}:
            if scope not in {"cursor", "block"} or selection is None:
                raise AIEditValidationError("ai_edit_scope_invalid")
            return
        if scope not in {"selection", "block"} or selection is None:
            raise AIEditValidationError("ai_edit_scope_invalid")
        if scope == "selection" and selection.from_ == selection.to:
            raise AIEditValidationError("ai_edit_selection_empty")

    @staticmethod
    def _validate_accept_selection(
        operation: ArticleAIEditOperation,
        document: dict[str, Any],
        current: AIEditSelection | None,
    ) -> None:
        if operation.anchor_node_id is None:
            if current is not None:
                raise AIEditRepositoryError("ai_edit_selection_stale")
            return
        if current is None or (
            current.anchor_node_id != operation.anchor_node_id
            or current.from_ != operation.selection_from
            or current.to != operation.selection_to
            or current.selected_text_hash != operation.selected_text_hash
        ):
            raise AIEditRepositoryError("ai_edit_selection_stale")
        validate_selection(
            document,
            operation.anchor_node_id,
            operation.selection_from or 0,
            operation.selection_to or 0,
            operation.selected_text_hash or "",
        )

    @staticmethod
    def _accepted_result(
        operation: ArticleAIEditOperation, candidate_index: int | None
    ) -> dict[str, Any]:
        if operation.candidate_kind == "text":
            if candidate_index is not None or not operation.candidate_text:
                raise AIEditRepositoryError("ai_edit_candidate_invalid")
            return {"kind": "text", "text": operation.candidate_text}
        if operation.candidate_kind == "slice":
            if candidate_index is not None or not operation.candidate_slice_json:
                raise AIEditRepositoryError("ai_edit_candidate_invalid")
            return {"kind": "slice", "slice": operation.candidate_slice_json}
        candidates = (operation.candidate_metadata_json or {}).get("candidates")
        if not isinstance(candidates, list) or candidate_index is None:
            raise AIEditRepositoryError("ai_edit_candidate_index_required")
        if candidate_index >= len(candidates):
            raise AIEditRepositoryError("ai_edit_candidate_index_invalid")
        field = str((operation.candidate_metadata_json or {}).get("field") or "")
        return {
            "kind": "metadata",
            "metadata": {"field": field, "value": str(candidates[candidate_index])},
        }

    async def _mark_stale(
        self,
        operation: ArticleAIEditOperation,
        code: str,
        audit: ContentAuditContext,
    ) -> None:
        await self.repository.mark_stale(
            operation.organization_id,
            operation.project_id,
            operation.article_id,
            operation.id,
            code=code,
            audit=audit,
        )
        raise AIEditRepositoryError("ai_edit_stale")

    @staticmethod
    def _idempotency_key(value: str) -> str:
        key = value.strip()
        if not key or len(key) > 200:
            raise AIEditRepositoryError("ai_edit_idempotency_key_invalid")
        return key


def operation_response(operation: ArticleAIEditOperation) -> AIEditOperationResponse:
    selection = None
    if operation.anchor_node_id is not None:
        selection = AIEditSelection(
            anchor_node_id=operation.anchor_node_id,
            from_=operation.selection_from or 0,
            to=operation.selection_to or 0,
            selected_text_hash=operation.selected_text_hash or sha256_text(""),
        )
    return AIEditOperationResponse(
        id=operation.id,
        article_id=operation.article_id,
        parent_operation_id=operation.parent_operation_id,
        command=operation.command,
        scope=operation.scope,
        status=operation.status,
        base_review_version=operation.base_review_version,
        document_hash=operation.document_hash,
        selection=selection,
        prompt_version=operation.prompt_version,
        provider=operation.provider,
        model=operation.model,
        candidate=AIEditCandidate(
            kind=operation.candidate_kind,
            text=operation.candidate_text,
            metadata=operation.candidate_metadata_json,
            slice=operation.candidate_slice_json,
        ),
        allowed_modes=operation.allowed_modes_json,
        error_code=operation.error_code,
        error_detail=operation.error_detail,
        input_tokens=operation.input_tokens,
        output_tokens=operation.output_tokens,
        latency_ms=operation.latency_ms,
        stream_revision=operation.stream_revision,
        created_at=operation.created_at,
        started_at=operation.started_at,
        completed_at=operation.completed_at,
        decided_at=operation.decided_at,
        accepted_mode=operation.accepted_mode,
        accepted_result=operation.accepted_result_json,
    )


def model_config_snapshot(record: AIProviderSettingsRecord) -> dict[str, Any]:
    parts = urlsplit(record.base_url)
    sanitized = urlunsplit((parts.scheme, parts.hostname or "", parts.path, "", ""))
    return {
        "provider": record.provider,
        "model": record.model,
        "reasoning_effort": record.reasoning_effort,
        "base_url_hash": sha256(sanitized.encode()).hexdigest(),
        "request_timeout_seconds": record.request_timeout_seconds,
        "max_retries": record.max_retries,
        "settings_updated_at": (record.updated_at.isoformat() if record.updated_at else None),
    }


def build_ai_edit_service() -> AIEditService:
    settings = get_settings()
    return AIEditService(settings, AIEditRepository(session_factory))
