from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.core.config import Settings
from app.modules.keywords.schemas import (
    KeywordBuildRunResponse,
    KeywordLibraryStatusResponse,
)
from app.modules.keywords.service import (
    KeywordActiveWorkflowRecord,
    KeywordCompetitorAnalysisActiveWorkflowRecord,
    KeywordCompetitorAnalysisDispatchRecord,
    KeywordDispatchRecord,
    KeywordMetricActiveWorkflowRecord,
    KeywordMetricDispatchRecord,
    KeywordOperationalHealth,
    KeywordService,
)


NOW = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
pytestmark = pytest.mark.anyio


def build_run(status: str, *, keyword_count: int = 0) -> KeywordBuildRunResponse:
    return KeywordBuildRunResponse(
        run_id="run-1",
        kind="initial",
        round_number=1,
        status=status,
        stage=status,
        message="关键词任务状态",
        progress=0,
        discovered_count=0,
        selected_count=0,
        keyword_count=keyword_count,
        result_version=0,
        profile_source="",
        gap_status="not_requested",
        gap_message="",
        gap_count=0,
        partial_failures=[],
        error_code=None,
        recovery_count=0,
        next_retry_at=None,
        started_at=None,
        finished_at=None,
        elapsed_seconds=0,
    )


def build_status(status: str, *, keyword_count: int = 0) -> KeywordLibraryStatusResponse:
    return KeywordLibraryStatusResponse(
        run=build_run(status, keyword_count=keyword_count),
        total_keywords=keyword_count,
        active_keywords=keyword_count,
        result_version=0,
    )


class RecoveryRepository:
    def __init__(self) -> None:
        self.status_results = [build_status("completed", keyword_count=1)]
        self.pending_dispatches: list[KeywordDispatchRecord] = []
        self.active_workflows: list[KeywordActiveWorkflowRecord] = []
        self.pending_metric_dispatches: list[KeywordMetricDispatchRecord] = []
        self.active_metric_workflows: list[KeywordMetricActiveWorkflowRecord] = []
        self.active_competitor_workflows: list[KeywordCompetitorAnalysisActiveWorkflowRecord] = []
        self.pending_competitor_dispatches: list[KeywordCompetitorAnalysisDispatchRecord] = []
        self.retry_calls: list[tuple[str, str]] = []
        self.requeue_calls: list[tuple[str, str]] = []
        self.checked_calls: list[tuple[str, str]] = []
        self.dispatch_successes: list[str] = []
        self.dispatch_failures: list[tuple[str, str]] = []
        self.metric_dispatch_successes: list[tuple[str, str]] = []
        self.metric_dispatch_failures: list[tuple[str, str, str]] = []
        self.metric_requeue_calls: list[tuple[str, str]] = []
        self.metric_checked_calls: list[tuple[str, str]] = []
        self.competitor_requeue_calls: list[tuple[str, str]] = []
        self.competitor_checked_calls: list[tuple[str, str]] = []
        self.competitor_dispatch_successes: list[tuple[str, str]] = []
        self.competitor_dispatch_failures: list[tuple[str, str, str]] = []
        self.resume_calls: list[str] = []
        self.competitor_configuration_resume_calls: list[str] = []
        self.stale_settlements = 0
        self.cleanup_calls: list[int] = []
        self.worker_healthy = True
        self.waiting_for_worker_updates = 0

    async def status(
        self,
        organization_id: str,
        project_id: str,
    ) -> KeywordLibraryStatusResponse:
        assert organization_id == "test-org"
        assert project_id == "project-1"
        if len(self.status_results) > 1:
            return self.status_results.pop(0)
        return self.status_results[0]

    async def retry_failed_initial_build(
        self,
        organization_id: str,
        project_id: str,
    ) -> KeywordBuildRunResponse:
        self.retry_calls.append((organization_id, project_id))
        return build_run("queued")

    async def list_pending_dispatches(self, limit: int) -> list[KeywordDispatchRecord]:
        return self.pending_dispatches[:limit]

    async def list_pending_metric_dispatches(
        self,
        limit: int,
    ) -> list[KeywordMetricDispatchRecord]:
        return self.pending_metric_dispatches[:limit]

    async def claim_pending_competitor_analysis_dispatches(
        self, limit: int
    ) -> list[KeywordCompetitorAnalysisDispatchRecord]:
        return self.pending_competitor_dispatches[:limit]

    async def mark_competitor_analysis_dispatch_succeeded(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        self.competitor_dispatch_successes.append((run_id, expected_workflow_id))

    async def record_competitor_analysis_dispatch_failure(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        message: str,
    ) -> None:
        self.competitor_dispatch_failures.append((run_id, expected_workflow_id, message))

    async def resume_ready_blocked_runs(
        self,
        organization_id: str,
        **kwargs: Any,
    ) -> int:
        self.resume_calls.append(organization_id)
        return 0

    async def resume_ready_failed_competitor_analysis_runs(
        self,
        organization_id: str,
        **kwargs: Any,
    ) -> int:
        self.competitor_configuration_resume_calls.append(organization_id)
        return 0

    async def mark_dispatch_succeeded(self, run_id: str) -> None:
        self.dispatch_successes.append(run_id)

    async def record_dispatch_failure(self, run_id: str, message: str) -> None:
        self.dispatch_failures.append((run_id, message))

    async def mark_metric_dispatch_succeeded(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        self.metric_dispatch_successes.append((run_id, expected_workflow_id))

    async def record_metric_dispatch_failure(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        message: str,
    ) -> None:
        self.metric_dispatch_failures.append((run_id, expected_workflow_id, message))

    async def list_active_workflows(
        self,
        organization_id: str,
        limit: int,
    ) -> list[KeywordActiveWorkflowRecord]:
        assert organization_id == "test-org"
        return self.active_workflows[:limit]

    async def list_active_metric_workflows(
        self,
        organization_id: str,
        limit: int,
    ) -> list[KeywordMetricActiveWorkflowRecord]:
        assert organization_id == "test-org"
        return self.active_metric_workflows[:limit]

    async def list_active_competitor_analysis_workflows(
        self,
        organization_id: str,
        limit: int,
    ) -> list[KeywordCompetitorAnalysisActiveWorkflowRecord]:
        assert organization_id == "test-org"
        return self.active_competitor_workflows[:limit]

    async def requeue_orphaned_workflow(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        max_recoveries: int,
    ) -> bool:
        assert max_recoveries == 3
        self.requeue_calls.append((run_id, expected_workflow_id))
        return True

    async def mark_workflow_checked(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        self.checked_calls.append((run_id, expected_workflow_id))

    async def requeue_orphaned_metric_workflow(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> bool:
        self.metric_requeue_calls.append((run_id, expected_workflow_id))
        return True

    async def mark_metric_workflow_checked(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        self.metric_checked_calls.append((run_id, expected_workflow_id))

    async def requeue_orphaned_competitor_analysis_workflow(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
        max_recoveries: int,
    ) -> bool:
        assert max_recoveries == 3
        self.competitor_requeue_calls.append((run_id, expected_workflow_id))
        return True

    async def mark_competitor_analysis_workflow_checked(
        self,
        run_id: str,
        *,
        expected_workflow_id: str,
    ) -> None:
        self.competitor_checked_calls.append((run_id, expected_workflow_id))

    async def settle_stale_external_requests(self) -> int:
        self.stale_settlements += 1
        return 0

    async def cleanup_operational_data(self, *, retention_days: int) -> int:
        self.cleanup_calls.append(retention_days)
        return 0

    async def operational_health(
        self,
        organization_id: str,
        **kwargs: Any,
    ) -> KeywordOperationalHealth:
        assert organization_id == "test-org"
        return KeywordOperationalHealth(
            worker_healthy=self.worker_healthy,
            worker_last_seen_at=NOW if self.worker_healthy else None,
            active_runs=len(self.active_workflows),
            waiting_runs=0,
            blocked_runs=0,
            stale_prepared_requests=0,
            uncertain_requests=0,
            charged_failed_requests=0,
            metric_refresh_waiting=len(self.pending_metric_dispatches),
            metric_refresh_running=len(self.active_metric_workflows),
            metric_refresh_exhausted=0,
            failed_metrics=0,
        )

    async def mark_active_runs_waiting_for_worker(
        self,
        organization_id: str,
        *,
        stale_seconds: int,
    ) -> int:
        assert organization_id == "test-org"
        self.waiting_for_worker_updates += 1
        return len(self.active_workflows)


class RecoveryLauncher:
    def __init__(self) -> None:
        self.states: dict[str, str] = {}
        self.state_calls: list[str] = []
        self.start_calls: list[tuple[dict[str, Any], str]] = []
        self.metric_start_calls: list[tuple[dict[str, Any], str]] = []
        self.competitor_start_calls: list[tuple[dict[str, Any], str]] = []

    async def start(self, task: dict[str, Any], workflow_id: str) -> None:
        self.start_calls.append((task, workflow_id))

    async def start_metrics(self, task: dict[str, Any], workflow_id: str) -> None:
        self.metric_start_calls.append((task, workflow_id))

    async def start_competitor_analysis(self, task: dict[str, Any], workflow_id: str) -> None:
        self.competitor_start_calls.append((task, workflow_id))

    async def cancel(self, workflow_id: str) -> None:
        return None

    async def state(self, workflow_id: str) -> str:
        self.state_calls.append(workflow_id)
        return self.states.get(workflow_id, "unknown")


def build_service() -> tuple[KeywordService, RecoveryRepository, RecoveryLauncher]:
    repository = RecoveryRepository()
    launcher = RecoveryLauncher()
    service = KeywordService(
        settings=Settings(app_env="test", default_organization_id="test-org"),
        repository=repository,  # type: ignore[arg-type]
        launcher=launcher,
    )
    return service, repository, launcher


async def test_status_is_read_only_for_a_legacy_failed_initial_build() -> None:
    service, repository, launcher = build_service()
    repository.status_results = [
        build_status("failed"),
        build_status("queued"),
    ]
    repository.pending_dispatches = [
        KeywordDispatchRecord(
            run_id="run-1",
            workflow_id="keywords:build:run-1:retry:1",
            task_payload={"run_id": "run-1"},
        )
    ]

    result = await service.status("project-1")

    assert result.run is not None
    assert result.run.status == "failed"
    assert repository.retry_calls == []
    assert launcher.start_calls == []
    assert repository.dispatch_successes == []


@pytest.mark.parametrize("workflow_state", ["closed", "missing"])
async def test_reconcile_requeues_confirmed_orphaned_workflows(
    workflow_state: str,
) -> None:
    service, repository, launcher = build_service()
    repository.active_workflows = [
        KeywordActiveWorkflowRecord(
            run_id="run-1",
            workflow_id="keywords:build:run-1",
            task_payload={"run_id": "run-1"},
            run_status="running",
            dispatch_status="dispatched",
            updated_at=datetime.now(UTC) - timedelta(minutes=5),
        )
    ]
    launcher.states["keywords:build:run-1"] = workflow_state

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 1
    assert repository.requeue_calls == [("run-1", "keywords:build:run-1")]
    assert repository.checked_calls == [("run-1", "keywords:build:run-1")]
    assert launcher.start_calls == []


async def test_reconcile_never_requeues_when_temporal_state_is_unknown() -> None:
    service, repository, launcher = build_service()
    repository.active_workflows = [
        KeywordActiveWorkflowRecord(
            run_id="run-1",
            workflow_id="keywords:build:run-1",
            task_payload={"run_id": "run-1"},
            run_status="waiting",
            dispatch_status="dispatched",
            updated_at=NOW - timedelta(hours=1),
        )
    ]
    launcher.states["keywords:build:run-1"] = "unknown"

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 0
    assert launcher.state_calls == ["keywords:build:run-1"]
    assert repository.requeue_calls == []
    assert launcher.start_calls == []
    assert repository.checked_calls == [("run-1", "keywords:build:run-1")]


async def test_reconcile_leaves_pending_dispatch_to_the_dispatch_loop() -> None:
    service, repository, launcher = build_service()
    repository.active_workflows = [
        KeywordActiveWorkflowRecord(
            run_id="run-1",
            workflow_id="keywords:build:run-1",
            task_payload={"run_id": "run-1"},
            run_status="queued",
            dispatch_status="pending",
            updated_at=NOW - timedelta(hours=1),
        )
    ]

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 0
    assert launcher.state_calls == []
    assert repository.requeue_calls == []
    assert launcher.start_calls == []
    assert repository.checked_calls == [("run-1", "keywords:build:run-1")]


async def test_reconcile_does_not_requeue_a_recently_missing_workflow() -> None:
    service, repository, launcher = build_service()
    repository.active_workflows = [
        KeywordActiveWorkflowRecord(
            run_id="run-1",
            workflow_id="keywords:build:run-1",
            task_payload={"run_id": "run-1"},
            run_status="queued",
            dispatch_status="dispatched",
            updated_at=datetime.now(UTC) - timedelta(seconds=20),
        )
    ]
    launcher.states["keywords:build:run-1"] = "missing"

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 0
    assert launcher.state_calls == ["keywords:build:run-1"]
    assert repository.requeue_calls == []
    assert repository.checked_calls == [("run-1", "keywords:build:run-1")]


async def test_reconcile_waits_for_worker_without_querying_temporal() -> None:
    service, repository, launcher = build_service()
    repository.worker_healthy = False
    repository.active_workflows = [
        KeywordActiveWorkflowRecord(
            run_id="run-1",
            workflow_id="keywords:build:run-1",
            task_payload={"run_id": "run-1"},
            run_status="running",
            dispatch_status="dispatched",
            updated_at=NOW - timedelta(minutes=5),
        )
    ]

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 0
    assert repository.stale_settlements == 1
    assert repository.cleanup_calls == [90]
    assert repository.waiting_for_worker_updates == 1
    assert launcher.state_calls == []


async def test_dispatch_checks_blocked_runs_before_starting_pending_workflows() -> None:
    service, repository, launcher = build_service()
    repository.pending_dispatches = [
        KeywordDispatchRecord(
            run_id="run-1",
            workflow_id="keywords:build:run-1",
            task_payload={"run_id": "run-1"},
        )
    ]

    dispatched = await service.dispatch_pending_workflows()

    assert dispatched == 1
    assert repository.resume_calls == ["test-org"]
    assert repository.competitor_configuration_resume_calls == ["test-org"]
    assert launcher.start_calls == [({"run_id": "run-1"}, "keywords:build:run-1")]


async def test_dispatch_starts_due_metric_recovery_workflow() -> None:
    service, repository, launcher = build_service()
    repository.pending_metric_dispatches = [
        KeywordMetricDispatchRecord(
            run_id="run-1",
            workflow_id="keyword-metrics:run-1:1",
            task_payload={
                "run_id": "run-1",
                "_metric_workflow_id": "keyword-metrics:run-1:1",
            },
        )
    ]

    dispatched = await service.dispatch_pending_workflows()

    assert dispatched == 1
    assert launcher.metric_start_calls == [
        (
            {
                "run_id": "run-1",
                "_metric_workflow_id": "keyword-metrics:run-1:1",
            },
            "keyword-metrics:run-1:1",
        )
    ]
    assert repository.metric_dispatch_successes == [("run-1", "keyword-metrics:run-1:1")]


async def test_metric_dispatch_failure_is_persisted_for_retry() -> None:
    service, repository, launcher = build_service()
    repository.pending_metric_dispatches = [
        KeywordMetricDispatchRecord(
            run_id="run-1",
            workflow_id="keyword-metrics:run-1:1",
            task_payload={"run_id": "run-1"},
        )
    ]

    async def fail_start_metrics(task: dict[str, Any], workflow_id: str) -> None:
        raise RuntimeError("temporal unavailable")

    launcher.start_metrics = fail_start_metrics  # type: ignore[method-assign]

    dispatched = await service.dispatch_pending_workflows()

    assert dispatched == 0
    assert repository.metric_dispatch_successes == []
    assert repository.metric_dispatch_failures == [
        ("run-1", "keyword-metrics:run-1:1", "temporal unavailable")
    ]


async def test_competitor_dispatch_acknowledges_the_expected_workflow() -> None:
    service, repository, launcher = build_service()
    repository.pending_competitor_dispatches = [
        KeywordCompetitorAnalysisDispatchRecord(
            run_id="analysis-1",
            workflow_id="keywords:competitor-analysis:analysis-1:replacement",
            task_payload={"run_id": "analysis-1"},
        )
    ]

    dispatched = await service.dispatch_pending_workflows()

    assert dispatched == 1
    assert launcher.competitor_start_calls == [
        (
            {"run_id": "analysis-1"},
            "keywords:competitor-analysis:analysis-1:replacement",
        )
    ]
    assert repository.competitor_dispatch_successes == [
        ("analysis-1", "keywords:competitor-analysis:analysis-1:replacement")
    ]


@pytest.mark.parametrize("workflow_state", ["closed", "missing"])
async def test_reconcile_requeues_orphaned_metric_workflow(
    workflow_state: str,
) -> None:
    service, repository, launcher = build_service()
    repository.active_metric_workflows = [
        KeywordMetricActiveWorkflowRecord(
            run_id="run-1",
            workflow_id="keyword-metrics:run-1:1",
            updated_at=datetime.now(UTC) - timedelta(minutes=5),
        )
    ]
    launcher.states["keyword-metrics:run-1:1"] = workflow_state

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 1
    assert repository.metric_requeue_calls == [("run-1", "keyword-metrics:run-1:1")]
    assert repository.metric_checked_calls == [("run-1", "keyword-metrics:run-1:1")]


@pytest.mark.parametrize("workflow_state", ["running", "unknown"])
async def test_reconcile_keeps_live_or_unknown_metric_workflow(
    workflow_state: str,
) -> None:
    service, repository, launcher = build_service()
    repository.active_metric_workflows = [
        KeywordMetricActiveWorkflowRecord(
            run_id="run-1",
            workflow_id="keyword-metrics:run-1:1",
            updated_at=NOW - timedelta(hours=1),
        )
    ]
    launcher.states["keyword-metrics:run-1:1"] = workflow_state

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 0
    assert repository.metric_requeue_calls == []
    assert repository.metric_checked_calls == [("run-1", "keyword-metrics:run-1:1")]


@pytest.mark.parametrize("workflow_state", ["closed", "missing"])
async def test_reconcile_requeues_orphaned_competitor_analysis(
    workflow_state: str,
) -> None:
    service, repository, launcher = build_service()
    repository.active_competitor_workflows = [
        KeywordCompetitorAnalysisActiveWorkflowRecord(
            run_id="analysis-1",
            workflow_id="keywords:competitor-analysis:analysis-1",
            updated_at=datetime.now(UTC) - timedelta(minutes=5),
        )
    ]
    launcher.states["keywords:competitor-analysis:analysis-1"] = workflow_state

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 1
    assert repository.competitor_requeue_calls == [
        ("analysis-1", "keywords:competitor-analysis:analysis-1")
    ]
    assert repository.competitor_checked_calls == [
        ("analysis-1", "keywords:competitor-analysis:analysis-1")
    ]


@pytest.mark.parametrize("workflow_state", ["running", "unknown"])
async def test_reconcile_keeps_live_or_unknown_competitor_analysis(
    workflow_state: str,
) -> None:
    service, repository, launcher = build_service()
    repository.active_competitor_workflows = [
        KeywordCompetitorAnalysisActiveWorkflowRecord(
            run_id="analysis-1",
            workflow_id="keywords:competitor-analysis:analysis-1",
            updated_at=NOW - timedelta(hours=1),
        )
    ]
    launcher.states["keywords:competitor-analysis:analysis-1"] = workflow_state

    reconciled = await service.reconcile_active_runs()

    assert reconciled == 0
    assert repository.competitor_requeue_calls == []
    assert repository.competitor_checked_calls == [
        ("analysis-1", "keywords:competitor-analysis:analysis-1")
    ]
