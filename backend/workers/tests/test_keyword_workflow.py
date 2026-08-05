import asyncio

import pytest
from temporalio.exceptions import ApplicationError

from seo_workers.keywords.workflow import (
    METERED_ACTIVITY_RETRY,
    SHORT_RETRY,
    KeywordBuildWorkflow,
    KeywordMetricsRecoveryWorkflow,
    WorkflowFailure,
    workflow_error,
)


@pytest.fixture(autouse=True)
def enable_current_workflow_patches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.patched",
        lambda patch_id: True,
    )


@pytest.mark.anyio
async def test_initial_build_does_not_run_the_old_expansion_or_gap_branches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[str] = []
    activity_options: dict[str, dict] = {}

    async def execute_activity(name: str, *args, **kwargs):
        activity_calls.append(name)
        activity_options[name] = kwargs
        results = {
            "keyword_mark_started": {"kind": "initial"},
            "keyword_prepare_seeds": {"selected_topic_count": 42},
            "keyword_prepare_topic_metrics": {
                "pending_metrics_count": 0,
                "overview_retryable": False,
            },
            "keyword_commit_topics": {
                "keyword_count": 42,
                "pending_metrics_count": 0,
                "result_version": 1,
            },
        }
        return results[name]

    async def completed(value):
        return value

    def start_activity(name: str, *args, **kwargs):
        if name == "keyword_discover_seeds":
            return asyncio.create_task(completed({"count": 100}))
        if name == "keyword_acquire_business_profile":
            return asyncio.create_task(completed({"source": "site_profile"}))
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.start_activity",
        start_activity,
    )
    result = await KeywordBuildWorkflow().run({"run_id": "run-1"})

    assert result["keyword_count"] == 42
    assert "keyword_commit_topics" in activity_calls
    assert "keyword_expand_ideas" not in activity_calls
    assert "keyword_classify_score_commit" not in activity_calls
    assert "keyword_fetch_competitor_gap" not in activity_calls
    assert "keyword_fail_run" not in activity_calls
    assert (
        activity_options["keyword_prepare_topic_metrics"]["retry_policy"]
        is METERED_ACTIVITY_RETRY
    )
    assert METERED_ACTIVITY_RETRY.maximum_attempts == 1
    assert activity_options["keyword_commit_topics"]["retry_policy"] is SHORT_RETRY
    assert SHORT_RETRY.maximum_attempts == 5


@pytest.mark.anyio
async def test_initial_build_finishes_without_waiting_for_pending_metrics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[str] = []

    async def execute_activity(name: str, *args, **kwargs):
        activity_calls.append(name)
        results = {
            "keyword_mark_started": {"kind": "initial"},
            "keyword_prepare_seeds": {"selected_topic_count": 20},
            "keyword_prepare_topic_metrics": {
                "pending_metrics_count": 3,
                "overview_retryable": True,
                "overview_failure_code": "dataforseo_retryable",
            },
            "keyword_commit_topics": {
                "keyword_count": 20,
                "pending_metrics_count": 3,
                "result_version": 1,
            },
        }
        return results[name]

    async def completed(value):
        return value

    def start_activity(name: str, *args, **kwargs):
        if name == "keyword_discover_seeds":
            return asyncio.create_task(completed({"count": 100}))
        if name == "keyword_acquire_business_profile":
            return asyncio.create_task(completed({"source": "site_profile"}))
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.start_activity",
        start_activity,
    )
    result = await KeywordBuildWorkflow().run({"run_id": "run-1"})

    assert result["pending_metrics_count"] == 3
    assert activity_calls[-1] == "keyword_commit_topics"
    assert "keyword_refresh_pending_metrics" not in activity_calls


@pytest.mark.anyio
async def test_metric_recovery_completes_in_an_independent_workflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[str] = []
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.logger.exception",
        lambda *args, **kwargs: None,
    )

    async def execute_activity(name: str, *args, **kwargs):
        activity_calls.append(name)
        if name == "keyword_mark_metric_refresh_started":
            return {"attempt": 1}
        if name == "keyword_refresh_pending_metrics":
            return {
                "requested": 3,
                "updated": 3,
                "failed": 0,
                "no_data": 0,
                "pending_metrics_count": 0,
                "result_version": 2,
            }
        if name == "keyword_finish_metric_refresh_job":
            assert args[0]["exhausted"] is False
            return None
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    result = await KeywordMetricsRecoveryWorkflow().run({"run_id": "run-1"})

    assert result["status"] == "completed"
    assert result["result_version"] == 2
    assert activity_calls == [
        "keyword_mark_metric_refresh_started",
        "keyword_refresh_pending_metrics",
        "keyword_finish_metric_refresh_job",
    ]


@pytest.mark.anyio
async def test_metric_recovery_persists_the_next_retry_instead_of_sleeping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[str] = []

    async def execute_activity(name: str, *args, **kwargs):
        activity_calls.append(name)
        if name == "keyword_mark_metric_refresh_started":
            return {"attempt": 1}
        if name == "keyword_refresh_pending_metrics":
            return {
                "requested": 3,
                "updated": 0,
                "failed": 0,
                "pending_metrics_count": 3,
                "retryable": True,
                "failure_code": "network_error",
            }
        if name == "keyword_schedule_metric_refresh_retry":
            assert args[0]["attempt"] == 1
            return {"next_attempt_seconds": 1800}
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )

    result = await KeywordMetricsRecoveryWorkflow().run({"run_id": "run-1"})

    assert result["status"] == "waiting"
    assert result["next_attempt_seconds"] == 1800
    assert activity_calls == [
        "keyword_mark_metric_refresh_started",
        "keyword_refresh_pending_metrics",
        "keyword_schedule_metric_refresh_retry",
    ]


@pytest.mark.anyio
async def test_metric_recovery_does_not_repeat_a_terminal_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[str] = []

    async def execute_activity(name: str, *args, **kwargs):
        activity_calls.append(name)
        if name == "keyword_mark_metric_refresh_started":
            return {
                "attempt": 2,
                "status": "completed",
                "started": False,
            }
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )

    result = await KeywordMetricsRecoveryWorkflow().run({"run_id": "run-1"})

    assert result == {"status": "completed", "attempt": 2}
    assert activity_calls == ["keyword_mark_metric_refresh_started"]


@pytest.mark.anyio
async def test_metric_recovery_settles_after_the_third_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[str] = []

    async def execute_activity(name: str, *args, **kwargs):
        activity_calls.append(name)
        if name == "keyword_mark_metric_refresh_started":
            return {"attempt": 3}
        if name == "keyword_refresh_pending_metrics":
            return {
                "requested": 2,
                "updated": 0,
                "failed": 0,
                "pending_metrics_count": 2,
                "retryable": True,
            }
        if name == "keyword_settle_pending_metrics":
            return {
                "requested": 2,
                "updated": 0,
                "failed": 2,
                "pending_metrics_count": 0,
            }
        if name == "keyword_finish_metric_refresh_job":
            assert args[0]["exhausted"] is True
            return None
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )

    result = await KeywordMetricsRecoveryWorkflow().run({"run_id": "run-1"})

    assert result["status"] == "exhausted"
    assert result["failed"] == 2
    assert "keyword_schedule_metric_refresh_retry" not in activity_calls


@pytest.mark.anyio
async def test_recoverable_primary_failure_is_deferred_and_continued_as_new(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[tuple[str, object]] = []

    async def execute_activity(name: str, payload: object, **kwargs):
        activity_calls.append((name, payload))
        if name == "keyword_mark_started":
            return {"kind": "initial"}
        if name == "keyword_defer_run":
            return None
        raise AssertionError(f"unexpected activity: {name}")

    async def failed_discovery():
        raise ApplicationError("provider unavailable", type="network_error")

    async def completed(value):
        return value

    def start_activity(name: str, *args, **kwargs):
        if name == "keyword_discover_seeds":
            return asyncio.create_task(failed_discovery())
        if name == "keyword_acquire_business_profile":
            return asyncio.create_task(completed({"source": "site_profile"}))
        if name == "keyword_fetch_competitor_gap":
            return asyncio.create_task(completed({"status": "not_requested"}))
        raise AssertionError(f"unexpected activity: {name}")

    async def no_sleep(*args, **kwargs):
        return None

    def continue_as_new(task: dict) -> None:
        raise RuntimeError(f"continued:{task['_recovery_count']}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.start_activity",
        start_activity,
    )
    monkeypatch.setattr("seo_workers.keywords.workflow.workflow.sleep", no_sleep)
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.continue_as_new",
        continue_as_new,
    )

    with pytest.raises(RuntimeError, match="continued:1"):
        await KeywordBuildWorkflow().run({"run_id": "run-1"})

    names = [name for name, _ in activity_calls]
    assert names == ["keyword_mark_started", "keyword_defer_run"]
    defer_payload = activity_calls[1][1]
    assert isinstance(defer_payload, dict)
    assert defer_payload["code"] == "network_error"
    assert defer_payload["retry_seconds"] == 30
    assert "keyword_fail_run" not in names


@pytest.mark.anyio
async def test_non_recoverable_workflow_input_is_recorded_as_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[tuple[str, object]] = []

    async def execute_activity(name: str, payload: object, **kwargs):
        activity_calls.append((name, payload))
        if name == "keyword_mark_started":
            return {"kind": "expansion"}
        if name == "keyword_fail_run":
            return None
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )

    with pytest.raises(ApplicationError) as caught:
        await KeywordBuildWorkflow().run({"run_id": "run-1"})

    assert caught.value.type == "keyword_expansion_disabled"
    names = [name for name, _ in activity_calls]
    assert names == ["keyword_mark_started", "keyword_fail_run"]
    assert "keyword_defer_run" not in names


@pytest.mark.anyio
async def test_no_data_is_deferred_instead_of_completing_an_empty_library(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[tuple[str, object]] = []

    async def execute_activity(name: str, payload: object, **kwargs):
        activity_calls.append((name, payload))
        if name == "keyword_mark_started":
            return {"kind": "initial"}
        if name == "keyword_defer_run":
            return None
        raise AssertionError(f"unexpected activity: {name}")

    async def failed_discovery():
        raise ApplicationError(
            "no site keywords",
            type="site_seed_empty",
            non_retryable=True,
        )

    async def completed(value):
        return value

    def start_activity(name: str, *args, **kwargs):
        if name == "keyword_discover_seeds":
            return asyncio.create_task(failed_discovery())
        if name == "keyword_acquire_business_profile":
            return asyncio.create_task(completed({"source": "site_profile"}))
        if name == "keyword_fetch_competitor_gap":
            return asyncio.create_task(completed({"status": "not_requested"}))
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.start_activity",
        start_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.sleep",
        lambda *args, **kwargs: asyncio.sleep(0),
    )

    def continue_as_new(task: dict) -> None:
        raise RuntimeError(f"continued:{task['_recovery_count']}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.continue_as_new",
        continue_as_new,
    )

    with pytest.raises(RuntimeError, match="continued:1"):
        await KeywordBuildWorkflow().run({"run_id": "run-1"})

    assert [name for name, _ in activity_calls] == [
        "keyword_mark_started",
        "keyword_defer_run",
    ]
    defer_payload = activity_calls[1][1]
    assert isinstance(defer_payload, dict)
    assert defer_payload["code"] == "site_seed_empty"
    assert defer_payload["retry_seconds"] == 30


@pytest.mark.anyio
async def test_legacy_no_data_history_keeps_its_recorded_completion_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[str] = []

    async def execute_activity(name: str, payload: object, **kwargs):
        activity_calls.append(name)
        if name == "keyword_mark_started":
            return {"kind": "initial"}
        if name == "keyword_complete_empty":
            return None
        raise AssertionError(f"unexpected activity: {name}")

    async def failed_discovery():
        raise ApplicationError(
            "no site keywords",
            type="site_seed_empty",
            non_retryable=True,
        )

    async def completed(value):
        return value

    def start_activity(name: str, *args, **kwargs):
        if name == "keyword_discover_seeds":
            return asyncio.create_task(failed_discovery())
        if name == "keyword_acquire_business_profile":
            return asyncio.create_task(completed({"source": "site_profile"}))
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.start_activity",
        start_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.patched",
        lambda patch_id: False,
    )

    result = await KeywordBuildWorkflow().run({"run_id": "run-1"})

    assert result == {
        "status": "completed",
        "keyword_count": 0,
        "reason": "site_seed_empty",
    }
    assert activity_calls == ["keyword_mark_started", "keyword_complete_empty"]


@pytest.mark.anyio
async def test_configuration_failure_blocks_until_settings_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[tuple[str, object]] = []

    async def execute_activity(name: str, payload: object, **kwargs):
        activity_calls.append((name, payload))
        if name == "keyword_mark_started":
            return {"kind": "initial"}
        if name == "keyword_block_run":
            return None
        raise AssertionError(f"unexpected activity: {name}")

    async def failed_discovery():
        raise ApplicationError(
            "missing credentials",
            type="dataforseo_not_configured",
            non_retryable=True,
        )

    async def completed(value):
        return value

    def start_activity(name: str, *args, **kwargs):
        if name == "keyword_discover_seeds":
            return asyncio.create_task(failed_discovery())
        if name == "keyword_acquire_business_profile":
            return asyncio.create_task(completed({"source": "site_profile"}))
        if name == "keyword_fetch_competitor_gap":
            return asyncio.create_task(completed({"status": "not_requested"}))
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.start_activity",
        start_activity,
    )

    result = await KeywordBuildWorkflow().run({"run_id": "run-1"})

    assert result == {
        "status": "blocked",
        "reason": "dataforseo_not_configured",
        "retry_seconds": None,
    }
    block_payload = activity_calls[1][1]
    assert isinstance(block_payload, dict)
    assert block_payload["retry_seconds"] is None


@pytest.mark.anyio
async def test_recovery_exhaustion_moves_to_delayed_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_calls: list[tuple[str, object]] = []

    async def execute_activity(name: str, payload: object, **kwargs):
        activity_calls.append((name, payload))
        if name == "keyword_mark_started":
            return {"kind": "initial"}
        if name == "keyword_block_run":
            return None
        raise AssertionError(f"unexpected activity: {name}")

    async def failed_discovery():
        raise ApplicationError("provider unavailable", type="network_error")

    async def completed(value):
        return value

    def start_activity(name: str, *args, **kwargs):
        if name == "keyword_discover_seeds":
            return asyncio.create_task(failed_discovery())
        if name == "keyword_acquire_business_profile":
            return asyncio.create_task(completed({"source": "site_profile"}))
        if name == "keyword_fetch_competitor_gap":
            return asyncio.create_task(completed({"status": "not_requested"}))
        raise AssertionError(f"unexpected activity: {name}")

    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.execute_activity",
        execute_activity,
    )
    monkeypatch.setattr(
        "seo_workers.keywords.workflow.workflow.start_activity",
        start_activity,
    )

    result = await KeywordBuildWorkflow().run({"run_id": "run-1", "_recovery_count": 4})

    assert result == {
        "status": "blocked",
        "reason": "network_error",
        "retry_seconds": 3600,
    }
    block_payload = activity_calls[1][1]
    assert isinstance(block_payload, dict)
    assert block_payload["retry_seconds"] == 3600


def test_workflow_error_preserves_application_error_retryability() -> None:
    failure = workflow_error(
        ApplicationError(
            "invalid credentials",
            type="dataforseo_auth_failed",
            non_retryable=True,
        )
    )

    assert failure == WorkflowFailure(
        code="dataforseo_auth_failed",
        detail="dataforseo_auth_failed: invalid credentials",
        non_retryable=True,
    )
