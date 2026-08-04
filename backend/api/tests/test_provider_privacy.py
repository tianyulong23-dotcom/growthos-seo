import json
import threading
from typing import Any

import pytest

from app.modules.agent import model_gateway
from app.modules.agent.model_gateway import ModelGateway
from app.modules.settings.provider_privacy import (
    apply_provider_privacy,
    is_openrouter_url,
)


class FakeResponse:
    def __init__(self, body: bytes, lines: list[bytes] | None = None) -> None:
        self.body = body
        self.lines = iter(lines or [])

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def read(self, *_: Any) -> bytes:
        return self.body

    def readline(self) -> bytes:
        return next(self.lines, b"")


@pytest.mark.parametrize(
    "base_url",
    [
        "https://openrouter.ai/api/v1",
        "https://gateway.openrouter.ai/api/v1",
        "HTTPS://OPENROUTER.AI/api/v1",
    ],
)
def test_openrouter_urls_enable_zero_data_retention(base_url: str) -> None:
    payload = apply_provider_privacy(
        base_url,
        {"model": "test", "provider": {"allow_fallbacks": True}},
    )

    assert is_openrouter_url(base_url) is True
    assert payload["provider"] == {"allow_fallbacks": True, "zdr": True}


@pytest.mark.parametrize(
    "base_url",
    [
        "https://models.example/v1",
        "https://openrouter.ai.evil.example/v1",
        "https://example/openrouter.ai/v1",
    ],
)
def test_non_openrouter_payload_is_not_modified(base_url: str) -> None:
    original = {"model": "test"}

    payload = apply_provider_privacy(base_url, original)

    assert is_openrouter_url(base_url) is False
    assert payload is original
    assert "provider" not in payload


def test_agent_requests_send_zdr_only_to_openrouter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: list[dict[str, Any]] = []

    def urlopen(request: Any, **_: Any) -> FakeResponse:
        captured.append(json.loads(request.data))
        return FakeResponse(b'{"choices":[]}')

    monkeypatch.setattr(model_gateway, "urlopen", urlopen)
    gateway = ModelGateway()

    gateway._request("https://openrouter.ai/api/v1", "secret", "model", 10, [])
    gateway._request("https://models.example/v1", "secret", "model", 10, [])

    assert captured[0]["provider"] == {"zdr": True}
    assert "provider" not in captured[1]


def test_agent_streaming_request_sends_openrouter_zdr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def urlopen(request: Any, **_: Any) -> FakeResponse:
        captured.update(json.loads(request.data))
        return FakeResponse(b"", [b"data: [DONE]\n"])

    monkeypatch.setattr(model_gateway, "urlopen", urlopen)
    events: list[tuple[str, Any]] = []

    ModelGateway()._stream_decision_request(
        "https://openrouter.ai/api/v1",
        "secret",
        "model",
        10,
        [],
        lambda kind, value: events.append((kind, value)),
        threading.Event(),
        {},
        None,
        "auto",
        True,
    )

    assert captured["provider"] == {"zdr": True}
    assert events[-1] == ("done", None)
