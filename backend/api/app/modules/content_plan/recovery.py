RECOVERABLE_PREPARATION_ERROR_CODES = frozenset(
    {
        "expansion_failed",
        "coverage_check_failed",
        "ai_request_in_progress",
        "serp_request_failed",
        "serp_request_outcome_unknown",
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

AUTOMATIC_RETRYABLE_BATCH_ERROR_CODES = MANUAL_RETRYABLE_BATCH_ERROR_CODES | {
    "ai_request_outcome_unknown",
    "ai_request_retry_exhausted",
    "pack_shortage",
    "serp_primary_candidates_exhausted",
}

USER_RETRYABLE_AUTOMATIC_BATCH_ERROR_CODES = (
    AUTOMATIC_RETRYABLE_BATCH_ERROR_CODES
    | {"classification_failed", "seed_decision_contract_invalid"}
)


__all__ = [
    "AUTOMATIC_RETRYABLE_BATCH_ERROR_CODES",
    "MANUAL_RETRYABLE_BATCH_ERROR_CODES",
    "RECOVERABLE_PREPARATION_ERROR_CODES",
    "USER_RETRYABLE_AUTOMATIC_BATCH_ERROR_CODES",
]
