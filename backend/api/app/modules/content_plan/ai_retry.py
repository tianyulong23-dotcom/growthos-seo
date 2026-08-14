from __future__ import annotations

from app.modules.agent.providers import ProviderError


AI_REQUEST_MAX_ATTEMPTS = 3


def classify_ai_provider_error(error: ProviderError) -> str:
    status_code = error.status_code
    if (
        error.request_not_submitted
        or status_code == 429
        or (status_code is not None and 500 <= status_code <= 599)
    ):
        return "retryable_failed"
    if status_code is not None or not error.retryable:
        return "failed"
    return "uncertain"


def ai_retry_delay(error: ProviderError, attempt_count: int) -> float:
    if error.retry_after_seconds is not None:
        return min(max(0.0, error.retry_after_seconds), 16.0)
    return float(min(16, 2 ** max(0, attempt_count - 1)))


__all__ = [
    "AI_REQUEST_MAX_ATTEMPTS",
    "ai_retry_delay",
    "classify_ai_provider_error",
]
