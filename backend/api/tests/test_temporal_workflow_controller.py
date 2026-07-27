import asyncio
from typing import Any

from temporalio.exceptions import WorkflowAlreadyStartedError

from app.modules.audit.service import TemporalWorkflowController


class AlreadyStartedClient:
    async def start_workflow(self, workflow: str, task: dict[str, Any], **kwargs: Any) -> None:
        raise WorkflowAlreadyStartedError(kwargs["id"], workflow)


def test_start_is_idempotent_when_temporal_already_accepted_workflow(
    monkeypatch: Any,
) -> None:
    controller = TemporalWorkflowController("crawler-go")

    async def client() -> AlreadyStartedClient:
        return AlreadyStartedClient()

    monkeypatch.setattr(controller, "_client", client)

    asyncio.run(controller.start({"run_id": "run-1"}, "workflow-1"))
