const safelyReplaceableFailureCodes = new Set([
  "GMAIL_SEND_RFC_MESSAGE_NOT_FOUND",
  "GMAIL_SEND_INVALID_REQUEST",
  "GMAIL_SEND_REAUTH_REQUIRED",
  "GMAIL_SEND_FORBIDDEN",
  "GMAIL_SEND_RATE_LIMITED",
  "GMAIL_SEND_PRE_REQUEST_FAILED",
  "GMAIL_SEND_TOKEN_REFRESH_FAILED",
]);

const safelyReplaceableNoAttemptFailureCodes = new Set([
  "GMAIL_SEND_RESERVATION_EXPIRED",
]);

export type FailedSendIntentReplacementEvidence = Readonly<{
  intentStatus: unknown;
  attemptStatus: unknown;
  errorCode: unknown;
  providerMessageId: unknown;
  providerThreadId: unknown;
}>;

export function canReplaceFailedSendIntent(
  evidence: FailedSendIntentReplacementEvidence,
): boolean {
  return evidence.intentStatus === "FAILED_FINAL"
    && evidence.providerMessageId === null
    && evidence.providerThreadId === null
    && typeof evidence.errorCode === "string"
    && (
      (
        (
          evidence.attemptStatus === "FAILED_RETRYABLE"
          || evidence.attemptStatus === "FAILED_FINAL"
        )
        && safelyReplaceableFailureCodes.has(evidence.errorCode)
      )
      || (
        evidence.attemptStatus === null
        && safelyReplaceableNoAttemptFailureCodes.has(evidence.errorCode)
      )
    );
}
