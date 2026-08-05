from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import time
import site
from pathlib import Path
from typing import Any
from uuid import uuid4

import asyncpg
import pytest
from sqlalchemy.engine import make_url
from temporalio.client import Client


def integration_settings() -> tuple[str, str]:
    address = os.getenv("AGENT_WORKFLOW_TEMPORAL_ADDRESS", "")
    database_url = os.getenv("AGENT_TEST_DATABASE_URL", "")
    if not address or not database_url:
        pytest.skip(
            "AGENT_WORKFLOW_TEMPORAL_ADDRESS and AGENT_TEST_DATABASE_URL are required"
        )
    if make_url(database_url).database != "seo_agent_v11_test":
        pytest.fail("Worker takeover tests may only use seo_agent_v11_test")
    return address, database_url


def database_connection_kwargs(database_url: str) -> dict[str, Any]:
    url = make_url(database_url)
    return {
        "host": url.host,
        "port": url.port,
        "user": url.username,
        "password": url.password,
        "database": url.database,
    }


async def wait_until(predicate: Any, timeout: float, message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await predicate():
            return
        await asyncio.sleep(0.1)
    raise TimeoutError(message)


def start_worker(
    address: str,
    queue: str,
    worker_id: str,
    ready_file: Path,
    database_url: str,
) -> subprocess.Popen[str]:
    environment = os.environ.copy()
    environment["AGENT_TEST_DATABASE_URL"] = database_url
    site_packages = next(
        path for path in site.getsitepackages() if path.endswith("site-packages")
    )
    environment["PYTHONPATH"] = os.pathsep.join(
        item
        for item in (site_packages, environment.get("PYTHONPATH", ""))
        if item
    )
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    python_executable = (
        getattr(sys, "_base_executable", sys.executable)
        if os.name == "nt"
        else sys.executable
    )
    output = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
    process = subprocess.Popen(
        [
            python_executable,
            str(Path(__file__).with_name("agent_worker_takeover_probe.py")),
            "--address",
            address,
            "--queue",
            queue,
            "--worker-id",
            worker_id,
            "--ready-file",
            str(ready_file),
        ],
        cwd=Path(__file__).parent.parent,
        env=environment,
        stdout=output,
        stderr=subprocess.STDOUT,
        text=True,
        creationflags=creation_flags,
    )
    process._agent_test_output = output  # type: ignore[attr-defined]
    return process


def worker_output(process: subprocess.Popen[str]) -> str:
    output = process._agent_test_output  # type: ignore[attr-defined]
    output.flush()
    output.seek(0)
    return output.read()


async def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            await asyncio.to_thread(process.wait, 5)
        except subprocess.TimeoutExpired:
            process.kill()
            await asyncio.to_thread(process.wait, 5)


def test_killed_worker_is_replaced_without_duplicate_business_write() -> None:
    async def scenario() -> None:
        address, database_url = integration_settings()
        database_kwargs = database_connection_kwargs(database_url)
        test_id = str(uuid4())
        operation_id = str(uuid4())
        queue = f"agent-takeover-test-{uuid4()}"
        workflow_id = f"agent-takeover-test:{uuid4()}"
        worker_a: subprocess.Popen[str] | None = None
        worker_b: subprocess.Popen[str] | None = None
        handle: Any | None = None
        connection = await asyncpg.connect(**database_kwargs)
        try:
            await connection.execute(
                """
                CREATE TABLE IF NOT EXISTS agent_worker_takeover_probe_results (
                    test_id uuid NOT NULL,
                    operation_id uuid PRIMARY KEY,
                    result_value text NOT NULL,
                    created_by text NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE TABLE IF NOT EXISTS agent_worker_takeover_probe_attempts (
                    test_id uuid NOT NULL,
                    operation_id uuid NOT NULL,
                    worker_id text NOT NULL,
                    started_at timestamptz NOT NULL DEFAULT now(),
                    PRIMARY KEY (test_id, worker_id)
                );
                """
            )
            with tempfile.TemporaryDirectory(prefix="agent-takeover-") as temp_dir:
                ready_a = Path(temp_dir) / "worker-a.ready"
                ready_b = Path(temp_dir) / "worker-b.ready"
                worker_a = start_worker(
                    address, queue, "worker-a", ready_a, database_url
                )

                async def worker_a_ready() -> bool:
                    if worker_a is not None and worker_a.poll() is not None:
                        raise RuntimeError(
                            f"worker-a exited before ready: {worker_output(worker_a)}"
                        )
                    return ready_a.exists()

                await wait_until(worker_a_ready, 20, "worker-a did not become ready")
                client = await Client.connect(address)
                handle = await client.start_workflow(
                    "AgentWorkerTakeoverProbeWorkflow",
                    {
                        "test_id": test_id,
                        "operation_id": operation_id,
                        "result_value": "saved-once",
                    },
                    id=workflow_id,
                    task_queue=queue,
                )

                async def first_write_committed() -> bool:
                    count = await connection.fetchval(
                        """
                        SELECT count(*) FROM agent_worker_takeover_probe_results
                        WHERE test_id = $1::uuid AND operation_id = $2::uuid
                        """,
                        test_id,
                        operation_id,
                    )
                    return count == 1

                try:
                    await wait_until(
                        first_write_committed,
                        20,
                        "worker-a did not commit the first write",
                    )
                except TimeoutError as exc:
                    await stop_process(worker_a)
                    raise TimeoutError(
                        f"{exc}; worker-a output={worker_output(worker_a)!r}"
                    ) from exc
                worker_b = start_worker(
                    address, queue, "worker-b", ready_b, database_url
                )

                async def worker_b_ready() -> bool:
                    if worker_b is not None and worker_b.poll() is not None:
                        raise RuntimeError(
                            f"worker-b exited before ready: {worker_output(worker_b)}"
                        )
                    return ready_b.exists()

                await wait_until(worker_b_ready, 20, "worker-b did not become ready")
                worker_a.kill()
                await asyncio.to_thread(worker_a.wait, 5)

                try:
                    result = await asyncio.wait_for(handle.result(), timeout=30)
                except Exception as exc:
                    await stop_process(worker_b)
                    raise RuntimeError(
                        f"takeover failed; worker-b output={worker_output(worker_b)!r}"
                    ) from exc
                assert result == {
                    "operation_id": operation_id,
                    "verified": True,
                    "reused_existing_result": True,
                }

                result_count = await connection.fetchval(
                    """
                    SELECT count(*) FROM agent_worker_takeover_probe_results
                    WHERE test_id = $1::uuid AND operation_id = $2::uuid
                    """,
                    test_id,
                    operation_id,
                )
                attempts = await connection.fetch(
                    """
                    SELECT worker_id FROM agent_worker_takeover_probe_attempts
                    WHERE test_id = $1::uuid ORDER BY worker_id
                    """,
                    test_id,
                )
                assert result_count == 1
                assert [row["worker_id"] for row in attempts] == [
                    "worker-a",
                    "worker-b",
                ]
        finally:
            if handle is not None:
                try:
                    await handle.terminate("isolated takeover test cleanup")
                except Exception:
                    pass
            if worker_a is not None:
                await stop_process(worker_a)
            if worker_b is not None:
                await stop_process(worker_b)
            await connection.execute(
                "DELETE FROM agent_worker_takeover_probe_attempts WHERE test_id = $1::uuid",
                test_id,
            )
            await connection.execute(
                "DELETE FROM agent_worker_takeover_probe_results WHERE test_id = $1::uuid",
                test_id,
            )
            await connection.execute(
                """
                DROP TABLE IF EXISTS agent_worker_takeover_probe_attempts;
                DROP TABLE IF EXISTS agent_worker_takeover_probe_results;
                """
            )
            await connection.close()

    asyncio.run(scenario())
