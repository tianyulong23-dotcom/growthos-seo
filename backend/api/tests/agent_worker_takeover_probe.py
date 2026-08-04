from __future__ import annotations

import argparse
import asyncio
import os
from datetime import timedelta
from pathlib import Path
from typing import Any

import psycopg
from sqlalchemy.engine import make_url
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.worker import Worker


def database_connection_kwargs() -> dict[str, Any]:
    url = make_url(os.environ["AGENT_TEST_DATABASE_URL"])
    return {
        "host": url.host,
        "port": url.port,
        "user": url.username,
        "password": url.password,
        "dbname": url.database,
    }


def write_once(payload: dict[str, str], worker_id: str) -> bool:
    with psycopg.connect(
        **database_connection_kwargs(),
        connect_timeout=5,
    ) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO agent_worker_takeover_probe_attempts
                    (test_id, operation_id, worker_id)
                VALUES (%s::uuid, %s::uuid, %s)
                ON CONFLICT (test_id, worker_id) DO NOTHING
                """,
                (payload["test_id"], payload["operation_id"], worker_id),
            )
            cursor.execute(
                """
                INSERT INTO agent_worker_takeover_probe_results
                    (test_id, operation_id, result_value, created_by)
                VALUES (%s::uuid, %s::uuid, %s, %s)
                ON CONFLICT (operation_id) DO NOTHING
                RETURNING true
                """,
                (
                    payload["test_id"],
                    payload["operation_id"],
                    payload["result_value"],
                    worker_id,
                ),
            )
            return cursor.fetchone() is not None


@activity.defn(name="agent_worker_takeover_probe_activity")
async def takeover_activity(payload: dict[str, str]) -> dict[str, Any]:
    worker_id = os.environ["AGENT_TAKEOVER_WORKER_ID"]
    print(f"{worker_id}: activity started", flush=True)
    write_task = asyncio.create_task(asyncio.to_thread(write_once, payload, worker_id))
    while not write_task.done():
        activity.heartbeat({"operation_id": payload["operation_id"]})
        await asyncio.sleep(0.25)
    inserted = await write_task
    print(f"{worker_id}: write committed={inserted}", flush=True)

    if inserted:
        while True:
            activity.heartbeat({"operation_id": payload["operation_id"]})
            await asyncio.sleep(0.25)

    return {
        "operation_id": payload["operation_id"],
        "verified": True,
        "reused_existing_result": True,
    }


@workflow.defn(name="AgentWorkerTakeoverProbeWorkflow")
class AgentWorkerTakeoverProbeWorkflow:
    @workflow.run
    async def run(self, payload: dict[str, str]) -> dict[str, Any]:
        return await workflow.execute_activity(
            "agent_worker_takeover_probe_activity",
            payload,
            start_to_close_timeout=timedelta(seconds=30),
            schedule_to_close_timeout=timedelta(seconds=90),
            heartbeat_timeout=timedelta(seconds=5),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(milliseconds=250),
                maximum_interval=timedelta(seconds=1),
                maximum_attempts=5,
            ),
        )


async def run_worker(address: str, queue: str, ready_file: Path) -> None:
    client = await Client.connect(address)
    worker = Worker(
        client,
        task_queue=queue,
        workflows=[AgentWorkerTakeoverProbeWorkflow],
        activities=[takeover_activity],
    )
    async with worker:
        ready_file.write_text("ready", encoding="ascii")
        print(f"{os.environ['AGENT_TAKEOVER_WORKER_ID']}: worker ready", flush=True)
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", required=True)
    parser.add_argument("--queue", required=True)
    parser.add_argument("--worker-id", required=True)
    parser.add_argument("--ready-file", required=True, type=Path)
    args = parser.parse_args()
    os.environ["AGENT_TAKEOVER_WORKER_ID"] = args.worker_id
    asyncio.run(run_worker(args.address, args.queue, args.ready_file))


if __name__ == "__main__":
    main()
