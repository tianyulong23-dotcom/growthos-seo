from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Protocol
from uuid import uuid4
from zoneinfo import ZoneInfo

from app.modules.content_plan.d4_service import ContentPlanD4Service, D4GroupError
from app.modules.content_plan.domain import normalize_keyword
from app.modules.content_plan.models import ContentPlanItem
from app.modules.content_plan.providers import (
    ContentPlanAIGateway,
    ContentPlanDataForSEOGateway,
    bind_content_plan_organization,
    reset_content_plan_organization,
)
from app.modules.content_plan.repository import (
    ContentPlanRepository,
    PlanItemBundle,
    PlanItemConflictError,
    PreparationBundle,
)
from app.modules.content_plan.recovery import RECOVERABLE_PREPARATION_ERROR_CODES
from app.modules.content_plan.schemas import (
    ContentPlanItemCollectionResponse,
    ContentPlanItemResponse,
    ContentPlanItemSummaryResponse,
    CreateManualPlanItemRequest,
    ManualPlanAcceptedResponse,
    PendingPreparationResponse,
    PlanItemEditAcceptedResponse,
    PlanItemKeywordResponse,
    PlanItemSerpSnapshotResponse,
    PreparationProcessResponse,
    UpdateContentPlanItemRequest,
)
from app.modules.content_plan.service import ContentPlanD3Service, D3ProcessingError

logger = logging.getLogger(__name__)


class PreparationDispatcher(Protocol):
    async def dispatch(self, preparation_id: str) -> None: ...


class ContentPlanWorkflowError(Exception):
    def __init__(
        self,
        code: str,
        message: str | None = None,
        *,
        retryable: bool = False,
        conflict_id: str | None = None,
        current_version: int | None = None,
    ) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.retryable = retryable
        self.conflict_id = conflict_id
        self.current_version = current_version


class ContentPlanD6Service:
    def __init__(
        self,
        repository: ContentPlanRepository,
        *,
        d3_service: ContentPlanD3Service,
        d4_service: ContentPlanD4Service,
        generate_now: Callable[[str, int], Awaitable[None]],
        dispatcher: PreparationDispatcher | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.repository = repository
        self.d3_service = d3_service
        self.d4_service = d4_service
        self.generate_now = generate_now
        self.dispatcher = dispatcher
        self.clock = clock or (lambda: datetime.now(UTC))

    async def create_manual(
        self,
        organization_id: str,
        project_id: str,
        request: CreateManualPlanItemRequest,
        *,
        idempotency_key: str,
    ) -> ManualPlanAcceptedResponse:
        context = await self.repository.get_project_plan_context(
            organization_id, project_id
        )
        if context is None:
            raise ContentPlanWorkflowError("project_not_found")
        conflict = await self.repository.find_keyword_conflict(
            project_id, request.seed_keyword
        )
        if conflict is not None:
            raise ContentPlanWorkflowError(
                "plan_keyword_conflict", conflict_id=conflict[1]
            )
        request_hash = self._hash(
            {
                "operation": "content_plan_manual_v1",
                "organization_id": organization_id,
                "project_id": project_id,
                "seed_keyword": normalize_keyword(request.seed_keyword),
            }
        )
        try:
            batch, preparation = await self.repository.create_manual_preparation(
                batch_id=f"content-plan-batch-{uuid4().hex}",
                preparation_id=f"preparation-{uuid4().hex}",
                organization_id=organization_id,
                project_id=project_id,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                seed_keyword=request.seed_keyword,
                normalized_seed_keyword=normalize_keyword(request.seed_keyword),
                country=context.project.country,
                language=context.project.language,
                timezone=context.settings.timezone,
                business_context=context.business_context,
            )
        except ValueError as exc:
            raise self._translate_value_error(exc) from exc
        await self._dispatch_after_commit(preparation.id)
        return ManualPlanAcceptedResponse(
            batch_id=batch.id, preparation_id=preparation.id
        )

    async def process_preparation(
        self, preparation_id: str
    ) -> PreparationProcessResponse:
        target = await self.repository.get_preparation_dispatch_target(preparation_id)
        if target is None:
            raise ContentPlanWorkflowError("content_plan_preparation_not_found")
        token = bind_content_plan_organization(target.organization_id)
        try:
            return await self._process_preparation(preparation_id)
        finally:
            reset_content_plan_organization(token)

    async def mark_retry_exhausted(
        self, preparation_id: str, *, last_error_code: str | None
    ) -> PreparationProcessResponse:
        bundle = await self.repository.get_preparation_bundle(preparation_id)
        if bundle is None:
            raise ContentPlanWorkflowError("content_plan_preparation_not_found")
        preparation = bundle.preparation
        detail = "Preparation technical retries exhausted after 5 attempts"
        if last_error_code:
            detail = f"{detail}: {last_error_code}"
        return await self._finish_permanent_failure(
            preparation_id,
            is_edit=preparation.plan_item_id is not None,
            code="content_plan_technical_retry_exhausted",
            detail=detail,
        )

    async def _process_preparation(
        self, preparation_id: str
    ) -> PreparationProcessResponse:
        bundle = await self.repository.get_preparation_bundle(preparation_id)
        if bundle is None:
            raise ContentPlanWorkflowError("content_plan_preparation_not_found")
        preparation = bundle.preparation
        if preparation.state in {"cancelled", "superseded"}:
            raise ContentPlanWorkflowError("preparation_superseded")
        is_edit = preparation.plan_item_id is not None
        fixed_primary = is_edit and preparation.state == "expanded"
        max_secondaries = 8 if is_edit else 5
        try:
            if not self._has_complete_keyword_package(bundle, max_secondaries):
                await self.d3_service.process_preparation(
                    preparation.id,
                    fixed_primary=fixed_primary,
                    max_secondaries=max_secondaries,
                )
            outcome = await self.d4_service.process_preparation(
                preparation.id, max_secondaries=max_secondaries
            )
            if not outcome.success:
                code = outcome.error_code or "serp_preview_failed"
                raise ContentPlanWorkflowError(
                    code,
                    outcome.error_detail,
                    retryable=self._is_retryable(code),
                )
            if is_edit:
                item = await self.repository.complete_plan_item_repreparation(
                    preparation.id
                )
                await self._trigger_if_due(item)
                return PreparationProcessResponse(
                    preparation_id=preparation.id,
                    status="completed",
                    item_id=item.id,
                )
            item = await self.repository.create_manual_plan_item(preparation.id)
            scheduled = await self.repository.schedule_batch(
                preparation.batch_id, now=self.clock()
            )
            item = next(row for row in scheduled if row.id == item.id)
            await self._trigger_if_due(item)
            return PreparationProcessResponse(
                preparation_id=preparation.id,
                status="completed",
                item_id=item.id,
            )
        except ContentPlanWorkflowError as exc:
            if exc.code == "preparation_superseded" or exc.retryable:
                raise
            return await self._finish_permanent_failure(
                preparation.id,
                is_edit=is_edit,
                code=exc.code,
                detail=exc.message,
            )
        except PlanItemConflictError as exc:
            error = ContentPlanWorkflowError(
                "plan_keyword_conflict", conflict_id=exc.conflict_plan_id
            )
            result = await self._finish_permanent_failure(
                preparation.id,
                is_edit=is_edit,
                code=error.code,
                detail=error.message,
            )
            if not is_edit:
                raise error from exc
            return result
        except D3ProcessingError as exc:
            error = ContentPlanWorkflowError(
                exc.code, exc.detail, retryable=self._is_retryable(exc.code)
            )
            if error.retryable:
                raise error from exc
            result = await self._finish_permanent_failure(
                preparation.id,
                is_edit=is_edit,
                code=error.code,
                detail=error.message,
            )
            if not is_edit:
                raise error from exc
            return result
        except D4GroupError as exc:
            if exc.code == "preparation_superseded":
                raise ContentPlanWorkflowError(exc.code, exc.detail) from exc
            error = ContentPlanWorkflowError(
                exc.code, exc.detail, retryable=self._is_retryable(exc.code)
            )
            if error.retryable:
                raise error from exc
            result = await self._finish_permanent_failure(
                preparation.id,
                is_edit=is_edit,
                code=error.code,
                detail=error.message,
            )
            if not is_edit:
                raise error from exc
            return result
        except ValueError as exc:
            error = self._translate_value_error(exc)
            if error.code == "preparation_superseded":
                raise error from exc
            result = await self._finish_permanent_failure(
                preparation.id,
                is_edit=is_edit,
                code=error.code,
                detail=error.message,
            )
            if not is_edit:
                raise error from exc
            return result

    async def get_item(
        self, organization_id: str, project_id: str, item_id: str
    ) -> ContentPlanItemResponse:
        bundle = await self.repository.get_plan_item_bundle_scoped(
            organization_id, project_id, item_id
        )
        if bundle is None:
            raise ContentPlanWorkflowError("content_plan_item_not_found")
        return self._item_response(bundle)

    async def list_items(
        self,
        organization_id: str,
        project_id: str,
        *,
        start_date: date | None = None,
        end_date: date | None = None,
        statuses: tuple[str, ...] = (),
    ) -> ContentPlanItemCollectionResponse:
        if start_date is not None and end_date is not None and start_date > end_date:
            raise ContentPlanWorkflowError("content_plan_date_range_invalid")
        allowed_statuses = {
            "unscheduled",
            "scheduled",
            "triggering",
            "generating",
            "generated",
            "failed",
            "cancelled",
        }
        if any(value not in allowed_statuses for value in statuses):
            raise ContentPlanWorkflowError("content_plan_status_invalid")
        if not await self.repository.project_exists(organization_id, project_id):
            raise ContentPlanWorkflowError("project_not_found")
        bundles = await self.repository.list_plan_item_bundles_scoped(
            organization_id,
            project_id,
            start_date=start_date,
            end_date=end_date,
            statuses=statuses,
        )
        items = [self._item_summary_response(bundle) for bundle in bundles]
        return ContentPlanItemCollectionResponse(items=items, total=len(items))

    async def update_item(
        self,
        organization_id: str,
        project_id: str,
        item_id: str,
        request: UpdateContentPlanItemRequest,
    ) -> ContentPlanItemResponse | PlanItemEditAcceptedResponse:
        current = await self.repository.get_plan_item_bundle_scoped(
            organization_id, project_id, item_id
        )
        if current is None:
            raise ContentPlanWorkflowError("content_plan_item_not_found")
        self._validate_version_and_status(current.item, request.version)
        if request.seed_keyword is not None or request.primary_keyword is not None:
            changed_keyword = request.seed_keyword or request.primary_keyword
            conflict = await self.repository.find_keyword_conflict(
                project_id, str(changed_keyword), exclude_item_id=item_id
            )
            if conflict is not None:
                raise ContentPlanWorkflowError(
                    "plan_keyword_conflict", conflict_id=conflict[1]
                )
            try:
                preparation = await self.repository.begin_plan_item_repreparation(
                    organization_id,
                    project_id,
                    item_id,
                    expected_version=request.version,
                    preparation_id=f"preparation-{uuid4().hex}",
                    seed_keyword=request.seed_keyword,
                    primary_keyword=request.primary_keyword,
                )
            except ValueError as exc:
                raise self._translate_value_error(exc) from exc
            await self._dispatch_after_commit(preparation.id)
            return PlanItemEditAcceptedResponse(
                item_id=item_id,
                version=request.version + 1,
                pending_preparation_id=preparation.id,
                preparation_version=preparation.preparation_version,
            )

        secondary_types = None
        if request.secondary_keywords is not None:
            if len(request.secondary_keywords) > 8:
                raise ContentPlanWorkflowError("secondary_keyword_limit_exceeded")
            normalized = [normalize_keyword(value) for value in request.secondary_keywords]
            if (
                len(normalized) != len(set(normalized))
                or normalize_keyword(current.item.primary_keyword) in normalized
            ):
                raise ContentPlanWorkflowError("secondary_keyword_duplicate")
            token = bind_content_plan_organization(organization_id)
            try:
                secondary_types = await self.d3_service.validate_secondary_keywords(
                    current.item.current_preparation_id,
                    item_version=request.version,
                    primary_keyword=current.item.primary_keyword,
                    secondary_keywords=request.secondary_keywords,
                )
            except D3ProcessingError as exc:
                raise ContentPlanWorkflowError(
                    exc.code, exc.detail, retryable=self._is_retryable(exc.code)
                ) from exc
            finally:
                reset_content_plan_organization(token)
        try:
            updated, trigger_now = await self.repository.update_plan_item_fields(
                organization_id,
                project_id,
                item_id,
                expected_version=request.version,
                title=request.title,
                writing_direction=request.writing_direction,
                secondary_keywords=request.secondary_keywords,
                publish_local_date=request.publish_local_date,
                now=self.clock(),
                secondary_keyword_types=secondary_types,
            )
        except ValueError as exc:
            raise self._translate_value_error(exc) from exc
        if trigger_now:
            await self.generate_now(updated.item.id, updated.item.version)
        refreshed = await self.repository.get_plan_item_bundle_scoped(
            organization_id, project_id, item_id
        )
        if refreshed is None:
            raise ContentPlanWorkflowError("content_plan_item_not_found")
        return self._item_response(refreshed)

    async def cancel_item(
        self,
        organization_id: str,
        project_id: str,
        item_id: str,
        *,
        expected_version: int,
    ) -> ContentPlanItemResponse:
        try:
            await self.repository.cancel_plan_item(
                organization_id,
                project_id,
                item_id,
                expected_version=expected_version,
            )
        except LookupError as exc:
            raise ContentPlanWorkflowError("content_plan_item_not_found") from exc
        except ValueError as exc:
            raise self._translate_value_error(exc) from exc
        return await self.get_item(organization_id, project_id, item_id)

    async def _fail_repreparation(
        self, preparation_id: str, code: str, detail: str
    ) -> PreparationProcessResponse:
        try:
            item = await self.repository.fail_plan_item_repreparation(
                preparation_id, error_code=code, error_detail=detail
            )
        except ValueError as exc:
            raise self._translate_value_error(exc) from exc
        return PreparationProcessResponse(
            preparation_id=preparation_id,
            status="reprepare_failed",
            item_id=item.id if item is not None else None,
        )

    async def _finish_permanent_failure(
        self,
        preparation_id: str,
        *,
        is_edit: bool,
        code: str,
        detail: str,
    ) -> PreparationProcessResponse:
        if is_edit:
            return await self._fail_repreparation(preparation_id, code, detail)
        await self.repository.fail_manual_preparation(
            preparation_id,
            error_code=code,
            error_detail=detail,
        )
        return PreparationProcessResponse(
            preparation_id=preparation_id,
            status="failed",
        )

    async def _dispatch_after_commit(self, preparation_id: str) -> None:
        if self.dispatcher is None:
            return
        try:
            await self.dispatcher.dispatch(preparation_id)
        except Exception:
            logger.exception(
                "Unable to dispatch persisted content-plan preparation %s",
                preparation_id,
            )

    async def _trigger_if_due(self, item: ContentPlanItem) -> None:
        if item.publish_local_date is None or item.schedule_timezone is None:
            return
        local_today = self.clock().astimezone(ZoneInfo(item.schedule_timezone)).date()
        if item.publish_local_date <= local_today + timedelta(days=1):
            await self.generate_now(item.id, item.version)

    @staticmethod
    def _validate_version_and_status(item: ContentPlanItem, version: int) -> None:
        if item.version != version:
            raise ContentPlanWorkflowError(
                "stale_version", current_version=item.version
            )
        if item.status not in {"unscheduled", "scheduled", "failed"}:
            raise ContentPlanWorkflowError("plan_not_editable")

    @staticmethod
    def _item_response(bundle: PlanItemBundle) -> ContentPlanItemResponse:
        item = bundle.item
        snapshot = bundle.serp_snapshot
        pending = bundle.pending_preparation
        article = bundle.article
        keyword_values = [
            PlanItemKeywordResponse(
                keyword=row.keyword,
                role=row.role,
                keyword_type=row.keyword_type,
                source=row.source,
                position=row.position,
            )
            for row in bundle.keywords
        ]
        return ContentPlanItemResponse(
            id=item.id,
            project_id=item.project_id,
            source=item.source,
            seed_keyword=item.seed_keyword,
            primary_keyword=item.primary_keyword,
            secondary_keywords=[
                row.keyword for row in bundle.keywords if row.role == "secondary"
            ],
            keywords=keyword_values,
            title=item.title,
            writing_direction=item.writing_direction,
            title_source="user" if item.title_user_edited else "system",
            writing_direction_source=(
                "user" if item.direction_user_edited else "system"
            ),
            title_user_edited=item.title_user_edited,
            direction_user_edited=item.direction_user_edited,
            edit_state=item.edit_state,
            pending_preparation_id=item.pending_preparation_id,
            preparation_version=item.preparation_version,
            version=item.version,
            publish_local_date=item.publish_local_date,
            schedule_timezone=item.schedule_timezone,
            generation_at=item.generation_at,
            status=item.status,
            schedule_attention_reason=item.schedule_attention_reason,
            article_id=item.article_id,
            current_serp_snapshot_id=item.current_serp_snapshot_id,
            current_serp_snapshot=(
                PlanItemSerpSnapshotResponse(
                    id=snapshot.id,
                    preparation_id=snapshot.preparation_id,
                    snapshot_version=snapshot.snapshot_version,
                    primary_keyword=snapshot.primary_keyword,
                    provider=snapshot.provider,
                    provider_request_id=snapshot.provider_request_id,
                )
                if snapshot is not None
                else None
            ),
            pending_preparation=(
                PendingPreparationResponse(
                    id=pending.id,
                    preparation_version=pending.preparation_version,
                    state=pending.state,
                    stage=pending.last_completed_stage,
                    error_code=pending.error_code,
                    error_detail=pending.error_detail,
                )
                if pending is not None
                else None
            ),
            publication_status=article.publication_status if article else None,
            review_status=article.review_status if article else None,
            review_version=article.review_version if article else None,
            publication_blocked_reason=(
                article.publication_blocked_reason if article else None
            ),
        )

    @staticmethod
    def _item_summary_response(bundle: PlanItemBundle) -> ContentPlanItemSummaryResponse:
        item = bundle.item
        article = bundle.article
        return ContentPlanItemSummaryResponse(
            id=item.id,
            project_id=item.project_id,
            source=item.source,
            title=item.title,
            primary_keyword=item.primary_keyword,
            edit_state=item.edit_state,
            version=item.version,
            publish_local_date=item.publish_local_date,
            schedule_timezone=item.schedule_timezone,
            generation_at=item.generation_at,
            status=item.status,
            schedule_attention_reason=item.schedule_attention_reason,
            article_id=item.article_id,
            publication_status=article.publication_status if article else None,
            review_status=article.review_status if article else None,
        )

    @staticmethod
    def _translate_value_error(exc: ValueError) -> ContentPlanWorkflowError:
        value = str(exc)
        code, _, suffix = value.partition(":")
        if code == "stale_version":
            return ContentPlanWorkflowError(
                code, current_version=int(suffix) if suffix.isdigit() else None
            )
        if code in {"schedule_date_conflict", "plan_keyword_conflict"}:
            return ContentPlanWorkflowError(code, conflict_id=suffix or None)
        return ContentPlanWorkflowError(code)

    @staticmethod
    def _is_retryable(code: str) -> bool:
        return code in RECOVERABLE_PREPARATION_ERROR_CODES

    @staticmethod
    def _has_complete_keyword_package(
        bundle: PreparationBundle, max_secondaries: int
    ) -> bool:
        if bundle.preparation.state not in {
            "pack_ready",
            "serp_preview",
            "preview_ready",
            "preview_failed",
        }:
            return False
        roles = [
            row.selected_role
            for row in bundle.keywords
            if row.selected_role in {"primary", "secondary"}
        ]
        return roles.count("primary") == 1 and roles.count("secondary") <= max_secondaries

    @staticmethod
    def _hash(value: dict[str, object]) -> str:
        payload = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
        return hashlib.sha256(payload.encode()).hexdigest()


def build_content_plan_d6_service() -> ContentPlanD6Service:
    from app.core.config import get_settings
    from app.db.session import session_factory
    from app.modules.content.service import build_content_service
    from app.modules.content_plan.dispatch import TemporalContentPlanDispatcher
    from app.modules.keywords.coverage import SQLAlchemyKeywordCoverageQuery

    repository = ContentPlanRepository(session_factory)
    ai_gateway = ContentPlanAIGateway()
    dataforseo_gateway = ContentPlanDataForSEOGateway()
    d3_service = ContentPlanD3Service(
        repository,
        seed_gateway=ai_gateway,
        expansion_gateway=dataforseo_gateway,
        classification_gateway=ai_gateway,
        coverage_query=SQLAlchemyKeywordCoverageQuery(session_factory),
        fallback_gateway=ai_gateway,
    )
    d4_service = ContentPlanD4Service(
        repository,
        serp_gateway=dataforseo_gateway,
        preview_gateway=ai_gateway,
    )
    content_service = build_content_service()

    async def generate_now(item_id: str, version: int) -> None:
        scope = await repository.get_plan_item_scope(item_id)
        if scope is None:
            raise ContentPlanWorkflowError("content_plan_item_not_found")
        organization_id, project_id = scope
        await content_service.generate_plan_item_now(
            project_id,
            item_id,
            expected_version=version,
            organization_id=organization_id,
        )

    return ContentPlanD6Service(
        repository,
        d3_service=d3_service,
        d4_service=d4_service,
        generate_now=generate_now,
        dispatcher=TemporalContentPlanDispatcher(
            repository, get_settings().content_task_queue
        ),
    )


__all__ = [
    "ContentPlanD6Service",
    "ContentPlanWorkflowError",
    "build_content_plan_d6_service",
]
