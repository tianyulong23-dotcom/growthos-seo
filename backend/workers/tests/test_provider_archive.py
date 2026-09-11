import asyncio
import base64
import json

import httpx
import pytest

from seo_workers.keywords.providers import JsonHttpClient, ProviderError


def test_keyword_http_capture_precedes_json_validation(tmp_path, monkeypatch):
    monkeypatch.setenv("PROVIDER_ARCHIVE_ENABLED", "true")
    monkeypatch.setenv("PROVIDER_ARCHIVE_DEPLOYMENT_ID", "keywords-a")
    monkeypatch.setenv("PROVIDER_ARCHIVE_SPOOL_DIR", str(tmp_path))

    async def run():
        client = JsonHttpClient(timeout_seconds=1, max_retries=0)
        await client.close()
        client.client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"bad-json"))
        )
        try:
            with pytest.raises(ProviderError, match="HTTP 200"):
                await client.request(
                    "POST", "https://api.dataforseo.com/v3/test",
                    json_body=[{"target": "example.test"}], paid_request=True,
                )
        finally:
            await client.close()

    asyncio.run(run())
    events = list(tmp_path.glob("*.event.json"))
    assert len(events) == 1
    event = json.loads(events[0].read_text())
    assert base64.b64decode(event["responseBodyBase64"]) == b"bad-json"


def test_unrelated_http_provider_does_not_enter_archive(tmp_path, monkeypatch):
    monkeypatch.setenv("PROVIDER_ARCHIVE_ENABLED", "true")
    monkeypatch.setenv("PROVIDER_ARCHIVE_DEPLOYMENT_ID", "keywords-a")
    monkeypatch.setenv("PROVIDER_ARCHIVE_SPOOL_DIR", str(tmp_path))

    async def run():
        client = JsonHttpClient(timeout_seconds=1, max_retries=0)
        await client.close()
        client.client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"ok": True}))
        )
        try:
            await client.request("POST", "https://other.test/v1/test", json_body={})
        finally:
            await client.close()

    asyncio.run(run())
    assert not list(tmp_path.iterdir())
