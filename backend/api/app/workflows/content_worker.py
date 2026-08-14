import asyncio
import json
import logging
import signal
import time
from contextlib import suppress
from dataclasses import dataclass

from sqlalchemy import text
from temporalio.client import Client
from temporalio.worker import Worker

from app.core.config import get_settings
from app.core.secure_logging import configure_sensitive_logging
from app.db.session import session_factory
from app.modules.content.activities import CONTENT_ACTIVITIES
from app.modules.content.workflows import ArticleAIEditWorkflow, ArticleGenerationWorkflow
from app.modules.content_plan.activities import CONTENT_PLAN_ACTIVITIES
from app.modules.content_plan.workflows import (
    ContentPlanGenerationWorkflow,
    ContentPlanPreparationWorkflow,
)
from app.workflows.client import connect_temporal


@dataclass
class ContentWorkerHealth:
    worker_running: bool = False
    database_ok: bool = False
    temporal_ok: bool = False
    last_probe_at: float = 0

    def ready(self, stale_seconds: float) -> bool:
        return (
            self.worker_running
            and self.database_ok
            and self.temporal_ok
            and self.last_probe_at > 0
            and time.monotonic() - self.last_probe_at <= stale_seconds
        )


async def probe_dependencies(
    client: Client,
    health: ContentWorkerHealth,
    interval_seconds: float,
    stopping: asyncio.Event,
) -> None:
    while not stopping.is_set():
        database_ok = False
        temporal_ok = False
        try:
            async with session_factory() as session:
                await session.execute(text("SELECT 1"))
            database_ok = True
        except Exception:
            database_ok = False
        try:
            temporal_ok = bool(await client.service_client.check_health())
        except Exception:
            temporal_ok = False
        health.database_ok = database_ok
        health.temporal_ok = temporal_ok
        health.last_probe_at = time.monotonic()
        try:
            await asyncio.wait_for(stopping.wait(), timeout=interval_seconds)
        except TimeoutError:
            continue


async def health_response(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    health: ContentWorkerHealth,
    stale_seconds: float,
) -> None:
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=2)
        parts = request_line.decode("ascii", errors="replace").split()
        path = parts[1] if len(parts) >= 2 else ""
        ready = path == "/health" and health.ready(stale_seconds)
        body = json.dumps(
            {
                "status": "ready" if ready else "not_ready",
                "worker_running": health.worker_running,
                "database": health.database_ok,
                "temporal": health.temporal_ok,
            },
            separators=(",", ":"),
        ).encode()
        status = "200 OK" if ready else "503 Service Unavailable"
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
            + body
        )
        await writer.drain()
    finally:
        writer.close()
        with suppress(Exception):
            await writer.wait_closed()


async def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    configure_sensitive_logging(settings)
    client = await connect_temporal()
    worker = Worker(
        client,
        task_queue=settings.content_task_queue,
        workflows=[
            ArticleGenerationWorkflow,
            ArticleAIEditWorkflow,
            ContentPlanGenerationWorkflow,
            ContentPlanPreparationWorkflow,
        ],
        activities=[*CONTENT_ACTIVITIES, *CONTENT_PLAN_ACTIVITIES],
    )
    health = ContentWorkerHealth(worker_running=True)
    stopping = asyncio.Event()
    worker_task = asyncio.create_task(worker.run())
    probe_task = asyncio.create_task(
        probe_dependencies(
            client,
            health,
            settings.content_worker_health_interval_seconds,
            stopping,
        )
    )

    async def handle_health(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        health.worker_running = not worker_task.done()
        await health_response(
            reader,
            writer,
            health,
            settings.content_worker_health_stale_seconds,
        )

    server = await asyncio.start_server(
        handle_health,
        settings.content_worker_health_host,
        settings.content_worker_health_port,
    )
    loop = asyncio.get_running_loop()

    def request_shutdown() -> None:
        if not stopping.is_set():
            stopping.set()
            asyncio.create_task(worker.shutdown())

    installed_signals: list[signal.Signals] = []
    for shutdown_signal in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(shutdown_signal, request_shutdown)
        except NotImplementedError:
            continue
        installed_signals.append(shutdown_signal)
    try:
        await worker_task
    finally:
        health.worker_running = False
        stopping.set()
        for shutdown_signal in installed_signals:
            loop.remove_signal_handler(shutdown_signal)
        probe_task.cancel()
        with suppress(asyncio.CancelledError):
            await probe_task
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
