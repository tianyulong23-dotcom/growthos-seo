from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Any

from temporalio import activity
from temporalio.exceptions import is_cancelled_exception

from app.core.config import get_settings
from app.db.session import session_factory
from app.modules.content.collection import (
    collect_competitors,
    collect_sources,
    prepare_project,
)
from app.modules.content.generation import (
    check_article,
    finalize_article_artifact,
    plan_article,
    recover_generation_stage,
    revise_article_sections,
    unify_article,
    write_article_sections,
)
from app.modules.content.ai_edit import (
    AIEditValidationError,
    canonical_hash,
    prompt_for,
    rekey_candidate_slice,
    validate_candidate,
)
from app.modules.content.ai_edit_provider import (
    ConfiguredAIEditProvider,
    DeterministicAIEditProvider,
    normalize_provider_error,
)
from app.modules.content.ai_edit_repository import AIEditRepository
from app.modules.content.ai_edit_service import model_config_snapshot
from app.modules.content.asset_repository import AssetRepository
from app.modules.content.asset_service import build_asset_service
from app.modules.content.document import extract_asset_manifest, markdown_to_document
from app.modules.content.object_storage import S3ArtifactStore
from app.modules.content.quality import markdown_to_html
from app.modules.content.repository import ContentRepository
from app.modules.content.visual_assembly import (
    assemble_visual_document,
    validate_article_visuals,
)
from app.modules.content.visual_generation import resolve_visuals
from app.modules.settings.service import (
    AIProviderNotConfiguredError,
    build_ai_settings_service,
)


DEGRADATION_MESSAGES = {
    "preparing": "部分项目资料暂不可用，已使用现有资料继续",
    "collecting": "部分外部资料暂不可用，已使用现有资料继续",
    "competitor_research": "竞争文章不足，已使用搜索摘要和现有研究继续",
    "planning": "大纲增强暂不可用，已使用基础结构继续",
    "writing": "部分章节已按精简版本完成",
    "editing": "全文编辑暂不可用，已保留合并后的完整稿",
    "checking": "检查服务暂不可用，已保存检查前完整稿",
    "revising": "局部修订暂不可用，已保存修订前完整稿",
    "visual_resolving": "未找到可用图片，正文已继续生成",
    "visual_assembling": "图片插入暂不可用，已保留完整正文",
    "visual_checking": "图片检查暂不可用，已保留完整正文",
}


def repository() -> ContentRepository:
    return ContentRepository(session_factory)


def ai_edit_repository() -> AIEditRepository:
    return AIEditRepository(session_factory)


def worker_identity() -> str:
    try:
        info = activity.info()
        return f"{info.workflow_id}:{info.activity_id}:{info.attempt}"
    except RuntimeError:
        return "direct-test-worker"


def budget_policy(
    target_remaining_seconds: float, hard_remaining_seconds: float | None = None
) -> dict[str, bool]:
    hard_remaining = (
        target_remaining_seconds if hard_remaining_seconds is None else hard_remaining_seconds
    )
    return {
        "hard_budget_reached": hard_remaining <= 0,
    }


def budget_policy_for_context(context: dict[str, Any]) -> dict[str, bool]:
    now = datetime.now(UTC)
    soft_deadline = context.get("soft_deadline_at")
    hard_deadline = context.get("hard_deadline_at")
    settings = get_settings()
    target_remaining = (
        (soft_deadline - now).total_seconds()
        if soft_deadline is not None
        else float(settings.content_target_seconds)
    )
    hard_remaining = (
        (hard_deadline - now).total_seconds()
        if hard_deadline is not None
        else float(settings.content_hard_timeout_seconds)
    )
    return budget_policy(target_remaining, hard_remaining)


def degraded_stage_result(step_key: str) -> dict[str, Any]:
    return {
        "warning": {
            "code": f"{step_key}_degraded",
            "message": DEGRADATION_MESSAGES[step_key],
        }
    }


def costed_usage(usage: dict[str, Any] | None) -> dict[str, Any]:
    normalized = dict(usage or {})
    reported = normalized.get("reported_cost", normalized.get("cost"))
    normalized.pop("cost", None)
    if reported is not None:
        normalized["reported_cost"] = float(reported)
    input_tokens = int(
        normalized.get(
            "unreported_input_tokens",
            normalized.get("input_tokens") if reported is None else 0,
        )
        or 0
    )
    output_tokens = int(
        normalized.get(
            "unreported_output_tokens",
            normalized.get("output_tokens") if reported is None else 0,
        )
        or 0
    )
    settings = get_settings()
    input_rate = float(settings.article_model_input_cost_per_million)
    output_rate = float(settings.article_model_output_cost_per_million)
    if (input_tokens or output_tokens) and (input_rate or output_rate):
        normalized["estimated_cost"] = (
            input_tokens * input_rate + output_tokens * output_rate
        ) / 1_000_000
        normalized["cost_currency"] = "USD"
        normalized["estimation_basis"] = {
            "method": "token_rate_v1",
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "input_cost_per_million": input_rate,
            "output_cost_per_million": output_rate,
        }
    else:
        normalized["estimated_cost"] = None
        normalized["estimation_basis"] = {}
    return normalized


async def execute_stage_work(
    step_key: str, context: dict[str, Any], policy: dict[str, bool]
) -> dict[str, Any]:
    repo = repository()
    stage_kind = str(context.get("stage_kind") or step_key)
    if stage_kind == "preparing":
        return await prepare_project(repo, str(context["run_id"]))
    if stage_kind == "collecting":
        return await collect_sources(repo, get_settings(), context)
    if stage_kind == "competitor_research":
        return await collect_competitors(repo, get_settings(), context)
    if stage_kind == "visual_resolving":
        return await resolve_visuals(
            settings=get_settings(),
            context=context,
            asset_repository=AssetRepository(session_factory),
            asset_service=build_asset_service(get_settings()),
        )
    if stage_kind == "visual_assembling":
        return await _assemble_visual_stage(get_settings(), context)
    if stage_kind == "visual_checking":
        return await _check_visual_stage(get_settings(), context)
    handlers = {
        "planning": plan_article,
        "writing": write_article_sections,
        "editing": unify_article,
        "checking": check_article,
        "revising": revise_article_sections,
    }
    return await handlers[stage_kind](repo, get_settings(), context, policy)


async def recover_stage_work(
    step_key: str, context: dict[str, Any], policy: dict[str, bool]
) -> dict[str, Any]:
    stage_kind = str(context.get("stage_kind") or step_key)
    run_id = str(context["run_id"])
    if stage_kind == "preparing":
        return {
            "output_ref": f"db://article-runs/{run_id}/project-snapshot",
            **degraded_stage_result(stage_kind),
            "summary": {"snapshot_fields": sorted(context.get("project_snapshot") or {})},
        }
    if stage_kind == "collecting":
        return {
            "output_ref": f"db://article-runs/{run_id}/sources",
            **degraded_stage_result(stage_kind),
            "summary": {"recovered": True},
        }
    if stage_kind == "competitor_research":
        return {
            "output_ref": f"db://article-runs/{run_id}/competitors",
            **degraded_stage_result(stage_kind),
            "summary": {"available": 0, "recovered": True},
        }
    if stage_kind == "visual_resolving":
        store = S3ArtifactStore(get_settings())
        output_ref = await store.write_json(
            f"article-runs/{run_id}/visuals/resolved.json.gz",
            {"kind": "resolved_visuals", "visuals": []},
        )
        return {
            "output_ref": output_ref,
            **degraded_stage_result(stage_kind),
            "summary": {"planned_count": 0, "ready_count": 0, "omitted_count": 0},
        }
    if stage_kind == "visual_assembling":
        return await _recover_visual_assembly_stage(get_settings(), context)
    if stage_kind == "visual_checking":
        return await _recover_visual_check_stage(get_settings(), context)
    return await recover_generation_stage(repository(), get_settings(), context, policy, stage_kind)


async def _assemble_visual_stage(
    settings: Any, context: dict[str, Any]
) -> dict[str, Any]:
    completed = context["completed_steps"]
    text_step = str(context.get("input_step_key") or "checking_1")
    text_artifact = await S3ArtifactStore(settings).read_json(
        str(completed[text_step]["output_ref"])
    )
    text_artifact, final_warnings = finalize_article_artifact(text_artifact)
    visual_artifact = await S3ArtifactStore(settings).read_json(
        str(completed["visual_resolving"]["output_ref"])
    )
    assembled = assemble_visual_document(text_artifact, visual_artifact)
    output_ref = await S3ArtifactStore(settings).write_json(
        f"article-runs/{context['run_id']}/visuals/assembled.json.gz",
        assembled,
    )
    return {
        "output_ref": output_ref,
        "warnings": final_warnings,
        "summary": {
            "image_count": len(assembled.get("asset_manifest") or []),
            "complete": True,
        },
        "usage": None,
    }


async def _check_visual_stage(
    settings: Any, context: dict[str, Any]
) -> dict[str, Any]:
    completed = context["completed_steps"]
    input_step = str(context.get("input_step_key") or "visual_assembling")
    store = S3ArtifactStore(settings)
    artifact = await store.read_json(str(completed[input_step]["output_ref"]))
    result = validate_article_visuals(artifact)
    artifact["visual_quality"] = result
    output_ref = await store.write_json(
        f"article-runs/{context['run_id']}/visuals/checked.json.gz",
        artifact,
    )
    if result["required_missing_count"]:
        raise ValueError("required_visual_missing")
    warnings = (
        [{"code": "visual_quality_warnings", "message": "部分可选图片未通过检查，已省略"}]
        if result["issues"]
        else []
    )
    return {
        "output_ref": output_ref,
        "warnings": warnings,
        "summary": result,
        "usage": None,
    }


async def _recover_visual_assembly_stage(
    settings: Any, context: dict[str, Any]
) -> dict[str, Any]:
    completed = context["completed_steps"]
    text_step = str(context.get("input_step_key") or "checking_1")
    store = S3ArtifactStore(settings)
    artifact = await store.read_json(str(completed[text_step]["output_ref"]))
    artifact, final_warnings = finalize_article_artifact(artifact)
    if not isinstance(artifact.get("document"), dict):
        artifact["document"] = markdown_to_document(str(artifact.get("markdown") or ""))
    artifact["asset_manifest"] = extract_asset_manifest(artifact["document"])
    artifact["visuals"] = []
    output_ref = await store.write_json(
        f"article-runs/{context['run_id']}/visuals/assembled.json.gz",
        artifact,
    )
    return {
        "output_ref": output_ref,
        **degraded_stage_result("visual_assembling"),
        "warnings": final_warnings,
        "summary": {"image_count": 0, "complete": True, "degraded": True},
        "usage": None,
    }


async def _recover_visual_check_stage(
    settings: Any, context: dict[str, Any]
) -> dict[str, Any]:
    completed = context["completed_steps"]
    input_step = str(context.get("input_step_key") or "visual_assembling")
    store = S3ArtifactStore(settings)
    artifact = await store.read_json(str(completed[input_step]["output_ref"]))
    visuals = [item for item in artifact.get("visuals") or [] if isinstance(item, dict)]
    resolved_by_id = {
        str(item.get("visual_id") or ""): item
        for item in visuals
        if item.get("visual_id")
    }
    planned_visuals = (
        artifact.get("plan", {}).get("visuals", [])
        if isinstance(artifact.get("plan"), dict)
        else []
    )
    required_ids = {
        str(item.get("visual_id") or "")
        for item in planned_visuals
        if isinstance(item, dict) and bool(item.get("required")) and item.get("visual_id")
    }
    required_ids.update(
        str(item.get("visual_id") or "")
        for item in visuals
        if bool(item.get("required")) and item.get("visual_id")
    )
    required_missing = [
        visual_id
        for visual_id in sorted(required_ids)
        if str(resolved_by_id.get(visual_id, {}).get("status") or "") != "ready"
    ]
    if required_missing:
        raise ValueError("required_visual_missing")
    manifest = (
        list(artifact.get("asset_manifest") or [])
        if isinstance(artifact.get("asset_manifest"), list)
        else extract_asset_manifest(artifact["document"])
    )
    artifact["visual_quality"] = {
        "passed": True,
        "issues": [{"code": "visual_check_unavailable"}],
        "manifest": manifest,
        "ready_count": sum(item.get("status") == "ready" for item in visuals),
        "required_missing_count": 0,
        "degraded": True,
    }
    output_ref = await store.write_json(
        f"article-runs/{context['run_id']}/visuals/checked.json.gz",
        artifact,
    )
    return {
        "output_ref": output_ref,
        **degraded_stage_result("visual_checking"),
        "summary": artifact["visual_quality"],
        "usage": None,
    }


@activity.defn(name="content_begin_run")
async def begin_run(payload: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    run = await repository().begin_run(
        str(payload["run_id"]),
        settings.content_target_seconds,
        settings.content_hard_timeout_seconds,
    )
    return {"status": run.status if run is not None else "missing"}


@activity.defn(name="content_execute_stage")
async def execute_stage(payload: dict[str, Any]) -> dict[str, Any]:
    run_id = str(payload["run_id"])
    step_key = str(payload["step_key"])
    progress = int(payload["progress"])
    stage_kind = str(payload.get("stage_kind") or step_key)
    repo = repository()
    context = await repo.get_run_context(run_id)
    if context is None:
        return {"status": "missing"}
    if context["status"] in {"failed", "cancelled"}:
        return {"status": context["status"]}

    policy = budget_policy_for_context(context)
    context = {
        **context,
        "run_id": run_id,
        "step_key": step_key,
        "stage_kind": stage_kind,
        "input_step_key": payload.get("input_step_key"),
        "repair_iteration": int(payload.get("repair_iteration") or 0),
    }
    owner = worker_identity()
    claim, step = await repo.claim_step(
        run_id,
        step_key,
        owner,
        lease_seconds=get_settings().content_execution_lease_seconds,
    )
    if claim == "completed" and step is not None:
        summary = dict(step.summary_json)
        return {
            "status": "completed",
            "warning": summary.get("warning"),
            "warnings": list(summary.get("warnings", [])),
            "result": dict(summary.get("result") or {}),
            "hard_budget_reached": bool(summary.get("hard_budget_reached")),
        }
    if claim == "busy":
        return {
            "status": "busy",
            "retry_after_seconds": _lease_retry_after_seconds(step),
        }
    if claim != "claimed":
        return {"status": claim}

    await repo.set_stage(run_id, stage_kind, progress)
    started = time.monotonic()
    heartbeat = asyncio.create_task(_heartbeat_step(repo, run_id, step_key, owner))
    try:
        try:
            output = await execute_stage_work(step_key, context, policy)
        except Exception as exc:
            if is_cancelled_exception(exc):
                raise
            output = await recover_stage_work(step_key, context, policy)
    except Exception as exc:
        if is_cancelled_exception(exc):
            raise
        await repo.fail_step(run_id, step_key, owner, f"{stage_kind}_recovery_failed")
        raise
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
    usage = costed_usage(output.get("usage"))
    summary = {
        "stage": stage_kind,
        "policy": policy,
        "warning": output.get("warning"),
        "warnings": list(output.get("warnings", [])),
        "result": dict(output.get("summary", {})),
        "hard_budget_reached": bool(policy["hard_budget_reached"]),
        "usage": usage,
    }
    await repo.complete_step(
        run_id,
        step_key,
        owner,
        summary=summary,
        output_ref=output.get("output_ref"),
        warning_code=(
            (output.get("warning") or {}).get("code")
            or next(
                (item.get("code") for item in output.get("warnings", []) if item.get("code")),
                None,
            )
        ),
        duration_ms=int((time.monotonic() - started) * 1000),
        usage=usage,
    )
    return {"status": "completed", **summary}


async def _heartbeat_step(repo: ContentRepository, run_id: str, step_key: str, owner: str) -> None:
    lease_seconds = get_settings().content_execution_lease_seconds
    interval = max(5, min(30, lease_seconds // 3))
    while True:
        try:
            activity.heartbeat({"run_id": run_id, "step_key": step_key})
        except RuntimeError:
            pass
        renew = getattr(repo, "renew_step_lease", None)
        if renew is not None:
            try:
                await renew(run_id, step_key, owner, lease_seconds)
            except Exception:
                pass
        await asyncio.sleep(interval)


def _lease_retry_after_seconds(step: Any | None) -> int:
    expires_at = getattr(step, "lease_expires_at", None)
    if expires_at is None:
        return 1
    remaining = (expires_at - datetime.now(UTC)).total_seconds()
    return max(1, int(remaining) + 1)


@activity.defn(name="content_recover_stage")
async def recover_stage(payload: dict[str, Any]) -> dict[str, Any]:
    run_id = str(payload["run_id"])
    step_key = str(payload["step_key"])
    stage_kind = str(payload.get("stage_kind") or step_key)
    repo = repository()
    context = await repo.get_run_context(run_id)
    if context is None:
        return {"status": "missing"}
    if context["status"] in {"failed", "cancelled"}:
        return {"status": context["status"]}
    context = {
        **context,
        "run_id": run_id,
        "step_key": step_key,
        "stage_kind": stage_kind,
        "input_step_key": payload.get("input_step_key"),
        "repair_iteration": int(payload.get("repair_iteration") or 0),
    }
    owner = worker_identity()
    claim, step = await repo.force_claim_step(
        run_id,
        step_key,
        owner,
        lease_seconds=get_settings().content_execution_lease_seconds,
    )
    if claim == "completed" and step is not None:
        summary = dict(step.summary_json)
        return {
            "status": "completed",
            "warning": summary.get("warning"),
            "warnings": list(summary.get("warnings", [])),
            "result": dict(summary.get("result") or {}),
            "hard_budget_reached": bool(summary.get("hard_budget_reached")),
        }
    if claim == "busy":
        return {
            "status": "busy",
            "retry_after_seconds": _lease_retry_after_seconds(step),
        }
    if claim != "claimed":
        return {"status": claim}
    policy = budget_policy_for_context(context)
    heartbeat = asyncio.create_task(_heartbeat_step(repo, run_id, step_key, owner))
    try:
        output = await recover_stage_work(step_key, context, policy)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
    usage = costed_usage(output.get("usage"))
    summary = {
        "stage": stage_kind,
        "policy": policy,
        "warning": output.get("warning"),
        "warnings": list(output.get("warnings", [])),
        "result": dict(output.get("summary", {})),
        "hard_budget_reached": bool(policy["hard_budget_reached"]),
        "usage": usage,
    }
    await repo.complete_step(
        run_id,
        step_key,
        owner,
        summary=summary,
        output_ref=output.get("output_ref"),
        warning_code=(output.get("warning") or {}).get("code"),
        usage=usage,
    )
    return {"status": "completed", **summary}


@activity.defn(name="content_finish_run")
async def finish_run(payload: dict[str, Any]) -> None:
    repo = repository()
    run_id = str(payload["run_id"])
    context = await repo.get_run_context(run_id)
    if context is None or context["status"] in {"failed", "cancelled"}:
        return
    completed = context["completed_steps"]
    requested_final_step = str(payload.get("final_step_key") or "")
    final_step = (
        requested_final_step
        if completed.get(requested_final_step, {}).get("output_ref")
        else next(
            (
                key
                for key in (
                    "visual_checking",
                    "visual_assembling",
                    "checking_4",
                    "revising_3",
                    "checking_3",
                    "revising_2",
                    "checking_2",
                    "revising_1",
                    "checking_1",
                    "editing",
                    "writing",
                )
                if completed.get(key, {}).get("output_ref")
            ),
            None,
        )
    )
    if final_step is None:
        raise LookupError("article_complete_draft_missing")
    settings = get_settings()
    store = S3ArtifactStore(settings)
    artifact = await store.read_json(str(completed[final_step]["output_ref"]))
    artifact, final_warnings = finalize_article_artifact(artifact)
    markdown = str(artifact.get("markdown") or "")
    if not markdown.strip():
        raise LookupError("article_complete_draft_missing")
    final_content_ref = await store.write_text(f"article-runs/{run_id}/final/article.md", markdown)
    await repo.finish_run(
        run_id,
        str(payload["status"]),
        [*list(payload.get("warnings", [])), *final_warnings],
        artifact=artifact,
        html=markdown_to_html(markdown),
        final_content_ref=final_content_ref,
    )


@activity.defn(name="content_fail_run")
async def fail_run(payload: dict[str, Any]) -> dict[str, str]:
    await repository().fail_run(
        str(payload["run_id"]),
        error_code=str(payload["error_code"]),
        error_detail=str(payload.get("error_detail") or ""),
        failed_stage=str(payload.get("failed_stage") or "unknown"),
        retryable=bool(payload.get("retryable")),
    )
    return {"status": "failed"}


@activity.defn(name="article_ai_edit_execute")
async def article_ai_edit_execute(payload: dict[str, Any]) -> dict[str, str]:
    if set(payload) != {"operation_id"}:
        raise ValueError("article_ai_edit_execute only accepts operation_id")
    operation_id = str(payload["operation_id"])
    repo = ai_edit_repository()
    operation = await repo.get_for_worker(operation_id)
    settings = get_settings()
    started_at = time.monotonic()
    attempt = activity.info().attempt
    try:
        if settings.article_ai_edit_provider_mode == "deterministic_fake":
            provider = DeterministicAIEditProvider(
                command=operation.command,
                payload=operation.input_payload_json,
            )
            provider_name = provider.name
            model = provider.model
            expected = dict(operation.model_config_json)
            if expected.get("provider") != provider_name or expected.get("model") != model:
                raise AIEditValidationError("ai_edit_provider_configuration_changed")
        else:
            record = await build_ai_settings_service().effective_record_for_organization(
                operation.organization_id
            )
            record = record.for_task("content")
            if model_config_snapshot(record) != operation.model_config_json:
                raise AIEditValidationError("ai_edit_provider_configuration_changed")
            provider = ConfiguredAIEditProvider(record)
            provider_name = provider.name
            model = provider.model

        running = await repo.worker_start(
            operation_id,
            provider=provider_name,
            model=model,
            retry=attempt > 1,
        )
        if running is None:
            current = await repo.get_for_worker(operation_id)
            return {"status": current.status}

        system, user = prompt_for(operation.command, operation.input_payload_json)
        raw = ""
        input_tokens = 0
        output_tokens = 0
        async for chunk in provider.stream(system, user):
            activity.heartbeat({"stream_revision": running.stream_revision})
            if chunk.text:
                raw += chunk.text
                if not await repo.append_chunk(operation_id, chunk.text):
                    current = await repo.get_for_worker(operation_id)
                    return {"status": current.status}
            input_tokens = max(input_tokens, chunk.input_tokens)
            output_tokens = max(output_tokens, chunk.output_tokens)
        text, metadata, slice_value = validate_candidate(operation.command, raw)
        if slice_value is not None:
            slice_value = rekey_candidate_slice(slice_value, operation.id)
        completed = await repo.worker_complete(
            operation_id,
            candidate_text=text,
            candidate_metadata=metadata,
            candidate_slice=slice_value,
            output_hash=canonical_hash({"text": text, "metadata": metadata, "slice": slice_value}),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=int((time.monotonic() - started_at) * 1000),
        )
        return {"status": "ready" if completed else "cancelled"}
    except asyncio.CancelledError:
        current = await repo.get_for_worker(operation_id)
        if current.status in {"queued", "streaming"}:
            await repo.worker_fail(
                operation_id,
                code="ai_edit_cancel_interrupted",
                detail="AI edit cancellation was interrupted",
                latency_ms=int((time.monotonic() - started_at) * 1000),
            )
        raise
    except Exception as exc:
        if isinstance(exc, AIProviderNotConfiguredError):
            code, detail, retryable = (
                "ai_edit_provider_not_configured",
                "AI provider is not configured",
                False,
            )
        elif isinstance(exc, AIEditValidationError):
            code, detail, retryable = str(exc), "AI edit candidate is invalid", False
        else:
            code, detail, retryable = normalize_provider_error(exc)
        if retryable and attempt < 3:
            raise
        await repo.worker_fail(
            operation_id,
            code=code,
            detail=detail,
            latency_ms=int((time.monotonic() - started_at) * 1000),
        )
        return {"status": "failed"}


CONTENT_ACTIVITIES = [
    begin_run,
    execute_stage,
    recover_stage,
    finish_run,
    fail_run,
    article_ai_edit_execute,
]
