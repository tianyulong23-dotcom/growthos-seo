from __future__ import annotations

from typing import Any

from sqlalchemy.exc import SQLAlchemyError
from temporalio import activity

from app.modules.content_plan.d6_service import (
    ContentPlanWorkflowError,
    build_content_plan_d6_service,
)
from app.modules.content_plan.batch_service import build_content_plan_batch_service


@activity.defn(name="content_plan_process_preparation")
async def process_preparation(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) != {"preparation_id"}:
        raise ValueError("content-plan preparation activity only accepts preparation_id")
    preparation_id = str(payload["preparation_id"])
    try:
        result = await build_content_plan_d6_service().process_preparation(preparation_id)
    except ContentPlanWorkflowError as exc:
        return {
            "preparation_id": preparation_id,
            "status": "retryable_failed" if exc.retryable else "failed",
            "error_code": exc.code,
            "error_detail": exc.message,
        }
    except SQLAlchemyError as exc:
        return {
            "preparation_id": preparation_id,
            "status": "retryable_failed",
            "error_code": "content_plan_database_failed",
            "error_detail": str(exc),
        }
    return result.model_dump(mode="json")


@activity.defn(name="content_plan_process_batch")
async def process_batch(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) != {"batch_id"}:
        raise ValueError("content-plan batch activity only accepts batch_id")
    batch_id = str(payload["batch_id"])
    try:
        return await build_content_plan_batch_service().process_batch(batch_id)
    except SQLAlchemyError as exc:
        return {
            "batch_id": batch_id,
            "status": "retryable_failed",
            "error_code": "content_plan_database_failed",
            "error_detail": str(exc),
        }


@activity.defn(name="content_plan_mark_batch_retry_exhausted")
async def mark_batch_retry_exhausted(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) != {"batch_id", "error_code"}:
        raise ValueError(
            "content-plan retry exhaustion activity only accepts batch_id and error_code"
        )
    error_code = payload["error_code"]
    if error_code is not None and not isinstance(error_code, str):
        raise ValueError("content-plan retry exhaustion error_code must be a string")
    return await build_content_plan_batch_service().mark_retry_exhausted(
        str(payload["batch_id"]),
        last_error_code=error_code,
    )


@activity.defn(name="content_plan_mark_preparation_retry_exhausted")
async def mark_preparation_retry_exhausted(
    payload: dict[str, Any],
) -> dict[str, Any]:
    if set(payload) != {"preparation_id", "error_code"}:
        raise ValueError(
            "content-plan preparation retry exhaustion activity only accepts "
            "preparation_id and error_code"
        )
    error_code = payload["error_code"]
    if error_code is not None and not isinstance(error_code, str):
        raise ValueError("content-plan retry exhaustion error_code must be a string")
    result = await build_content_plan_d6_service().mark_retry_exhausted(
        str(payload["preparation_id"]),
        last_error_code=error_code,
    )
    return result.model_dump(mode="json")


CONTENT_PLAN_ACTIVITIES = [
    process_preparation,
    process_batch,
    mark_batch_retry_exhausted,
    mark_preparation_retry_exhausted,
]
