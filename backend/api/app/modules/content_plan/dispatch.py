from __future__ import annotations

from temporalio.common import WorkflowIDReusePolicy
from temporalio.exceptions import WorkflowAlreadyStartedError

from app.modules.content_plan.repository import ContentPlanRepository
from app.workflows.client import connect_temporal


class TemporalContentPlanDispatcher:
    def __init__(self, repository: ContentPlanRepository, task_queue: str) -> None:
        self.repository = repository
        self.task_queue = task_queue

    async def dispatch(self, preparation_id: str) -> None:
        target = await self.repository.get_preparation_dispatch_target(preparation_id)
        if target is None:
            raise LookupError("content_plan_preparation_not_found")
        client = await connect_temporal()
        try:
            await client.start_workflow(
                "ContentPlanPreparationWorkflow",
                {"preparation_id": target.preparation_id},
                id=target.workflow_id,
                task_queue=self.task_queue,
                id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
            )
        except WorkflowAlreadyStartedError:
            return

    async def dispatch_batch(self, batch_id: str) -> None:
        target = await self.repository.get_batch_dispatch_target(batch_id)
        if target is None:
            raise LookupError("content_plan_batch_not_found")
        client = await connect_temporal()
        try:
            await client.start_workflow(
                "ContentPlanGenerationWorkflow",
                {"batch_id": target.batch_id},
                id=target.workflow_id,
                task_queue=self.task_queue,
                id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
            )
        except WorkflowAlreadyStartedError:
            return


__all__ = ["TemporalContentPlanDispatcher"]
