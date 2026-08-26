from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel

from app.modules.keywords.schemas import KeywordOperationalHealthResponse
from app.modules.keywords.service import KeywordService, build_keyword_service

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: Literal["ok"]


class CoreApiRuntimeStatus(BaseModel):
    running: bool
    build_id: str | None


class WorkerTaskRuntimeStatus(BaseModel):
    status: Literal["ok", "unavailable"]
    active_jobs: int
    recoverable_queued_project_analysis: int
    unrecoverable_stale_queued_project_analysis: int
    stale_running_jobs: int
    waiting_provider_jobs: int
    oldest_active_at: str | None
    reason_code: Literal["task_health_unavailable"] | None
    recovery_action: Literal["inspect_worker_task_health"] | None


class WorkerRuntimeStatus(BaseModel):
    process_running: bool
    build_id: str | None
    execution_mode: Literal["normal", "quiesced", "recovery", "unavailable"]
    postgres_ready: bool
    temporal_ready: bool
    reason_code: Literal[
        "worker_unavailable",
        "worker_dependencies_unavailable",
        "worker_quiesced",
        "worker_recovery",
        "worker_consumers_unavailable",
    ] | None
    recovery_action: Literal[
        "start_worker",
        "restore_worker_dependencies",
        "start_business_consumers",
        "complete_recovery",
        "restore_worker_consumers",
    ] | None
    tasks: WorkerTaskRuntimeStatus


class BuildRuntimeStatus(BaseModel):
    current: bool
    expected_build_id: str | None
    core_api_build_id: str | None
    worker_build_id: str | None
    reason_code: Literal[
        "runtime_build_identity_missing",
        "runtime_build_mismatch",
        "runtime_build_stale",
    ] | None
    recovery_action: Literal["restart_product_runtime"] | None


class ProviderRuntimeStatus(BaseModel):
    configured: bool
    external_availability: Literal[
        "disabled",
        "not_checked",
        "available",
        "unavailable",
    ]
    reason_code: Literal[
        "provider_disabled",
        "provider_not_checked",
        "insufficient_balance",
        "invalid_credentials",
        "rate_limited",
        "provider_timeout",
        "provider_outage",
        "unknown_charge",
        "explicit_block",
    ] | None
    recovery_action: Literal[
        "enable_provider",
        "run_provider_diagnostic",
        "fund_provider_account",
        "repair_provider_credentials",
        "retry_after_rate_limit",
        "retry_after_timeout",
        "retry_when_provider_recovers",
        "reconcile_request_fingerprint",
        "remove_explicit_block",
    ] | None


class ProvidersRuntimeStatus(BaseModel):
    data_for_seo: ProviderRuntimeStatus
    browser: ProviderRuntimeStatus
    ai: ProviderRuntimeStatus
    gmail: ProviderRuntimeStatus


class ProjectionDeliveryRuntimeStatus(BaseModel):
    status: Literal["ok", "unavailable"]
    due_pending: int
    retryable_failed: int
    permanent_failed: int
    exhausted: int
    oldest_waiting_at: str | None
    latest_failure_code: str | None
    latest_error: str | None
    reason_code: Literal["projection_delivery_health_unavailable"] | None
    recovery_action: Literal["inspect_projection_delivery"] | None


class PlatformRuntimeStatus(BaseModel):
    background_dispatch_enabled: bool
    project_context_projection_enabled: bool
    project_context_dispatcher_running: bool
    reason_code: Literal[
        "runtime_maintenance",
        "runtime_recovery",
        "background_dispatch_disabled",
        "project_projection_disabled",
        "project_dispatcher_unavailable",
    ] | None
    recovery_action: Literal[
        "switch_to_product_mode",
        "complete_recovery",
        "enable_background_dispatch",
        "enable_project_projection",
        "restart_platform_dispatcher",
    ] | None
    projection_delivery: ProjectionDeliveryRuntimeStatus


class RuntimeStatusResponse(BaseModel):
    status: Literal["ok", "maintenance", "unavailable"]
    mode: Literal["PRODUCT", "MAINTENANCE", "RECOVERY"]
    business_consumers_running: bool
    core_api: CoreApiRuntimeStatus
    worker: WorkerRuntimeStatus
    build: BuildRuntimeStatus
    platform: PlatformRuntimeStatus
    providers: ProvidersRuntimeStatus


@router.get(
    "/health",
    response_model=HealthResponse,
    operation_id="platformHealthV1",
)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/api/v1/runtime-status",
    response_model=RuntimeStatusResponse,
    include_in_schema=False,
)
async def runtime_status(request: Request) -> RuntimeStatusResponse:
    return RuntimeStatusResponse(
        **await request.app.state.backlinks_runtime_status.snapshot()
    )


def get_keyword_health_service() -> KeywordService:
    return build_keyword_service()


@router.get(
    "/health/keywords",
    response_model=KeywordOperationalHealthResponse,
)
async def keyword_health(
    service: Annotated[KeywordService, Depends(get_keyword_health_service)],
) -> KeywordOperationalHealthResponse:
    return await service.operational_health()


@router.get(
    "/health/keywords/readiness",
    response_model=KeywordOperationalHealthResponse,
)
async def keyword_readiness(
    response: Response,
    service: Annotated[KeywordService, Depends(get_keyword_health_service)],
) -> KeywordOperationalHealthResponse:
    snapshot = await service.operational_health()
    unavailable = (
        not snapshot.worker_healthy
        or snapshot.stale_prepared_requests > 0
        or snapshot.uncertain_requests > 0
        or snapshot.charged_failed_requests > 0
    )
    if unavailable:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return snapshot
