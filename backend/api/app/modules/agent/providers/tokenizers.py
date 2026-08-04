from __future__ import annotations

import json
import math
from functools import lru_cache
from typing import Any

from app.modules.agent.providers.base import ProviderName, ProviderRequest, TokenCount

try:
    import tiktoken
except ImportError:  # pragma: no cover - deployment validation checks the dependency
    tiktoken = None


def upstream_model(provider: ProviderName, model: str) -> tuple[ProviderName, str]:
    if provider != "openrouter" or "/" not in model:
        return provider, model
    namespace, upstream = model.split("/", 1)
    if namespace in {"openai", "anthropic"}:
        return namespace, upstream
    return provider, model


@lru_cache(maxsize=128)
def encoding_for(provider: ProviderName, model: str) -> tuple[Any | None, str]:
    resolved_provider, resolved_model = upstream_model(provider, model)
    if tiktoken is None or resolved_provider not in {"openai", "openrouter"}:
        return None, "multilingual_conservative_fallback"
    try:
        return tiktoken.encoding_for_model(resolved_model), "tiktoken_model"
    except KeyError:
        return tiktoken.get_encoding("o200k_base"), "tiktoken_o200k_fallback"


def conservative_text_tokens(text: str) -> int:
    utf8_bytes = len(text.encode("utf-8"))
    non_ascii = sum(1 for character in text if not character.isascii())
    return max(1, math.ceil(utf8_bytes / 4) + math.ceil(non_ascii / 4))


def serialized_request(request: ProviderRequest) -> str:
    payload: dict[str, Any] = {"messages": request.messages}
    if request.tools:
        payload["tools"] = request.tools
    if request.tool_choice is not None:
        payload["tool_choice"] = request.tool_choice
    if request.parallel_tool_calls is not None and request.tools:
        payload["parallel_tool_calls"] = request.parallel_tool_calls
    if request.response_format is not None:
        payload["response_format"] = request.response_format
    if request.max_output_tokens is not None:
        payload["max_output_tokens"] = request.max_output_tokens
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def local_count(
    provider: ProviderName,
    model: str,
    request: ProviderRequest,
) -> TokenCount:
    serialized = serialized_request(request)
    encoding, source = encoding_for(provider, model)
    if encoding is not None:
        return TokenCount(
            tokens=len(encoding.encode(serialized)),
            provider=provider,
            model=model,
            count_source=source,
            exact=source == "tiktoken_model",
        )
    return TokenCount(
        tokens=conservative_text_tokens(serialized),
        provider=provider,
        model=model,
        count_source=source,
        exact=False,
    )


def truncate_with_model(
    provider: ProviderName,
    model: str,
    text: str,
    max_tokens: int,
) -> str:
    if max_tokens < 1:
        return ""
    encoding, _ = encoding_for(provider, model)
    if encoding is not None:
        encoded = encoding.encode(text)
        return text if len(encoded) <= max_tokens else encoding.decode(encoded[:max_tokens])
    if conservative_text_tokens(text) <= max_tokens:
        return text
    low, high = 0, len(text)
    while low < high:
        midpoint = (low + high + 1) // 2
        if conservative_text_tokens(text[:midpoint]) <= max_tokens:
            low = midpoint
        else:
            high = midpoint - 1
    return text[:low]
