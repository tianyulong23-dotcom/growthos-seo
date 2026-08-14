from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings
from app.modules.content.asset_repository import AssetRepository
from app.modules.content.asset_schemas import AssetImportRequest, AssetUpdateRequest
from app.modules.content.asset_service import AssetService
from app.modules.content.image_gateway import (
    ImageProviderError,
    ImageRequest,
    ImageResult,
    best_project_asset_match,
    image_provider_for,
    visual_strategy_chain,
)
from app.modules.content.object_storage import S3ArtifactStore, StoredTextNotFoundError
from app.modules.content.writing_gateway import ArticlePlan, VisualPlanItem


IMAGE_PROCESSING_TIMEOUT_SECONDS = 60.0
IMAGE_PROCESSING_POLL_SECONDS = 1.0
RETRYABLE_PROVIDER_CODES = {
    "image_acquisition_failed",
    "provider_timeout",
    "provider_unavailable",
}


class ResolvedVisual(BaseModel):
    model_config = ConfigDict(extra="forbid")

    visual_id: str
    section_id: str
    asset_id: str | None = None
    status: Literal["ready", "failed", "omitted"]
    required: bool = False
    alt_text: str = ""
    caption: str | None = None
    provider: str
    source_strategy: str | None = None
    attempts: int = 0
    elapsed_ms: int = 0
    width: int | None = None
    height: int | None = None
    alt_source: str | None = None
    source_url: str | None = None
    license_name: str | None = None
    creator_name: str | None = None
    attribution_url: str | None = None
    generation_request_id: str | None = None
    generation_prompt: str | None = None
    model_name: str | None = None
    captured_at: str | None = None
    viewport_width: int | None = None
    viewport_height: int | None = None
    cost_usd: Decimal | None = None
    failure_code: str | None = None
    reused: bool = False
    attempt_log: list[dict[str, Any]] = Field(default_factory=list)


async def resolve_visuals(
    *,
    settings: Settings,
    context: dict[str, Any],
    asset_repository: AssetRepository,
    asset_service: AssetService,
    concurrency: int = 3,
) -> dict[str, Any]:
    run_id = str(context["run_id"])
    planning_ref = str(context["completed_steps"]["planning"]["output_ref"])
    store = S3ArtifactStore(settings)
    planning = await store.read_json(planning_ref)
    plan = ArticlePlan.model_validate(planning["plan"])
    headings = {section.section_id: section.heading for section in plan.sections}
    project_id = str(context["project_id"])
    ready_assets = await asset_repository.list_ready_images(project_id, limit=100)
    strategy_chains: dict[str, list[str]] = {}
    for visual in plan.visuals:
        probe = ImageRequest(
            run_id=run_id,
            project_id=project_id,
            visual=visual,
            section_heading=headings.get(visual.section_id, ""),
            idempotency_key="visual-strategy-probe",
            claims=plan.claims,
        )
        strategy_chains[visual.visual_id] = visual_strategy_chain(
            visual,
            has_relevant_project_asset=(
                best_project_asset_match(probe, ready_assets) is not None
            ),
        )
    semaphore = asyncio.Semaphore(max(1, min(concurrency, 4)))
    provider_timeout = float(
        getattr(settings, "article_image_provider_timeout_seconds", 30.0)
    )
    processing_timeout = float(
        getattr(settings, "article_image_processing_timeout_seconds", 60.0)
    )
    max_attempts = int(getattr(settings, "article_image_max_attempts", 2))

    async def resolve_one(visual: VisualPlanItem) -> ResolvedVisual:
        started_at = time.monotonic()
        attempts = 0
        attempt_log: list[dict[str, Any]] = []
        strategies = strategy_chains[visual.visual_id]
        async with semaphore:
            request = ImageRequest(
                run_id=run_id,
                project_id=project_id,
                visual=visual,
                section_heading=headings.get(visual.section_id, ""),
                idempotency_key=_visual_idempotency_key(
                    context,
                    visual,
                    strategies=strategies,
                ),
                claims=plan.claims,
            )
            provider: Any = None
            selected_strategy = strategies[0]
            try:
                cached = await _load_reusable_visual(
                    store,
                    result_reference=_result_reference(settings, run_id, visual.visual_id),
                    idempotency_key=request.idempotency_key,
                    visual=visual,
                    allowed_strategies=set(strategies),
                    asset_service=asset_service,
                    project_id=project_id,
                )
                if cached is not None:
                    return cached.model_copy(
                        update={"elapsed_ms": _elapsed_ms(started_at), "reused": True}
                    )
                reusable_asset = await _find_idempotent_asset(
                    asset_repository,
                    project_id=project_id,
                    strategies=strategies,
                    idempotency_key=request.idempotency_key,
                )
                if reusable_asset is not None:
                    asset, reused_strategy = reusable_asset
                    return await _resolved_from_idempotent_asset(
                        visual,
                        asset.id,
                        source_strategy=reused_strategy,
                        asset_service=asset_service,
                        project_id=project_id,
                        started_at=started_at,
                    )
                result: ImageResult | None = None
                last_error: ImageProviderError | None = None
                for strategy in strategies:
                    selected_strategy = strategy
                    provider = image_provider_for(
                        strategy,
                        asset_repository=asset_repository,
                        settings=settings,
                    )
                    provider_request = request.model_copy(
                        update={
                            "visual": visual.model_copy(
                                update={"source_strategy": strategy}
                            )
                        }
                    )
                    for provider_attempt in range(1, max(1, max_attempts) + 1):
                        attempts += 1
                        attempt_started = time.monotonic()
                        try:
                            result = await asyncio.wait_for(
                                provider.acquire(provider_request),
                                timeout=provider_timeout,
                            )
                            attempt_log.append(
                                {
                                    "provider": strategy,
                                    "attempt": provider_attempt,
                                    "status": "succeeded",
                                    "elapsed_ms": _elapsed_ms(attempt_started),
                                }
                            )
                            break
                        except TimeoutError:
                            last_error = ImageProviderError(
                                "provider_timeout",
                                "The image provider exceeded its per-image timeout.",
                            )
                            attempt_log.append(
                                {
                                    "provider": strategy,
                                    "attempt": provider_attempt,
                                    "status": "failed",
                                    "error_code": last_error.code,
                                    "elapsed_ms": _elapsed_ms(attempt_started),
                                }
                            )
                            if provider_attempt >= max_attempts:
                                break
                        except ImageProviderError as exc:
                            last_error = exc
                            attempt_log.append(
                                {
                                    "provider": strategy,
                                    "attempt": provider_attempt,
                                    "status": "failed",
                                    "error_code": exc.code,
                                    "elapsed_ms": _elapsed_ms(attempt_started),
                                }
                            )
                            if (
                                exc.code not in RETRYABLE_PROVIDER_CODES
                                or provider_attempt >= max_attempts
                            ):
                                break
                        except Exception:
                            last_error = ImageProviderError(
                                "image_acquisition_failed",
                                "The image provider failed after bounded attempts.",
                            )
                            attempt_log.append(
                                {
                                    "provider": strategy,
                                    "attempt": provider_attempt,
                                    "status": "failed",
                                    "error_code": last_error.code,
                                    "elapsed_ms": _elapsed_ms(attempt_started),
                                }
                            )
                            if provider_attempt >= max_attempts:
                                break
                        await asyncio.sleep(min(0.25 * provider_attempt, 1.0))
                    if result is not None:
                        break
                if result is None:
                    raise last_error or ImageProviderError(
                        "image_acquisition_failed", "The image provider returned no result."
                    )
                if not result.alt_text.strip() or not result.alt_source:
                    raise ImageProviderError(
                        "image_alt_missing",
                        "The acquired image has no alt text derived from the actual image metadata.",
                    )
                asset_id = await register_image_result(
                    result,
                    request=request,
                    asset_service=asset_service,
                )
                if result.asset_id is None:
                    ready_asset = await wait_for_ready_asset(
                        asset_service,
                        project_id=request.project_id,
                        asset_id=asset_id,
                        timeout_seconds=processing_timeout,
                    )
                    asset_id = ready_asset.asset_id
                    result.width = result.width or ready_asset.width
                    result.height = result.height or ready_asset.height
                return ResolvedVisual(
                    visual_id=visual.visual_id,
                    section_id=visual.section_id,
                    asset_id=asset_id,
                    status="ready",
                    required=visual.required,
                    alt_text=result.alt_text.strip(),
                    caption=result.caption or visual.caption,
                    provider=result.provider,
                    source_strategy=selected_strategy,
                    attempts=attempts,
                    elapsed_ms=_elapsed_ms(started_at),
                    width=result.width,
                    height=result.height,
                    alt_source=result.alt_source,
                    source_url=result.source_url,
                    license_name=result.license_name,
                    creator_name=result.creator_name,
                    attribution_url=result.attribution_url,
                    generation_request_id=result.generation_request_id,
                    generation_prompt=result.generation_prompt,
                    model_name=result.model_name,
                    captured_at=result.captured_at,
                    viewport_width=result.viewport_width,
                    viewport_height=result.viewport_height,
                    cost_usd=result.cost_usd,
                    attempt_log=attempt_log,
                )
            except ImageProviderError as exc:
                return ResolvedVisual(
                    visual_id=visual.visual_id,
                    section_id=visual.section_id,
                    status="failed" if visual.required else "omitted",
                    required=visual.required,
                    provider=getattr(provider, "name", selected_strategy),
                    source_strategy=selected_strategy,
                    attempts=attempts,
                    elapsed_ms=_elapsed_ms(started_at),
                    failure_code=exc.code,
                    attempt_log=attempt_log,
                )
            except Exception:
                return ResolvedVisual(
                    visual_id=visual.visual_id,
                    section_id=visual.section_id,
                    status="failed" if visual.required else "omitted",
                    required=visual.required,
                    provider=getattr(provider, "name", selected_strategy),
                    source_strategy=selected_strategy,
                    attempts=attempts,
                    elapsed_ms=_elapsed_ms(started_at),
                    failure_code="image_acquisition_failed",
                    attempt_log=attempt_log,
                )

    async def resolve_and_record(visual: VisualPlanItem) -> tuple[ResolvedVisual, str]:
        item = await resolve_one(visual)
        idempotency_key = _visual_idempotency_key(
            context,
            visual,
            strategies=strategy_chains[visual.visual_id],
        )
        result_ref = await store.write_json(
            f"article-runs/{run_id}/visuals/{_artifact_segment(visual.visual_id)}/result.json.gz",
            {
                "kind": "resolved_visual",
                "idempotency_key": idempotency_key,
                "visual": item.model_dump(mode="json"),
            },
        )
        return item, result_ref

    recorded = await asyncio.gather(*(resolve_and_record(item) for item in plan.visuals))
    resolved = [item for item, _ in recorded]
    resolved_by_id = {item.visual_id: item for item in resolved}
    final_visuals = [
        item.model_copy(
            update={
                "source_strategy": resolved_by_id[item.visual_id].source_strategy
                or item.source_strategy
            }
        )
        for item in plan.visuals
    ]
    plan = plan.model_copy(update={"visuals": final_visuals})
    plan_ref = await store.write_json(
        f"article-runs/{run_id}/visuals/plan.json.gz",
        {
            "kind": "visual_plan",
            "plan": plan.model_dump(mode="json"),
            "visuals": [item.model_dump(mode="json") for item in final_visuals],
        },
    )
    artifact = {
        "kind": "resolved_visuals",
        "plan_ref": plan_ref,
        "plan": plan.model_dump(mode="json"),
        "result_refs": [result_ref for _, result_ref in recorded],
        "visuals": [item.model_dump(mode="json") for item in resolved],
    }
    output_ref = await store.write_json(
        f"article-runs/{run_id}/visuals/resolved.json.gz",
        artifact,
    )
    omitted = [item for item in resolved if item.status != "ready"]
    warnings = (
        [{"code": "optional_visuals_omitted", "message": "部分可选图片未找到，正文已继续生成"}]
        if any(not item.required for item in omitted)
        else []
    )
    return {
        "output_ref": output_ref,
        "warnings": warnings,
        "summary": {
            "planned_count": len(plan.visuals),
            "ready_count": sum(item.status == "ready" for item in resolved),
            "omitted_count": len(omitted),
            "required_failed_count": sum(
                item.required and item.status != "ready" for item in resolved
            ),
        },
        "usage": _image_usage(resolved),
    }


async def register_image_result(
    result: ImageResult,
    *,
    request: ImageRequest,
    asset_service: AssetService,
) -> str:
    if result.asset_id:
        return result.asset_id
    if result.content is not None and result.mime_type and result.filename:
        response = await asset_service.ingest_bytes(
            project_id=request.project_id,
            user_id="system",
            idempotency_key=request.idempotency_key,
            filename=result.filename,
            mime_type=result.mime_type,
            content=result.content,
            source_type=result.provider,
        )
        await _persist_result_metadata(
            asset_service,
            project_id=request.project_id,
            asset_id=response.asset_id,
            request=request,
            result=result,
        )
        return response.asset_id
    if result.source_url:
        response = await asset_service.import_url(
            project_id=request.project_id,
            user_id="system",
            idempotency_key=request.idempotency_key,
            request=AssetImportRequest(
                source_url=result.source_url,
                asset_type="image",
                filename=result.filename,
            ),
        )
        await _persist_result_metadata(
            asset_service,
            project_id=request.project_id,
            asset_id=response.asset_id,
            request=request,
            result=result,
        )
        return response.asset_id
    raise ImageProviderError("image_result_invalid", "The image provider returned no image.")


async def _persist_result_metadata(
    asset_service: AssetService,
    *,
    project_id: str,
    asset_id: str,
    request: ImageRequest,
    result: ImageResult,
) -> None:
    values: dict[str, str] = {
        "title": request.visual.title,
        "default_alt_text": result.alt_text.strip(),
    }
    caption = str(result.caption or request.visual.caption or "").strip()
    if caption:
        values["caption"] = caption
    await asset_service.update_metadata(
        project_id=project_id,
        asset_id=asset_id,
        user_id="system",
        request=AssetUpdateRequest(**values),
    )
    provider_metadata: dict[str, object] = {
        "visual_id": result.visual_id,
        "provider": result.provider,
        "source_strategy": request.visual.source_strategy,
    }
    optional_values = {
        "source_url": result.source_url,
        "license_name": result.license_name,
        "creator_name": result.creator_name,
        "attribution_url": result.attribution_url,
        "generation_request_id": result.generation_request_id,
        "generation_prompt": result.generation_prompt,
        "model_name": result.model_name,
        "captured_at": result.captured_at,
        "viewport_width": result.viewport_width,
        "viewport_height": result.viewport_height,
        "cost_usd": str(result.cost_usd) if result.cost_usd is not None else None,
    }
    provider_metadata.update(
        {key: value for key, value in optional_values.items() if value is not None}
    )
    if result.provider == "chart":
        provider_metadata["data_claim_ids"] = list(request.visual.data_claim_ids)
        provider_metadata["chart_data"] = [
            item.model_dump(mode="json") for item in request.visual.chart_data
        ]
    await asset_service.update_provider_metadata(
        project_id=project_id,
        asset_id=asset_id,
        user_id="system",
        provider_metadata=provider_metadata,
    )


async def _load_reusable_visual(
    store: S3ArtifactStore,
    *,
    result_reference: str,
    idempotency_key: str,
    visual: VisualPlanItem,
    allowed_strategies: set[str],
    asset_service: AssetService,
    project_id: str,
) -> ResolvedVisual | None:
    try:
        artifact = await store.read_json(result_reference)
    except StoredTextNotFoundError:
        return None
    if (
        artifact.get("kind") != "resolved_visual"
        or artifact.get("idempotency_key") != idempotency_key
        or not isinstance(artifact.get("visual"), dict)
    ):
        return None
    cached = ResolvedVisual.model_validate(artifact["visual"])
    if (
        cached.status != "ready"
        or not cached.asset_id
        or cached.visual_id != visual.visual_id
        or cached.section_id != visual.section_id
        or cached.source_strategy not in allowed_strategies
    ):
        return None
    asset = await wait_for_ready_asset(
        asset_service,
        project_id=project_id,
        asset_id=cached.asset_id,
    )
    return cached.model_copy(
        update={
            "asset_id": asset.asset_id,
            "width": cached.width or asset.width,
            "height": cached.height or asset.height,
        }
    )


async def _find_idempotent_asset(
    repository: AssetRepository,
    *,
    project_id: str,
    strategies: list[str],
    idempotency_key: str,
) -> tuple[Any, str] | None:
    imported = await repository.find_import_by_idempotency(
        project_id, "system", idempotency_key
    )
    if imported is not None:
        metadata = dict(imported.provider_metadata or {})
        source_strategy = str(metadata.get("source_strategy") or "")
        if source_strategy not in strategies:
            source_strategy = strategies[0]
        return imported, source_strategy
    for strategy in strategies:
        ingested = await repository.find_ingested_by_idempotency(
            project_id, "system", strategy, idempotency_key
        )
        if ingested is not None:
            return ingested, strategy
    return None


async def _resolved_from_idempotent_asset(
    visual: VisualPlanItem,
    asset_id: str,
    *,
    source_strategy: str,
    asset_service: AssetService,
    project_id: str,
    started_at: float,
) -> ResolvedVisual:
    asset = await wait_for_ready_asset(
        asset_service,
        project_id=project_id,
        asset_id=asset_id,
    )
    alt_text = str(
        asset.default_alt_text or asset.title or asset.caption or asset.description or ""
    ).strip()
    if not alt_text:
        raise ImageProviderError(
            "cached_image_metadata_missing",
            "The reusable image has no descriptive metadata.",
        )
    return ResolvedVisual(
        visual_id=visual.visual_id,
        section_id=visual.section_id,
        asset_id=asset.asset_id,
        status="ready",
        required=visual.required,
        alt_text=alt_text,
        caption=asset.caption or visual.caption,
        provider=source_strategy,
        source_strategy=source_strategy,
        elapsed_ms=_elapsed_ms(started_at),
        width=asset.width,
        height=asset.height,
        alt_source=(
            "default_alt_text"
            if asset.default_alt_text
            else "title" if asset.title else "caption" if asset.caption else "description"
        ),
        source_url=asset.final_source_url or asset.source_url,
        reused=True,
    )


async def wait_for_ready_asset(
    asset_service: AssetService,
    *,
    project_id: str,
    asset_id: str,
    timeout_seconds: float = IMAGE_PROCESSING_TIMEOUT_SECONDS,
    poll_seconds: float = IMAGE_PROCESSING_POLL_SECONDS,
) -> Any:
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        asset = await asset_service.get_asset(project_id, asset_id)
        if asset.status == "ready":
            return asset
        if asset.status in {"failed", "quarantined", "pending_delete", "deleted"}:
            raise ImageProviderError(
                asset.failure_code or "image_processing_failed",
                "The image did not pass asset processing.",
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ImageProviderError(
                "image_processing_timeout",
                "The image was not ready before the bounded wait ended.",
            )
        await asyncio.sleep(min(max(0.01, poll_seconds), remaining))


def _visual_idempotency_key(
    context: dict[str, Any],
    visual: VisualPlanItem,
    *,
    strategies: list[str] | None = None,
) -> str:
    providers = strategies or [visual.source_strategy]
    payload = {
        "project_id": str(context["project_id"]),
        "visual_id": visual.visual_id,
        "providers": providers,
        # Re-render charts when registration or deterministic presentation changes.
        "chart_registration_revision": 3 if "chart" in providers else 1,
        "prompt": " ".join(str(visual.prompt or "").split()),
        "aspect_ratio": visual.aspect_ratio,
        "target_url": visual.target_url,
        "data_claim_ids": visual.data_claim_ids,
        "chart_data": [item.model_dump(mode="json") for item in visual.chart_data],
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"article-visual:{digest}"


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.monotonic() - started_at) * 1000))


def _artifact_segment(visual_id: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]", "-", visual_id).strip(".-")
    if normalized and normalized == visual_id:
        return normalized
    digest = hashlib.sha256(visual_id.encode("utf-8")).hexdigest()[:12]
    return f"visual-{digest}"


def _result_reference(settings: Settings, run_id: str, visual_id: str) -> str:
    return (
        f"s3://{settings.s3_bucket}/article-runs/{run_id}/visuals/"
        f"{_artifact_segment(visual_id)}/result.json.gz"
    )


def _image_usage(resolved: list[ResolvedVisual]) -> dict[str, Any] | None:
    costs = [item.cost_usd for item in resolved if item.cost_usd is not None]
    if not costs:
        return None
    return {
        "reported_cost": float(sum(costs, Decimal("0"))),
        "cost_currency": "USD",
        "image_count": len(costs),
    }
