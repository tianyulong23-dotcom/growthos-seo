from __future__ import annotations

import asyncio
import json
import os
import site
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.engine import URL, make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from temporalio.api.enums.v1 import EventType
from temporalio.client import Client

from app.modules.agent.models import (
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentToolExecution,
)
from app.modules.crawling.models import CrawlRun
from app.modules.projects.models import (
    Project,
    SiteProfile,
    SiteProfileOperation,
    WorkflowDispatch,
)


LIMITS = {
    "model_rounds": 4,
    "tool_calls": 8,
    "consecutive_failures": 3,
    "model_timeout_seconds": 30,
    "read_tool_timeout_seconds": 30,
    "write_tool_timeout_seconds": 60,
    "run_timeout_seconds": 180,
    "execution_lease_seconds": 15,
    "tool_arguments_bytes": 256_000,
    "tool_result_bytes": 102_400,
    "final_answer_chars": 8_000,
    "recent_tokens": 5_000,
}


def compose_environment() -> dict[str, str]:
    env_file = Path(__file__).parents[3] / "deploy" / "compose" / ".env"
    if not env_file.is_file():
        pytest.skip(
            "Agent takeover integration requires explicit service environment variables "
            "or deploy/compose/.env"
        )
    values: dict[str, str] = {}
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def integration_settings() -> tuple[str, str, str]:
    database_url = os.getenv("AGENT_TEST_DATABASE_URL", "")
    temporal_address = os.getenv("AGENT_WORKFLOW_TEMPORAL_ADDRESS", "")
    redis_url = os.getenv("AGENT_WORKFLOW_REDIS_URL", "")
    if not database_url or not temporal_address or not redis_url:
        compose = compose_environment()
    if not database_url:
        database_url = URL.create(
            "postgresql+asyncpg",
            username="postgres",
            password=compose["POSTGRES_PASSWORD"],
            host="127.0.0.1",
            port=int(compose.get("POSTGRES_HOST_PORT", "5432")),
            database="seo_agent_v11_test",
        ).render_as_string(hide_password=False)
    if make_url(database_url).database != "seo_agent_v11_test":
        pytest.fail("Full Agent takeover tests may only use seo_agent_v11_test")
    if not temporal_address:
        temporal_address = f"127.0.0.1:{compose.get('TEMPORAL_HOST_PORT', '7233')}"
    if not redis_url:
        redis_url = f"redis://127.0.0.1:{compose.get('REDIS_HOST_PORT', '6379')}/0"
    return temporal_address, database_url, redis_url


async def wait_until(predicate: Any, timeout: float, message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await predicate():
            return
        await asyncio.sleep(0.1)
    raise TimeoutError(message)


def start_worker(
    *,
    address: str,
    queue: str,
    worker_id: str,
    ready_file: Path,
    first_write_marker: Path,
    reused_write_marker: Path,
    database_url: str,
    redis_url: str,
    tool_name: str,
    tool_arguments: dict[str, Any],
) -> subprocess.Popen[str]:
    api_root = Path(__file__).parent.parent
    environment = os.environ.copy()
    environment.update(
        {
            "APP_ENV": "test",
            "DATABASE_URL": database_url,
            "AGENT_TEST_DATABASE_URL": database_url,
            "REDIS_URL": redis_url,
            "TEMPORAL_ADDRESS": address,
            "AGENT_FULL_TAKEOVER_WORKER_ID": worker_id,
            "AGENT_FULL_TAKEOVER_FIRST_WRITE_MARKER": str(first_write_marker),
            "AGENT_FULL_TAKEOVER_REUSED_WRITE_MARKER": str(reused_write_marker),
            "AGENT_FULL_TAKEOVER_TOOL_NAME": tool_name,
            "AGENT_FULL_TAKEOVER_TOOL_ARGUMENTS": json.dumps(tool_arguments),
        }
    )
    site_packages = next(
        path for path in site.getsitepackages() if path.endswith("site-packages")
    )
    environment["PYTHONPATH"] = os.pathsep.join(
        item
        for item in (
            str(api_root),
            site_packages,
            environment.get("PYTHONPATH", ""),
        )
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
            str(Path(__file__).with_name("agent_full_workflow_takeover_probe.py")),
            "--address",
            address,
            "--queue",
            queue,
            "--ready-file",
            str(ready_file),
        ],
        cwd=api_root,
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


async def wait_for_worker(
    process: subprocess.Popen[str], ready_file: Path, worker_id: str
) -> dict[str, Any]:
    async def ready() -> bool:
        if process.poll() is not None:
            raise RuntimeError(
                f"{worker_id} exited before ready; output={worker_output(process)!r}"
            )
        return ready_file.exists()

    try:
        await wait_until(ready, 30, f"{worker_id} did not become ready")
    except TimeoutError as exc:
        raise TimeoutError(
            f"{exc}; pid={process.pid}; return_code={process.poll()}; "
            f"output={worker_output(process)!r}"
        ) from exc
    readiness = json.loads(ready_file.read_text(encoding="ascii"))
    assert readiness == {
        "activity_poller_registered": worker_id == "worker-a",
        "process_id": process.pid,
        "temporal_identity": f"agent-full-takeover:{worker_id}:{process.pid}",
        "worker_id": worker_id,
        "workflow_poller_registered": True,
    }
    return readiness


async def takeover_diagnostics(
    *,
    sessions: async_sessionmaker[AsyncSession],
    run_id: str,
    tool_call_id: str,
    handle: Any,
    worker: subprocess.Popen[str],
) -> dict[str, Any]:
    async with sessions() as session:
        run = await session.get(AgentRun, run_id)
        execution = await session.get(AgentToolExecution, tool_call_id)
    history_events: list[dict[str, Any]] = []
    try:
        history = await handle.fetch_history()
        history_events = [
            {
                "event_id": event.event_id,
                "event_type": EventType.Name(event.event_type),
            }
            for event in history.events[-20:]
        ]
    except Exception as exc:
        history_events = [{"history_error": repr(exc)}]
    return {
        "worker": {
            "pid": worker.pid,
            "return_code": worker.poll(),
            "output": worker_output(worker),
        },
        "run": None
        if run is None
        else {
            "status": run.status,
            "error_code": run.error_code,
            "error_message": run.error_message,
        },
        "tool_execution": None
        if execution is None
        else {
            "status": execution.status,
            "worker_id": execution.worker_id,
            "error_code": execution.error_code,
            "lease_expires_at": (
                execution.lease_expires_at.isoformat()
                if execution.lease_expires_at is not None
                else None
            ),
        },
        "temporal_history": history_events,
    }


@pytest.mark.parametrize(
    "tool_name",
    [
        "update_business_profile",
        "refresh_business_profile",
        "start_technical_audit",
    ],
)
def test_formal_agent_workflow_survives_worker_loss_without_duplicate_write(
    tool_name: str,
) -> None:
    async def scenario() -> None:
        address, database_url, redis_url = integration_settings()
        engine = create_async_engine(database_url, pool_pre_ping=True)
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        test_id = str(uuid4())
        project_id = str(uuid4())
        crawl_run_id = str(uuid4())
        conversation_id = str(uuid4())
        message_id = str(uuid4())
        run_id = str(uuid4())
        workflow_id = f"agent-full-takeover:{test_id}"
        task_queue = f"agent-full-takeover-{test_id}"
        target_business_name = f"Takeover verified {test_id[:8]}"
        tool_arguments = (
            {"changes": {"business_name": target_business_name}}
            if tool_name == "update_business_profile"
            else {}
        )
        user_request = {
            "update_business_profile": (
                f"请修改业务名称，改成 {target_business_name}"
            ),
            "refresh_business_profile": "请重新识别当前项目的网站业务资料",
            "start_technical_audit": "请启动当前项目的技术审计",
        }[tool_name]
        tool_call_id = f"{run_id}:1:1"
        expected_operation_id = str(
            uuid5(
                NAMESPACE_URL,
                f"agent:{tool_call_id}:{tool_name}",
            )
        )
        worker_a: subprocess.Popen[str] | None = None
        worker_b: subprocess.Popen[str] | None = None
        handle: Any | None = None
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="local",
                        name="Full Agent takeover validation",
                        domain=f"{test_id}.example.test",
                        country="US",
                        language="en",
                    )
                )
                await session.flush()
                if tool_name == "update_business_profile":
                    session.add(
                        CrawlRun(
                            run_id=crawl_run_id,
                            organization_id="local",
                            project_id=project_id,
                            task_type="site_understanding",
                            status="completed",
                        )
                    )
                    await session.flush()
                    session.add(
                        SiteProfile(
                            project_id=project_id,
                            source_run_id=crawl_run_id,
                            profile_json={
                                "business_name": "Before takeover",
                                "business_type": "SEO software",
                                "business_summary": "Production validation fixture",
                                "target_audiences": ["SEO teams"],
                                "products_services": ["SEO platform"],
                                "value_propositions": ["Reliable automation"],
                                "ai_content_rules": "",
                            },
                            user_overrides={},
                            confidence=0.9,
                        )
                    )
                conversation = AgentConversation(
                    id=conversation_id,
                    organization_id="local",
                    project_id=project_id,
                    created_by="production-validation",
                    title="Worker takeover validation",
                )
                session.add(conversation)
                await session.flush()
                session.add(
                    AgentMessage(
                        id=message_id,
                        conversation_id=conversation_id,
                        run_id=run_id,
                        role="user",
                        content=user_request,
                        metadata_json={},
                        client_request_id=test_id,
                    )
                )
                await session.flush()
                conversation.active_message_id = message_id
                session.add(
                    AgentRun(
                        id=run_id,
                        conversation_id=conversation_id,
                        user_message_id=message_id,
                        workflow_id=workflow_id,
                        status="queued",
                        limits_json=LIMITS,
                    )
                )
                await session.commit()

            with tempfile.TemporaryDirectory(prefix="agent-full-takeover-") as temp_dir:
                temp_path = Path(temp_dir)
                ready_a = temp_path / "worker-a.ready"
                ready_b = temp_path / "worker-b.ready"
                first_write_marker = temp_path / "first-write.json"
                reused_write_marker = temp_path / "reused-write.json"
                worker_a = start_worker(
                    address=address,
                    queue=task_queue,
                    worker_id="worker-a",
                    ready_file=ready_a,
                    first_write_marker=first_write_marker,
                    reused_write_marker=reused_write_marker,
                    database_url=database_url,
                    redis_url=redis_url,
                    tool_name=tool_name,
                    tool_arguments=tool_arguments,
                )
                await wait_for_worker(worker_a, ready_a, "worker-a")
                client = await Client.connect(address)
                handle = await client.start_workflow(
                    "AgentWorkflow",
                    {"run_id": run_id, "limits": LIMITS},
                    id=workflow_id,
                    task_queue=task_queue,
                )

                async def first_write_completed() -> bool:
                    if worker_a is not None and worker_a.poll() is not None:
                        raise RuntimeError(
                            "worker-a exited before the formal write committed; "
                            f"output={worker_output(worker_a)!r}"
                        )
                    return first_write_marker.exists()

                try:
                    await wait_until(
                        first_write_completed,
                        30,
                        "worker-a did not commit the formal business write",
                    )
                except TimeoutError as exc:
                    diagnostics = await takeover_diagnostics(
                        sessions=sessions,
                        run_id=run_id,
                        tool_call_id=tool_call_id,
                        handle=handle,
                        worker=worker_a,
                    )
                    raise TimeoutError(
                        f"{exc}; diagnostics={json.dumps(diagnostics, ensure_ascii=False)}"
                    ) from exc
                first_marker = json.loads(first_write_marker.read_text(encoding="ascii"))
                assert first_marker["worker_id"] == "worker-a"
                assert first_marker["process_id"] == worker_a.pid
                assert first_marker["activity_attempt"] == 1
                assert first_marker["already_completed"] is False
                assert first_marker["operation_id"] == expected_operation_id
                assert first_marker["workflow_id"] == workflow_id

                worker_b = start_worker(
                    address=address,
                    queue=task_queue,
                    worker_id="worker-b",
                    ready_file=ready_b,
                    first_write_marker=first_write_marker,
                    reused_write_marker=reused_write_marker,
                    database_url=database_url,
                    redis_url=redis_url,
                    tool_name=tool_name,
                    tool_arguments=tool_arguments,
                )
                await wait_for_worker(worker_b, ready_b, "worker-b")
                worker_a.kill()
                await asyncio.to_thread(worker_a.wait, 5)

                try:
                    await asyncio.wait_for(handle.result(), timeout=90)
                except Exception as exc:
                    await stop_process(worker_b)
                    raise RuntimeError(
                        "formal Agent takeover failed; "
                        f"worker-b output={worker_output(worker_b)!r}"
                    ) from exc

                assert reused_write_marker.exists()
                reused_marker = json.loads(
                    reused_write_marker.read_text(encoding="ascii")
                )
                assert reused_marker["worker_id"] == "worker-b"
                assert reused_marker["process_id"] == worker_b.pid
                assert reused_marker["operation_id"] == expected_operation_id
                assert reused_marker["already_completed"] is True
                assert reused_marker["verified"] is True, reused_marker
                assert reused_marker["workflow_id"] == first_marker["workflow_id"]
                assert (
                    reused_marker["activity_id"] != first_marker["activity_id"]
                    or reused_marker["activity_attempt"]
                    > first_marker["activity_attempt"]
                )

                async with sessions() as session:
                    execution = await session.get(AgentToolExecution, tool_call_id)
                    run = await session.get(AgentRun, run_id)
                    if tool_name == "update_business_profile":
                        profile = await session.get(SiteProfile, project_id)
                        operation_count = await session.scalar(
                            select(func.count())
                            .select_from(SiteProfileOperation)
                            .where(SiteProfileOperation.project_id == project_id)
                        )
                        assert profile is not None
                        assert (
                            profile.profile_json["business_name"]
                            == target_business_name
                        )
                        assert operation_count == 1
                    else:
                        expected_task_type = (
                            "site_understanding"
                            if tool_name == "refresh_business_profile"
                            else "technical_audit"
                        )
                        business_run_count = await session.scalar(
                            select(func.count())
                            .select_from(CrawlRun)
                            .where(
                                CrawlRun.run_id == expected_operation_id,
                                CrawlRun.organization_id == "local",
                                CrawlRun.project_id == project_id,
                                CrawlRun.task_type == expected_task_type,
                            )
                        )
                        dispatch_count = await session.scalar(
                            select(func.count())
                            .select_from(WorkflowDispatch)
                            .where(WorkflowDispatch.run_id == expected_operation_id)
                        )
                        assert business_run_count == 1
                        assert dispatch_count == 1
                assert execution is not None
                assert execution.tool_name == tool_name
                assert execution.status == "completed", {
                    "status": execution.status,
                    "error_code": execution.error_code,
                    "result_json": execution.result_json,
                    "worker_id": execution.worker_id,
                    "reused_marker": reused_marker,
                    "lease_expires_at": (
                        execution.lease_expires_at.isoformat()
                        if execution.lease_expires_at is not None
                        else None
                    ),
                }
                assert execution.result_json["data"]["already_completed"] is True
                assert run is not None
                assert run.status == "completed"
                assert run.finished_at is not None
        finally:
            if handle is not None:
                try:
                    await handle.terminate("isolated full Agent takeover cleanup")
                except Exception:
                    pass
            if worker_a is not None:
                await stop_process(worker_a)
            if worker_b is not None:
                await stop_process(worker_b)
            if tool_name == "refresh_business_profile":
                business_workflow_id = (
                    f"crawler:site_understanding:{project_id}:"
                    f"{expected_operation_id}"
                )
            elif tool_name == "start_technical_audit":
                business_workflow_id = f"crawler:technical_audit:{expected_operation_id}"
            else:
                business_workflow_id = None
            if business_workflow_id is not None:
                try:
                    client = await Client.connect(address)
                    await client.get_workflow_handle(business_workflow_id).terminate(
                        "isolated business workflow cleanup"
                    )
                except Exception:
                    pass
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.execute(
                    delete(CrawlRun).where(CrawlRun.project_id == project_id)
                )
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())
