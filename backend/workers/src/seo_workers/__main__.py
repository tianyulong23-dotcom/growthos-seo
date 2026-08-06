import asyncio
import argparse
import logging
import os
import signal
import socket
from contextlib import suppress
from dataclasses import dataclass

from temporalio.client import Client
from temporalio.worker import Worker

from seo_workers.keywords.activities import KeywordActivities
from seo_workers.keywords.config import KeywordWorkerSettings
from seo_workers.keywords.repository import KeywordRepository, create_pool
from seo_workers.keywords.workflow import (
    KeywordBuildWorkflow,
    KeywordCompetitorAnalysisWorkflow,
    KeywordMetricsRecoveryWorkflow,
)

WORKER_TYPES = ("keywords", "analysis", "ai", "integration", "publish")
logger = logging.getLogger(__name__)


@dataclass
class WorkerHealth:
    last_db_heartbeat: float = 0

    def healthy(self, interval_seconds: int) -> bool:
        if self.last_db_heartbeat <= 0:
            return False
        return asyncio.get_running_loop().time() - self.last_db_heartbeat <= max(
            interval_seconds * 3, 30
        )


async def keyword_worker_heartbeat(
    repository: KeywordRepository,
    settings: KeywordWorkerSettings,
    worker_id: str,
    health: WorkerHealth,
    stopping: asyncio.Event,
) -> None:
    interval = max(settings.keyword_worker_heartbeat_seconds, 2)
    while not stopping.is_set():
        try:
            await repository.touch_worker_heartbeat(
                worker_id,
                task_queue=settings.keyword_task_queue,
                details={
                    "hostname": socket.gethostname(),
                    "pid": os.getpid(),
                },
            )
            health.last_db_heartbeat = asyncio.get_running_loop().time()
        except Exception:
            logger.exception("Unable to persist keyword worker heartbeat")
        try:
            await asyncio.wait_for(stopping.wait(), timeout=interval)
        except TimeoutError:
            pass


async def keyword_worker_health_response(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    health: WorkerHealth,
    interval_seconds: int,
) -> None:
    try:
        with suppress(TimeoutError):
            await asyncio.wait_for(reader.read(2048), timeout=1)
        healthy = health.healthy(interval_seconds)
        body = b'{"status":"ok"}' if healthy else b'{"status":"unhealthy"}'
        status = b"200 OK" if healthy else b"503 Service Unavailable"
        writer.write(
            b"HTTP/1.1 "
            + status
            + b"\r\nContent-Type: application/json\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\nConnection: close\r\n\r\n"
            + body
        )
        await writer.drain()
    finally:
        writer.close()
        with suppress(Exception):
            await writer.wait_closed()


async def run_keyword_worker() -> None:
    settings = KeywordWorkerSettings()
    pool = await create_pool(settings)
    repository = KeywordRepository(pool, settings)
    activities = KeywordActivities(
        repository,
        settings,
    )
    client = await Client.connect(
        settings.temporal_address,
        namespace=settings.temporal_namespace,
    )
    worker = Worker(
        client,
        task_queue=settings.keyword_task_queue,
        max_concurrent_activities=max(
            1,
            min(settings.keyword_max_concurrent_activities, 32),
        ),
        workflows=[
            KeywordBuildWorkflow,
            KeywordCompetitorAnalysisWorkflow,
            KeywordMetricsRecoveryWorkflow,
        ],
        activities=[
            activities.mark_started,
            activities.discover_seeds,
            activities.acquire_business_profile,
            activities.prepare_seeds,
            activities.fetch_competitor_gap,
            activities.validate_competitor,
            activities.start_competitor_analysis,
            activities.prepare_manual_competitors,
            activities.discover_competitors,
            activities.fetch_competitor_opportunities,
            activities.finalize_competitor_analysis,
            activities.fail_competitor_analysis,
            activities.prepare_topic_metrics,
            activities.commit_topics,
            activities.refresh_pending_metrics,
            activities.settle_pending_metrics,
            activities.mark_metric_refresh_started,
            activities.schedule_metric_refresh_retry,
            activities.finish_metric_refresh_job,
            activities.record_gap_failure,
            activities.defer_run,
            activities.block_run,
            activities.complete_empty,
            activities.fail_run,
        ],
    )
    worker_id = f"{socket.gethostname()}:{os.getpid()}"
    health = WorkerHealth()
    stopping = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        keyword_worker_heartbeat(
            repository,
            settings,
            worker_id,
            health,
            stopping,
        )
    )

    async def handle_health(
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        await keyword_worker_health_response(
            reader,
            writer,
            health,
            settings.keyword_worker_heartbeat_seconds,
        )

    health_server = await asyncio.start_server(
        handle_health,
        settings.keyword_worker_health_host,
        settings.keyword_worker_health_port,
    )
    loop = asyncio.get_running_loop()
    shutdown_task: asyncio.Task[None] | None = None

    def request_shutdown() -> None:
        nonlocal shutdown_task
        if shutdown_task is None:
            shutdown_task = asyncio.create_task(worker.shutdown())

    installed_signals: list[signal.Signals] = []
    for shutdown_signal in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(shutdown_signal, request_shutdown)
        except NotImplementedError:
            continue
        installed_signals.append(shutdown_signal)
    try:
        await worker.run()
    finally:
        for shutdown_signal in installed_signals:
            loop.remove_signal_handler(shutdown_signal)
        if shutdown_task is not None:
            with suppress(asyncio.CancelledError):
                await shutdown_task
        stopping.set()
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat_task
        health_server.close()
        await health_server.wait_closed()
        with suppress(Exception):
            await repository.remove_worker_heartbeat(worker_id)
        await pool.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="seo Python workers")
    parser.add_argument("--list", action="store_true", help="list available worker types")
    parser.add_argument("worker", nargs="?", choices=WORKER_TYPES)
    args = parser.parse_args()

    if args.list:
        print("\n".join(WORKER_TYPES))
        return
    if args.worker == "keywords":
        asyncio.run(run_keyword_worker())
        return
    if args.worker:
        parser.error(f"{args.worker} worker is not implemented yet")
    parser.error("a worker command is required")


if __name__ == "__main__":
    main()
