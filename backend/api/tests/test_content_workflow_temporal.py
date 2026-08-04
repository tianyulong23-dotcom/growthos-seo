import asyncio
import os
from collections import Counter
from typing import Any
from uuid import uuid4

import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from app.modules.content.workflows import ARTICLE_STAGES, ArticleGenerationWorkflow


def temporal_address() -> str:
    value = os.getenv("CONTENT_WORKFLOW_TEMPORAL_ADDRESS", "")
    if not value:
        pytest.skip("CONTENT_WORKFLOW_TEMPORAL_ADDRESS is not configured")
    return value


def test_real_worker_restart_does_not_repeat_completed_stages() -> None:
    async def scenario() -> None:
        calls: Counter[str] = Counter()
        writing_deferred = asyncio.Event()
        finishes: list[dict[str, Any]] = []

        @activity.defn(name="content_begin_run")
        async def fake_begin_run(payload: dict[str, Any]) -> dict[str, str]:
            return {"status": "running"}

        @activity.defn(name="content_execute_stage")
        async def fake_execute_stage(payload: dict[str, Any]) -> dict[str, Any]:
            step_key = str(payload["step_key"])
            calls[step_key] += 1
            if step_key == "writing" and calls[step_key] == 1:
                writing_deferred.set()
                return {"status": "busy"}
            return {
                "status": "completed",
                "warning": None,
                "result": (
                    {"passed": True, "issue_count": 0}
                    if payload.get("stage_kind") == "checking"
                    else {}
                ),
            }

        @activity.defn(name="content_recover_stage")
        async def fake_recover_stage(payload: dict[str, Any]) -> dict[str, Any]:
            return await fake_execute_stage(payload)

        @activity.defn(name="content_finish_run")
        async def fake_finish_run(payload: dict[str, Any]) -> None:
            finishes.append(payload)

        client = await Client.connect(temporal_address())
        queue = f"content-stage2-test-{uuid4()}"
        workflow_id = f"article-generation:test:{uuid4()}"
        activities = [
            fake_begin_run,
            fake_execute_stage,
            fake_recover_stage,
            fake_finish_run,
        ]

        first_worker = Worker(
            client,
            task_queue=queue,
            workflows=[ArticleGenerationWorkflow],
            activities=activities,
        )
        first_worker_task = asyncio.create_task(first_worker.run())
        handle = await client.start_workflow(
            ArticleGenerationWorkflow.run,
            {"run_id": "run-restart-test"},
            id=workflow_id,
            task_queue=queue,
        )
        try:
            await asyncio.wait_for(writing_deferred.wait(), timeout=60)
        except TimeoutError:
            await first_worker.shutdown()
            await asyncio.wait_for(first_worker_task, timeout=10)
            pytest.skip("Temporal worker did not receive tasks within the integration window")
        await asyncio.sleep(0.5)
        await first_worker.shutdown()
        await asyncio.wait_for(first_worker_task, timeout=10)

        async with Worker(
            client,
            task_queue=queue,
            workflows=[ArticleGenerationWorkflow],
            activities=activities,
        ):
            await asyncio.wait_for(handle.result(), timeout=60)

        for step_key, _ in ARTICLE_STAGES[:3]:
            assert calls[step_key] == 1
        assert calls["writing"] == 2
        assert finishes == [
            {
                "run_id": "run-restart-test",
                "status": "completed",
                "warnings": [],
            }
        ]

    asyncio.run(scenario())
