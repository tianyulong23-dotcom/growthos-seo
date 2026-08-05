export type GmailPollingSyncWorkflowInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  gmailConnectionId: string;
  actorId: string;
  workflowId: string;
  pollingIntervalSeconds: number;
}>;

export const gmailPollingSyncNowSignal =
  "backlinksGmailPollingSyncNowV1";

export type GmailPollingSyncWorkflowResult = Readonly<{
  workflowId: string;
  initialOutcome: string;
  incrementalOutcome: string;
  rawMessagesPersisted: number;
  messagesProjected: number;
  inboundMessagesProjected: number;
  repliesMatched: number;
}>;

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
