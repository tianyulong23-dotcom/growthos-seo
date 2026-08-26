import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from httpx import AsyncClient
from temporalio.api.enums.v1 import TaskQueueType
from temporalio.api.taskqueue.v1 import TaskQueue
from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest
from temporalio.client import Client

JsonObject = dict[str, Any]
JsonFetcher = Callable[[str], Awaitable[JsonObject]]
DispatcherRunning = Callable[[], bool]
DispatcherHealth = Callable[[], Awaitable[JsonObject]]

_PROVIDER_NAMES = ("dataForSeo", "browser", "ai", "gmail")
_PROVIDER_RESPONSE_NAMES = {
    "dataForSeo": "data_for_seo",
    "browser": "browser",
    "ai": "ai",
    "gmail": "gmail",
}
_EXTERNAL_AVAILABILITY = {
    "disabled",
    "not_checked",
    "available",
    "unavailable",
}
_PROVIDER_REASON_CODES = {
    "provider_disabled",
    "provider_not_checked",
    "insufficient_balance",
    "invalid_credentials",
    "rate_limited",
    "provider_timeout",
    "provider_outage",
    "unknown_charge",
    "explicit_block",
}
_PROVIDER_RECOVERY_ACTIONS = {
    "enable_provider",
    "run_provider_diagnostic",
    "fund_provider_account",
    "repair_provider_credentials",
    "retry_after_rate_limit",
    "retry_after_timeout",
    "retry_when_provider_recovers",
    "reconcile_request_fingerprint",
    "remove_explicit_block",
}


class BacklinksRuntimeStatus:
    def __init__(
        self,
        *,
        core_api_health_url: str,
        worker_health_url: str,
        address: str,
        namespace: str,
        task_queue: str,
        timeout_seconds: float,
        expected_build_id: str | None = None,
        runtime_mode: str = "MAINTENANCE",
        background_dispatch_enabled: bool = False,
        project_context_projection_enabled: bool = False,
        project_context_dispatcher_running: DispatcherRunning | None = None,
        project_context_dispatcher_health: DispatcherHealth | None = None,
        connect: Callable[..., Awaitable[Client]] = Client.connect,
        get_json: JsonFetcher | None = None,
    ) -> None:
        self._core_api_health_url = core_api_health_url
        self._worker_health_url = worker_health_url
        self._address = address
        self._namespace = namespace
        self._task_queue = task_queue
        self._timeout_seconds = timeout_seconds
        self._expected_build_id = expected_build_id
        self._runtime_mode = runtime_mode
        self._background_dispatch_enabled = background_dispatch_enabled
        self._project_context_projection_enabled = (
            project_context_projection_enabled
        )
        self._project_context_dispatcher_running = (
            project_context_dispatcher_running or (lambda: False)
        )
        self._project_context_dispatcher_health = (
            project_context_dispatcher_health
        )
        self._connect = connect
        self._get_json = get_json or self._fetch_json
        self._client: Client | None = None
        self._client_lock = asyncio.Lock()

    async def snapshot(self) -> JsonObject:
        api_result, worker_result, dispatcher_health = await asyncio.gather(
            self._probe(self._core_api_health_url),
            self._probe(self._worker_health_url),
            self._dispatcher_health(),
        )
        api_running = (
            api_result.get("status") == "ok"
            and api_result.get("process") == "api"
        )
        worker_running = (
            worker_result.get("status") == "ok"
            and worker_result.get("process") == "worker"
        )
        api_build_id = self._optional_text(api_result.get("buildId"))
        worker_build_id = self._optional_text(worker_result.get("buildId"))
        build_status = self._build_status(
            api_build_id=api_build_id,
            worker_build_id=worker_build_id,
        )
        execution_mode = worker_result.get("workerExecutionMode")
        if execution_mode not in {"normal", "quiesced", "recovery"}:
            execution_mode = "unavailable"

        postgres_ready = worker_result.get("postgresReady") is True
        temporal_ready = worker_result.get("temporalReady") is True
        reported_consumers = (
            worker_result.get("businessConsumersRunning") is True
        )
        pollers_running = False
        if (
            worker_running
            and execution_mode == "normal"
            and reported_consumers
            and temporal_ready
        ):
            pollers_running = await self._workflow_pollers_running()
        consumers_running = (
            worker_running
            and execution_mode == "normal"
            and reported_consumers
            and pollers_running
        )
        platform_status = self._platform_status(dispatcher_health)
        product_consumers_running = (
            self._runtime_mode == "PRODUCT"
            and consumers_running
            and platform_status["project_context_dispatcher_running"]
            and build_status["current"]
        )
        worker_reason_code: str | None = None
        worker_recovery_action: str | None = None
        if not worker_running:
            worker_reason_code = "worker_unavailable"
            worker_recovery_action = "start_worker"
        elif not postgres_ready or not temporal_ready:
            worker_reason_code = "worker_dependencies_unavailable"
            worker_recovery_action = "restore_worker_dependencies"
        elif execution_mode == "quiesced":
            worker_reason_code = "worker_quiesced"
            worker_recovery_action = "start_business_consumers"
        elif execution_mode == "recovery":
            worker_reason_code = "worker_recovery"
            worker_recovery_action = "complete_recovery"
        elif not consumers_running:
            worker_reason_code = "worker_consumers_unavailable"
            worker_recovery_action = "restore_worker_consumers"

        if not api_running or not worker_running:
            status = "unavailable"
        elif product_consumers_running and postgres_ready and temporal_ready:
            status = "ok"
        else:
            status = "maintenance"

        return {
            "status": status,
            "mode": self._runtime_mode,
            "business_consumers_running": product_consumers_running,
            "core_api": {
                "running": api_running,
                "build_id": api_build_id,
            },
            "worker": {
                "process_running": worker_running,
                "build_id": worker_build_id,
                "execution_mode": execution_mode,
                "postgres_ready": postgres_ready,
                "temporal_ready": temporal_ready,
                "reason_code": worker_reason_code,
                "recovery_action": worker_recovery_action,
                "tasks": self._worker_tasks(worker_result),
            },
            "build": build_status,
            "platform": platform_status,
            "providers": self._providers(api_result if api_running else {}),
        }

    async def business_consumers_running(self) -> bool:
        return bool((await self.snapshot())["business_consumers_running"])

    async def _probe(self, url: str) -> JsonObject:
        try:
            result = await asyncio.wait_for(
                self._get_json(url),
                timeout=self._timeout_seconds,
            )
        except Exception:  # noqa: BLE001 - health probes fail closed.
            return {}
        return result if isinstance(result, dict) else {}

    async def _fetch_json(self, url: str) -> JsonObject:
        async with AsyncClient(timeout=self._timeout_seconds) as client:
            response = await client.get(url)
            response.raise_for_status()
            payload = response.json()
        return payload if isinstance(payload, dict) else {}

    async def _dispatcher_health(self) -> JsonObject:
        if self._project_context_dispatcher_health is None:
            return {
                "status": "unavailable",
                "reason_code": "projection_delivery_health_unavailable",
                "recovery_action": "inspect_projection_delivery",
            }
        try:
            result = await asyncio.wait_for(
                self._project_context_dispatcher_health(),
                timeout=self._timeout_seconds,
            )
        except Exception:  # noqa: BLE001 - health probes fail closed.
            return {
                "status": "unavailable",
                "reason_code": "projection_delivery_health_unavailable",
                "recovery_action": "inspect_projection_delivery",
            }
        return result if isinstance(result, dict) else {}

    def _platform_status(self, dispatcher_health: JsonObject) -> JsonObject:
        dispatcher_running = bool(self._project_context_dispatcher_running())
        reason_code: str | None = None
        recovery_action: str | None = None
        if self._runtime_mode == "MAINTENANCE":
            reason_code = "runtime_maintenance"
            recovery_action = "switch_to_product_mode"
        elif self._runtime_mode == "RECOVERY":
            reason_code = "runtime_recovery"
            recovery_action = "complete_recovery"
        elif not self._background_dispatch_enabled:
            reason_code = "background_dispatch_disabled"
            recovery_action = "enable_background_dispatch"
        elif not self._project_context_projection_enabled:
            reason_code = "project_projection_disabled"
            recovery_action = "enable_project_projection"
        elif not dispatcher_running:
            reason_code = "project_dispatcher_unavailable"
            recovery_action = "restart_platform_dispatcher"
        return {
            "background_dispatch_enabled": self._background_dispatch_enabled,
            "project_context_projection_enabled": (
                self._project_context_projection_enabled
            ),
            "project_context_dispatcher_running": dispatcher_running,
            "reason_code": reason_code,
            "recovery_action": recovery_action,
            "projection_delivery": self._projection_delivery(dispatcher_health),
        }

    def _projection_delivery(self, reported: JsonObject) -> JsonObject:
        if reported.get("status") == "unavailable":
            return {
                "status": "unavailable",
                "due_pending": 0,
                "retryable_failed": 0,
                "permanent_failed": 0,
                "exhausted": 0,
                "oldest_waiting_at": None,
                "latest_failure_code": None,
                "latest_error": None,
                "reason_code": "projection_delivery_health_unavailable",
                "recovery_action": "inspect_projection_delivery",
            }
        return {
            "status": "ok",
            "due_pending": self._nonnegative_int(reported.get("due_pending")),
            "retryable_failed": self._nonnegative_int(
                reported.get("retryable_failed")
            ),
            "permanent_failed": self._nonnegative_int(
                reported.get("permanent_failed")
            ),
            "exhausted": self._nonnegative_int(reported.get("exhausted")),
            "oldest_waiting_at": self._optional_text(
                reported.get("oldest_waiting_at")
            ),
            "latest_failure_code": self._optional_text(
                reported.get("latest_failure_code")
            ),
            "latest_error": self._optional_text(reported.get("latest_error")),
            "reason_code": None,
            "recovery_action": None,
        }

    def _worker_tasks(self, worker_result: JsonObject) -> JsonObject:
        reported = worker_result.get("tasks")
        reported = reported if isinstance(reported, dict) else {}
        if reported.get("status") != "ok":
            return {
                "status": "unavailable",
                "active_jobs": 0,
                "recoverable_queued_project_analysis": 0,
                "unrecoverable_stale_queued_project_analysis": 0,
                "stale_running_jobs": 0,
                "waiting_provider_jobs": 0,
                "oldest_active_at": None,
                "reason_code": "task_health_unavailable",
                "recovery_action": "inspect_worker_task_health",
            }
        return {
            "status": "ok",
            "active_jobs": self._nonnegative_int(reported.get("activeJobs")),
            "recoverable_queued_project_analysis": self._nonnegative_int(
                reported.get("recoverableQueuedProjectAnalysis")
            ),
            "unrecoverable_stale_queued_project_analysis": self._nonnegative_int(
                reported.get("unrecoverableStaleQueuedProjectAnalysis")
            ),
            "stale_running_jobs": self._nonnegative_int(
                reported.get("staleRunningJobs")
            ),
            "waiting_provider_jobs": self._nonnegative_int(
                reported.get("waitingProviderJobs")
            ),
            "oldest_active_at": self._optional_text(
                reported.get("oldestActiveAt")
            ),
            "reason_code": None,
            "recovery_action": None,
        }

    @staticmethod
    def _nonnegative_int(value: object) -> int:
        return value if isinstance(value, int) and value >= 0 else 0

    @staticmethod
    def _optional_text(value: object) -> str | None:
        return value if isinstance(value, str) and value else None

    def _build_status(
        self,
        *,
        api_build_id: str | None,
        worker_build_id: str | None,
    ) -> JsonObject:
        reason_code: str | None = None
        if api_build_id is None or worker_build_id is None:
            reason_code = "runtime_build_identity_missing"
        elif api_build_id != worker_build_id:
            reason_code = "runtime_build_mismatch"
        elif (
            self._expected_build_id is not None
            and api_build_id != self._expected_build_id
        ):
            reason_code = "runtime_build_stale"
        return {
            "current": reason_code is None,
            "expected_build_id": self._expected_build_id,
            "core_api_build_id": api_build_id,
            "worker_build_id": worker_build_id,
            "reason_code": reason_code,
            "recovery_action": (
                None if reason_code is None else "restart_product_runtime"
            ),
        }

    def _providers(self, api_result: JsonObject) -> JsonObject:
        reported = api_result.get("providers")
        reported = reported if isinstance(reported, dict) else {}
        result: JsonObject = {}
        for provider_name in _PROVIDER_NAMES:
            provider = reported.get(provider_name)
            provider = provider if isinstance(provider, dict) else {}
            availability = provider.get("externalAvailability")
            if availability not in _EXTERNAL_AVAILABILITY:
                availability = "unavailable"
            reason_code = provider.get("reasonCode")
            recovery_action = provider.get("recoveryAction")
            if availability == "available":
                reason_code = None
                recovery_action = None
            else:
                if reason_code not in _PROVIDER_REASON_CODES:
                    reason_code = "provider_not_checked"
                if recovery_action not in _PROVIDER_RECOVERY_ACTIONS:
                    recovery_action = "run_provider_diagnostic"
            result[_PROVIDER_RESPONSE_NAMES[provider_name]] = {
                "configured": provider.get("configured") is True,
                "external_availability": availability,
                "reason_code": reason_code,
                "recovery_action": recovery_action,
            }
        return result

    async def _workflow_pollers_running(self) -> bool:
        try:
            client = await asyncio.wait_for(
                self._get_client(),
                timeout=self._timeout_seconds,
            )
            response = await asyncio.wait_for(
                client.service_client.workflow_service.describe_task_queue(
                    DescribeTaskQueueRequest(
                        namespace=self._namespace,
                        task_queue=TaskQueue(name=self._task_queue),
                        task_queue_type=TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW,
                        report_pollers=True,
                    )
                ),
                timeout=self._timeout_seconds,
            )
        except Exception:  # noqa: BLE001 - Temporal health probes fail closed.
            self._client = None
            return False
        return bool(response.pollers)

    async def _get_client(self) -> Client:
        if self._client is not None:
            return self._client
        async with self._client_lock:
            if self._client is None:
                self._client = await self._connect(
                    self._address,
                    namespace=self._namespace,
                )
            return self._client
