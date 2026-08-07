from __future__ import annotations

import hashlib
import json
import logging
from typing import Protocol
from uuid import uuid4

from app.modules.content_plan.d4_service import ContentPlanD4Service
from app.modules.content_plan.providers import (
    ContentPlanAIGateway,
    ContentPlanDataForSEOGateway,
    bind_content_plan_organization,
    reset_content_plan_organization,
)
from app.modules.content_plan.recovery import RECOVERABLE_PREPARATION_ERROR_CODES
from app.modules.content_plan.recovery import MANUAL_RETRYABLE_BATCH_ERROR_CODES
from app.modules.content_plan.repository import (
    ActiveAutomaticBatchError,
    BatchProgress,
    ContentPlanRepository,
)
from app.modules.content_plan.schemas import (
    AutomaticBatchAcceptedResponse,
    BatchRetryAcceptedResponse,
    ContentPlanBatchCollectionResponse,
    ContentPlanBatchResponse,
)
from app.modules.content_plan.service import ContentPlanD3Service

logger = logging.getLogger(__name__)


class BatchDispatcher(Protocol):
    async def dispatch(self, preparation_id: str) -> None: ...

    async def dispatch_batch(self, batch_id: str) -> None: ...


class ContentPlanBatchError(Exception):
    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        retryable: bool = False,
        conflict_id: str | None = None,
    ) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.retryable = retryable
        self.conflict_id = conflict_id


class ContentPlanBatchService:
    def __init__(
        self,
        repository: ContentPlanRepository,
        *,
        d3_service: ContentPlanD3Service,
        d4_service: ContentPlanD4Service,
        dispatcher: BatchDispatcher | None = None,
    ) -> None:
        self.repository = repository
        self.d3_service = d3_service
        self.d4_service = d4_service
        self.dispatcher = dispatcher

    async def create_automatic(
        self,
        organization_id: str,
        project_id: str,
        *,
        idempotency_key: str,
    ) -> AutomaticBatchAcceptedResponse:
        context = await self.repository.get_project_plan_context(
            organization_id, project_id
        )
        if context is None:
            raise ContentPlanBatchError("project_or_content_plan_settings_not_found")
        self._validate_business_context(context.business_context)
        request_hash = self._hash(
            {
                "operation": "content_plan_automatic_v1",
                "organization_id": organization_id,
                "project_id": project_id,
                "target_count": 30,
            }
        )
        batch_id = f"content-plan-batch-{uuid4().hex}"
        try:
            batch = await self.repository.create_automatic_batch(
                batch_id=batch_id,
                organization_id=organization_id,
                project_id=project_id,
                workflow_id=f"content-plan:automatic:{batch_id}",
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                country=context.project.country,
                language=context.project.language,
                timezone=context.settings.timezone,
                business_context=context.business_context,
            )
        except ActiveAutomaticBatchError as exc:
            raise ContentPlanBatchError(
                "active_automatic_batch_exists", conflict_id=exc.batch_id
            ) from exc
        except ValueError as exc:
            raise ContentPlanBatchError(str(exc)) from exc
        if self._should_dispatch(batch.status, batch.error_code):
            await self._dispatch_batch_after_commit(batch.id)
        return AutomaticBatchAcceptedResponse(batch_id=batch.id)

    async def get_batch(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> ContentPlanBatchResponse:
        progress = await self.repository.get_batch_progress_scoped(
            organization_id, project_id, batch_id
        )
        if progress is None:
            raise ContentPlanBatchError("content_plan_batch_not_found")
        return self._response(progress)

    async def list_batches(
        self, organization_id: str, project_id: str, *, limit: int = 20
    ) -> ContentPlanBatchCollectionResponse:
        rows = await self.repository.list_batch_progress_scoped(
            organization_id, project_id, limit=limit
        )
        return ContentPlanBatchCollectionResponse(
            items=[self._response(row) for row in rows], total=len(rows)
        )

    async def retry_batch(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> BatchRetryAcceptedResponse:
        try:
            target = await self.repository.prepare_batch_retry_scoped(
                organization_id, project_id, batch_id
            )
        except ValueError as exc:
            raise ContentPlanBatchError(str(exc)) from exc
        if target is None:
            raise ContentPlanBatchError("content_plan_batch_not_found")
        if target.preparation_id is None:
            await self._dispatch_batch_after_commit(target.batch.id)
        else:
            await self._dispatch_preparation_after_commit(target.preparation_id)
        return BatchRetryAcceptedResponse(
            batch_id=target.batch.id,
            target_count=target.batch.target_count,
        )

    async def process_batch(self, batch_id: str) -> dict[str, object]:
        target = await self.repository.get_batch_dispatch_target(batch_id)
        if target is None:
            raise ContentPlanBatchError("content_plan_batch_not_found")
        token = bind_content_plan_organization(target.organization_id)
        try:
            batch = await self.repository.get_batch(batch_id)
            if batch is None:
                raise ContentPlanBatchError("content_plan_batch_not_found")
            if batch.status == "completed":
                return {
                    "batch_id": batch_id,
                    "status": "completed",
                    "plan_item_count": batch.target_count,
                }
            if batch.status == "cancelled":
                return {"batch_id": batch_id, "status": "cancelled"}
            if not self._d4_started(batch.status, batch.stage):
                d3_result = await self.d3_service.run(batch_id)
                if d3_result.status != "pack_ready":
                    return {
                        "batch_id": batch_id,
                        "status": (
                            "retryable_failed"
                            if d3_result.error_code
                            in RECOVERABLE_PREPARATION_ERROR_CODES
                            else "needs_attention"
                        ),
                        "error_code": d3_result.error_code,
                    }
            d4_result = await self.d4_service.run(batch_id)
            if d4_result.status == "completed":
                return {
                    "batch_id": batch_id,
                    "status": "completed",
                    "plan_item_count": d4_result.plan_item_count,
                }
            return {
                "batch_id": batch_id,
                "status": (
                    "retryable_failed"
                    if d4_result.error_code in RECOVERABLE_PREPARATION_ERROR_CODES
                    else "needs_attention"
                ),
                "error_code": d4_result.error_code,
            }
        finally:
            reset_content_plan_organization(token)

    async def mark_retry_exhausted(
        self, batch_id: str, *, last_error_code: str | None
    ) -> dict[str, object]:
        batch = await self.repository.get_batch(batch_id)
        if batch is None:
            raise ContentPlanBatchError("content_plan_batch_not_found")
        if batch.status in {"completed", "cancelled"}:
            return {"batch_id": batch_id, "status": batch.status}
        detail = "Automatic technical retries exhausted after 5 attempts"
        if last_error_code:
            detail = f"{detail}: {last_error_code}"
        await self.repository.update_batch_progress(
            batch_id,
            status="needs_attention",
            stage=batch.stage,
            error_code="content_plan_technical_retry_exhausted",
            error_detail=detail,
        )
        return {
            "batch_id": batch_id,
            "status": "needs_attention",
            "error_code": "content_plan_technical_retry_exhausted",
        }

    async def _dispatch_batch_after_commit(self, batch_id: str) -> None:
        if self.dispatcher is None:
            return
        try:
            await self.dispatcher.dispatch_batch(batch_id)
        except Exception:
            logger.exception(
                "Unable to dispatch persisted automatic content-plan batch %s",
                batch_id,
            )

    async def _dispatch_preparation_after_commit(self, preparation_id: str) -> None:
        if self.dispatcher is None:
            return
        try:
            await self.dispatcher.dispatch(preparation_id)
        except Exception:
            logger.exception(
                "Unable to dispatch persisted content-plan preparation %s",
                preparation_id,
            )

    @staticmethod
    def _validate_business_context(value: dict[str, object]) -> None:
        for field in ("business_name", "business_type"):
            if not isinstance(value.get(field), str) or not str(value[field]).strip():
                raise ContentPlanBatchError("business_context_missing")
        if not isinstance(value.get("business_summary"), str):
            raise ContentPlanBatchError("business_context_missing")
        for field in ("target_audiences", "products_services"):
            items = value.get(field)
            if not isinstance(items, list) or not all(
                isinstance(item, str) and item.strip() for item in items
            ):
                raise ContentPlanBatchError("business_context_missing")

    @staticmethod
    def _should_dispatch(status: str, error_code: str | None) -> bool:
        if status in {"completed", "cancelled"}:
            return False
        if status == "needs_attention":
            return error_code in RECOVERABLE_PREPARATION_ERROR_CODES
        return True

    @staticmethod
    def _d4_started(status: str, stage: str) -> bool:
        return status in {
            "building_previews",
            "creating_items",
            "scheduling",
        } or stage.startswith(("d4_", "d5_"))

    @staticmethod
    def _response(progress: BatchProgress) -> ContentPlanBatchResponse:
        batch = progress.batch
        return ContentPlanBatchResponse(
            batch_id=batch.id,
            project_id=batch.project_id,
            source=batch.source,
            target_count=batch.target_count,
            status=batch.status,
            stage=batch.stage,
            candidate_snapshot_count=batch.candidate_snapshot_count,
            selected_count=batch.selected_count,
            valid_pack_count=batch.valid_pack_count,
            preparation_count=progress.preparation_count,
            preview_ready_count=progress.preview_ready_count,
            plan_item_count=progress.plan_item_count,
            external_request_count=progress.external_request_count,
            total_cost_usd=progress.total_cost_usd,
            retryable=(
                batch.status == "needs_attention"
                and batch.error_code in MANUAL_RETRYABLE_BATCH_ERROR_CODES
            ),
            error_code=batch.error_code,
            error_detail=batch.error_detail,
            created_at=batch.created_at,
            updated_at=batch.updated_at,
            finished_at=batch.finished_at,
        )

    @staticmethod
    def _hash(value: dict[str, object]) -> str:
        payload = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
        return hashlib.sha256(payload.encode()).hexdigest()


def build_content_plan_batch_service() -> ContentPlanBatchService:
    from app.core.config import get_settings
    from app.db.session import session_factory
    from app.modules.content_plan.dispatch import TemporalContentPlanDispatcher
    from app.modules.keywords.coverage import SQLAlchemyKeywordCoverageQuery

    repository = ContentPlanRepository(session_factory)
    ai_gateway = ContentPlanAIGateway()
    dataforseo_gateway = ContentPlanDataForSEOGateway()
    return ContentPlanBatchService(
        repository,
        d3_service=ContentPlanD3Service(
            repository,
            seed_gateway=ai_gateway,
            expansion_gateway=dataforseo_gateway,
            classification_gateway=ai_gateway,
            coverage_query=SQLAlchemyKeywordCoverageQuery(session_factory),
            fallback_gateway=ai_gateway,
        ),
        d4_service=ContentPlanD4Service(
            repository,
            serp_gateway=dataforseo_gateway,
            preview_gateway=ai_gateway,
        ),
        dispatcher=TemporalContentPlanDispatcher(
            repository, get_settings().content_task_queue
        ),
    )


__all__ = [
    "ContentPlanBatchError",
    "ContentPlanBatchService",
    "build_content_plan_batch_service",
]
