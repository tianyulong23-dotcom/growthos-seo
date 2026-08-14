from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from collections.abc import Awaitable, Callable
from typing import Any, Protocol, Sequence
from uuid import uuid4

from app.modules.agent.providers import ProviderError
from app.modules.content_plan.ai_retry import (
    AI_REQUEST_MAX_ATTEMPTS,
    ai_retry_delay,
    classify_ai_provider_error,
)
from app.modules.content_plan.domain import (
    CandidateClassification,
    ClassificationDecision,
    SeedCandidate,
    build_keyword_package,
    deduplicate_keyword_candidates,
    normalize_keyword,
    resolve_seed_decisions,
    validate_classification_decisions,
)
from app.modules.content_plan.models import (
    ContentPlanBatch,
    ContentPlanCandidate,
    ContentPlanPreparation,
    ContentPlanPreparationKeyword,
)
from app.modules.content_plan.repository import ContentPlanRepository
from app.modules.keywords.schemas import (
    KeywordCoverageBatchRequest,
    KeywordCoverageBatchResponse,
    KeywordCoverageInput,
)


@dataclass(frozen=True)
class ExpansionSeed:
    preparation_id: str
    request_index: int
    keyword: str
    tag: str


@dataclass(frozen=True)
class ExpansionRow:
    keyword: str
    provider_position: int | None = None
    search_volume: int | None = None
    keyword_difficulty: int | None = None
    provider_intent: str | None = None
    raw_item: dict[str, Any] | None = None


@dataclass(frozen=True)
class ExpansionResult:
    preparation_id: str
    status: str
    rows: tuple[ExpansionRow, ...] = ()
    provider_request_id: str | None = None
    cost_usd: float = 0
    error_code: str | None = None
    error_detail: str | None = None


@dataclass(frozen=True)
class AICallResult:
    output: Sequence[Any]
    provider: str
    model: str
    request_id: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    cache_hit: bool = False


@dataclass(frozen=True)
class BusinessContext:
    business_name: str
    business_type: str
    business_summary: str
    target_audiences: tuple[str, ...]
    products_services: tuple[str, ...]

    def to_payload(self) -> dict[str, Any]:
        return {
            "business_name": self.business_name,
            "business_type": self.business_type,
            "business_summary": self.business_summary,
            "target_audiences": list(self.target_audiences),
            "products_services": list(self.products_services),
        }


@dataclass(frozen=True)
class TopicClassificationInput:
    topic_id: str
    seed_keyword: str
    candidates: tuple[CandidateClassification, ...]


class SeedDecisionGateway(Protocol):
    async def decide(
        self,
        candidates: Sequence[SeedCandidate],
        retained: Sequence[SeedCandidate],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult: ...


class ClassificationGateway(Protocol):
    async def classify(
        self,
        seed_keyword: str,
        candidates: Sequence[CandidateClassification],
        *,
        business_context: BusinessContext,
        country: str,
        language: str,
        validation_error: str | None = None,
    ) -> AICallResult: ...


class ExpansionGateway(Protocol):
    async def expand(
        self,
        seeds: Sequence[ExpansionSeed],
        *,
        country: str,
        language: str,
    ) -> list[ExpansionResult]: ...


class FallbackGateway(Protocol):
    async def generate(
        self,
        seed_keyword: str,
        *,
        business_context: BusinessContext,
        language: str,
        limit: int,
        validation_error: str | None = None,
    ) -> AICallResult: ...


class CoverageQuery(Protocol):
    async def query(
        self, request: KeywordCoverageBatchRequest
    ) -> KeywordCoverageBatchResponse: ...


@dataclass(frozen=True)
class D3BatchResult:
    batch_id: str
    status: str
    pack_ready_count: int
    error_code: str | None = None
    missing_count: int = 0


class D3ProcessingError(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class ContentPlanD3Service:
    def __init__(
        self,
        repository: ContentPlanRepository,
        *,
        seed_gateway: SeedDecisionGateway,
        expansion_gateway: ExpansionGateway,
        classification_gateway: ClassificationGateway,
        coverage_query: CoverageQuery,
        fallback_gateway: FallbackGateway | None = None,
        seed_decision_version: str = "content-plan-seed-v3",
        classifier_version: str = "content-plan-classifier-v3",
        fallback_version: str = "content-plan-fallback-v2",
        external_request_max_attempts: int = 3,
    ) -> None:
        self.repository = repository
        self.seed_gateway = seed_gateway
        self.expansion_gateway = expansion_gateway
        self.classification_gateway = classification_gateway
        self.coverage_query = coverage_query
        self.fallback_gateway = fallback_gateway
        self.seed_decision_version = seed_decision_version
        self.classifier_version = classifier_version
        self.fallback_version = fallback_version
        self.external_request_max_attempts = external_request_max_attempts

    @staticmethod
    def _require_business_context(batch: ContentPlanBatch) -> BusinessContext:
        value = batch.config_snapshot_json.get("business_context")
        if not isinstance(value, dict):
            raise D3ProcessingError(
                "business_context_missing",
                "批次缺少创建时冻结的项目业务资料",
            )

        def required_text(field: str) -> str:
            item = value.get(field)
            if not isinstance(item, str) or not item.strip():
                raise D3ProcessingError(
                    "business_context_missing",
                    f"批次业务资料缺少 {field}",
                )
            return item.strip()

        def text_items(field: str) -> tuple[str, ...]:
            items = value.get(field)
            if not isinstance(items, list) or not all(
                isinstance(item, str) and item.strip() for item in items
            ):
                raise D3ProcessingError(
                    "business_context_missing",
                    f"批次业务资料中的 {field} 不合法",
                )
            return tuple(item.strip() for item in items)

        summary = value.get("business_summary")
        if not isinstance(summary, str):
            raise D3ProcessingError(
                "business_context_missing",
                "批次业务资料中的 business_summary 不合法",
            )

        return BusinessContext(
            business_name=required_text("business_name"),
            business_type=required_text("business_type"),
            business_summary=summary.strip(),
            target_audiences=text_items("target_audiences"),
            products_services=text_items("products_services"),
        )

    async def run(self, batch_id: str) -> D3BatchResult:
        batch = await self._require_batch(batch_id)
        if batch.source != "automatic":
            raise ValueError("D3 automatic orchestration requires an automatic batch")
        try:
            business_context = self._require_business_context(batch)
            await self._ensure_snapshot(batch)
            if not await self.repository.get_selected_candidates(batch.id):
                selected = await self._select_seeds(
                    batch,
                    business_context,
                    required=batch.target_count,
                )
                if len(selected) < batch.target_count:
                    return await self._needs_attention(
                        batch,
                        "candidate_pool_exhausted",
                        f"候选池耗尽，还缺 {batch.target_count - len(selected)} 个种子词",
                        missing_count=batch.target_count - len(selected),
                    )
                await self.repository.assign_initial_seed_orders(
                    batch.id, batch.target_count
                )
            await self._ensure_initial_preparations(batch)
            current = await self.repository.get_current_preparations(batch.id)
            if len(current) != batch.target_count:
                raise D3ProcessingError(
                    "preparation_count_mismatch",
                    f"当前准备记录为 {len(current)}/{batch.target_count}",
                )
            await self._expand_current(batch)
            await self._build_current_packages(batch, business_context)
            technical = await self._technical_current_preparations(batch.id)
            if technical:
                return await self._technical_failure_result(batch, technical)

            batch = await self._sync_completed_supplement_round(batch)
            invalid = await self._invalid_current_preparations(batch.id)
            while invalid and batch.supplement_round < 2:
                replacements = await self._select_replacement_seeds(
                    batch,
                    business_context,
                    invalid,
                )
                if not replacements:
                    break
                round_number = batch.supplement_round + 1
                await self._replace_invalid_preparations(
                    batch, invalid, replacements, round_number
                )
                await self.repository.update_batch_progress(
                    batch.id,
                    status="supplementing",
                    stage=f"refill_{round_number}",
                )
                await self._expand_current(batch)
                await self._build_current_packages(batch, business_context)
                technical = await self._technical_current_preparations(batch.id)
                if technical:
                    return await self._technical_failure_result(batch, technical)
                await self.repository.update_batch_progress(
                    batch.id,
                    status="supplementing",
                    stage=f"refill_{round_number}_completed",
                    supplement_round=round_number,
                )
                batch = await self._require_batch(batch.id)
                invalid = await self._invalid_current_preparations(batch.id)

            if invalid:
                fallback_eligible = [
                    row for row in invalid if row.preparation_version <= 3
                ]
                if fallback_eligible:
                    await self._run_fallback(
                        batch,
                        fallback_eligible,
                        business_context,
                    )

            invalid = await self._invalid_current_preparations(batch.id)
            final_refill_count = 0
            final_refill_pool_exhausted = False
            while invalid and final_refill_count < batch.target_count:
                remaining_attempts = batch.target_count - final_refill_count
                replacements = await self._select_replacement_seeds(
                    batch,
                    business_context,
                    invalid[:remaining_attempts],
                )
                if not replacements:
                    final_refill_pool_exhausted = True
                    break
                await self._replace_invalid_preparations(
                    batch,
                    invalid,
                    replacements,
                    2,
                )
                final_refill_count += len(replacements)
                await self._expand_current(batch)
                await self._build_current_packages(batch, business_context)
                technical = await self._technical_current_preparations(batch.id)
                if technical:
                    return await self._technical_failure_result(batch, technical)
                invalid = await self._invalid_current_preparations(batch.id)

            preparations = await self.repository.get_current_preparations(batch.id)
            pack_count = sum(row.state == "pack_ready" for row in preparations)
            technical = [row for row in preparations if row.state.endswith("_failed")]
            if technical:
                return await self._technical_failure_result(batch, technical)
            if pack_count != batch.target_count:
                error_code = (
                    "candidate_pool_exhausted"
                    if final_refill_pool_exhausted
                    else "final_refill_limit_exhausted"
                )
                return await self._needs_attention(
                    batch,
                    error_code,
                    f"关键词包只完成 {pack_count}/{batch.target_count}",
                )
            await self.repository.finalize_current_preparation_orders(batch.id)
            await self.repository.update_batch_progress(
                batch.id,
                status="building_packs",
                stage="d3_pack_ready",
            )
            return D3BatchResult(batch.id, "pack_ready", pack_count)
        except D3ProcessingError as exc:
            return await self._needs_attention(batch, exc.code, exc.detail)

    async def process_preparation(
        self,
        preparation_id: str,
        *,
        fixed_primary: bool = False,
        max_secondaries: int = 5,
    ) -> ContentPlanPreparation:
        """Run D3 for one manual or edit preparation without replacing its seed."""
        bundle = await self.repository.get_preparation_bundle(preparation_id)
        if bundle is None:
            raise D3ProcessingError(
                "content_plan_preparation_not_found", "内容计划准备记录不存在"
            )
        preparation = bundle.preparation
        batch = await self._require_batch(preparation.batch_id)
        business_context = self._require_business_context(batch)
        if preparation.state in {"cancelled", "superseded"}:
            raise D3ProcessingError("preparation_superseded", "准备版本已失效")
        if fixed_primary:
            await self._build_fixed_primary_package(
                batch,
                business_context,
                preparation,
                max_secondaries=max_secondaries,
            )
        else:
            await self._expand_preparations(batch, [preparation])
            refreshed = await self.repository.get_preparation_bundle(preparation_id)
            if refreshed is None:
                raise D3ProcessingError(
                    "content_plan_preparation_not_found", "内容计划准备记录不存在"
                )
            if refreshed.preparation.state != "expanded":
                raise D3ProcessingError(
                    refreshed.preparation.error_code or "expansion_failed",
                    refreshed.preparation.error_detail or "Related Keywords 拓展失败",
                )
            await self._build_packages(
                batch,
                business_context,
                [refreshed.preparation],
                exclude_item_id=preparation.plan_item_id,
            )
        result = await self.repository.get_preparation_bundle(preparation_id)
        if result is None:
            raise D3ProcessingError(
                "content_plan_preparation_not_found", "内容计划准备记录不存在"
            )
        if result.preparation.state != "pack_ready":
            raise D3ProcessingError(
                result.preparation.error_code or "no_valid_informational_topic",
                result.preparation.error_detail or "没有找到有效的信息型文章选题",
            )
        return result.preparation

    async def replenish_serp_exhausted_packages(self, batch_id: str) -> D3BatchResult:
        batch = await self._require_batch(batch_id)
        if batch.source != "automatic":
            raise ValueError("SERP package replenishment requires an automatic batch")
        business_context = self._require_business_context(batch)
        replacement_count = 0
        target_plan_orders: set[int] | None = None

        while replacement_count < batch.target_count:
            preparations = await self.repository.get_current_preparations(batch.id)
            if target_plan_orders is None:
                target_plan_orders = {
                    row.plan_order
                    for row in preparations
                    if row.state == "invalid"
                    and row.error_code == "serp_primary_candidates_exhausted"
                }
            exhausted = [
                row
                for row in preparations
                if row.plan_order in target_plan_orders and row.state == "invalid"
            ]
            if not exhausted:
                ready_count = sum(
                    row.state in {"pack_ready", "preview_ready"}
                    for row in preparations
                )
                if ready_count == batch.target_count:
                    await self.repository.update_batch_progress(
                        batch.id,
                        status="building_previews",
                        stage="d4_serp_refill_ready",
                    )
                    return D3BatchResult(batch.id, "pack_ready", ready_count)
                return D3BatchResult(batch.id, "not_needed", ready_count)

            replacements = await self._select_replacement_seeds(
                batch,
                business_context,
                exhausted[: batch.target_count - replacement_count],
            )
            if not replacements:
                return await self._needs_attention(
                    batch,
                    "candidate_pool_exhausted",
                    "No eligible seed keyword remains after a SERP package was exhausted",
                    missing_count=len(exhausted),
                )
            await self._replace_invalid_preparations(
                batch,
                exhausted,
                replacements,
                2,
            )
            replacement_count += len(replacements)
            await self.repository.update_batch_progress(
                batch.id,
                status="supplementing",
                stage="d3_serp_refill",
            )
            await self._expand_current(batch)
            await self._build_current_packages(batch, business_context)
            technical = await self._technical_current_preparations(batch.id)
            if technical:
                return await self._technical_failure_result(batch, technical)

        return await self._needs_attention(
            batch,
            "final_refill_limit_exhausted",
            "SERP package replacement limit exhausted",
        )

    async def validate_secondary_keywords(
        self,
        preparation_id: str,
        *,
        item_version: int,
        primary_keyword: str,
        secondary_keywords: Sequence[str],
    ) -> dict[str, str]:
        bundle = await self.repository.get_preparation_bundle(preparation_id)
        if bundle is None:
            raise D3ProcessingError(
                "content_plan_preparation_not_found", "内容计划准备记录不存在"
            )
        batch = await self._require_batch(bundle.preparation.batch_id)
        business_context = self._require_business_context(batch)

        def stable_id(role: str, keyword: str) -> str:
            digest = hashlib.sha256(normalize_keyword(keyword).encode()).hexdigest()[:24]
            return f"d6-{role}-{digest}"

        candidates = [
            CandidateClassification(
                candidate_id=stable_id("primary", primary_keyword),
                keyword=primary_keyword,
                source="user",
                provider_position=0,
            ),
            *[
                CandidateClassification(
                    candidate_id=stable_id("secondary", keyword),
                    keyword=keyword,
                    source="user",
                    provider_position=index,
                )
                for index, keyword in enumerate(secondary_keywords, start=1)
            ],
        ]
        validation_error: str | None = None
        request_input = {
            "business_context": business_context.to_payload(),
            "country": batch.country,
            "language": batch.language,
            "seed_keyword": bundle.preparation.seed_keyword,
            "primary_keyword": primary_keyword,
            "secondary_keywords": list(secondary_keywords),
            "candidates": [
                {
                    "candidate_id": row.candidate_id,
                    "keyword": row.keyword,
                    "source": row.source,
                    "provider_position": row.provider_position,
                }
                for row in candidates
            ],
        }
        request_input_hash = self._hash(request_input)[:16]
        for attempt in range(1, 3):
            output = await self._run_ai_request(
                batch=batch,
                preparation_id=preparation_id,
                request_key=(
                    f"ai:secondary-validation:{self.classifier_version}:"
                    f"{preparation_id}:{item_version}:{request_input_hash}:{attempt}"
                ),
                endpoint="content_plan/secondary_validation",
                prompt_version=self.classifier_version,
                request_input=request_input,
                round_number=0,
                structural_attempt=attempt,
                validation_error=validation_error,
                invoke=lambda error=validation_error: self.classification_gateway.classify(
                    bundle.preparation.seed_keyword,
                    candidates,
                    business_context=business_context,
                    country=batch.country,
                    language=batch.language,
                    validation_error=error,
                ),
                encode_output=self._classification_output_json,
            )
            try:
                decisions = validate_classification_decisions(
                    candidates, [ClassificationDecision(**row) for row in output]
                )
                primary_id = candidates[0].candidate_id
                allowed = set(decisions[primary_id].secondary_candidate_ids)
                if any(
                    row.candidate_id not in allowed
                    or decisions[row.candidate_id].relevance != "same_topic"
                    for row in candidates[1:]
                ):
                    raise ValueError("secondary_keyword_not_same_article")
                return {
                    row.normalized_keyword: decisions[row.candidate_id].keyword_type
                    for row in candidates[1:]
                }
            except (TypeError, ValueError, AttributeError) as exc:
                validation_error = str(exc)
        raise D3ProcessingError(
            "secondary_keyword_invalid",
            validation_error or "次关键词不能与主关键词写在同一篇文章中",
        )

    async def _ensure_snapshot(self, batch: ContentPlanBatch) -> None:
        if batch.candidate_snapshot_status == "completed":
            return
        source_keywords = await self.repository.list_candidate_source_keywords(batch.id)
        coverage = await self._coverage_by_keyword(
            batch.project_id,
            [(row.id, row.keyword) for row in source_keywords],
        )
        await self.repository.create_candidate_snapshot(
            batch.id,
            coverage_by_keyword={
                normalize_keyword(row.keyword): coverage[row.id].status
                for row in source_keywords
            },
        )

    async def _select_seeds(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
        *,
        required: int,
    ) -> list[ContentPlanCandidate]:
        if required <= 0:
            return []
        retained = await self.repository.get_retained_candidates(batch.id)
        available = [row for row in retained if row.selected_plan_order is None]
        if available:
            coverage = await self._coverage_by_keyword(
                batch.project_id,
                [(row.id, row.keyword) for row in available],
            )
            occupied = await self.repository.occupied_normalized_keywords(
                batch.project_id
            )
            unavailable: dict[str, str] = {}
            for row in available:
                status = coverage[row.id].status
                if status == "unknown":
                    raise D3ProcessingError(
                        "coverage_check_failed",
                        f"候选词 {row.keyword} 的覆盖状态未知",
                    )
                if status == "covered" or row.normalized_keyword in occupied:
                    unavailable[row.id] = (
                        "covered" if status == "covered" else "plan_occupied"
                    )
            await self.repository.drop_unavailable_candidates(batch.id, unavailable)
            if unavailable:
                retained = await self.repository.get_retained_candidates(batch.id)
                available = [
                    row for row in retained if row.selected_plan_order is None
                ]
        cursor_batch = await self._require_batch(batch.id)
        cursor = cursor_batch.candidate_cursor_source_rank
        while len(available) < required:
            window = await self.repository.get_candidate_window(
                batch.id, after_source_rank=cursor, limit=50
            )
            if not window.candidates:
                break
            coverage = await self._coverage_by_keyword(
                batch.project_id,
                [(row.id, row.keyword) for row in window.candidates],
            )
            occupied = await self.repository.occupied_normalized_keywords(batch.project_id)
            usable = []
            deterministic: dict[str, dict[str, Any]] = {}
            for row in window.candidates:
                status = coverage[row.id].status
                if status == "unknown":
                    raise D3ProcessingError(
                        "coverage_check_failed",
                        f"候选词 {row.keyword} 的覆盖状态未知，当前窗口未推进",
                    )
                if status == "covered" or row.normalized_keyword in occupied:
                    deterministic[row.id] = {
                        "candidate_id": row.id,
                        "decision": "dropped",
                        "decision_reason": (
                            "covered" if status == "covered" else "plan_occupied"
                        ),
                        "representative_candidate_id": None,
                    }
                else:
                    usable.append(
                        SeedCandidate(row.id, row.keyword, row.source_rank)
                    )
            retained_domain = [
                SeedCandidate(row.id, row.keyword, row.source_rank) for row in retained
            ]
            if usable:
                resolved = await self._decide_seeds_with_repair(
                    batch,
                    business_context,
                    usable,
                    retained_domain,
                    window_number=cursor_batch.candidate_window_number + 1,
                )
                for decision in resolved:
                    deterministic[decision.candidate_id] = {
                        "candidate_id": decision.candidate_id,
                        "decision": "kept" if decision.action == "keep" else "dropped",
                        "decision_reason": decision.reason,
                        "representative_candidate_id": (
                            decision.representative_candidate_id
                        ),
                    }
            await self.repository.save_candidate_window_decisions(
                batch.id,
                window_number=cursor_batch.candidate_window_number + 1,
                last_source_rank=window.last_source_rank,
                values=[deterministic[row.id] for row in window.candidates],
                ai_decision_version=self.seed_decision_version,
            )
            cursor = window.last_source_rank
            cursor_batch = await self._require_batch(batch.id)
            retained = await self.repository.get_retained_candidates(batch.id)
            available = [row for row in retained if row.selected_plan_order is None]
            if window.exhausted:
                break
        return available[:required]

    async def _select_replacement_seeds(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
        invalid: Sequence[ContentPlanPreparation],
    ) -> list[ContentPlanCandidate]:
        selected_by_order = {
            int(candidate.selected_plan_order): candidate
            for candidate in await self.repository.get_selected_candidates(batch.id)
            if candidate.selected_plan_order is not None
        }
        recovered = {
            preparation.id: selected_by_order[preparation.plan_order]
            for preparation in invalid
            if preparation.plan_order in selected_by_order
            and selected_by_order[preparation.plan_order].id
            != preparation.candidate_id
        }
        await self.repository.drop_unavailable_candidates(
            batch.id,
            {
                preparation.candidate_id: (
                    f"preparation_{preparation.error_code or 'invalid'}"
                )
                for preparation in invalid
                if preparation.candidate_id is not None
                and preparation.id not in recovered
            },
        )
        fresh = iter(
            await self._select_seeds(
                batch,
                business_context,
                required=len(invalid) - len(recovered),
            )
        )
        replacements: list[ContentPlanCandidate] = []
        for preparation in invalid:
            candidate = recovered.get(preparation.id)
            if candidate is None:
                candidate = next(fresh, None)
            if candidate is None:
                break
            replacements.append(candidate)
        return replacements

    async def _ensure_initial_preparations(self, batch: ContentPlanBatch) -> None:
        if await self.repository.get_current_preparations(batch.id):
            return
        for candidate in await self.repository.get_selected_candidates(batch.id):
            await self.repository.create_preparation(
                preparation_id=f"preparation-{uuid4().hex}",
                batch_id=batch.id,
                candidate_id=candidate.id,
                seed_keyword_id=candidate.keyword_id,
                plan_order=int(candidate.selected_plan_order),
                seed_keyword=candidate.keyword,
                normalized_seed_keyword=candidate.normalized_keyword,
                source_round="initial",
                workflow_id=f"content-plan:{batch.id}:prepare:{candidate.selected_plan_order}:1",
                state="expanding",
            )

    async def _expand_current(self, batch: ContentPlanBatch) -> None:
        preparations = [
            row
            for row in await self.repository.get_current_preparations(batch.id)
            if row.state in {"pending", "selected", "expanding", "expansion_failed"}
        ]
        await self._expand_preparations(batch, preparations)

    async def _expand_preparations(
        self,
        batch: ContentPlanBatch,
        preparations: Sequence[ContentPlanPreparation],
    ) -> None:
        claimed: list[tuple[ContentPlanPreparation, str, str]] = []
        for preparation in preparations:
            round_number = self._preparation_round(preparation)
            request_key = (
                f"related:{batch.id}:{round_number}:{preparation.id}:"
                f"{preparation.preparation_version}"
            )
            legacy_request_key = (
                f"related:{batch.id}:{round_number}:{preparation.plan_order}:"
                f"{preparation.preparation_version}"
            )
            request_hash = self._hash(
                {
                    "keyword": preparation.normalized_seed_keyword,
                    "country": batch.country,
                    "language": batch.language,
                }
            )
            request = await self.repository.prepare_external_request(
                batch_id=batch.id,
                preparation_id=preparation.id,
                plan_item_id=None,
                request_key=request_key,
                provider="dataforseo",
                endpoint="related_keywords/live",
                request_hash=request_hash,
                round_number=round_number,
                legacy_request_key=legacy_request_key,
            )
            request_key = request.request_key
            if request.status == "completed":
                await self._restore_completed_expansion(preparation, request.response_metadata_json)
                continue
            if request.status in {"uncertain", "charged_failed", "failed"}:
                await self.repository.set_preparation_state(
                    preparation.id,
                    state="expansion_failed",
                    error_code=request.error_code or request.status,
                    error_detail=request.error_detail,
                )
                continue
            if (
                request.status == "retryable_failed"
                and request.attempt_count >= self.external_request_max_attempts
            ):
                await self.repository.set_preparation_state(
                    preparation.id,
                    state="expansion_failed",
                    error_code="external_request_retry_exhausted",
                    error_detail=request.error_detail,
                )
                continue
            claim_token = uuid4().hex
            claim = await self.repository.claim_external_request(
                request_key,
                claim_token=claim_token,
                lease_until=datetime.now(UTC) + timedelta(minutes=10),
                max_attempts=self.external_request_max_attempts,
            )
            if claim is not None:
                claimed.append((preparation, request_key, claim_token))
                continue
            stale = await self.repository.mark_stale_submitted_request_uncertain(request_key)
            if stale is not None:
                await self.repository.set_preparation_state(
                    preparation.id,
                    state="expansion_failed",
                    error_code="external_request_outcome_unknown",
                    error_detail=stale.error_detail,
                )
        if not claimed:
            return
        seeds = [
            ExpansionSeed(
                preparation_id=preparation.id,
                request_index=index,
                keyword=preparation.seed_keyword,
                tag=f"content-plan:{batch.id}:{preparation.id}",
            )
            for index, (preparation, _key, _token) in enumerate(claimed, start=1)
        ]
        try:
            results = await self.expansion_gateway.expand(
                seeds,
                country=batch.country,
                language=batch.language,
            )
        except Exception as exc:
            await self._mark_claims_uncertain(claimed, str(exc))
            raise D3ProcessingError("external_request_outcome_unknown", str(exc)) from exc
        results_by_id = {result.preparation_id: result for result in results}
        if len(results_by_id) != len(results) or set(results_by_id) != {
            seed.preparation_id for seed in seeds
        }:
            await self._mark_claims_uncertain(
                claimed, "Related Keywords response groups did not match the request"
            )
            raise D3ProcessingError(
                "external_response_mismatch", "Related Keywords 响应缺组或多组"
            )
        for preparation, request_key, claim_token in claimed:
            result = results_by_id[preparation.id]
            if result.status == "completed":
                metadata = {
                    "request_round": self._preparation_round(preparation),
                    "rows": [self._expansion_row_json(row) for row in result.rows],
                }
                completed = await self.repository.complete_external_request(
                    request_key,
                    claim_token=claim_token,
                    cost_usd=result.cost_usd,
                    result_count=len(result.rows),
                    provider_request_ids=(
                        [result.provider_request_id] if result.provider_request_id else []
                    ),
                    response_metadata=metadata,
                )
                if completed is None:
                    raise D3ProcessingError(
                        "external_request_claim_lost", "付费请求保存前失去领取权"
                    )
                await self._save_expansion(
                    preparation,
                    result.rows,
                    self._preparation_round(preparation),
                )
            else:
                await self.repository.fail_external_request(
                    request_key,
                    claim_token=claim_token,
                    status=result.status,
                    error_code=result.error_code or result.status,
                    error_detail=result.error_detail or result.status,
                    cost_usd=result.cost_usd,
                    provider_request_ids=(
                        [result.provider_request_id] if result.provider_request_id else []
                    ),
                )
                await self.repository.set_preparation_state(
                    preparation.id,
                    state="expansion_failed",
                    error_code=result.error_code or result.status,
                    error_detail=result.error_detail,
                )

    async def _save_expansion(
        self,
        preparation: ContentPlanPreparation,
        rows: Sequence[ExpansionRow],
        request_round: int,
    ) -> None:
        if not rows:
            await self.repository.save_expansion_result(
                preparation.id, [], request_round=request_round
            )
            return
        candidates = deduplicate_keyword_candidates(
            [
                CandidateClassification(
                    candidate_id=f"q-{uuid4().hex}",
                    keyword=preparation.seed_keyword,
                    source="seed",
                    provider_position=0,
                ),
                *[
                    CandidateClassification(
                        candidate_id=f"q-{uuid4().hex}",
                        keyword=row.keyword,
                        source="related",
                        provider_position=row.provider_position,
                        search_volume=row.search_volume,
                        keyword_difficulty=row.keyword_difficulty,
                        provider_intent=row.provider_intent,
                        raw_item=row.raw_item or {},
                    )
                    for row in rows
                ],
            ]
        )
        await self.repository.save_expansion_result(
            preparation.id,
            [self._candidate_persistence_value(candidate) for candidate in candidates],
            request_round=request_round,
        )

    async def _restore_completed_expansion(
        self, preparation: ContentPlanPreparation, metadata: dict[str, Any]
    ) -> None:
        raw_rows = metadata.get("rows") if isinstance(metadata, dict) else None
        rows = raw_rows if isinstance(raw_rows, list) else []
        await self._save_expansion(
            preparation,
            [ExpansionRow(**row) for row in rows],
            request_round=int(
                metadata.get("request_round", self._preparation_round(preparation))
            ),
        )

    async def _build_current_packages(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
    ) -> None:
        await self._build_packages(
            batch,
            business_context,
            await self.repository.get_current_preparations(batch.id),
        )

    async def _build_packages(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
        preparations: Sequence[ContentPlanPreparation],
        *,
        exclude_item_id: str | None = None,
    ) -> None:
        reserved_primary_keywords: set[str] = set()
        for preparation in preparations:
            if preparation.state not in {"pack_ready", "preview_ready"}:
                continue
            bundle = await self.repository.get_preparation_bundle(preparation.id)
            if bundle is None:
                continue
            reserved_primary_keywords.update(
                row.normalized_keyword
                for row in bundle.keywords
                if row.selected_role == "primary"
            )

        pending = []
        for preparation in preparations:
            if preparation.state == "expanded":
                bundle = await self.repository.get_preparation_bundle(preparation.id)
                assert bundle is not None
                pending.append(
                    (
                        preparation,
                        bundle.keywords,
                        tuple(self._domain_candidate(row) for row in bundle.keywords),
                    )
                )

        bulk_decisions: dict[str, dict[str, ClassificationDecision]] = {}
        bulk_classifier_version = "content-plan-classifier-bulk-v1"
        bulk_classify = getattr(self.classification_gateway, "classify_topics", None)
        if callable(bulk_classify):
            for request in await self.repository.get_completed_external_requests(
                batch.id,
                "content_plan/classification_bulk",
            ):
                output = request.response_metadata_json.get("output")
                if not isinstance(output, list):
                    continue
                for preparation, _keyword_rows, candidates in pending:
                    if preparation.id in bulk_decisions:
                        continue
                    topic_rows = [
                        row
                        for row in output
                        if isinstance(row, dict)
                        and row.get("topic_id") == preparation.id
                        and row.get("preparation_version")
                        == preparation.preparation_version
                        and row.get("package_version") == preparation.package_version
                    ]
                    try:
                        bulk_decisions[preparation.id] = (
                            self._validated_classification_decisions(
                                candidates,
                                topic_rows,
                            )
                        )
                    except (ValueError, TypeError, AttributeError, KeyError):
                        continue

        unresolved = [
            item for item in pending if item[0].id not in bulk_decisions
        ]
        if len(unresolved) > 1 and callable(bulk_classify):
            topics = [
                TopicClassificationInput(
                    topic_id=preparation.id,
                    seed_keyword=preparation.seed_keyword,
                    candidates=candidates,
                )
                for preparation, _keyword_rows, candidates in unresolved
            ]
            request_input = {
                "business_context": business_context.to_payload(),
                "country": batch.country,
                "language": batch.language,
                "topics": [
                    {
                        "topic_id": topic.topic_id,
                        "seed_keyword": topic.seed_keyword,
                        "preparation_version": preparation.preparation_version,
                        "package_version": preparation.package_version,
                        "candidates": [
                            self._classification_candidate_json(candidate)
                            for candidate in topic.candidates
                        ],
                    }
                    for topic, (preparation, _keyword_rows, _candidates) in zip(
                        topics, unresolved, strict=True
                    )
                ],
            }
            fingerprint = self._hash(
                {
                    "topics": [
                        {
                            "topic_id": topic.topic_id,
                            "preparation_version": preparation.preparation_version,
                            "package_version": preparation.package_version,
                        }
                        for topic, (preparation, _keyword_rows, _candidates) in zip(
                            topics, unresolved, strict=True
                        )
                    ]
                }
            )[:16]
            raw_bulk_decisions = await self._run_ai_request(
                batch=batch,
                preparation_id=None,
                request_key=(
                    f"ai:classification_bulk:{bulk_classifier_version}:"
                    f"{batch.id}:{fingerprint}"
                ),
                endpoint="content_plan/classification_bulk",
                prompt_version=bulk_classifier_version,
                request_input=request_input,
                round_number=max(
                    (
                        self._preparation_round(preparation)
                        for preparation, _, _ in unresolved
                    ),
                    default=0,
                ),
                structural_attempt=1,
                validation_error=None,
                invoke=lambda: bulk_classify(
                    topics,
                    business_context=business_context,
                    country=batch.country,
                    language=batch.language,
                ),
                encode_output=lambda output: self._bulk_classification_output_json(
                    output,
                    topic_versions={
                        preparation.id: (
                            preparation.preparation_version,
                            preparation.package_version,
                        )
                        for preparation, _keyword_rows, _candidates in unresolved
                    },
                ),
            )
            for topic in topics:
                topic_rows = [
                    row
                    for row in raw_bulk_decisions
                    if row.get("topic_id") == topic.topic_id
                ]
                try:
                    bulk_decisions[topic.topic_id] = self._validated_classification_decisions(
                        topic.candidates,
                        topic_rows,
                    )
                except (ValueError, TypeError, AttributeError, KeyError):
                    continue

        for preparation, keyword_rows, candidates_tuple in pending:
            candidates = list(candidates_tuple)
            try:
                decisions_by_id = bulk_decisions.get(preparation.id)
                if decisions_by_id is None:
                    decisions_by_id = await self._classify_with_repair(
                        batch,
                        business_context,
                        preparation,
                        preparation.seed_keyword,
                        candidates,
                    )
            except D3ProcessingError as exc:
                replaceable = exc.code in {
                    "ai_request_outcome_unknown",
                    "ai_request_retry_exhausted",
                }
                await self.repository.set_preparation_state(
                    preparation.id,
                    state="invalid" if replaceable else "classification_failed",
                    error_code=exc.code,
                    error_detail=exc.detail,
                )
                continue
            except (ValueError, TypeError, AttributeError, KeyError) as exc:
                await self.repository.set_preparation_state(
                    preparation.id,
                    state="classification_failed",
                    error_code="classification_failed",
                    error_detail=str(exc),
                )
                continue
            primary_eligible = [
                candidate
                for candidate in candidates
                if decisions_by_id[candidate.candidate_id].relevance == "same_topic"
                and decisions_by_id[candidate.candidate_id].keyword_type == "informational"
                and decisions_by_id[candidate.candidate_id].primary_fit
                in {"strong", "acceptable"}
            ]
            coverage_results = await self._coverage_by_keyword(
                batch.project_id,
                [(candidate.candidate_id, candidate.keyword) for candidate in primary_eligible],
            )
            coverage_by_id = {
                candidate_id: result.status
                for candidate_id, result in coverage_results.items()
            }
            occupied = await self.repository.occupied_normalized_keywords(
                batch.project_id, exclude_item_id=exclude_item_id
            )
            occupied.update(reserved_primary_keywords)
            package = build_keyword_package(
                candidates,
                list(decisions_by_id.values()),
                coverage_by_candidate=coverage_by_id,
                occupied_normalized_keywords=occupied,
            )
            await self._persist_package(
                preparation,
                keyword_rows,
                decisions_by_id,
                coverage_results,
                package,
                classifier_version=(
                    bulk_classifier_version
                    if preparation.id in bulk_decisions
                    else self.classifier_version
                ),
            )
            if package.status == "pack_ready" and package.primary_candidate_id is not None:
                primary = next(
                    candidate
                    for candidate in candidates
                    if candidate.candidate_id == package.primary_candidate_id
                )
                reserved_primary_keywords.add(primary.normalized_keyword)

    async def _build_fixed_primary_package(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
        preparation: ContentPlanPreparation,
        *,
        max_secondaries: int,
    ) -> None:
        bundle = await self.repository.get_preparation_bundle(preparation.id)
        if bundle is None or not bundle.keywords:
            raise D3ProcessingError(
                "primary_keyword_required", "主关键词编辑缺少候选词"
            )
        candidates = [self._domain_candidate(row) for row in bundle.keywords]
        decisions = await self._classify_with_repair(
            batch,
            business_context,
            preparation,
            preparation.seed_keyword,
            candidates,
        )
        primary = candidates[0]
        primary_decision = decisions[primary.candidate_id]
        eligible = (
            primary_decision.relevance == "same_topic"
            and primary_decision.keyword_type == "informational"
            and primary_decision.primary_fit in {"strong", "acceptable"}
        )
        coverage = None
        error_code = None
        if eligible:
            coverage = (
                await self._coverage_by_keyword(
                    batch.project_id, [(primary.candidate_id, primary.keyword)]
                )
            )[primary.candidate_id]
            occupied = await self.repository.occupied_normalized_keywords(
                batch.project_id, exclude_item_id=preparation.plan_item_id
            )
            if coverage.status == "unknown":
                error_code = "coverage_check_failed"
            elif coverage.status == "covered":
                error_code = "primary_keyword_covered"
            elif primary.normalized_keyword in occupied:
                error_code = "plan_keyword_conflict"
        else:
            error_code = "primary_keyword_not_informational"

        allowed_ids = set(primary_decision.secondary_candidate_ids)
        secondaries = (
            [
                candidate
                for candidate in candidates[1:]
                if candidate.candidate_id in allowed_ids
                and decisions[candidate.candidate_id].relevance == "same_topic"
            ][:max_secondaries]
            if error_code is None
            else []
        )
        await self._persist_fixed_primary_package(
            preparation,
            bundle.keywords,
            decisions,
            coverage,
            secondaries,
            error_code=error_code,
        )

    async def _persist_fixed_primary_package(
        self,
        preparation: ContentPlanPreparation,
        rows: Sequence[ContentPlanPreparationKeyword],
        decisions: dict[str, ClassificationDecision],
        primary_coverage: Any | None,
        secondaries: Sequence[CandidateClassification],
        *,
        error_code: str | None,
    ) -> None:
        primary = rows[0]
        secondary_ids = {row.candidate_id for row in secondaries}
        positions = {
            row.candidate_id: index for index, row in enumerate(secondaries, start=2)
        }
        values = []
        for row in rows:
            decision = decisions[row.candidate_id]
            is_primary = row.id == primary.id and error_code is None
            is_secondary = row.candidate_id in secondary_ids and error_code is None
            values.append(
                {
                    "id": row.id,
                    "relevance": decision.relevance,
                    "keyword_type": decision.keyword_type,
                    "primary_fit": decision.primary_fit,
                    "reason_code": decision.reason_code,
                    "classifier_version": self.classifier_version,
                    "coverage_status": (
                        primary_coverage.status
                        if row.id == primary.id and primary_coverage is not None
                        else "unknown"
                    ),
                    "coverage_relation_id": (
                        primary_coverage.relation_id
                        if row.id == primary.id and primary_coverage is not None
                        else None
                    ),
                    "covered_url": (
                        primary_coverage.covered_url
                        if row.id == primary.id and primary_coverage is not None
                        else None
                    ),
                    "coverage_checked_at": (
                        datetime.now(UTC) if row.id == primary.id else None
                    ),
                    "selected_role": (
                        "primary"
                        if is_primary
                        else "secondary" if is_secondary else "excluded"
                    ),
                    "exclusion_reason": (
                        None
                        if is_primary or is_secondary
                        else error_code or decision.reason_code
                    ),
                    "package_position": (
                        1 if is_primary else positions.get(row.candidate_id)
                    ),
                }
            )
        row_ids = {row.candidate_id: row.id for row in rows}
        relation_values = [
            {
                "id": f"relation-{uuid4().hex}",
                "primary_candidate_id": primary.id,
                "secondary_candidate_id": row_ids[secondary.candidate_id],
                "classifier_version": self.classifier_version,
            }
            for secondary in secondaries
        ]
        await self.repository.save_keyword_package(
            preparation.id,
            keyword_values=values,
            relation_values=relation_values,
            selected_primary_keyword_id=primary.id if error_code is None else None,
            state="pack_ready" if error_code is None else "invalid",
            error_code=error_code,
            error_detail=error_code,
        )

    async def _persist_package(
        self,
        preparation: ContentPlanPreparation,
        rows: Sequence[ContentPlanPreparationKeyword],
        decisions: dict[str, ClassificationDecision],
        coverage_results: dict[str, Any],
        package: Any,
        *,
        classifier_version: str | None = None,
    ) -> None:
        effective_classifier_version = classifier_version or self.classifier_version
        rows_by_candidate = {row.candidate_id: row for row in rows}
        secondary_ids = set(package.secondary_candidate_ids)
        keyword_values = []
        for row in rows:
            decision = decisions[row.candidate_id]
            coverage = coverage_results.get(row.candidate_id)
            selected_role = "excluded"
            package_position = None
            exclusion_reason = package.exclusion_reasons.get(row.candidate_id)
            if row.candidate_id == package.primary_candidate_id:
                selected_role = "primary"
                package_position = 1
            elif row.candidate_id in secondary_ids:
                selected_role = "secondary"
                package_position = 2 + package.secondary_candidate_ids.index(row.candidate_id)
            keyword_values.append(
                {
                    "id": row.id,
                    "relevance": decision.relevance,
                    "keyword_type": decision.keyword_type,
                    "primary_fit": decision.primary_fit,
                    "reason_code": decision.reason_code,
                    "classifier_version": effective_classifier_version,
                    "coverage_status": coverage.status if coverage else "unknown",
                    "coverage_relation_id": coverage.relation_id if coverage else None,
                    "covered_url": coverage.covered_url if coverage else None,
                    "coverage_checked_at": datetime.now(UTC),
                    "selected_role": selected_role,
                    "exclusion_reason": exclusion_reason,
                    "package_position": package_position,
                }
            )
        relation_values = []
        for decision in decisions.values():
            for secondary_id in decision.secondary_candidate_ids:
                relation_values.append(
                    {
                        "id": f"relation-{uuid4().hex}",
                        "primary_candidate_id": rows_by_candidate[decision.candidate_id].id,
                        "secondary_candidate_id": rows_by_candidate[secondary_id].id,
                            "classifier_version": effective_classifier_version,
                    }
                )
        selected_primary_id = (
            rows_by_candidate[package.primary_candidate_id].id
            if package.primary_candidate_id
            else None
        )
        await self.repository.save_keyword_package(
            preparation.id,
            keyword_values=keyword_values,
            relation_values=relation_values,
            selected_primary_keyword_id=selected_primary_id,
            state=package.status,
            error_code=package.error_code,
            error_detail=package.error_code,
        )

    async def _replace_invalid_preparations(
        self,
        batch: ContentPlanBatch,
        invalid: Sequence[ContentPlanPreparation],
        replacements: Sequence[ContentPlanCandidate],
        round_number: int,
    ) -> None:
        replaced = list(zip(invalid, replacements, strict=False))
        for old, candidate in replaced:
            await self.repository.replace_preparation_seed(
                preparation_id=f"preparation-{uuid4().hex}",
                old_preparation_id=old.id,
                replacement_candidate_id=candidate.id,
                source_round=f"refill_{round_number}",
                workflow_id=f"content-plan:{batch.id}:replace:{old.id}",
            )

    async def _run_fallback(
        self,
        batch: ContentPlanBatch,
        invalid: Sequence[ContentPlanPreparation],
        business_context: BusinessContext,
    ) -> None:
        if self.fallback_gateway is None:
            return
        for old in invalid:
            try:
                normalized = await self._fallback_candidates_with_repair(
                    batch,
                    business_context,
                    old,
                    old.seed_keyword,
                    language=batch.language,
                )
            except D3ProcessingError as exc:
                replaceable = exc.code in {
                    "ai_request_outcome_unknown",
                    "ai_request_retry_exhausted",
                }
                await self.repository.set_preparation_state(
                    old.id,
                    state="invalid" if replaceable else "classification_failed",
                    error_code=exc.code,
                    error_detail=exc.detail,
                )
                continue
            except (ValueError, TypeError) as exc:
                await self.repository.set_preparation_state(
                    old.id,
                    state="classification_failed",
                    error_code="fallback_contract_invalid",
                    error_detail=str(exc),
                )
                continue
            if not normalized:
                continue
            replacement = await self.repository.create_replacement_preparation(
                preparation_id=f"preparation-{uuid4().hex}",
                old_preparation_id=old.id,
                candidate_id=old.candidate_id,
                seed_keyword_id=old.seed_keyword_id,
                seed_keyword=old.seed_keyword,
                normalized_seed_keyword=old.normalized_seed_keyword,
                source_round="ai_fallback",
                workflow_id=f"content-plan:{batch.id}:fallback:{old.id}",
                state="expanded",
            )
            candidates = [
                CandidateClassification(
                    candidate_id=f"q-{uuid4().hex}",
                    keyword=old.seed_keyword,
                    source="seed",
                )
            ] + [
                CandidateClassification(
                    candidate_id=f"q-{uuid4().hex}",
                    keyword=value,
                    source="ai",
                )
                for value in normalized.values()
            ]
            await self.repository.save_expansion_result(
                replacement.id,
                [self._candidate_persistence_value(candidate) for candidate in candidates],
                request_round=2,
            )
        await self._build_current_packages(batch, business_context)

    async def _decide_seeds_with_repair(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
        candidates: Sequence[SeedCandidate],
        retained: Sequence[SeedCandidate],
        *,
        window_number: int,
    ) -> list[Any]:
        validation_error: str | None = None
        request_input = {
            "business_context": business_context.to_payload(),
            "country": batch.country,
            "language": batch.language,
            "candidates": [
                {
                    "candidate_id": row.candidate_id,
                    "keyword": row.keyword,
                    "source_rank": row.source_rank,
                }
                for row in candidates
            ],
            "retained": [
                {
                    "candidate_id": row.candidate_id,
                    "keyword": row.keyword,
                    "source_rank": row.source_rank,
                }
                for row in retained
            ],
        }
        for attempt in range(1, 3):
            raw_decisions = await self._run_ai_request(
                batch=batch,
                preparation_id=None,
                request_key=(
                    f"ai:seed:{self.seed_decision_version}:{batch.id}:"
                    f"{window_number}:{attempt}"
                ),
                endpoint="content_plan/seed_decision",
                prompt_version=self.seed_decision_version,
                request_input=request_input,
                round_number=0,
                structural_attempt=attempt,
                validation_error=validation_error,
                invoke=lambda error=validation_error: self.seed_gateway.decide(
                    candidates,
                    retained,
                    business_context=business_context,
                    country=batch.country,
                    language=batch.language,
                    validation_error=error,
                ),
                encode_output=lambda output: [dict(row) for row in output],
            )
            try:
                return resolve_seed_decisions(
                    candidates,
                    retained=retained,
                    decisions=raw_decisions,
                )
            except (ValueError, TypeError, KeyError) as exc:
                validation_error = str(exc)
        raise D3ProcessingError(
            "seed_decision_contract_invalid",
            validation_error or "候选词判断输出不合法",
        )

    async def _classify_with_repair(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
        preparation: ContentPlanPreparation,
        seed_keyword: str,
        candidates: Sequence[CandidateClassification],
    ) -> dict[str, ClassificationDecision]:
        validation_error: str | None = None
        request_input = {
            "business_context": business_context.to_payload(),
            "country": batch.country,
            "language": batch.language,
            "seed_keyword": seed_keyword,
            "candidates": [self._classification_candidate_json(row) for row in candidates],
        }
        for attempt in range(1, 3):
            raw_decisions = await self._run_ai_request(
                batch=batch,
                preparation_id=preparation.id,
                request_key=(
                    f"ai:classification:{self.classifier_version}:{batch.id}:"
                    f"{preparation.id}:"
                    f"{preparation.preparation_version}:"
                    f"{preparation.package_version}:{attempt}"
                ),
                endpoint="content_plan/classification",
                prompt_version=self.classifier_version,
                request_input=request_input,
                round_number=self._preparation_round(preparation),
                structural_attempt=attempt,
                validation_error=validation_error,
                invoke=lambda error=validation_error: self.classification_gateway.classify(
                    seed_keyword,
                    candidates,
                    business_context=business_context,
                    country=batch.country,
                    language=batch.language,
                    validation_error=error,
                ),
                encode_output=self._classification_output_json,
            )
            try:
                return self._validated_classification_decisions(candidates, raw_decisions)
            except (ValueError, TypeError, AttributeError, KeyError) as exc:
                validation_error = str(exc)
        raise ValueError(validation_error or "classification output is invalid")

    @staticmethod
    def _classification_candidate_json(
        candidate: CandidateClassification,
    ) -> dict[str, Any]:
        return {
            "candidate_id": candidate.candidate_id,
            "keyword": candidate.keyword,
            "source": candidate.source,
            "provider_position": candidate.provider_position,
            "search_volume": candidate.search_volume,
            "keyword_difficulty": candidate.keyword_difficulty,
            "provider_intent": candidate.provider_intent,
        }

    @staticmethod
    def _validated_classification_decisions(
        candidates: Sequence[CandidateClassification],
        raw_decisions: Sequence[Any],
    ) -> dict[str, ClassificationDecision]:
        decisions = []
        for row in raw_decisions:
            if isinstance(row, ClassificationDecision):
                decisions.append(row)
                continue
            decisions.append(
                ClassificationDecision(
                    candidate_id=row["candidate_id"],
                    relevance=row["relevance"],
                    keyword_type=row["keyword_type"],
                    primary_fit=row["primary_fit"],
                    secondary_candidate_ids=tuple(row["secondary_candidate_ids"]),
                    reason_code=row["reason_code"],
                )
            )
        candidate_ids = {candidate.candidate_id for candidate in candidates}
        relevance_by_id = {
            decision.candidate_id: decision.relevance for decision in decisions
        }
        cleaned = []
        for decision in decisions:
            secondary_ids = []
            seen_secondary_ids: set[str] = set()
            for secondary_id in decision.secondary_candidate_ids:
                if (
                    secondary_id not in candidate_ids
                    or secondary_id == decision.candidate_id
                    or secondary_id in seen_secondary_ids
                    or relevance_by_id.get(secondary_id) != "same_topic"
                ):
                    continue
                seen_secondary_ids.add(secondary_id)
                secondary_ids.append(secondary_id)
            cleaned.append(
                ClassificationDecision(
                    candidate_id=decision.candidate_id,
                    relevance=decision.relevance,
                    keyword_type=decision.keyword_type,
                    primary_fit=decision.primary_fit,
                    secondary_candidate_ids=tuple(secondary_ids),
                    reason_code=decision.reason_code,
                )
            )
        return validate_classification_decisions(candidates, cleaned)

    async def _fallback_candidates_with_repair(
        self,
        batch: ContentPlanBatch,
        business_context: BusinessContext,
        preparation: ContentPlanPreparation,
        seed_keyword: str,
        *,
        language: str,
    ) -> dict[str, str]:
        assert self.fallback_gateway is not None
        validation_error: str | None = None
        request_input = {
            "business_context": business_context.to_payload(),
            "seed_keyword": seed_keyword,
            "language": language,
            "limit": 50,
        }
        for attempt in range(1, 3):
            generated = await self._run_ai_request(
                batch=batch,
                preparation_id=preparation.id,
                request_key=(
                    f"ai:fallback:{self.fallback_version}:{batch.id}:"
                    f"{preparation.id}:"
                    f"{preparation.preparation_version}:{attempt}"
                ),
                endpoint="content_plan/fallback",
                prompt_version=self.fallback_version,
                request_input=request_input,
                round_number=2,
                structural_attempt=attempt,
                validation_error=validation_error,
                invoke=lambda error=validation_error: self.fallback_gateway.generate(
                    seed_keyword,
                    business_context=business_context,
                    language=language,
                    limit=50,
                    validation_error=error,
                ),
                encode_output=lambda output: [dict(row) for row in output],
            )
            try:
                normalized: dict[str, str] = {}
                for item in generated:
                    value = str(item["keyword"]).strip()
                    reason = str(item["generation_reason"]).strip()
                    clean = normalize_keyword(value)
                    if not reason:
                        raise ValueError("generation_reason is required")
                    if not self._valid_fallback_keyword(value, clean, language):
                        raise ValueError(f"invalid fallback keyword: {value}")
                    normalized.setdefault(clean, value)
                return normalized
            except (KeyError, TypeError, ValueError) as exc:
                validation_error = str(exc)
        raise ValueError(validation_error or "fallback output is invalid")

    async def _run_ai_request(
        self,
        *,
        batch: ContentPlanBatch,
        preparation_id: str | None,
        request_key: str,
        endpoint: str,
        prompt_version: str,
        request_input: dict[str, Any],
        round_number: int,
        structural_attempt: int,
        validation_error: str | None,
        invoke: Callable[[], Awaitable[AICallResult]],
        encode_output: Callable[[Sequence[Any]], list[dict[str, Any]]],
    ) -> list[dict[str, Any]]:
        request_hash = self._hash(
            {
                "endpoint": endpoint,
                "prompt_version": prompt_version,
                "input": request_input,
                "structural_attempt": structural_attempt,
                "validation_error": validation_error,
            }
        )
        request = await self.repository.prepare_external_request(
            batch_id=batch.id,
            preparation_id=preparation_id,
            plan_item_id=None,
            request_key=request_key,
            provider="ai",
            endpoint=endpoint,
            request_hash=request_hash,
            round_number=round_number,
        )
        if request.status == "completed":
            output = request.response_metadata_json.get("output")
            if not isinstance(output, list) or not all(isinstance(row, dict) for row in output):
                raise D3ProcessingError(
                    "ai_audit_record_invalid",
                    f"AI 请求 {request_key} 缺少可恢复输出",
                )
            return output
        if request.status in {"uncertain", "charged_failed", "failed"}:
            raise D3ProcessingError(
                request.error_code or "ai_request_outcome_unknown",
                request.error_detail or f"AI 请求 {request_key} 不能自动重试",
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
                stale = await self.repository.mark_stale_submitted_request_uncertain(
                    request_key
                )
                if stale is not None:
                    raise D3ProcessingError(
                        "ai_request_outcome_unknown",
                        stale.error_detail or f"AI 请求 {request_key} 结果未知",
                    )
                raise D3ProcessingError(
                    "ai_request_in_progress",
                    f"AI 请求 {request_key} 已被其他执行领取",
                )
            try:
                response = await invoke()
                output = encode_output(response.output)
                self._validate_ai_response(response)
                break
            except ProviderError as exc:
                failure_status = classify_ai_provider_error(exc)
                error_code = (
                    "ai_request_outcome_unknown"
                    if failure_status == "uncertain"
                    else exc.code
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
                    error_code = "ai_request_retry_exhausted"
                raise D3ProcessingError(error_code, str(exc)) from exc
            except Exception as exc:
                await self.repository.fail_external_request(
                    request_key,
                    claim_token=claim_token,
                    status="uncertain",
                    error_code="ai_request_outcome_unknown",
                    error_detail=str(exc),
                )
                raise D3ProcessingError("ai_request_outcome_unknown", str(exc)) from exc
        completed = await self.repository.complete_external_request(
            request_key,
            claim_token=claim_token,
            cost_usd=response.cost_usd,
            result_count=len(output),
            provider_request_ids=[response.request_id],
            response_metadata={
                "provider": response.provider,
                "model": response.model,
                "prompt_version": prompt_version,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
                "cache_hit": response.cache_hit,
                "structural_attempt": structural_attempt,
                "validation_error": validation_error,
                "output": output,
            },
        )
        if completed is None:
            raise D3ProcessingError(
                "ai_request_claim_lost",
                f"AI 请求 {request_key} 保存前失去领取权",
            )
        return output

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
    def _classification_output_json(
        output: Sequence[Any],
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for row in output:
            if isinstance(row, dict):
                rows.append(
                    {
                        "candidate_id": row["candidate_id"],
                        "relevance": row["relevance"],
                        "keyword_type": row["keyword_type"],
                        "primary_fit": row["primary_fit"],
                        "secondary_candidate_ids": list(
                            row["secondary_candidate_ids"]
                        ),
                        "reason_code": row["reason_code"],
                    }
                )
                continue
            rows.append(
                {
                    "candidate_id": row.candidate_id,
                    "relevance": row.relevance,
                    "keyword_type": row.keyword_type,
                    "primary_fit": row.primary_fit,
                    "secondary_candidate_ids": list(row.secondary_candidate_ids),
                    "reason_code": row.reason_code,
                }
            )
        return rows

    @classmethod
    def _bulk_classification_output_json(
        cls,
        output: Sequence[Any],
        *,
        topic_versions: dict[str, tuple[int, int]],
    ) -> list[dict[str, Any]]:
        rows = []
        for row in output:
            if not isinstance(row, dict):
                raise TypeError("bulk classification output rows must be objects")
            [decision] = cls._classification_output_json([row])
            preparation_version, package_version = topic_versions.get(
                row["topic_id"],
                (0, 0),
            )
            rows.append(
                {
                    "topic_id": row["topic_id"],
                    "preparation_version": preparation_version,
                    "package_version": package_version,
                    **decision,
                }
            )
        return rows

    async def _sync_completed_supplement_round(
        self, batch: ContentPlanBatch
    ) -> ContentPlanBatch:
        preparations = await self.repository.get_current_preparations(batch.id)
        refill_rows: dict[int, list[ContentPlanPreparation]] = {}
        for row in preparations:
            if row.source_round.startswith("refill_"):
                refill_rows.setdefault(self._preparation_round(row), []).append(row)
        completed_rounds = [
            round_number
            for round_number, rows in refill_rows.items()
            if rows and all(row.state in {"pack_ready", "invalid"} for row in rows)
        ]
        completed_round = max(completed_rounds, default=batch.supplement_round)
        if completed_round > batch.supplement_round:
            return await self.repository.update_batch_progress(
                batch.id,
                status="supplementing",
                stage=f"refill_{completed_round}_completed",
                supplement_round=completed_round,
            )
        return batch

    async def _mark_claims_uncertain(
        self,
        claimed: Sequence[tuple[ContentPlanPreparation, str, str]],
        detail: str,
    ) -> None:
        for preparation, request_key, claim_token in claimed:
            await self.repository.fail_external_request(
                request_key,
                claim_token=claim_token,
                status="uncertain",
                error_code="external_request_outcome_unknown",
                error_detail=detail,
            )
            await self.repository.set_preparation_state(
                preparation.id,
                state="expansion_failed",
                error_code="external_request_outcome_unknown",
                error_detail=detail,
            )

    async def _coverage_by_keyword(
        self, project_id: str, values: Sequence[tuple[str, str]]
    ) -> dict[str, Any]:
        results: dict[str, Any] = {}
        for start in range(0, len(values), 100):
            chunk = values[start : start + 100]
            if not chunk:
                continue
            request = KeywordCoverageBatchRequest(
                project_id=project_id,
                keywords=[
                    KeywordCoverageInput(request_id=request_id, keyword=keyword)
                    for request_id, keyword in chunk
                ],
            )
            try:
                response = await self.coverage_query.query(request)
            except Exception as exc:
                raise D3ProcessingError("coverage_check_failed", str(exc)) from exc
            chunk_results = {row.request_id: row for row in response.results}
            if set(chunk_results) != {request_id for request_id, _keyword in chunk}:
                raise D3ProcessingError(
                    "coverage_check_failed", "关键词覆盖查询响应缺项或多项"
                )
            results.update(chunk_results)
        return results

    async def _invalid_current_preparations(
        self, batch_id: str
    ) -> list[ContentPlanPreparation]:
        return [
            row
            for row in await self.repository.get_current_preparations(batch_id)
            if row.state == "invalid"
            or (
                row.state == "expansion_failed"
                and row.error_code == "external_request_outcome_unknown"
            )
        ]

    async def _technical_current_preparations(
        self, batch_id: str
    ) -> list[ContentPlanPreparation]:
        return [
            row
            for row in await self.repository.get_current_preparations(batch_id)
            if row.state in {
                "expansion_failed",
                "classification_failed",
                "coverage_check_failed",
            }
            and not (
                row.state == "expansion_failed"
                and row.error_code == "external_request_outcome_unknown"
            )
        ]

    async def _technical_failure_result(
        self, batch: ContentPlanBatch, rows: Sequence[ContentPlanPreparation]
    ) -> D3BatchResult:
        first = rows[0]
        return await self._needs_attention(
            batch,
            first.error_code or first.state,
            first.error_detail or f"准备记录 {first.plan_order} 处理失败",
        )

    async def _needs_attention(
        self,
        batch: ContentPlanBatch,
        code: str,
        detail: str,
        *,
        missing_count: int | None = None,
    ) -> D3BatchResult:
        preparations = await self.repository.get_current_preparations(batch.id)
        pack_count = sum(row.state == "pack_ready" for row in preparations)
        await self.repository.update_batch_progress(
            batch.id,
            status="needs_attention",
            stage="d3_failed",
            error_code=code,
            error_detail=detail,
        )
        return D3BatchResult(
            batch.id,
            "needs_attention",
            pack_count,
            code,
            (
                max(batch.target_count - pack_count, 0)
                if missing_count is None
                else missing_count
            ),
        )

    async def _require_batch(self, batch_id: str) -> ContentPlanBatch:
        batch = await self.repository.get_batch(batch_id)
        if batch is None:
            raise ValueError("content plan batch does not exist")
        return batch

    @staticmethod
    def _hash(value: dict[str, Any]) -> str:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(payload.encode()).hexdigest()

    @staticmethod
    def _preparation_round(preparation: ContentPlanPreparation) -> int:
        if preparation.source_round == "refill_1":
            return 1
        if preparation.source_round == "refill_2":
            return 2
        return 0

    @staticmethod
    def _valid_fallback_keyword(value: str, normalized: str, language: str) -> bool:
        if not 2 <= len(normalized) <= 200:
            return False
        if "\n" in value or "\r" in value or re.search(r"https?://|www\.", value, re.I):
            return False
        if len(value.split()) > 20 or value.count(".") > 1:
            return False
        has_cjk = bool(re.search(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", value))
        if language.lower().startswith(("zh", "ja", "ko")):
            return has_cjk
        return not has_cjk

    @staticmethod
    def _expansion_row_json(row: ExpansionRow) -> dict[str, Any]:
        return {
            "keyword": row.keyword,
            "provider_position": row.provider_position,
            "search_volume": row.search_volume,
            "keyword_difficulty": row.keyword_difficulty,
            "provider_intent": row.provider_intent,
            "raw_item": row.raw_item,
        }

    @staticmethod
    def _candidate_persistence_value(
        candidate: CandidateClassification,
    ) -> dict[str, Any]:
        return {
            "id": f"preparation-keyword-{uuid4().hex}",
            "candidate_id": candidate.candidate_id,
            "source": candidate.source,
            "raw_keyword": candidate.keyword,
            "normalized_keyword": candidate.normalized_keyword,
            "provider_position": candidate.provider_position,
            "search_volume": candidate.search_volume,
            "keyword_difficulty": candidate.keyword_difficulty,
            "provider_intent": candidate.provider_intent,
            "raw_item_json": candidate.raw_item,
        }

    @staticmethod
    def _domain_candidate(
        row: ContentPlanPreparationKeyword,
    ) -> CandidateClassification:
        return CandidateClassification(
            candidate_id=row.candidate_id,
            keyword=row.raw_keyword,
            source=row.source,
            search_volume=row.search_volume,
            provider_position=row.provider_position,
            keyword_difficulty=row.keyword_difficulty,
            provider_intent=row.provider_intent,
            raw_item=row.raw_item_json,
        )
