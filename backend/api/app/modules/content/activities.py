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
from app.modules.content.object_storage import S3ArtifactStore
from app.modules.content.quality import markdown_to_html
from app.modules.content.repository import ContentRepository


DEGRADATION_MESSAGES = {
    "preparing": "部分项目资料暂不可用，已使用现有资料继续",
    "collecting": "部分外部资料暂不可用，已使用现有资料继续",
    "competitor_research": "竞争文章不足，已使用搜索摘要和现有研究继续",
    "planning": "大纲增强暂不可用，已使用基础结构继续",
    "writing": "部分章节已按精简版本完成",
    "editing": "全文编辑暂不可用，已保留合并后的完整稿",
    "checking": "检查服务暂不可用，已保存检查前完整稿",
    "revising": "局部修订暂不可用，已保存修订前完整稿",
}


def repository() -> ContentRepository:
    return ContentRepository(session_factory)


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
        target_remaining_seconds
        if hard_remaining_seconds is None
        else hard_remaining_seconds
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
    return await recover_generation_stage(
        repository(), get_settings(), context, policy, stage_kind
    )


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
    if context["status"] == "cancelled":
        return {"status": "cancelled"}

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
        return {"status": "busy"}
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
                (
                    item.get("code")
                    for item in output.get("warnings", [])
                    if item.get("code")
                ),
                None,
            )
        ),
        duration_ms=int((time.monotonic() - started) * 1000),
        usage=usage,
    )
    return {"status": "completed", **summary}


async def _heartbeat_step(
    repo: ContentRepository, run_id: str, step_key: str, owner: str
) -> None:
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


@activity.defn(name="content_recover_stage")
async def recover_stage(payload: dict[str, Any]) -> dict[str, Any]:
    run_id = str(payload["run_id"])
    step_key = str(payload["step_key"])
    stage_kind = str(payload.get("stage_kind") or step_key)
    repo = repository()
    context = await repo.get_run_context(run_id)
    if context is None:
        return {"status": "missing"}
    if context["status"] == "cancelled":
        return {"status": "cancelled"}
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
        return {"status": "busy"}
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
    if context is None or context["status"] == "cancelled":
        return
    completed = context["completed_steps"]
    final_step = next(
        (
            key
            for key in (
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
    if final_step is None:
        raise LookupError("article_complete_draft_missing")
    settings = get_settings()
    store = S3ArtifactStore(settings)
    artifact = await store.read_json(str(completed[final_step]["output_ref"]))
    artifact, final_warnings = finalize_article_artifact(artifact)
    markdown = str(artifact.get("markdown") or "")
    if not markdown.strip():
        raise LookupError("article_complete_draft_missing")
    final_content_ref = await store.write_text(
        f"article-runs/{run_id}/final/article.md", markdown
    )
    await repo.finish_run(
        run_id,
        str(payload["status"]),
        [*list(payload.get("warnings", [])), *final_warnings],
        artifact=artifact,
        html=markdown_to_html(markdown),
        final_content_ref=final_content_ref,
    )


CONTENT_ACTIVITIES = [begin_run, execute_stage, recover_stage, finish_run]
