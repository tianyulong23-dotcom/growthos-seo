import asyncio

import pytest

from seo_workers.__main__ import WORKER_TYPES, WorkerHealth


def test_worker_types_are_unique() -> None:
    assert len(WORKER_TYPES) == len(set(WORKER_TYPES))
    assert WORKER_TYPES == ("keywords", "analysis", "ai", "integration", "publish")


@pytest.mark.anyio
async def test_keyword_worker_health_requires_a_recent_database_heartbeat() -> None:
    health = WorkerHealth()

    assert health.healthy(10) is False

    health.last_db_heartbeat = asyncio.get_running_loop().time()
    assert health.healthy(10) is True

    health.last_db_heartbeat -= 31
    assert health.healthy(10) is False
