from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

from temporalio import activity
from temporalio.api.enums.v1 import TaskQueueType
from temporalio.api.taskqueue.v1 import TaskQueue
from temporalio.api.workflowservice.v1 import DescribeTaskQueueRequest
from temporalio.client import Client
from temporalio.worker import Worker

from app.modules.agent.activities import (
    check_run,
    execute_tool,
    finish,
    finish_turn,
    repository,
    set_status,
    skip_tool_calls,
    stream_final,
)
from app.modules.agent.tools import ToolRegistry
from app.modules.agent.workflows import AgentWorkflow


TOOL_NAME = os.environ["AGENT_FULL_TAKEOVER_TOOL_NAME"]
TOOL_ARGUMENTS = json.loads(os.environ["AGENT_FULL_TAKEOVER_TOOL_ARGUMENTS"])
WORKER_ID = os.environ["AGENT_FULL_TAKEOVER_WORKER_ID"]
FIRST_WRITE_MARKER = Path(os.environ["AGENT_FULL_TAKEOVER_FIRST_WRITE_MARKER"])
REUSED_WRITE_MARKER = Path(os.environ["AGENT_FULL_TAKEOVER_REUSED_WRITE_MARKER"])


@activity.defn(name="agent_model_decide")
async def deterministic_model_decide(payload: dict[str, Any]) -> dict[str, Any]:
    repo = repository()
    round_number = int(payload["round"])
    if round_number == 1:
        registered = await repo.registered_tool_call_refs(payload["run_id"], 1)
        if not registered:
            registered = await repo.register_tool_calls(
                payload["run_id"],
                1,
                [
                    {
                        "tool_call_id": "production-validation-write",
                        "tool": TOOL_NAME,
                        "arguments": TOOL_ARGUMENTS,
                    }
                ],
                256_000,
            )
        return {"type": "tool_calls", "tool_calls": registered}
    return {
        "type": "final",
        "answer": f"{TOOL_NAME} 已完成。",
        "evidence": [],
    }


@activity.defn(name="agent_judge_final")
async def deterministic_judge_final(_: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "completed",
        "reason": "正式业务写入已经完成并通过工具校验",
        "criteria": [],
        "remaining_work": [],
    }


def write_marker(path: Path, result: dict[str, Any]) -> None:
    info = activity.info()
    path.write_text(
        json.dumps(
            {
                "worker_id": WORKER_ID,
                "process_id": os.getpid(),
                "activity_id": info.activity_id,
                "activity_attempt": int(info.attempt),
                "workflow_id": info.workflow_id,
                "workflow_run_id": info.workflow_run_id,
                "operation_id": result.get("operation_id"),
                "already_completed": bool(result.get("already_completed")),
                "status": result.get("status"),
                "verified": result.get("verified"),
            },
            sort_keys=True,
        ),
        encoding="ascii",
    )


original_execute_write = ToolRegistry.execute_write


async def controlled_execute_write(
    self: ToolRegistry,
    project_id: str,
    name: str,
    arguments: dict[str, Any],
    before: dict[str, Any],
    expected_hash: str,
) -> dict[str, Any]:
    result = await original_execute_write(
        self, project_id, name, arguments, before, expected_hash
    )
    if name != TOOL_NAME:
        return result
    if result.get("already_completed"):
        write_marker(REUSED_WRITE_MARKER, result)
        return result
    write_marker(FIRST_WRITE_MARKER, result)
    if WORKER_ID == "worker-a":
        await asyncio.Future()
    return result


ToolRegistry.execute_write = controlled_execute_write


async def wait_for_registered_pollers(
    client: Client,
    queue: str,
    identity: str,
    task_queue_types: tuple[TaskQueueType.ValueType, ...],
) -> None:
    for task_queue_type in task_queue_types:
        observed_identities: list[str] = []
        for attempt in range(200):
            response = await client.service_client.workflow_service.describe_task_queue(
                DescribeTaskQueueRequest(
                    namespace=client.namespace,
                    task_queue=TaskQueue(name=queue),
                    task_queue_type=task_queue_type,
                    report_pollers=True,
                )
            )
            observed_identities = [poller.identity for poller in response.pollers]
            if any(poller.identity == identity for poller in response.pollers):
                break
            if attempt % 20 == 19:
                print(
                    "waiting for Temporal poller registration: "
                    f"queue={queue} type={task_queue_type} "
                    f"identity={identity} observed={observed_identities}",
                    flush=True,
                )
            await asyncio.sleep(0.1)
        else:
            raise TimeoutError(
                f"Temporal did not register {identity} for task queue type "
                f"{task_queue_type}; observed identities={observed_identities}"
            )


async def run_worker(address: str, queue: str, ready_file: Path) -> None:
    identity = f"agent-full-takeover:{WORKER_ID}:{os.getpid()}"
    client = await Client.connect(address, identity=identity)
    worker = Worker(
        client,
        task_queue=queue,
        workflows=[AgentWorkflow],
        activities=[
            set_status,
            finish_turn,
            check_run,
            deterministic_model_decide,
            deterministic_judge_final,
            stream_final,
            execute_tool,
            skip_tool_calls,
            finish,
        ],
    )
    async with worker:
        task_queue_types = (TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW,)
        if WORKER_ID == "worker-a":
            task_queue_types += (TaskQueueType.TASK_QUEUE_TYPE_ACTIVITY,)
        await wait_for_registered_pollers(
            client,
            queue,
            identity,
            task_queue_types,
        )
        ready_file.write_text(
            json.dumps(
                {
                    "worker_id": WORKER_ID,
                    "process_id": os.getpid(),
                    "temporal_identity": identity,
                    "workflow_poller_registered": True,
                    "activity_poller_registered": WORKER_ID == "worker-a",
                },
                sort_keys=True,
            ),
            encoding="ascii",
        )
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", required=True)
    parser.add_argument("--queue", required=True)
    parser.add_argument("--ready-file", required=True, type=Path)
    args = parser.parse_args()
    asyncio.run(run_worker(args.address, args.queue, args.ready_file))


if __name__ == "__main__":
    main()
