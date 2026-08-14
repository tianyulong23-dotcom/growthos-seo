import asyncio
import json

from app.workflows.content_worker import ContentWorkerHealth, health_response


class FakeWriter:
    def __init__(self) -> None:
        self.output = b""

    def write(self, value: bytes) -> None:
        self.output += value

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None

    async def wait_closed(self) -> None:
        return None


def test_content_worker_health_requires_worker_database_and_temporal() -> None:
    async def scenario() -> None:
        reader = asyncio.StreamReader()
        reader.feed_data(b"GET /health HTTP/1.1\r\n\r\n")
        reader.feed_eof()
        writer = FakeWriter()
        health = ContentWorkerHealth(
            worker_running=True,
            database_ok=True,
            temporal_ok=True,
        )
        health.last_probe_at = __import__("time").monotonic()
        await health_response(reader, writer, health, stale_seconds=20)
        assert writer.output.startswith(b"HTTP/1.1 200 OK")
        body = json.loads(writer.output.split(b"\r\n\r\n", 1)[1])
        assert body == {
            "status": "ready",
            "worker_running": True,
            "database": True,
            "temporal": True,
        }

        reader = asyncio.StreamReader()
        reader.feed_data(b"GET /health HTTP/1.1\r\n\r\n")
        reader.feed_eof()
        writer = FakeWriter()
        health.temporal_ok = False
        await health_response(reader, writer, health, stale_seconds=20)
        assert writer.output.startswith(b"HTTP/1.1 503 Service Unavailable")

    asyncio.run(scenario())
