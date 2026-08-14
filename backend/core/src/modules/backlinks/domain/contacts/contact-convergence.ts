export type ContactTerminalReason =
  | "PUBLIC_EMAIL_FOUND"
  | "CONTACT_FORM_ONLY"
  | "LOGIN_REQUIRED"
  | "CAPTCHA_OR_BOT_CHALLENGE"
  | "ROBOTS_DISALLOWED"
  | "ACCESS_DENIED"
  | "NO_PUBLIC_EMAIL"
  | "SITE_UNREACHABLE"
  | "UNSUPPORTED_CONTENT"
  | "MANUAL_REVIEW_REQUIRED"
  | "COMPLETED_PARTIAL";

export type ContactEnrichmentMethod =
  | "none"
  | "static"
  | "browser"
  | "static_and_browser";

export type ContactConvergenceSignals = Readonly<{
  contactForm: boolean;
  loginRequired: boolean;
  challenge: boolean;
  accessDenied: boolean;
  robotsDisallowed: number;
  unsupportedContent: number;
  transportFailures: number;
  parsedPages: number;
}>;

export type ContactConvergenceOutcome = Readonly<{
  status:
    | "completed"
    | "partially_completed"
    | "no_contact_found"
    | "retry_scheduled";
  retry: boolean;
  terminalReasonCode: ContactTerminalReason | null;
  method: ContactEnrichmentMethod;
  lastErrorCategory: ContactTerminalReason | null;
}>;

const transientHttpStatuses = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

export function isTransientContactHttpStatus(status: number): boolean {
  return transientHttpStatuses.has(status);
}

export function shouldAttemptContactBrowserFallback(input: Readonly<{
  browserAuthorized: boolean;
  browserAttempted: boolean;
  status: number;
  challenge: boolean;
}>): boolean {
  return input.browserAuthorized
    && !input.browserAttempted
    && (
      input.challenge
      || input.status === 403
      || input.status === 429
    );
}

export function classifyContactConvergence(input: Readonly<{
  eligibleCount: number;
  candidateCount: number;
  failures: number;
  retryableFailures: number;
  attemptCount: number;
  maxAttempts: number;
  pagesVisited: number;
  browserUsed: boolean;
  signals: ContactConvergenceSignals;
}>): ContactConvergenceOutcome {
  const retry = input.eligibleCount === 0
    && input.retryableFailures > 0
    && input.attemptCount < input.maxAttempts;
  const status = retry
    ? "retry_scheduled" as const
    : input.candidateCount > 0 && input.failures === 0
      ? "completed" as const
      : input.candidateCount > 0 || input.failures > 0
        ? "partially_completed" as const
        : "no_contact_found" as const;
  const terminalReasonCode: ContactTerminalReason | null = retry
    ? null
    : input.eligibleCount > 0
      ? "PUBLIC_EMAIL_FOUND"
      : input.signals.challenge
        ? "CAPTCHA_OR_BOT_CHALLENGE"
        : input.signals.loginRequired
          ? "LOGIN_REQUIRED"
          : input.signals.accessDenied
            ? "ACCESS_DENIED"
            : input.signals.contactForm
              ? "CONTACT_FORM_ONLY"
              : input.signals.robotsDisallowed > 0
                  && input.pagesVisited === 0
                ? "ROBOTS_DISALLOWED"
                : input.signals.unsupportedContent > 0
                    && input.signals.parsedPages === 0
                  ? "UNSUPPORTED_CONTENT"
                  : input.signals.transportFailures > 0
                      && input.pagesVisited === 0
                    ? "SITE_UNREACHABLE"
                    : input.candidateCount > 0
                      ? "MANUAL_REVIEW_REQUIRED"
                      : input.failures > 0
                        ? "COMPLETED_PARTIAL"
                        : "NO_PUBLIC_EMAIL";
  const method: ContactEnrichmentMethod = input.browserUsed
    ? input.pagesVisited > 0 ? "static_and_browser" : "browser"
    : input.pagesVisited > 0 ? "static" : "none";
  const lastErrorCategory = terminalReasonCode === null
    || terminalReasonCode === "PUBLIC_EMAIL_FOUND"
    || terminalReasonCode === "NO_PUBLIC_EMAIL"
    || terminalReasonCode === "CONTACT_FORM_ONLY"
    ? null
    : terminalReasonCode;

  return Object.freeze({
    status,
    retry,
    terminalReasonCode,
    method,
    lastErrorCategory,
  });
}
