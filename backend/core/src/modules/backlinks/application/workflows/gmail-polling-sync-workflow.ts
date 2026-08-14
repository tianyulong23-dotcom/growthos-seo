export const gmailPollingSyncNowSignal =
  "backlinksGmailPollingSyncNowV1";
export const gmailPollingSyncStatusQuery =
  "backlinksGmailPollingSyncStatusV1";

export type GmailPollingSyncErrorCategory =
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "GOOGLE_AUTH_EXPIRED"
  | "GOOGLE_5XX"
  | "NETWORK_TIMEOUT"
  | "RATE_LIMITED"
  | "TRANSPORT_FAILURE"
  | "UNKNOWN";

export type GmailPollingSyncWorkflowStatus = Readonly<{
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  lastErrorCategory: GmailPollingSyncErrorCategory | null;
  nextRetryAt: string | null;
  consecutiveFailures: number;
}>;

export type GmailPollingSyncWorkflowInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  gmailConnectionId: string;
  actorId: string;
  workflowId: string;
  pollingIntervalSeconds: number;
  resume?: Readonly<{
    status: GmailPollingSyncWorkflowStatus;
    retryDelaySeconds: number;
  }>;
}>;

const retryableCategories = new Set<GmailPollingSyncErrorCategory>([
  "AUTHENTICATION_FAILED",
  "GOOGLE_5XX",
  "NETWORK_TIMEOUT",
  "RATE_LIMITED",
  "TRANSPORT_FAILURE",
]);

const errorText = (error: unknown): string => {
  const values: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      values.push(current.name, current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "string") values.push(current);
    break;
  }
  return values.join(" ");
};

export const classifyGmailPollingSyncError = (
  error: unknown,
): GmailPollingSyncErrorCategory => {
  const text = errorText(error);
  if (
    /GMAIL_SYNC_NETWORK_TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET/iu
      .test(text)
  ) {
    return "NETWORK_TIMEOUT";
  }
  if (/GMAIL_SYNC_RATE_LIMITED|\b429\b/iu.test(text)) {
    return "RATE_LIMITED";
  }
  if (/GMAIL_SYNC_PROVIDER_5XX|\b5[0-9]{2}\b/iu.test(text)) {
    return "GOOGLE_5XX";
  }
  if (/GMAIL_SYNC_AUTHENTICATION_FAILED|\b401\b/iu.test(text)) {
    return "AUTHENTICATION_FAILED";
  }
  if (/GMAIL_SYNC_FORBIDDEN|\b403\b/iu.test(text)) {
    return "FORBIDDEN";
  }
  if (
    /GMAIL_SYNC_TRANSPORT_FAILURE|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/iu
      .test(text)
  ) {
    return "TRANSPORT_FAILURE";
  }
  return "UNKNOWN";
};

export const gmailPollingMaximumRetryDelaySeconds = 3_600;

export const calculateGmailPollingRetryDelaySeconds = (
  pollingIntervalSeconds: number,
  consecutiveFailures: number,
  category: GmailPollingSyncErrorCategory,
): number => {
  const base = Math.max(15, Math.floor(pollingIntervalSeconds));
  if (!retryableCategories.has(category)) return base;
  const exponent = Math.max(0, Math.floor(consecutiveFailures) - 1);
  return Math.min(
    gmailPollingMaximumRetryDelaySeconds,
    base * 2 ** Math.min(exponent, 16),
  );
};

export type GmailPollingSyncWorkflowResult = Readonly<{
  workflowId: string;
  initialOutcome: string;
  incrementalOutcome: string;
  rawMessagesPersisted: number;
  messagesProjected: number;
  inboundMessagesProjected: number;
  repliesMatched: number;
}>;

export const gmailPollingSyncCapabilityPausedOutcome =
  "CAPABILITY_PAUSED";

export const createGmailPollingSyncCapabilityPausedResult = (
  input: Readonly<{ workflowId: string }>,
): GmailPollingSyncWorkflowResult => Object.freeze({
  workflowId: input.workflowId,
  initialOutcome: gmailPollingSyncCapabilityPausedOutcome,
  incrementalOutcome: gmailPollingSyncCapabilityPausedOutcome,
  rawMessagesPersisted: 0,
  messagesProjected: 0,
  inboundMessagesProjected: 0,
  repliesMatched: 0,
});

export const isGmailPollingSyncCapabilityPausedResult = (
  result: GmailPollingSyncWorkflowResult,
): boolean =>
  result.initialOutcome === gmailPollingSyncCapabilityPausedOutcome
  && result.incrementalOutcome === gmailPollingSyncCapabilityPausedOutcome;

export type GmailPollingSyncCommands = Readonly<{
  start(input: Readonly<{
    context: import("../../ports/project-context.port.js")
      .ResolvedProjectContext;
    connectionId: string;
  }>): Promise<Readonly<{
    status: "ACCEPTED";
    workflowId: string;
  }>>;
  status(input: Readonly<{
    context: import("../../ports/project-context.port.js")
      .ResolvedProjectContext;
    connectionId: string;
  }>): Promise<Readonly<{
    state: "BLOCKED" | "WAITING_FOR_ACCEPTED_SEND" | "POLLING";
    workflowId: string;
    pollingIntervalSeconds: number;
    killSwitchOpen: boolean;
    acceptedSendCount: number;
    lastSuccessfulSyncAt: string | null;
    lastError: string | null;
    lastErrorCategory: GmailPollingSyncErrorCategory | null;
    nextRetryAt: string | null;
    consecutiveFailures: number;
    cursor: null | Readonly<{
      historyId: string;
      initialSyncCompletedAt: string | null;
      lastSyncedAt: string | null;
      version: number;
    }>;
  }>>;
}>;

export type GmailPollingSyncWorkflowActivities = Readonly<{
  run(
    input: GmailPollingSyncWorkflowInput,
  ): Promise<GmailPollingSyncWorkflowResult>;
}>;

export function runGmailPollingSyncWorkflow(
  input: GmailPollingSyncWorkflowInput,
  activities: GmailPollingSyncWorkflowActivities,
): Promise<GmailPollingSyncWorkflowResult> {
  return activities.run(input);
}
