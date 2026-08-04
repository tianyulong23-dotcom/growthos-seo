import asyncio
from pathlib import Path
from typing import Any

from app.core.config import Settings
from app.workflows import worker


class FakeProcess:
    def __init__(self) -> None:
        self.pid = 1234
        self.returncode: int | None = None


def test_local_launcher_starts_one_process_for_concurrent_requests(
    monkeypatch: Any,
    tmp_path: Path,
) -> None:
    executable = tmp_path / "crawler-worker-docker.exe"
    executable.touch()
    process = FakeProcess()
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    async def create_subprocess_exec(
        *args: Any,
        **kwargs: Any,
    ) -> FakeProcess:
        calls.append((args, kwargs))
        return process

    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess_exec)
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    launcher = worker.LocalCrawlerWorkerLauncher(Settings(), executable)

    async def ensure_twice() -> None:
        await asyncio.gather(
            launcher.ensure_started(),
            launcher.ensure_started(),
        )

    asyncio.run(ensure_twice())

    assert len(calls) == 1
    assert calls[0][0] == (str(executable),)


def test_local_launcher_builds_crawler_environment(tmp_path: Path) -> None:
    executable = tmp_path / "crawler-worker-docker.exe"
    settings = Settings(
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/seo",
        crawler_database_url=None,
        crawler_worker_idle_timeout_seconds=120,
        ai_settings_encryption_key="encryption-key",
    )
    launcher = worker.LocalCrawlerWorkerLauncher(settings, executable)

    environment = launcher._environment()

    assert environment["CRAWLER_DATABASE_URL"] == (
        "postgresql://postgres:postgres@localhost:5432/seo"
    )
    assert environment["CRAWLER_WORKER_IDLE_TIMEOUT"] == "120s"
    assert environment["CRAWLER_BROWSER_CACHE_DIR"] == str(tmp_path / "browser")
    assert environment["AI_SETTINGS_ENCRYPTION_KEY"] == "encryption-key"
    assert environment["BUSINESS_PROFILE_AI_TIMEOUT"] == "90s"
    assert environment["BUSINESS_PROFILE_AI_MAX_RETRIES"] == "4"


def test_production_uses_disabled_launcher(monkeypatch: Any) -> None:
    worker.get_crawler_worker_launcher.cache_clear()
    monkeypatch.setattr(
        worker,
        "get_settings",
        lambda: Settings(app_env="production"),
    )

    try:
        launcher = worker.get_crawler_worker_launcher()
    finally:
        worker.get_crawler_worker_launcher.cache_clear()

    assert isinstance(launcher, worker.DisabledWorkerLauncher)
