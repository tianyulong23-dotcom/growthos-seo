from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Protocol, Sequence
from uuid import uuid4

from app.modules.agent.providers import ProviderError
from app.modules.content.dataforseo import (
    DataForSEOEmptyResult,
    DataForSEOError,
    DataForSEOOutcomeUnknown,
    DataForSEOTaskPending,
    OrganicResult,
    SERPResult,
    SerpTaskReceipt,
)
from app.modules.content_plan.ai_retry import (
    AI_REQUEST_MAX_ATTEMPTS,
    ai_retry_delay,
    classify_ai_provider_error,
)
from app.modules.content_plan.models import ContentPlanBatch, ContentPlanPreparation
from app.modules.content_plan.repository import (
    ContentPlanRepository,
    PlanItemConflictError,
)
from app.modules.content_plan.recovery import RECOVERABLE_PREPARATION_ERROR_CODES
from app.modules.content_plan.service import AICallResult


class SerpGateway(Protocol):
    async def search(
        self,
        keyword: str,
        country: str,
        language: str,
        device: str = "desktop",
    ) -> SERPResult: ...

    async def submit_serp_task(
        self,
        keyword: str,
        country: str,
        language: str,
        device: str = "desktop",
        *,
        tag: str,
    ) -> SerpTaskReceipt: ...

    async def get_serp_task(self, task_id: str, keyword: str) -> SERPResult: ...

    async def find_ready_serp_task(self, tag: str) -> str | None: ...


class PreviewGateway(Protocol):
    async def preview(
        self,
        primary_keyword: str,
        secondary_keywords: Sequence[str],
        *,
        evidence: dict[str, Any],
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult: ...


@dataclass(frozen=True)
class PreviewOutput:
    title: str
    writing_direction: str
    evidence_ids: tuple[str, ...]


@dataclass(frozen=True)
class D4BatchResult:
    batch_id: str
    status: str
    preview_ready_count: int
    plan_item_count: int = 0
    error_code: str | None = None
    error_detail: str | None = None
    conflict_plan_id: str | None = None


@dataclass(frozen=True)
class GroupResult:
    preparation_id: str
    success: bool
    error_code: str | None = None
    error_detail: str | None = None
    replace_primary: bool = False


class D4GroupError(Exception):
    def __init__(
        self,
        code: str,
        detail: str,
        *,
        serp_result: SERPResult | None = None,
        replace_primary: bool = False,
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.serp_result = serp_result
        self.replace_primary = replace_primary


class ContentPlanD4Service:
    def __init__(
        self,
        repository: ContentPlanRepository,
        *,
        serp_gateway: SerpGateway,
        preview_gateway: PreviewGateway,
        serp_concurrency: int = 5,
        preview_version: str = "content-plan-preview-v1",
        external_request_max_attempts: int = 3,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if not 1 <= serp_concurrency <= 5:
            raise ValueError("SERP concurrency must be between 1 and 5")
        if external_request_max_attempts < 1:
            raise ValueError("external request max attempts must be positive")
        self.repository = repository
        self.serp_gateway = serp_gateway
        self.preview_gateway = preview_gateway
        self.serp_concurrency = serp_concurrency
        self.preview_version = preview_version
        self.external_request_max_attempts = external_request_max_attempts
        self.clock = clock or (lambda: datetime.now(UTC))

    async def run(self, batch_id: str) -> D4BatchResult:
        preview_result = await self.build_previews(batch_id)
        if preview_result.status != "preview_ready":
            return preview_result
        try:
            await self.repository.create_automatic_plan_items(batch_id)
        except PlanItemConflictError as exc:
            detail = f"种子词已存在于活跃计划 {exc.conflict_plan_id}"
            await self.repository.update_batch_progress(
                batch_id,
                status="needs_attention",
                stage="d4_item_conflict",
                error_code="active_plan_seed_conflict",
                error_detail=detail,
            )
            return D4BatchResult(
                batch_id,
                "needs_attention",
                30,
                error_code="active_plan_seed_conflict",
                error_detail=detail,
                conflict_plan_id=exc.conflict_plan_id,
            )
        except ValueError as exc:
            detail = str(exc)
            await self.repository.update_batch_progress(
                batch_id,
                status="needs_attention",
                stage="d4_item_validation_failed",
                error_code="formal_plan_item_validation_failed",
                error_detail=detail,
            )
            return D4BatchResult(
                batch_id,
                "needs_attention",
                30,
                error_code="formal_plan_item_validation_failed",
                error_detail=detail,
            )
        try:
            scheduled = await self.repository.schedule_batch(batch_id, now=self.clock())
        except Exception as exc:
            return D4BatchResult(
                batch_id,
                "needs_attention",
                30,
                error_code="content_plan_scheduling_failed",
                error_detail=str(exc),
            )
        return D4BatchResult(batch_id, "completed", 30, len(scheduled))

    async def build_previews(self, batch_id: str) -> D4BatchResult:
        batch = await self._require_batch(batch_id)
        if batch.source != "automatic" or batch.target_count != 30:
            raise ValueError("D4 automatic orchestration requires an automatic batch")
        preparations = await self.repository.get_current_preparations(batch.id)
        self._validate_preparation_set(preparations)

        pending = [
            row
            for row in preparations
            if row.state in {"pack_ready", "serp_preview"}
            or (
                row.state == "preview_failed"
                and row.error_code in RECOVERABLE_PREPARATION_ERROR_CODES
            )
        ]
        while pending:
            await self.repository.update_batch_progress(
                batch.id,
                status="building_previews",
                stage="d4_serp_preview",
            )
            semaphore = asyncio.Semaphore(self.serp_concurrency)
            outcomes = await asyncio.gather(
                *(
                    self._bounded_process_group(semaphore, batch, preparation)
                    for preparation in pending
                ),
                return_exceptions=True,
            )
            unexpected = [outcome for outcome in outcomes if isinstance(outcome, Exception)]
            if unexpected:
                raise unexpected[0]
            replacements: list[ContentPlanPreparation] = []
            for outcome in outcomes:
                if not isinstance(outcome, GroupResult) or not outcome.replace_primary:
                    continue
                replacement = await self.repository.replace_failed_primary_keyword(
                    outcome.preparation_id
                )
                if replacement is None:
                    await self.repository.set_preparation_state(
                        outcome.preparation_id,
                        state="invalid",
                        error_code="serp_primary_candidates_exhausted",
                        error_detail="No eligible keyword remains in the current package",
                    )
                    continue
                bundle = await self.repository.get_preparation_bundle(outcome.preparation_id)
                if bundle is None:
                    raise ValueError("content plan preparation does not exist")
                replacements.append(bundle.preparation)
            pending = replacements

        preparations = await self.repository.get_current_preparations(batch.id)
        ready_count = sum(row.state == "preview_ready" for row in preparations)
        if ready_count != 30:
            failed = next(
                (row for row in preparations if row.state == "preview_failed"),
                next(row for row in preparations if row.state != "preview_ready"),
            )
            code = failed.error_code or "preview_batch_incomplete"
            detail = failed.error_detail or f"SERP 预览只完成 {ready_count}/30"
            await self.repository.update_batch_progress(
                batch.id,
                status="needs_attention",
                stage="d4_failed",
                error_code=code,
                error_detail=detail,
            )
            return D4BatchResult(
                batch.id,
                "needs_attention",
                ready_count,
                error_code=code,
                error_detail=detail,
            )
        await self.repository.update_batch_progress(
            batch.id,
            status="building_previews",
            stage="d4_preview_ready",
        )
        return D4BatchResult(batch.id, "preview_ready", ready_count)

    async def process_preparation(
        self, preparation_id: str, *, max_secondaries: int = 5
    ) -> GroupResult:
        bundle = await self.repository.get_preparation_bundle(preparation_id)
        if bundle is None:
            raise ValueError("content plan preparation does not exist")
        if bundle.preparation.state in {"cancelled", "superseded"}:
            raise D4GroupError("preparation_superseded", "准备版本已失效")
        batch = await self._require_batch(bundle.preparation.batch_id)
        return await self._process_group(batch, bundle.preparation, max_secondaries=max_secondaries)

    async def _bounded_process_group(
        self,
        semaphore: asyncio.Semaphore,
        batch: ContentPlanBatch,
        preparation: ContentPlanPreparation,
    ) -> GroupResult:
        async with semaphore:
            return await self._process_group(batch, preparation)

    async def _process_group(
        self,
        batch: ContentPlanBatch,
        preparation: ContentPlanPreparation,
        *,
        max_secondaries: int = 5,
    ) -> GroupResult:
        bundle = await self.repository.get_preparation_bundle(preparation.id)
        if bundle is None:
            raise ValueError("content plan preparation does not exist")
        selected = [row for row in bundle.keywords if row.selected_role in {"primary", "secondary"}]
        primary = [row for row in selected if row.selected_role == "primary"]
        secondaries = [row for row in selected if row.selected_role == "secondary"]
        if len(primary) != 1 or len(secondaries) > max_secondaries:
            raise ValueError(
                "keyword package must contain one primary and no more than "
                f"{max_secondaries} secondaries"
            )
        primary_keyword = primary[0].raw_keyword
        await self.repository.set_preparation_state(preparation.id, state="serp_preview")

        try:
            serp = await self._run_serp_request(batch, preparation, primary_keyword)
        except D4GroupError as exc:
            evidence = self._build_evidence(exc.serp_result) if exc.serp_result else None
            await self._save_failed_snapshot(
                batch,
                preparation,
                primary_keyword,
                request_key=self._serp_request_key(batch, preparation),
                serp=exc.serp_result,
                evidence=evidence,
                error_code=exc.code,
                error_detail=exc.detail,
            )
            return GroupResult(
                preparation.id,
                False,
                exc.code,
                exc.detail,
                exc.replace_primary,
            )

        evidence = self._build_evidence(serp)
        all_evidence_ids = {
            item["evidence_id"]
            for group in ("organic", "paa", "related_searches")
            for item in evidence[group]
        }
        if not all_evidence_ids:
            detail = f"{primary_keyword} 的 SERP 没有可用结果"
            await self._save_failed_snapshot(
                batch,
                preparation,
                primary_keyword,
                request_key=self._serp_request_key(batch, preparation),
                serp=serp,
                evidence=evidence,
                error_code="serp_empty_result",
                error_detail=detail,
            )
            return GroupResult(
                preparation.id,
                False,
                "serp_empty_result",
                detail,
                True,
            )

        try:
            preview = await self._preview_with_repair(
                batch,
                preparation,
                primary_keyword,
                [row.raw_keyword for row in secondaries],
                evidence,
                all_evidence_ids,
            )
        except D4GroupError as exc:
            await self._save_failed_snapshot(
                batch,
                preparation,
                primary_keyword,
                request_key=self._serp_request_key(batch, preparation),
                serp=serp,
                evidence=evidence,
                error_code=exc.code,
                error_detail=exc.detail,
            )
            return GroupResult(preparation.id, False, exc.code, exc.detail)

        used = set(preview.evidence_ids)
        organic = self._mark_used(evidence["organic"], used)
        paa = self._mark_used(evidence["paa"], used)
        related = self._mark_used(evidence["related_searches"], used)
        await self.repository.add_serp_snapshot(
            snapshot_id=f"serp-snapshot-{uuid4().hex}",
            preparation_id=preparation.id,
            primary_keyword=primary_keyword,
            country=batch.country,
            language=batch.language,
            provider="dataforseo",
            provider_request_id=serp.provider_request_id,
            request_key=self._serp_request_key(batch, preparation),
            cache_hit=serp.cached,
            cost_usd=serp.request_cost_usd,
            organic_summary=organic,
            paa=paa,
            related_searches=related,
            serp_features=list(evidence["features"]),
            featured_snippet=evidence["featured_snippet"],
            provisional_title=preview.title,
            provisional_direction=preview.writing_direction,
        )
        return GroupResult(preparation.id, True)

    async def _run_serp_request(
        self,
        batch: ContentPlanBatch,
        preparation: ContentPlanPreparation,
        primary_keyword: str,
    ) -> SERPResult:
        if all(
            callable(getattr(self.serp_gateway, name, None))
            for name in (
                "submit_serp_task",
                "get_serp_task",
                "find_ready_serp_task",
            )
        ):
            return await self._run_standard_serp_request(batch, preparation, primary_keyword)
        request_key = self._serp_request_key(batch, preparation)
        request = await self.repository.prepare_external_request(
            batch_id=batch.id,
            preparation_id=preparation.id,
            plan_item_id=None,
            request_key=request_key,
            provider="dataforseo",
            endpoint="serp/google/organic/live/advanced",
            request_hash=self._hash(
                {
                    "keyword": primary_keyword,
                    "country": batch.country,
                    "language": batch.language,
                    "device": "desktop",
                }
            ),
            round_number=0,
        )
        if request.status == "completed":
            return self._serp_from_metadata(request.response_metadata_json)
        if request.status in {"uncertain", "charged_failed", "failed"}:
            raise D4GroupError(
                request.error_code or "serp_request_outcome_unknown",
                request.error_detail or f"SERP 请求 {request_key} 不能自动重试",
                replace_primary=True,
            )
        if (
            request.status == "retryable_failed"
            and request.attempt_count >= self.external_request_max_attempts
        ):
            raise D4GroupError(
                "serp_retry_exhausted",
                request.error_detail or f"SERP 请求 {request_key} 已达到重试上限",
                replace_primary=True,
            )
        claim_token = uuid4().hex
        claim = await self.repository.claim_external_request(
            request_key,
            claim_token=claim_token,
            lease_until=datetime.now(UTC) + timedelta(minutes=10),
            max_attempts=self.external_request_max_attempts,
        )
        if claim is None:
            stale = await self.repository.mark_stale_submitted_request_uncertain(request_key)
            if stale is not None:
                raise D4GroupError(
                    "serp_request_outcome_unknown",
                    stale.error_detail or f"SERP 请求 {request_key} 结果未知",
                )
            raise D4GroupError("serp_request_in_progress", f"SERP 请求 {request_key} 正在执行")
        try:
            result = await self.serp_gateway.search(
                primary_keyword,
                country=batch.country,
                language=batch.language,
                device="desktop",
            )
            self._validate_serp_result(result)
        except DataForSEOEmptyResult as exc:
            result = exc.result
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status="charged_failed",
                error_code="serp_empty_result",
                error_detail=str(exc),
                cost_usd=result.request_cost_usd,
                provider_request_ids=(
                    [result.provider_request_id] if result.provider_request_id else []
                ),
                response_metadata=self._serp_metadata(result),
            )
            raise D4GroupError(
                "serp_empty_result",
                str(exc),
                serp_result=result,
                replace_primary=True,
            ) from exc
        except DataForSEOOutcomeUnknown as exc:
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status="uncertain",
                error_code="serp_request_outcome_unknown",
                error_detail=str(exc),
            )
            raise D4GroupError(
                "serp_request_outcome_unknown",
                str(exc),
                replace_primary=True,
            ) from exc
        except DataForSEOError as exc:
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status="retryable_failed",
                error_code="serp_retryable_failed",
                error_detail=str(exc),
            )
            raise D4GroupError("serp_request_failed", str(exc)) from exc
        except Exception as exc:
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status="uncertain",
                error_code="serp_request_outcome_unknown",
                error_detail=str(exc),
            )
            raise D4GroupError("serp_request_outcome_unknown", str(exc)) from exc
        completed = await self.repository.complete_external_request(
            request_key,
            claim_token=claim_token,
            cost_usd=result.request_cost_usd,
            result_count=(
                len(result.organic_results)
                + len(result.people_also_ask)
                + len(result.related_searches)
            ),
            provider_request_ids=(
                [result.provider_request_id] if result.provider_request_id else []
            ),
            response_metadata=self._serp_metadata(result),
        )
        if completed is None:
            raise D4GroupError(
                "serp_request_claim_lost", f"SERP 请求 {request_key} 保存前失去领取权"
            )
        return result

    async def _run_standard_serp_request(
        self,
        batch: ContentPlanBatch,
        preparation: ContentPlanPreparation,
        primary_keyword: str,
    ) -> SERPResult:
        request_key = self._serp_request_key(batch, preparation)
        request = await self.repository.prepare_external_request(
            batch_id=batch.id,
            preparation_id=preparation.id,
            plan_item_id=None,
            request_key=request_key,
            provider="dataforseo",
            endpoint="serp/google/organic/task_post",
            request_hash=self._hash(
                {
                    "keyword": primary_keyword,
                    "country": batch.country,
                    "language": batch.language,
                    "device": "desktop",
                }
            ),
            round_number=0,
        )
        if request.status == "completed":
            return self._serp_from_metadata(request.response_metadata_json)
        if request.status in {"charged_failed", "failed"}:
            raise D4GroupError(
                request.error_code or "serp_request_outcome_unknown",
                request.error_detail or "SERP request cannot be retried",
                replace_primary=True,
            )
        if request.status == "uncertain" and not request.endpoint.endswith("task_post"):
            raise D4GroupError(
                request.error_code or "serp_request_outcome_unknown",
                request.error_detail or "SERP request cannot be reconciled",
                replace_primary=True,
            )

        claim_token = uuid4().hex
        if request.status == "submitted":
            claim = await self.repository.take_over_submitted_external_request(
                request_key,
                claim_token=claim_token,
                lease_until=datetime.now(UTC) + timedelta(seconds=45),
            )
        elif request.status in {"uncertain", "retryable_failed"}:
            claim = await self.repository.claim_external_request_reconciliation(
                request_key,
                claim_token=claim_token,
                lease_until=datetime.now(UTC) + timedelta(seconds=45),
            )
        else:
            claim = await self.repository.claim_external_request(
                request_key,
                claim_token=claim_token,
                lease_until=datetime.now(UTC) + timedelta(seconds=45),
                max_attempts=self.external_request_max_attempts,
            )
        if claim is None:
            raise D4GroupError("serp_request_in_progress", "SERP task is still being processed")

        task_id = str(request.provider_request_ids[0]) if request.provider_request_ids else None
        submission_cost = float(request.cost_usd)
        if task_id is None and request.status == "submitted":
            if request.endpoint.endswith("task_post"):
                task_id = await self._find_standard_serp_task(request_key)
            if task_id is None:
                detail = (
                    "Legacy Live SERP request has no recoverable task id"
                    if request.endpoint.endswith("live/advanced")
                    else "Standard SERP task id could not be reconciled by tag"
                )
                await self.repository.fail_external_request(
                    request_key,
                    claim_token=claim_token,
                    status="uncertain",
                    error_code="serp_request_outcome_unknown",
                    error_detail=detail,
                )
                raise D4GroupError(
                    (
                        "serp_request_outcome_unknown"
                        if request.endpoint.endswith("live/advanced")
                        else "serp_request_failed"
                    ),
                    detail,
                    replace_primary=request.endpoint.endswith("live/advanced"),
                )
            recorded = await self.repository.record_external_request_submission(
                request_key,
                claim_token=claim_token,
                provider_request_ids=[task_id],
                cost_usd=submission_cost,
                response_metadata={"tag": request_key, "phase": "task_recovered"},
            )
            if recorded is None:
                raise D4GroupError(
                    "serp_request_claim_lost", "Recovered SERP task could not be saved"
                )

        try:
            if task_id is None:
                if request.status in {"uncertain", "retryable_failed"}:
                    task_id = await self._find_standard_serp_task(request_key)
                    if task_id is None:
                        raise DataForSEOOutcomeUnknown("dataforseo_task_reconciliation_pending")
                    submission_metadata = {
                        "tag": request_key,
                        "phase": "task_recovered",
                    }
                else:
                    try:
                        receipt = await self.serp_gateway.submit_serp_task(
                            primary_keyword,
                            country=batch.country,
                            language=batch.language,
                            device="desktop",
                            tag=request_key,
                        )
                    except DataForSEOOutcomeUnknown as exc:
                        task_id = exc.task_id
                        submission_cost = max(submission_cost, exc.cost_usd)
                        if task_id is None:
                            task_id = await self._find_standard_serp_task(request_key)
                        if task_id is None:
                            raise
                        submission_metadata = {
                            "tag": request_key,
                            "phase": "task_recovered",
                        }
                    except DataForSEOError as exc:
                        if not exc.task_id:
                            raise
                        task_id = exc.task_id
                        submission_cost = max(submission_cost, exc.cost_usd)
                        submission_metadata = {
                            "tag": request_key,
                            "phase": "task_recovered",
                            "provider_status_code": exc.status_code,
                            "provider_status_message": exc.status_message,
                        }
                    else:
                        task_id = receipt.task_id
                        submission_cost = receipt.cost_usd
                        submission_metadata = {
                            "tag": request_key,
                            "phase": "task_submitted",
                            "provider_status_code": receipt.status_code,
                            "provider_status_message": receipt.status_message,
                        }
                recorded = await self.repository.record_external_request_submission(
                    request_key,
                    claim_token=claim_token,
                    provider_request_ids=[task_id],
                    cost_usd=submission_cost,
                    response_metadata=submission_metadata,
                )
                if recorded is None:
                    raise D4GroupError(
                        "serp_request_claim_lost",
                        "Submitted SERP task id could not be saved",
                    )
            result = await self._collect_standard_serp_task(task_id, primary_keyword)
            self._validate_serp_result(result)
        except DataForSEOEmptyResult as exc:
            result = exc.result
            cost = max(submission_cost, result.request_cost_usd)
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status="charged_failed" if cost > 0 else "failed",
                error_code="serp_empty_result",
                error_detail=str(exc),
                cost_usd=cost,
                provider_request_ids=[task_id] if task_id else [],
                response_metadata=self._serp_metadata(result),
            )
            raise D4GroupError(
                "serp_empty_result",
                str(exc),
                serp_result=result,
                replace_primary=True,
            ) from exc
        except DataForSEOOutcomeUnknown as exc:
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status=("retryable_failed" if task_id else "uncertain"),
                error_code=(
                    "serp_result_retrieval_failed" if task_id else "serp_request_outcome_unknown"
                ),
                error_detail=str(exc),
                cost_usd=submission_cost,
                provider_request_ids=[task_id] if task_id else [],
                response_metadata={"tag": request_key, "phase": "task_submitted"},
            )
            raise D4GroupError(
                "serp_request_failed",
                str(exc),
            ) from exc
        except DataForSEOTaskPending as exc:
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status="retryable_failed",
                error_code="serp_result_pending",
                error_detail=str(exc),
                cost_usd=submission_cost,
                provider_request_ids=[task_id] if task_id else [],
                response_metadata={"tag": request_key, "phase": "task_submitted"},
            )
            raise D4GroupError("serp_request_failed", str(exc)) from exc
        except DataForSEOError as exc:
            cost = max(submission_cost, exc.cost_usd)
            status = (
                "charged_failed"
                if cost > 0
                else ("retryable_failed" if exc.retryable else "failed")
            )
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status=status,
                error_code=(
                    "serp_retryable_failed"
                    if status == "retryable_failed"
                    else "serp_provider_failed"
                ),
                error_detail=exc.status_message or str(exc),
                cost_usd=cost,
                provider_request_ids=[task_id] if task_id else [],
                response_metadata={
                    "tag": request_key,
                    "provider_status_code": exc.status_code,
                    "provider_status_message": exc.status_message,
                },
            )
            raise D4GroupError(
                "serp_request_failed",
                exc.status_message or str(exc),
                replace_primary=status in {"charged_failed", "failed"},
            ) from exc

        effective_cost = max(submission_cost, result.request_cost_usd)
        if effective_cost != result.request_cost_usd:
            result = SERPResult(
                keyword=result.keyword,
                organic_results=result.organic_results,
                features=result.features,
                people_also_ask=result.people_also_ask,
                related_searches=result.related_searches,
                featured_snippet=result.featured_snippet,
                cached=result.cached,
                request_cost_usd=effective_cost,
                provider_request_id=result.provider_request_id or task_id,
                raw_response=result.raw_response,
            )
        completed = await self.repository.complete_external_request(
            request_key,
            claim_token=claim_token,
            cost_usd=result.request_cost_usd,
            result_count=(
                len(result.organic_results)
                + len(result.people_also_ask)
                + len(result.related_searches)
            ),
            provider_request_ids=[task_id],
            response_metadata={
                **self._serp_metadata(result),
                "tag": request_key,
                "phase": "task_completed",
            },
        )
        if completed is None:
            raise D4GroupError("serp_request_claim_lost", "SERP task result could not be saved")
        return result

    async def _find_standard_serp_task(self, request_key: str) -> str | None:
        for attempt in range(5):
            try:
                task_id = await self.serp_gateway.find_ready_serp_task(request_key)
            except DataForSEOError:
                task_id = None
            if task_id:
                return task_id
            if attempt < 4:
                await asyncio.sleep(3)
        return None

    async def _collect_standard_serp_task(self, task_id: str, primary_keyword: str) -> SERPResult:
        transport_failures = 0
        for _attempt in range(200):
            try:
                return await self.serp_gateway.get_serp_task(task_id, primary_keyword)
            except DataForSEOTaskPending:
                await asyncio.sleep(3)
            except DataForSEOOutcomeUnknown:
                transport_failures += 1
                if transport_failures >= 5:
                    raise
                await asyncio.sleep(3)
        raise DataForSEOTaskPending("dataforseo_task_pending", task_id=task_id, retryable=True)

    async def _preview_with_repair(
        self,
        batch: ContentPlanBatch,
        preparation: ContentPlanPreparation,
        primary_keyword: str,
        secondary_keywords: Sequence[str],
        evidence: dict[str, Any],
        allowed_evidence_ids: set[str],
    ) -> PreviewOutput:
        validation_error: str | None = None
        request_input = {
            "primary_keyword": primary_keyword,
            "secondary_keywords": list(secondary_keywords),
            "country": batch.country,
            "language": batch.language,
            "evidence": evidence,
        }
        for attempt in range(1, 3):
            outputs = await self._run_preview_request(
                batch,
                preparation,
                primary_keyword,
                secondary_keywords,
                evidence,
                request_input,
                attempt,
                validation_error,
            )
            try:
                if len(outputs) != 1 or not isinstance(outputs[0], dict):
                    raise ValueError("preview response must contain exactly one object")
                return validate_preview_output(outputs[0], allowed_evidence_ids)
            except (TypeError, ValueError) as exc:
                validation_error = str(exc)
        raise D4GroupError(
            "preview_contract_invalid",
            validation_error or "预览输出合同不合法",
        )

    async def _run_preview_request(
        self,
        batch: ContentPlanBatch,
        preparation: ContentPlanPreparation,
        primary_keyword: str,
        secondary_keywords: Sequence[str],
        evidence: dict[str, Any],
        request_input: dict[str, Any],
        attempt: int,
        validation_error: str | None,
    ) -> list[Any]:
        request_key = (
            f"ai:preview:{self.preview_version}:{batch.id}:{preparation.id}:"
            f"{preparation.preparation_version}:{attempt}"
        )
        if preparation.package_version > 1:
            request_key = f"{request_key}:package:{preparation.package_version}"
        request = await self.repository.prepare_external_request(
            batch_id=batch.id,
            preparation_id=preparation.id,
            plan_item_id=None,
            request_key=request_key,
            provider="ai",
            endpoint="content_plan/serp_preview",
            request_hash=self._hash(
                {
                    "endpoint": "content_plan/serp_preview",
                    "prompt_version": self.preview_version,
                    "input": request_input,
                    "structural_attempt": attempt,
                    "validation_error": validation_error,
                }
            ),
            round_number=0,
        )
        if request.status == "completed":
            stored_output = request.response_metadata_json.get("output")
            if isinstance(stored_output, dict):
                return [stored_output]
            if not isinstance(stored_output, list):
                raise D4GroupError(
                    "preview_audit_record_invalid",
                    f"预览请求 {request_key} 缺少可恢复输出",
                )
            return stored_output
        if request.status in {"uncertain", "charged_failed", "failed"}:
            raise D4GroupError(
                request.error_code or "preview_request_outcome_unknown",
                request.error_detail or f"预览请求 {request_key} 不能自动重试",
            )
        while True:
            claim_token = uuid4().hex
            claim = await self.repository.claim_external_request(
                request_key,
                claim_token=claim_token,
                lease_until=datetime.now(UTC) + timedelta(minutes=10),
                max_attempts=AI_REQUEST_MAX_ATTEMPTS,
            )
            if claim is None:
                stale = await self.repository.mark_stale_submitted_request_uncertain(request_key)
                if stale is not None:
                    raise D4GroupError(
                        "preview_request_outcome_unknown",
                        stale.error_detail or f"预览请求 {request_key} 结果未知",
                    )
                raise D4GroupError(
                    "preview_request_in_progress", f"预览请求 {request_key} 正在执行"
                )
            try:
                response = await self.preview_gateway.preview(
                    primary_keyword,
                    secondary_keywords,
                    evidence=evidence,
                    country=batch.country,
                    language=batch.language,
                    validation_error=validation_error,
                )
                self._validate_ai_response(response)
                output = list(response.output)
                break
            except ProviderError as exc:
                failure_status = classify_ai_provider_error(exc)
                error_code = (
                    "preview_request_outcome_unknown" if failure_status == "uncertain" else exc.code
                )
                await self.repository.fail_external_request(
                    request_key,
                    claim_token=claim_token,
                    status=failure_status,
                    error_code=error_code,
                    error_detail=str(exc),
                )
                if (
                    failure_status == "retryable_failed"
                    and claim.attempt_count < AI_REQUEST_MAX_ATTEMPTS
                ):
                    await asyncio.sleep(ai_retry_delay(exc, claim.attempt_count))
                    continue
                if failure_status == "retryable_failed":
                    error_code = "preview_request_retry_exhausted"
                raise D4GroupError(error_code, str(exc)) from exc
            except Exception as exc:
                await self.repository.fail_external_request(
                    request_key,
                    claim_token=claim_token,
                    status="uncertain",
                    error_code="preview_request_outcome_unknown",
                    error_detail=str(exc),
                )
                raise D4GroupError("preview_request_outcome_unknown", str(exc)) from exc
        completed = await self.repository.complete_external_request(
            request_key,
            claim_token=claim_token,
            cost_usd=response.cost_usd,
            result_count=1,
            provider_request_ids=[response.request_id],
            response_metadata={
                "provider": response.provider,
                "model": response.model,
                "prompt_version": self.preview_version,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "cache_hit": response.cache_hit,
                "structural_attempt": attempt,
                "validation_error": validation_error,
                "output": output,
            },
        )
        if completed is None:
            raise D4GroupError(
                "preview_request_claim_lost",
                f"预览请求 {request_key} 保存前失去领取权",
            )
        return output

    async def _save_failed_snapshot(
        self,
        batch: ContentPlanBatch,
        preparation: ContentPlanPreparation,
        primary_keyword: str,
        *,
        request_key: str,
        error_code: str,
        error_detail: str,
        serp: SERPResult | None = None,
        evidence: dict[str, Any] | None = None,
    ) -> None:
        evidence = evidence or {
            "organic": [],
            "paa": [],
            "related_searches": [],
            "features": [],
            "featured_snippet": None,
        }
        await self.repository.add_serp_snapshot(
            snapshot_id=f"serp-snapshot-{uuid4().hex}",
            preparation_id=preparation.id,
            primary_keyword=primary_keyword,
            country=batch.country,
            language=batch.language,
            provider="dataforseo",
            provider_request_id=serp.provider_request_id if serp else None,
            request_key=request_key,
            cache_hit=serp.cached if serp else False,
            cost_usd=serp.request_cost_usd if serp else 0,
            organic_summary=list(evidence["organic"]),
            paa=list(evidence["paa"]),
            related_searches=list(evidence["related_searches"]),
            serp_features=list(evidence["features"]),
            featured_snippet=evidence["featured_snippet"],
            provisional_title=None,
            provisional_direction=None,
            error_code=error_code,
            error_detail=error_detail,
        )

    async def _require_batch(self, batch_id: str) -> ContentPlanBatch:
        batch = await self.repository.get_batch(batch_id)
        if batch is None:
            raise ValueError("content plan batch does not exist")
        return batch

    @staticmethod
    def _validate_preparation_set(
        preparations: Sequence[ContentPlanPreparation],
    ) -> None:
        if len(preparations) != 30:
            raise ValueError("automatic batch must have exactly 30 current preparations")
        if [row.plan_order for row in preparations] != list(range(1, 31)):
            raise ValueError("automatic preparation plan_order must be contiguous from 1 to 30")
        allowed = {
            "pack_ready",
            "serp_preview",
            "preview_ready",
            "preview_failed",
            "invalid",
        }
        if any(row.state not in allowed for row in preparations):
            raise ValueError("all preparations must have completed D3 keyword packages")

    @staticmethod
    def _build_evidence(result: SERPResult) -> dict[str, Any]:
        return {
            "organic": [
                {
                    "evidence_id": f"organic-{index}",
                    "position": row.position,
                    "url": row.url,
                    "domain": row.domain,
                    "title": row.title,
                    "description": row.description,
                }
                for index, row in enumerate(result.organic_results[:10], start=1)
            ],
            "paa": [
                {"evidence_id": f"paa-{index}", "question": question}
                for index, question in enumerate(result.people_also_ask[:10], start=1)
            ],
            "related_searches": [
                {"evidence_id": f"related-{index}", "query": query}
                for index, query in enumerate(result.related_searches[:10], start=1)
            ],
            "features": list(result.features),
            "featured_snippet": result.featured_snippet,
        }

    @staticmethod
    def _mark_used(values: Sequence[dict[str, Any]], used: set[str]) -> list[dict[str, Any]]:
        return [{**value, "used_by_preview": value["evidence_id"] in used} for value in values]

    @staticmethod
    def _validate_serp_result(result: SERPResult) -> None:
        if result.request_cost_usd < 0:
            raise ValueError("SERP cost must be non-negative")
        if result.cached and result.request_cost_usd != 0:
            raise ValueError("cached SERP response must have zero cost")

    @staticmethod
    def _validate_ai_response(response: AICallResult) -> None:
        if not response.provider.strip() or not response.model.strip():
            raise ValueError("AI response provider and model are required")
        if not response.request_id.strip():
            raise ValueError("AI response request_id is required")
        if response.input_tokens < 0 or response.output_tokens < 0:
            raise ValueError("AI response token counts must be non-negative")
        if response.cost_usd < 0:
            raise ValueError("AI response cost must be non-negative")
        if response.cache_hit and response.cost_usd != 0:
            raise ValueError("cached AI response must have zero cost")

    @staticmethod
    def _serp_metadata(result: SERPResult) -> dict[str, Any]:
        return {
            "keyword": result.keyword,
            "organic_results": [asdict(row) for row in result.organic_results],
            "features": list(result.features),
            "people_also_ask": list(result.people_also_ask),
            "related_searches": list(result.related_searches),
            "featured_snippet": result.featured_snippet,
            "cached": result.cached,
            "request_cost_usd": result.request_cost_usd,
            "provider_request_id": result.provider_request_id,
            "raw_response": result.raw_response,
        }

    @staticmethod
    def _serp_from_metadata(value: dict[str, Any]) -> SERPResult:
        try:
            return SERPResult(
                keyword=str(value["keyword"]),
                organic_results=[OrganicResult(**row) for row in value.get("organic_results", [])],
                features=list(value.get("features", [])),
                people_also_ask=list(value.get("people_also_ask", [])),
                related_searches=list(value.get("related_searches", [])),
                featured_snippet=value.get("featured_snippet"),
                cached=bool(value.get("cached", False)),
                request_cost_usd=float(value.get("request_cost_usd", 0)),
                provider_request_id=value.get("provider_request_id"),
                raw_response=value.get("raw_response"),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise D4GroupError("serp_audit_record_invalid", "SERP 请求账本缺少可恢复结果") from exc

    @staticmethod
    def _hash(value: dict[str, Any]) -> str:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(payload.encode()).hexdigest()

    @staticmethod
    def _serp_request_key(batch: ContentPlanBatch, preparation: ContentPlanPreparation) -> str:
        request_key = f"serp:{batch.id}:{preparation.id}:{preparation.preparation_version}"
        if preparation.package_version > 1:
            return f"{request_key}:package:{preparation.package_version}"
        return request_key


def validate_preview_output(value: dict[str, Any], allowed_evidence_ids: set[str]) -> PreviewOutput:
    if set(value) != {"title", "writing_direction", "evidence_ids"}:
        raise ValueError("preview output contains missing or unsupported fields")
    title = value["title"]
    direction = value["writing_direction"]
    evidence_ids = value["evidence_ids"]
    if not isinstance(title, str) or title != title.strip() or not 1 <= len(title) <= 120:
        raise ValueError("title must be 1 to 120 characters of plain text")
    if "\n" in title or "\r" in title:
        raise ValueError("title must be a single line")
    if (
        not isinstance(direction, str)
        or direction != direction.strip()
        or not 1 <= len(direction) <= 600
    ):
        raise ValueError("writing_direction must be 1 to 600 characters of plain text")
    if re.search(r"(?im)^\s*(?:#{1,6}\s+|h[2-6]\s*:|\d+[.)]\s+|[-*]\s+)", direction):
        raise ValueError("writing_direction must not contain an outline")
    sentence_count = len([part for part in re.split(r"[.!?。！？]+", direction) if part.strip()])
    if not 1 <= sentence_count <= 3:
        raise ValueError("writing_direction must contain 1 to 3 sentences")
    if (
        not isinstance(evidence_ids, list)
        or not evidence_ids
        or not all(isinstance(item, str) and item for item in evidence_ids)
        or len(evidence_ids) != len(set(evidence_ids))
        or not set(evidence_ids) <= allowed_evidence_ids
    ):
        raise ValueError("evidence_ids must reference this SERP group")
    return PreviewOutput(title, direction, tuple(evidence_ids))


__all__ = [
    "ContentPlanD4Service",
    "D4BatchResult",
    "PlanItemConflictError",
    "PreviewOutput",
    "validate_preview_output",
]
