from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError


PAID_ACTIVITY_RETRY = RetryPolicy(maximum_attempts=1)
CONTROL_ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=2),
    backoff_coefficient=2,
    maximum_interval=timedelta(seconds=16),
    maximum_attempts=5,
)
CONTROL_ACTIVITY_MAX_ATTEMPTS = 5
RETRY_INITIAL_SECONDS = 2
RETRY_MAX_SECONDS = 16


def retry_delay(attempt: int) -> float:
    return float(min(RETRY_MAX_SECONDS, RETRY_INITIAL_SECONDS * (2 ** max(0, attempt))))


@workflow.defn(name="ContentPlanPreparationWorkflow")
class ContentPlanPreparationWorkflow:
    @workflow.run
    async def run(self, payload: dict[str, Any]) -> None:
        if set(payload) != {"preparation_id"}:
            raise ValueError("ContentPlanPreparationWorkflow only accepts preparation_id")
        preparation_id = str(payload["preparation_id"])
        for attempt in range(CONTROL_ACTIVITY_MAX_ATTEMPTS):
            try:
                result = await workflow.execute_activity(
                    "content_plan_process_preparation",
                    {"preparation_id": preparation_id},
                    start_to_close_timeout=timedelta(hours=1),
                    retry_policy=PAID_ACTIVITY_RETRY,
                )
            except ActivityError:
                result = {
                    "status": "retryable_failed",
                    "error_code": "content_plan_activity_failed",
                }
            if not isinstance(result, dict):
                raise ValueError("content-plan preparation activity returned invalid data")
            if result.get("status") != "retryable_failed":
                return
            if attempt == CONTROL_ACTIVITY_MAX_ATTEMPTS - 1:
                await workflow.execute_activity(
                    "content_plan_mark_preparation_retry_exhausted",
                    {
                        "preparation_id": preparation_id,
                        "error_code": result.get("error_code"),
                    },
                    start_to_close_timeout=timedelta(minutes=1),
                    retry_policy=CONTROL_ACTIVITY_RETRY,
                )
                return
            await workflow.sleep(timedelta(seconds=retry_delay(attempt)))


@workflow.defn(name="ContentPlanGenerationWorkflow")
class ContentPlanGenerationWorkflow:
    @workflow.run
    async def run(self, payload: dict[str, Any]) -> None:
        if set(payload) != {"batch_id"}:
            raise ValueError("ContentPlanGenerationWorkflow only accepts batch_id")
        batch_id = str(payload["batch_id"])
        for attempt in range(CONTROL_ACTIVITY_MAX_ATTEMPTS):
            try:
                result = await workflow.execute_activity(
                    "content_plan_process_batch",
                    {"batch_id": batch_id},
                    start_to_close_timeout=timedelta(hours=4),
                    heartbeat_timeout=timedelta(seconds=30),
                    retry_policy=PAID_ACTIVITY_RETRY,
                )
            except ActivityError:
                result = {
                    "status": "retryable_failed",
                    "error_code": "content_plan_activity_failed",
                }
            if not isinstance(result, dict):
                raise ValueError("content-plan batch activity returned invalid data")
            if result.get("status") != "retryable_failed":
                return
            if attempt == CONTROL_ACTIVITY_MAX_ATTEMPTS - 1:
                await workflow.execute_activity(
                    "content_plan_mark_batch_retry_exhausted",
                    {
                        "batch_id": batch_id,
                        "error_code": result.get("error_code"),
                    },
                    start_to_close_timeout=timedelta(minutes=1),
                    retry_policy=CONTROL_ACTIVITY_RETRY,
                )
                return
            await workflow.sleep(timedelta(seconds=retry_delay(attempt)))
