RECOVERABLE_PREPARATION_ERROR_CODES = frozenset(
    {
        "expansion_failed",
        "coverage_check_failed",
        "ai_request_in_progress",
        "serp_request_failed",
        "serp_retryable_failed",
        "serp_request_in_progress",
        "serp_preview_failed",
        "preview_request_in_progress",
        "content_plan_scheduling_failed",
    }
)

MANUAL_RETRYABLE_BATCH_ERROR_CODES = RECOVERABLE_PREPARATION_ERROR_CODES | {
    "content_plan_technical_retry_exhausted"
}


__all__ = [
    "MANUAL_RETRYABLE_BATCH_ERROR_CODES",
    "RECOVERABLE_PREPARATION_ERROR_CODES",
]
