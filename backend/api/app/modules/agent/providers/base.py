from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from app.modules.agent.providers.events import ProviderStreamEvent
from app.modules.agent.providers.usage import ProviderUsage


ProviderName = Literal["openai", "anthropic", "openrouter"]


@dataclass(frozen=True)
class ProviderConfig:
    provider: ProviderName
    base_url: str
    api_key: str = field(repr=False)
    model: str
    timeout_seconds: int
    max_retries: int


@dataclass(frozen=True)
class ProviderRequest:
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None
    tool_choice: str | None = None
    parallel_tool_calls: bool | None = None
    response_format: dict[str, Any] | None = None
    metadata: dict[str, str] = field(default_factory=dict)
    max_output_tokens: int | None = None


@dataclass(frozen=True)
class ProviderResult:
    provider: ProviderName
    model: str
    response_model: str
    message: dict[str, Any]
    usage: ProviderUsage
    stop_reason: str | None = None
    response_id: str | None = None
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class TokenCount:
    tokens: int
    provider: ProviderName
    model: str
    count_source: str
    exact: bool


class ModelProvider(Protocol):
    config: ProviderConfig

    async def complete(self, request: ProviderRequest) -> ProviderResult: ...

    def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderStreamEvent]: ...

    async def count_tokens(self, request: ProviderRequest) -> TokenCount: ...

    def truncate_text(self, text: str, max_tokens: int) -> str: ...

    async def test_connection(self) -> None: ...
