from __future__ import annotations

import asyncio
import os
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.core.config import Settings, get_settings


class WorkerLauncher(Protocol):
    async def ensure_started(self) -> None: ...

    async def stop(self) -> None: ...


class DisabledWorkerLauncher:
    async def ensure_started(self) -> None:
        return None

    async def stop(self) -> None:
        return None


class LocalCrawlerWorkerLauncher:
    def __init__(self, settings: Settings, executable: Path) -> None:
        self.settings = settings
        self.executable = executable
        self._lock = asyncio.Lock()
        self._process: asyncio.subprocess.Process | None = None

    async def ensure_started(self) -> None:
        async with self._lock:
            if self._process is not None and self._process.returncode is None:
                return
            if not self.executable.is_file():
                raise RuntimeError(f"Crawler worker executable not found: {self.executable}")

            stdout_path = self.executable.with_name("crawler-docker.stdout.log")
            stderr_path = self.executable.with_name("crawler-docker.stderr.log")
            stdout_path.parent.mkdir(parents=True, exist_ok=True)
            creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0

            with stdout_path.open("ab") as stdout, stderr_path.open("ab") as stderr:
                process = await asyncio.create_subprocess_exec(
                    str(self.executable),
                    cwd=str(self.executable.parent),
                    env=self._environment(),
                    stdout=stdout,
                    stderr=stderr,
                    creationflags=creationflags,
                )

            await asyncio.sleep(0.1)
            if process.returncode is not None:
                raise RuntimeError(f"Crawler worker exited during startup; see {stderr_path}")
            self._process = process

    async def stop(self) -> None:
        async with self._lock:
            process = self._process
            self._process = None
            if process is None or process.returncode is not None:
                return

            if os.name == "nt":
                tree_killer = await asyncio.create_subprocess_exec(
                    "taskkill.exe",
                    "/PID",
                    str(process.pid),
                    "/T",
                    "/F",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                await tree_killer.wait()
                await process.wait()
                return

            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()

    def _environment(self) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "CRAWLER_DATABASE_URL": _crawler_database_url(self.settings),
                "TEMPORAL_ADDRESS": self.settings.temporal_address,
                "TEMPORAL_NAMESPACE": self.settings.temporal_namespace,
                "CRAWLER_TASK_QUEUE": self.settings.crawler_task_queue,
                "CRAWLER_WORKER_IDLE_TIMEOUT": (
                    f"{self.settings.crawler_worker_idle_timeout_seconds:g}s"
                ),
                "S3_REGION": self.settings.s3_region,
                "S3_BUCKET": self.settings.s3_bucket,
                "S3_USE_PATH_STYLE": str(self.settings.s3_use_path_style).lower(),
                "S3_CREATE_BUCKET": str(self.settings.s3_create_bucket).lower(),
                "SITE_UNDERSTANDING_REQUEST_TIMEOUT": (
                    self.settings.site_understanding_request_timeout
                ),
                "SITE_UNDERSTANDING_MAX_RETRIES": str(self.settings.site_understanding_max_retries),
                "BUSINESS_PROFILE_AI_MODEL": self.settings.business_profile_ai_model,
                "BUSINESS_PROFILE_AI_API_PROTOCOL": (
                    self.settings.business_profile_ai_api_protocol
                ),
                "BUSINESS_PROFILE_AI_TIMEOUT": self.settings.business_profile_ai_timeout,
                "BUSINESS_PROFILE_AI_MAX_RETRIES": str(
                    self.settings.business_profile_ai_max_retries
                ),
            }
        )
        optional_values = {
            "CRAWLER_BROWSER_CACHE_DIR": (
                self.settings.crawler_browser_cache_dir or str(self.executable.parent / "browser")
            ),
            "CRAWLER_PROXY_URL": self.settings.crawler_proxy_url,
            "CRAWLER_FALLBACK_PROXY_URL": self.settings.crawler_fallback_proxy_url,
            "S3_ENDPOINT_URL": self.settings.s3_endpoint_url,
            "S3_ACCESS_KEY_ID": self.settings.s3_access_key_id,
            "S3_SECRET_ACCESS_KEY": self.settings.s3_secret_access_key,
            "GOOGLE_PAGESPEED_API_KEY": self.settings.google_pagespeed_api_key,
            "BUSINESS_PROFILE_AI_BASE_URL": self.settings.business_profile_ai_base_url,
            "BUSINESS_PROFILE_AI_API_PROTOCOL": (
                self.settings.business_profile_ai_api_protocol
            ),
            "BUSINESS_PROFILE_AI_API_KEY": self.settings.business_profile_ai_api_key,
            "AI_SETTINGS_ENCRYPTION_KEY": self.settings.ai_settings_encryption_key,
        }
        environment.update(
            {name: value for name, value in optional_values.items() if value is not None}
        )
        return environment


def _crawler_database_url(settings: Settings) -> str:
    if settings.crawler_database_url:
        return settings.crawler_database_url
    return settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


def _default_executable() -> Path:
    root = Path(__file__).resolve().parents[4]
    return root / "storage" / "runtime" / "crawler-worker-docker.exe"


@lru_cache
def get_crawler_worker_launcher() -> WorkerLauncher:
    settings = get_settings()
    if settings.app_env != "development":
        return DisabledWorkerLauncher()
    executable = (
        Path(settings.crawler_worker_executable)
        if settings.crawler_worker_executable
        else _default_executable()
    )
    return LocalCrawlerWorkerLauncher(settings, executable)
