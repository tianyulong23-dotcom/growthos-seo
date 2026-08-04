from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ApplicationError


SHORT_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    backoff_coefficient=2,
    maximum_interval=timedelta(seconds=20),
    maximum_attempts=5,
)

METERED_ACTIVITY_RETRY = RetryPolicy(
    maximum_attempts=1,
)
ACTIVITY_SCHEDULE_TO_START = timedelta(minutes=2)
CONTROL_ACTIVITY_SCHEDULE_TO_START = timedelta(minutes=1)
MAX_IMMEDIATE_RECOVERIES = 4
DELAYED_RETRY_SECONDS = 3600
METRIC_REFRESH_MAX_ATTEMPTS = 3

NO_DATA_ERRORS = {
    "active_seeds_empty",
    "expanded_keywords_empty",
    "seed_candidates_empty",
    "site_seed_empty",
}
NO_DATA_BACKGROUND_RETRY_PATCH = "keyword-no-data-background-retry-v1"
CONFIGURATION_ERRORS = {
    "ai_auth_failed",
    "ai_not_configured",
    "dataforseo_auth_failed",
    "dataforseo_not_configured",
}
PROJECT_CONFIGURATION_ERRORS = {
    "unsupported_country",
    "unsupported_language",
}
NON_RECOVERABLE_ERRORS = {"keyword_expansion_disabled"}


@dataclass(frozen=True)
class WorkflowFailure:
    code: str
    detail: str
    non_retryable: bool


@workflow.defn(name="KeywordBuildWorkflow")
class KeywordBuildWorkflow:
    @workflow.run
    async def run(self, task: dict[str, Any]) -> dict[str, Any]:
        primary_activities: list[Any] = []
        try:
            context = await workflow.execute_activity(
                "keyword_mark_started",
                task,
                start_to_close_timeout=timedelta(minutes=2),
                schedule_to_start_timeout=ACTIVITY_SCHEDULE_TO_START,
                retry_policy=SHORT_RETRY,
            )
            if str(context["kind"]) != "initial":
                raise ApplicationError(
                    "当前版本只支持初次关键词建库",
                    type="keyword_expansion_disabled",
                    non_retryable=True,
                )

            discovery = workflow.start_activity(
                "keyword_discover_seeds",
                task,
                start_to_close_timeout=timedelta(minutes=15),
                schedule_to_start_timeout=ACTIVITY_SCHEDULE_TO_START,
                heartbeat_timeout=timedelta(minutes=2),
                retry_policy=METERED_ACTIVITY_RETRY,
            )
            profile = workflow.start_activity(
                "keyword_acquire_business_profile",
                task,
                start_to_close_timeout=timedelta(minutes=12),
                schedule_to_start_timeout=ACTIVITY_SCHEDULE_TO_START,
                heartbeat_timeout=timedelta(minutes=2),
                retry_policy=METERED_ACTIVITY_RETRY,
            )
            primary_activities = [discovery, profile]
            discovery_result, profile_result = await asyncio.gather(
                discovery,
                profile,
            )

            seed_result = await workflow.execute_activity(
                "keyword_prepare_seeds",
                task,
                start_to_close_timeout=timedelta(minutes=20),
                schedule_to_start_timeout=ACTIVITY_SCHEDULE_TO_START,
                heartbeat_timeout=timedelta(minutes=2),
                retry_policy=METERED_ACTIVITY_RETRY,
            )
            metrics_result = await workflow.execute_activity(
                "keyword_prepare_topic_metrics",
                task,
                start_to_close_timeout=timedelta(minutes=15),
                schedule_to_start_timeout=ACTIVITY_SCHEDULE_TO_START,
                heartbeat_timeout=timedelta(minutes=2),
                retry_policy=METERED_ACTIVITY_RETRY,
            )
            commit_result = await workflow.execute_activity(
                "keyword_commit_topics",
                task,
                start_to_close_timeout=timedelta(minutes=10),
                schedule_to_start_timeout=ACTIVITY_SCHEDULE_TO_START,
                heartbeat_timeout=timedelta(minutes=2),
                retry_policy=SHORT_RETRY,
            )
            return {
                "discovery": discovery_result,
                "profile": profile_result,
                "topics": seed_result,
                "metrics": metrics_result,
                **commit_result,
            }
        except Exception as exc:
            for handle in primary_activities:
                if not handle.done():
                    handle.cancel()
            failure = workflow_error(exc)
            recovery_count = max(int(task.get("_recovery_count") or 0), 0)
            no_data = failure.code in NO_DATA_ERRORS
            legacy_empty_completion = no_data and not workflow.patched(
                NO_DATA_BACKGROUND_RETRY_PATCH
            )
            if legacy_empty_completion:
                try:
                    await workflow.execute_activity(
                        "keyword_complete_empty",
                        {
                            "task": task,
                            "code": failure.code,
                            "detail": failure.detail,
                        },
                        start_to_close_timeout=timedelta(minutes=2),
                        schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                        retry_policy=SHORT_RETRY,
                    )
                except Exception:
                    workflow.logger.exception("failed to persist legacy empty keyword result")
                    raise
                return {
                    "status": "completed",
                    "keyword_count": 0,
                    "reason": failure.code,
                }
            should_block = (
                failure.code in CONFIGURATION_ERRORS
                or failure.code in PROJECT_CONFIGURATION_ERRORS
                or (
                    failure.non_retryable
                    and not no_data
                    and failure.code not in NON_RECOVERABLE_ERRORS
                )
                or recovery_count >= MAX_IMMEDIATE_RECOVERIES
            )
            if should_block:
                retry_seconds = (
                    DELAYED_RETRY_SECONDS
                    if (no_data or not failure.non_retryable)
                    and failure.code not in CONFIGURATION_ERRORS
                    and failure.code not in PROJECT_CONFIGURATION_ERRORS
                    else None
                )
                try:
                    await workflow.execute_activity(
                        "keyword_block_run",
                        {
                            "task": task,
                            "code": failure.code,
                            "detail": failure.detail,
                            "retry_seconds": retry_seconds,
                        },
                        start_to_close_timeout=timedelta(minutes=2),
                        schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                        retry_policy=SHORT_RETRY,
                    )
                except Exception:
                    workflow.logger.exception("failed to persist blocked keyword run")
                    raise
                return {
                    "status": "blocked",
                    "reason": failure.code,
                    "retry_seconds": retry_seconds,
                }

            if no_data or failure.code not in NON_RECOVERABLE_ERRORS:
                retry_seconds = min(30 * (2 ** min(recovery_count, 5)), 900)
                try:
                    await workflow.execute_activity(
                        "keyword_defer_run",
                        {
                            "task": task,
                            "code": failure.code,
                            "detail": failure.detail,
                            "retry_seconds": retry_seconds,
                        },
                        start_to_close_timeout=timedelta(minutes=2),
                        schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                        retry_policy=SHORT_RETRY,
                    )
                except Exception:
                    workflow.logger.exception("failed to persist keyword workflow recovery")
                await workflow.sleep(timedelta(seconds=retry_seconds))
                next_task = dict(task)
                next_task["_recovery_count"] = recovery_count + 1
                workflow.continue_as_new(next_task)
            try:
                await workflow.execute_activity(
                    "keyword_fail_run",
                    {
                        "task": task,
                        "code": failure.code,
                        "detail": failure.detail,
                    },
                    start_to_close_timeout=timedelta(minutes=2),
                    schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                    retry_policy=SHORT_RETRY,
                )
            except Exception:
                workflow.logger.exception("failed to persist keyword workflow failure")
            raise


@workflow.defn(name="KeywordMetricsRecoveryWorkflow")
class KeywordMetricsRecoveryWorkflow:
    @workflow.run
    async def run(self, task: dict[str, Any]) -> dict[str, Any]:
        attempt = 0
        try:
            started = await workflow.execute_activity(
                "keyword_mark_metric_refresh_started",
                task,
                start_to_close_timeout=timedelta(minutes=2),
                schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                retry_policy=SHORT_RETRY,
            )
            attempt = max(int(started.get("attempt") or 0), 0)
            if not bool(started.get("started", True)):
                return {
                    "status": str(started.get("status") or "completed"),
                    "attempt": attempt,
                }
            result = await workflow.execute_activity(
                "keyword_refresh_pending_metrics",
                {"task": task, "attempt": attempt},
                start_to_close_timeout=timedelta(minutes=10),
                schedule_to_start_timeout=ACTIVITY_SCHEDULE_TO_START,
                heartbeat_timeout=timedelta(minutes=2),
                retry_policy=METERED_ACTIVITY_RETRY,
            )
            pending_count = int(result.get("pending_metrics_count") or 0)
            failed_count = int(result.get("failed") or 0)
            if pending_count > 0 and bool(result.get("retryable")):
                if attempt < METRIC_REFRESH_MAX_ATTEMPTS:
                    scheduled = await workflow.execute_activity(
                        "keyword_schedule_metric_refresh_retry",
                        {
                            "task": task,
                            "attempt": attempt,
                            "code": str(
                                result.get("failure_code")
                                or "keyword_metrics_unavailable"
                            ),
                            "detail": "关键词指标暂时未完整返回",
                        },
                        start_to_close_timeout=timedelta(minutes=2),
                        schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                        retry_policy=SHORT_RETRY,
                    )
                    return {"status": "waiting", "attempt": attempt, **scheduled}
                result = await self._settle(
                    task,
                    code="keyword_metrics_retries_exhausted",
                    detail="关键词指标自动恢复次数已用完",
                )
                failed_count = int(result.get("failed") or 0)
                pending_count = int(result.get("pending_metrics_count") or 0)
            elif pending_count > 0:
                result = await self._settle(
                    task,
                    code=str(
                        result.get("failure_code")
                        or "keyword_metrics_not_recoverable"
                    ),
                    detail="关键词指标无法继续自动补充",
                )
                failed_count = int(result.get("failed") or 0)
                pending_count = int(result.get("pending_metrics_count") or 0)

            exhausted = failed_count > 0 or pending_count > 0
            await workflow.execute_activity(
                "keyword_finish_metric_refresh_job",
                {
                    "task": task,
                    "exhausted": exhausted,
                    "code": "keyword_metrics_incomplete" if exhausted else "",
                    "detail": "部分关键词没有可用的完整指标" if exhausted else "",
                },
                start_to_close_timeout=timedelta(minutes=2),
                schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                retry_policy=SHORT_RETRY,
            )
            return {
                "status": "exhausted" if exhausted else "completed",
                "attempt": attempt,
                **result,
            }
        except Exception as exc:
            failure = workflow_error(exc)
            if 0 < attempt < METRIC_REFRESH_MAX_ATTEMPTS:
                try:
                    scheduled = await workflow.execute_activity(
                        "keyword_schedule_metric_refresh_retry",
                        {
                            "task": task,
                            "attempt": attempt,
                            "code": failure.code,
                            "detail": failure.detail,
                        },
                        start_to_close_timeout=timedelta(minutes=2),
                        schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
                        retry_policy=SHORT_RETRY,
                    )
                    return {"status": "waiting", "attempt": attempt, **scheduled}
                except Exception:
                    workflow.logger.exception("failed to schedule metric refresh retry")
            raise

    async def _settle(
        self,
        task: dict[str, Any],
        *,
        code: str,
        detail: str,
    ) -> dict[str, Any]:
        return await workflow.execute_activity(
            "keyword_settle_pending_metrics",
            {"task": task, "code": code, "detail": detail},
            start_to_close_timeout=timedelta(minutes=2),
            schedule_to_start_timeout=CONTROL_ACTIVITY_SCHEDULE_TO_START,
            retry_policy=SHORT_RETRY,
        )


def workflow_error(error: Exception) -> WorkflowFailure:
    current: BaseException | None = error
    for _ in range(8):
        if isinstance(current, ApplicationError):
            return WorkflowFailure(
                code=current.type or "keyword_build_failed",
                detail=str(current),
                non_retryable=bool(current.non_retryable),
            )
        current = getattr(current, "cause", None)
        if current is None:
            break
    return WorkflowFailure(
        code="keyword_build_failed",
        detail=str(error),
        non_retryable=False,
    )
