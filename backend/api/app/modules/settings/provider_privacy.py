from __future__ import annotations

from typing import Any, Literal
from urllib.parse import urlsplit


DataRetentionMode = Literal["zero_data_retention", "provider_policy"]


def is_openrouter_url(base_url: str) -> bool:
    hostname = (urlsplit(base_url).hostname or "").casefold()
    return hostname == "openrouter.ai" or hostname.endswith(".openrouter.ai")


def apply_provider_privacy(
    base_url: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if not is_openrouter_url(base_url):
        return payload
    controlled = dict(payload)
    provider = dict(controlled.get("provider") or {})
    provider["zdr"] = True
    controlled["provider"] = provider
    return controlled


def data_retention_mode(base_url: str) -> DataRetentionMode:
    return "zero_data_retention" if is_openrouter_url(base_url) else "provider_policy"
