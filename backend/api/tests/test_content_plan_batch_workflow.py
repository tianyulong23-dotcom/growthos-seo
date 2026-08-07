from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import ActivityError, WorkflowAlreadyStartedError

from app.modules.content_plan import activities, workflows
from app.modules.content_plan.batch_service import ContentPlanBatchService
from app.modules.content_plan.d6_service import ContentPlanD6Service
from app.modules.content_plan.dispatch import TemporalContentPlanDispatcher
from app.modules.content_plan.repository import BatchRetryTarget
from app.modules.content_plan.workflows import (
    ContentPlanGenerationWorkflow,
    ContentPlanPreparationWorkflow,
)

pytestmark = pytest.mark.anyio


class DispatchTarget:
    organization_id = "org-a"
    batch_id = "batch-a"
    workflow_id = "content-plan:automatic:batch-a"


class FakeRepository:
    def __init__(self, *, status: str = "queued", stage: str = "queued") -> None:
        self.batch = SimpleNamespace(status=status, stage=stage, target_count=30)

    async def get_batch_dispatch_target(self, batch_id: str):
        assert batch_id == "batch-a"
        return DispatchTarget()

    async def get_batch(self, batch_id: str):
        assert batch_id == "batch-a"
        return self.batch


class CreateRepository(FakeRepository):
    def __init__(self, *, status: str = "queued", error_code: str | None = None):
        self.status = status
        self.error_code = error_code
        self.created: list[dict[str, object]] = []

    async def get_project_plan_context(self, organization_id: str, project_id: str):
        assert (organization_id, project_id) == ("org-a", "project-a")
        return SimpleNamespace(
            project=SimpleNamespace(country="US", language="en"),
            settings=SimpleNamespace(timezone="America/New_York"),
            business_context={
                "business_name": "Detail Lab",
                "business_type": "local service",
                "business_summary": "Car detailing service.",
                "target_audiences": ["car owners"],
                "products_services": ["car detailing"],
            },
        )

    async def create_automatic_batch(self, **values):
        self.created.append(values)
        return SimpleNamespace(
            id=values["batch_id"],
            status=self.status,
            error_code=self.error_code,
        )


class RetryRepository(FakeRepository):
    def __init__(self, batch: object | None) -> None:
        self.batch = batch
        self.calls: list[tuple[str, str, str]] = []

    async def prepare_batch_retry_scoped(
        self, organization_id: str, project_id: str, batch_id: str
    ):
        self.calls.append((organization_id, project_id, batch_id))
        return self.batch


class FailingDispatcher:
    def __init__(self) -> None:
        self.batch_calls: list[str] = []
        self.preparation_calls: list[str] = []

    async def dispatch(self, preparation_id: str) -> None:
        self.preparation_calls.append(preparation_id)
        raise RuntimeError("temporal unavailable")

    async def dispatch_batch(self, batch_id: str) -> None:
        self.batch_calls.append(batch_id)
        raise RuntimeError("temporal unavailable")


class FakeD3:
    def __init__(self, status: str, error_code: str | None = None) -> None:
        self.status = status
        self.error_code = error_code
        self.calls: list[str] = []

    async def run(self, batch_id: str):
        self.calls.append(batch_id)
        return type(
            "D3Result",
            (),
            {"status": self.status, "error_code": self.error_code},
        )()


class FakeD4:
    def __init__(self, status: str = "completed") -> None:
        self.status = status
        self.calls: list[str] = []

    async def run(self, batch_id: str):
        self.calls.append(batch_id)
        return type(
            "D4Result",
            (),
            {
                "status": self.status,
                "error_code": None,
                "plan_item_count": 30,
            },
        )()


async def test_batch_service_runs_d3_then_d4_only_when_keyword_packs_are_ready() -> None:
    d3 = FakeD3("pack_ready")
    d4 = FakeD4()
    service = ContentPlanBatchService(FakeRepository(), d3_service=d3, d4_service=d4)

    result = await service.process_batch("batch-a")

    assert result == {
        "batch_id": "batch-a",
        "status": "completed",
        "plan_item_count": 30,
    }
    assert d3.calls == ["batch-a"]
    assert d4.calls == ["batch-a"]


async def test_batch_service_stops_before_d4_for_permanent_d3_failure() -> None:
    d3 = FakeD3("needs_attention", "external_request_outcome_unknown")
    d4 = FakeD4()
    service = ContentPlanBatchService(FakeRepository(), d3_service=d3, d4_service=d4)

    result = await service.process_batch("batch-a")

    assert result["status"] == "needs_attention"
    assert d4.calls == []


async def test_batch_service_resumes_d4_without_replaying_d3() -> None:
    d3 = FakeD3("needs_attention", "pack_shortage")
    d4 = FakeD4()
    service = ContentPlanBatchService(
        FakeRepository(status="building_previews", stage="d4_serp_preview"),
        d3_service=d3,
        d4_service=d4,
    )

    result = await service.process_batch("batch-a")

    assert result["status"] == "completed"
    assert d3.calls == []
    assert d4.calls == ["batch-a"]


async def test_batch_service_returns_completed_batch_without_replaying_work() -> None:
    d3 = FakeD3("pack_ready")
    d4 = FakeD4()
    service = ContentPlanBatchService(
        FakeRepository(status="completed", stage="scheduled"),
        d3_service=d3,
        d4_service=d4,
    )

    result = await service.process_batch("batch-a")

    assert result == {
        "batch_id": "batch-a",
        "status": "completed",
        "plan_item_count": 30,
    }
    assert d3.calls == []
    assert d4.calls == []


async def test_persisted_batch_is_accepted_when_immediate_dispatch_fails() -> None:
    repository = CreateRepository()
    dispatcher = FailingDispatcher()
    service = ContentPlanBatchService(
        repository,
        d3_service=FakeD3("pack_ready"),
        d4_service=FakeD4(),
        dispatcher=dispatcher,
    )

    accepted = await service.create_automatic("org-a", "project-a", idempotency_key="batch-key")

    assert accepted.status == "queued"
    assert accepted.target_count == 30
    assert dispatcher.batch_calls == [accepted.batch_id]
    assert dispatcher.preparation_calls == []
    assert repository.created[0]["business_context"]["business_name"] == "Detail Lab"


async def test_completed_idempotent_replay_is_not_dispatched_again() -> None:
    repository = CreateRepository(status="completed")
    dispatcher = FailingDispatcher()
    service = ContentPlanBatchService(
        repository,
        d3_service=FakeD3("pack_ready"),
        d4_service=FakeD4(),
        dispatcher=dispatcher,
    )

    await service.create_automatic("org-a", "project-a", idempotency_key="completed-key")

    assert dispatcher.batch_calls == []


async def test_automatic_retry_reopens_batch_and_dispatches_batch_workflow() -> None:
    row = SimpleNamespace(id="batch-a", source="automatic", target_count=30)
    repository = RetryRepository(BatchRetryTarget(row, None))
    dispatcher = FailingDispatcher()
    service = ContentPlanBatchService(
        repository,
        d3_service=FakeD3("pack_ready"),
        d4_service=FakeD4(),
        dispatcher=dispatcher,
    )

    result = await service.retry_batch("org-a", "project-a", "batch-a")

    assert result.batch_id == "batch-a"
    assert result.target_count == 30
    assert repository.calls == [("org-a", "project-a", "batch-a")]
    assert dispatcher.batch_calls == ["batch-a"]
    assert dispatcher.preparation_calls == []


async def test_manual_retry_dispatches_its_preparation_workflow() -> None:
    row = SimpleNamespace(id="batch-manual", source="manual", target_count=1)
    repository = RetryRepository(
        BatchRetryTarget(row, "preparation-manual")
    )
    dispatcher = FailingDispatcher()
    service = ContentPlanBatchService(
        repository,
        d3_service=FakeD3("pack_ready"),
        d4_service=FakeD4(),
        dispatcher=dispatcher,
    )

    result = await service.retry_batch("org-a", "project-a", "batch-manual")

    assert result.batch_id == "batch-manual"
    assert result.target_count == 1
    assert repository.calls == [("org-a", "project-a", "batch-manual")]
    assert dispatcher.batch_calls == []
    assert dispatcher.preparation_calls == ["preparation-manual"]


async def test_batch_dispatch_allows_same_workflow_id_after_a_finished_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = FakeRepository()
    client = SimpleNamespace(start_workflow=AsyncMock())

    async def connect():
        return client

    monkeypatch.setattr("app.modules.content_plan.dispatch.connect_temporal", connect)

    await TemporalContentPlanDispatcher(repository, "content-plan").dispatch_batch("batch-a")

    client.start_workflow.assert_awaited_once_with(
        "ContentPlanGenerationWorkflow",
        {"batch_id": "batch-a"},
        id="content-plan:automatic:batch-a",
        task_queue="content-plan",
        id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
    )


async def test_batch_dispatch_treats_an_active_same_id_workflow_as_dispatched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = FakeRepository()
    client = SimpleNamespace(
        start_workflow=AsyncMock(
            side_effect=WorkflowAlreadyStartedError(
                "content-plan:automatic:batch-a", "ContentPlanGenerationWorkflow"
            )
        )
    )

    async def connect():
        return client

    monkeypatch.setattr("app.modules.content_plan.dispatch.connect_temporal", connect)

    await TemporalContentPlanDispatcher(repository, "content-plan").dispatch_batch("batch-a")

    assert client.start_workflow.await_count == 1


async def test_generation_workflow_retries_only_explicit_retryable_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock(
        side_effect=[
            {"status": "retryable_failed"},
            {"status": "completed"},
        ]
    )
    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)

    await ContentPlanGenerationWorkflow().run({"batch_id": "batch-a"})

    assert execute.await_count == 2
    sleep.assert_awaited_once()


async def test_batch_activity_marks_database_failure_as_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = SimpleNamespace(
        process_batch=AsyncMock(side_effect=SQLAlchemyError("database unavailable"))
    )
    monkeypatch.setattr(
        activities,
        "build_content_plan_batch_service",
        lambda: service,
    )

    result = await activities.process_batch({"batch_id": "batch-a"})

    assert result == {
        "batch_id": "batch-a",
        "status": "retryable_failed",
        "error_code": "content_plan_database_failed",
        "error_detail": "database unavailable",
    }


async def test_generation_workflow_does_not_swallow_unknown_activity_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock(side_effect=RuntimeError("unknown activity failure"))
    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)

    with pytest.raises(RuntimeError, match="unknown activity failure"):
        await ContentPlanGenerationWorkflow().run({"batch_id": "batch-a"})

    sleep.assert_not_awaited()


async def test_generation_workflow_retries_temporal_activity_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_error = ActivityError(
        "worker stopped during activity",
        scheduled_event_id=1,
        started_event_id=2,
        identity="content-worker",
        activity_type="content_plan_process_batch",
        activity_id="activity-a",
        retry_state=None,
    )
    process_results = 0

    async def execute(activity_name: str, payload: dict, **_kwargs):
        nonlocal process_results
        if activity_name == "content_plan_process_batch":
            process_results += 1
            raise activity_error
        assert activity_name == "content_plan_mark_batch_retry_exhausted"
        assert payload == {
            "batch_id": "batch-a",
            "error_code": "content_plan_activity_failed",
        }
        return {"status": "needs_attention"}

    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)

    await ContentPlanGenerationWorkflow().run({"batch_id": "batch-a"})

    assert process_results == 5
    assert [call.args[0].total_seconds() for call in sleep.await_args_list] == [
        2,
        4,
        8,
        16,
    ]


async def test_generation_workflow_stops_after_five_technical_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process_results = 0

    async def execute(activity_name: str, payload: dict, **_kwargs):
        nonlocal process_results
        if activity_name == "content_plan_process_batch":
            process_results += 1
            return {
                "status": "retryable_failed",
                "error_code": "content_plan_scheduling_failed",
            }
        assert activity_name == "content_plan_mark_batch_retry_exhausted"
        assert payload == {
            "batch_id": "batch-a",
            "error_code": "content_plan_scheduling_failed",
        }
        return {"status": "needs_attention"}

    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)

    await ContentPlanGenerationWorkflow().run({"batch_id": "batch-a"})

    assert process_results == 5
    assert sleep.await_count == 4
    assert [call.args[0].total_seconds() for call in sleep.await_args_list] == [
        2,
        4,
        8,
        16,
    ]


async def test_preparation_workflow_retries_only_explicit_retryable_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    execute = AsyncMock(
        side_effect=[
            {"status": "retryable_failed", "error_code": "temporary_failure"},
            {"status": "completed"},
        ]
    )
    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)

    await ContentPlanPreparationWorkflow().run({"preparation_id": "preparation-a"})

    assert execute.await_count == 2
    sleep.assert_awaited_once()


async def test_preparation_workflow_stops_after_five_technical_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process_results = 0

    async def execute(activity_name: str, payload: dict, **_kwargs):
        nonlocal process_results
        if activity_name == "content_plan_process_preparation":
            process_results += 1
            return {
                "status": "retryable_failed",
                "error_code": "content_plan_database_failed",
            }
        assert activity_name == "content_plan_mark_preparation_retry_exhausted"
        assert payload == {
            "preparation_id": "preparation-a",
            "error_code": "content_plan_database_failed",
        }
        return {"status": "failed"}

    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)

    await ContentPlanPreparationWorkflow().run({"preparation_id": "preparation-a"})

    assert process_results == 5
    assert [call.args[0].total_seconds() for call in sleep.await_args_list] == [
        2,
        4,
        8,
        16,
    ]


async def test_preparation_workflow_counts_temporal_activity_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activity_error = ActivityError(
        "worker stopped during activity",
        scheduled_event_id=1,
        started_event_id=2,
        identity="content-worker",
        activity_type="content_plan_process_preparation",
        activity_id="activity-a",
        retry_state=None,
    )
    process_results = 0

    async def execute(activity_name: str, payload: dict, **_kwargs):
        nonlocal process_results
        if activity_name == "content_plan_process_preparation":
            process_results += 1
            raise activity_error
        assert payload == {
            "preparation_id": "preparation-a",
            "error_code": "content_plan_activity_failed",
        }
        return {"status": "failed"}

    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)

    await ContentPlanPreparationWorkflow().run({"preparation_id": "preparation-a"})

    assert process_results == 5
    assert sleep.await_count == 4


async def test_preparation_activity_marks_database_failure_as_retryable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = SimpleNamespace(
        process_preparation=AsyncMock(side_effect=SQLAlchemyError("database unavailable"))
    )
    monkeypatch.setattr(activities, "build_content_plan_d6_service", lambda: service)

    result = await activities.process_preparation({"preparation_id": "preparation-a"})

    assert result == {
        "preparation_id": "preparation-a",
        "status": "retryable_failed",
        "error_code": "content_plan_database_failed",
        "error_detail": "database unavailable",
    }


async def test_preparation_retry_exhaustion_updates_manual_and_edit_states() -> None:
    class Repository:
        def __init__(self, plan_item_id: str | None) -> None:
            self.plan_item_id = plan_item_id
            self.manual_failures: list[dict[str, str]] = []
            self.edit_failures: list[dict[str, str]] = []

        async def get_preparation_bundle(self, preparation_id: str):
            return SimpleNamespace(
                preparation=SimpleNamespace(
                    id=preparation_id,
                    plan_item_id=self.plan_item_id,
                )
            )

        async def fail_manual_preparation(self, preparation_id: str, **values):
            self.manual_failures.append({"preparation_id": preparation_id, **values})

        async def fail_plan_item_repreparation(self, preparation_id: str, **values):
            self.edit_failures.append({"preparation_id": preparation_id, **values})
            return SimpleNamespace(id=self.plan_item_id)

    async def generate_now(_item_id: str, _version: int) -> None:
        return None

    manual_repository = Repository(None)
    manual_service = ContentPlanD6Service(
        manual_repository,
        d3_service=SimpleNamespace(),
        d4_service=SimpleNamespace(),
        generate_now=generate_now,
    )
    manual_result = await manual_service.mark_retry_exhausted(
        "preparation-manual", last_error_code="content_plan_database_failed"
    )

    edit_repository = Repository("item-a")
    edit_service = ContentPlanD6Service(
        edit_repository,
        d3_service=SimpleNamespace(),
        d4_service=SimpleNamespace(),
        generate_now=generate_now,
    )
    edit_result = await edit_service.mark_retry_exhausted(
        "preparation-edit", last_error_code=None
    )

    assert manual_result.status == "failed"
    assert manual_repository.manual_failures[0]["error_code"] == (
        "content_plan_technical_retry_exhausted"
    )
    assert edit_result.status == "reprepare_failed"
    assert edit_result.item_id == "item-a"
    assert edit_repository.edit_failures[0]["error_code"] == (
        "content_plan_technical_retry_exhausted"
    )


async def test_retry_exhaustion_becomes_nonrecoverable_attention_state() -> None:
    repository = FakeRepository(status="needs_attention", stage="d5_scheduling_failed")
    repository.updates = []

    async def update_batch_progress(batch_id: str, **values):
        assert batch_id == "batch-a"
        repository.updates.append(values)

    repository.update_batch_progress = update_batch_progress
    service = ContentPlanBatchService(
        repository,
        d3_service=FakeD3("pack_ready"),
        d4_service=FakeD4(),
    )

    result = await service.mark_retry_exhausted(
        "batch-a", last_error_code="content_plan_scheduling_failed"
    )

    assert result["status"] == "needs_attention"
    assert result["error_code"] == "content_plan_technical_retry_exhausted"
    assert repository.updates == [
        {
            "status": "needs_attention",
            "stage": "d5_scheduling_failed",
            "error_code": "content_plan_technical_retry_exhausted",
            "error_detail": (
                "Automatic technical retries exhausted after 5 attempts: "
                "content_plan_scheduling_failed"
            ),
        }
    ]
