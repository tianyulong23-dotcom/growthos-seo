from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from app.modules.agent.providers import (
    ProviderConfig,
    ProviderError,
    ProviderRequest,
    build_provider,
)
from app.modules.settings.service import AIProviderSettingsRecord


@dataclass(frozen=True)
class AIEditProviderChunk:
    text: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    done: bool = False


class AIEditProvider(Protocol):
    name: str
    model: str

    def stream(self, system: str, user: str) -> AsyncIterator[AIEditProviderChunk]: ...


class ConfiguredAIEditProvider:
    def __init__(self, record: AIProviderSettingsRecord) -> None:
        self.name = record.provider
        self.model = record.model
        self._provider = build_provider(
            ProviderConfig(
                provider=record.provider,
                api_protocol=record.api_protocol,
                base_url=record.base_url,
                api_key=record.api_key,
                model=record.model,
                timeout_seconds=record.request_timeout_seconds,
                max_retries=record.max_retries,
                reasoning_effort=record.reasoning_effort,
            )
        )

    async def stream(self, system: str, user: str) -> AsyncIterator[AIEditProviderChunk]:
        request = ProviderRequest(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_output_tokens=8_000,
        )
        async for event in self._provider.stream(request):
            if event.kind == "text_delta" and event.delta:
                yield AIEditProviderChunk(text=event.delta)
            elif event.kind == "error":
                raise event.error or RuntimeError("AI provider stream failed")
            elif event.kind == "done":
                usage = event.usage or {}
                yield AIEditProviderChunk(
                    input_tokens=_token_count(usage, "input_tokens", "prompt_tokens"),
                    output_tokens=_token_count(usage, "output_tokens", "completion_tokens"),
                    done=True,
                )


class DeterministicAIEditProvider:
    name = "deterministic_fake"
    model = "article-ai-edit-fixture-v1"

    def __init__(self, *, command: str, payload: dict[str, Any]) -> None:
        self.command = command
        self.payload = payload

    async def stream(self, system: str, user: str) -> AsyncIterator[AIEditProviderChunk]:
        del system, user
        selected = str(self.payload.get("selected_text") or "")
        outputs = {
            "title": '{"candidates":["成熟文章标题一","成熟文章标题二","成熟文章标题三"]}',
            "meta_title": '{"candidates":["可验证的 SEO 标题一","可验证的 SEO 标题二","可验证的 SEO 标题三"]}',
            "meta_description": '{"candidates":["这是一个可验证、可审计的元描述候选。","这是第二个受控元描述候选。","这是第三个受控元描述候选。"]}',
            "faq": '{"content":[{"type":"heading","attrs":{"node_id":"ai-faq-heading","level":2,"textAlign":null},"content":[{"type":"text","text":"常见问题"}]},{"type":"details","attrs":{"node_id":"ai-faq-details","summary":"这个流程如何工作？","open_by_default":false},"content":[{"type":"detailsContent","content":[{"type":"paragraph","attrs":{"node_id":"ai-faq-answer","textAlign":null},"content":[{"type":"text","text":"候选经过人工接受后才会进入正文。"}]}]}]}]}',
            "cta": '{"content":[{"type":"button","attrs":{"node_id":"ai-cta-button","label":"查看完整方案","href":"https://example.com/solution","target":"_self","rel":null,"style":"primary"}}]}',
        }
        output = outputs.get(self.command)
        if output is None:
            suffix = "（AI 候选）"
            output = f"{selected}{suffix}" if selected else "这是受控的 AI 续写候选。"
        midpoint = max(1, len(output) // 2)
        yield AIEditProviderChunk(text=output[:midpoint])
        yield AIEditProviderChunk(text=output[midpoint:])
        yield AIEditProviderChunk(
            input_tokens=max(1, len(str(self.payload)) // 4),
            output_tokens=max(1, len(output) // 4),
            done=True,
        )


def normalize_provider_error(exc: Exception) -> tuple[str, str, bool]:
    if not isinstance(exc, ProviderError):
        return "ai_edit_provider_failed", "AI provider failed", False
    mapping = {
        "model_provider_timeout": (
            "ai_edit_provider_timeout",
            "AI provider timed out",
        ),
        "model_provider_unavailable": (
            "ai_edit_provider_unavailable",
            "AI provider is unavailable",
        ),
        "model_provider_rate_limited": (
            "ai_edit_provider_rate_limited",
            "AI provider rate limit reached",
        ),
        "model_provider_invalid_response": (
            "ai_edit_provider_invalid_response",
            "AI provider returned an invalid response",
        ),
        "model_provider_request_rejected": (
            "ai_edit_provider_rejected",
            "AI provider rejected the request",
        ),
    }
    code, detail = mapping.get(exc.code, ("ai_edit_provider_failed", "AI provider failed"))
    return code, detail, exc.retryable


def _token_count(usage: dict[str, Any], *names: str) -> int:
    for name in names:
        value = usage.get(name)
        if isinstance(value, (int, float)):
            return max(0, int(value))
    return 0
