import type { GmailConnectionView } from "../gmail-connection.gateway.js";
import { gmailMailReadScope } from "../../domain/sending/oauth-attempt.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type { SecretStoreReference } from "../../ports/secret-store.port.js";

export const gmailSendScope =
  "https://www.googleapis.com/auth/gmail.send";

export const gmailReadinessBlockerCodes = [
  "GMAIL_ACCOUNT_NOT_SELECTED",
  "GMAIL_OAUTH_CONNECTING",
  "GMAIL_REAUTH_REQUIRED",
  "GMAIL_TOKEN_REFRESH_FAILED",
  "GMAIL_TOKEN_REVOKED",
  "GMAIL_DISCONNECTED",
  "PROJECT_BINDING_MISSING",
  "GMAIL_SEND_SCOPE_MISSING",
  "GMAIL_SYNC_SCOPE_MISSING",
  "GMAIL_SEND_IDENTITY_UNVERIFIED",
  "GMAIL_SECRET_UNRESOLVABLE",
  "GMAIL_SEND_PAUSED",
  "GMAIL_SEND_RUNTIME_DISABLED",
  "GMAIL_SYNC_RUNTIME_DISABLED",
  "GMAIL_WORKER_UNAVAILABLE",
  "SEND_CONTEXT_REQUIRED",
  "APPROVED_SEND_SNAPSHOT_MISSING",
  "SEND_SUPPRESSION_BLOCKED",
  "SEND_QUOTA_UNAVAILABLE",
  "GMAIL_SYNC_KILL_SWITCH_CLOSED",
  "GMAIL_SYNC_STATUS_UNAVAILABLE",
  "GMAIL_SYNC_CURSOR_MISSING",
] as const;

export type GmailReadinessBlockerCode =
  (typeof gmailReadinessBlockerCodes)[number];

export const gmailReadinessRecoveryActions = [
  "CONNECT_GMAIL",
  "COMPLETE_GMAIL_OAUTH",
  "REAUTHORIZE_GMAIL",
  "SELECT_GMAIL_ACCOUNT",
  "REPAIR_PROJECT_BINDING",
  "GRANT_GMAIL_SEND_SCOPE",
  "GRANT_GMAIL_SYNC_SCOPE",
  "VERIFY_SEND_IDENTITY",
  "REPAIR_GMAIL_SECRET",
  "RESUME_GMAIL_SEND",
  "ENABLE_GMAIL_SEND_RUNTIME",
  "ENABLE_GMAIL_SYNC_RUNTIME",
  "START_GMAIL_WORKER",
  "OPEN_APPROVED_DRAFT",
  "REAPPROVE_CURRENT_DRAFT",
  "CLEAR_SEND_SUPPRESSION",
  "WAIT_FOR_SEND_QUOTA",
  "OPEN_GMAIL_SYNC_KILL_SWITCH",
  "REFRESH_GMAIL_READINESS",
  "REPAIR_GMAIL_SYNC_CURSOR",
] as const;

export type GmailReadinessRecoveryAction =
  (typeof gmailReadinessRecoveryActions)[number];

export type GmailReadinessBlocker = Readonly<{
  code: GmailReadinessBlockerCode;
  capability: "CONNECTION" | "SEND" | "SYNC";
  owner: "USER" | "ADMIN" | "SYSTEM";
  retrySafe: boolean;
  recoveryAction: GmailReadinessRecoveryAction;
  detail: string;
}>;

export type GmailSendContextFacts = Readonly<{
  approvedSnapshotCurrent: boolean;
  suppressionClear: boolean;
  quotaAvailable: boolean;
}>;

export type GmailSyncStatusFacts = Readonly<{
  state: "BLOCKED" | "WAITING_FOR_ACCEPTED_SEND" | "POLLING";
  killSwitchOpen: boolean;
  cursorPresent: boolean;
}>;

export type GmailReadinessFacts = Readonly<{
  connection: GmailConnectionView | null;
  projectBindingActive: boolean;
  verifiedSendIdentity: boolean;
  secretResolvable: boolean;
  sendRuntimeEnabled: boolean;
  syncRuntimeEnabled: boolean;
  workerAvailable: boolean;
  sendContext: GmailSendContextFacts | null;
  syncStatus: GmailSyncStatusFacts | null;
}>;

export type GmailReadinessProjection = Readonly<{
  evaluatedAt: string;
  connection: Readonly<{
    state: "CONNECTED" | "NOT_CONNECTED";
    ready: boolean;
  }>;
  send: Readonly<{
    state: "SEND_READY" | "WAITING_FOR_SEND_CONTEXT" | "BLOCKED";
    ready: boolean;
  }>;
  sync: Readonly<{
    state: "SYNC_READY" | "WAITING_FOR_ACCEPTED_SEND" | "BLOCKED";
    ready: boolean;
  }>;
  blockers: readonly GmailReadinessBlocker[];
  primaryBlocker: GmailReadinessBlocker | null;
}>;

export type GmailProjectReadinessInfrastructure = Readonly<{
  connectionId: string;
  projectBindingActive: boolean;
  verifiedSendIdentity: boolean;
  tokenSecretReference: SecretStoreReference | null;
}>;

export interface GmailProjectReadinessInfrastructureReader {
  findProjectReadinessInfrastructure(
    context: ResolvedProjectContext,
    connectionId: string,
  ): Promise<GmailProjectReadinessInfrastructure | null>;
}

const blocker = (
  code: GmailReadinessBlockerCode,
  capability: GmailReadinessBlocker["capability"],
  owner: GmailReadinessBlocker["owner"],
  retrySafe: boolean,
  recoveryAction: GmailReadinessRecoveryAction,
  detail: string,
): GmailReadinessBlocker => Object.freeze({
  code,
  capability,
  owner,
  retrySafe,
  recoveryAction,
  detail,
});

const connectionBlocker = (
  connection: GmailConnectionView | null,
): GmailReadinessBlocker | null => {
  if (connection === null) {
    return blocker(
      "GMAIL_ACCOUNT_NOT_SELECTED",
      "CONNECTION",
      "USER",
      true,
      "SELECT_GMAIL_ACCOUNT",
      "Select or connect a Gmail account for this project.",
    );
  }
  if (
    connection.connectionStatus === "CONNECTED"
    && (
      connection.recentErrorCategory === "GOOGLE_AUTH_TEMPORARY_FAILURE"
      || connection.recentErrorCategory === "GOOGLE_AUTH_RATE_LIMITED"
    )
  ) {
    return blocker(
      "GMAIL_TOKEN_REFRESH_FAILED",
      "CONNECTION",
      "SYSTEM",
      true,
      "REFRESH_GMAIL_READINESS",
      "The selected Gmail account could not refresh its access token.",
    );
  }
  switch (connection.connectionStatus) {
    case "CONNECTED":
      return null;
    case "CONNECTING":
      return blocker(
        "GMAIL_OAUTH_CONNECTING",
        "CONNECTION",
        "USER",
        true,
        "COMPLETE_GMAIL_OAUTH",
        "Complete the in-progress Gmail authorization.",
      );
    case "REAUTH_REQUIRED":
      return blocker(
        "GMAIL_REAUTH_REQUIRED",
        "CONNECTION",
        "USER",
        true,
        "REAUTHORIZE_GMAIL",
        "Reconnect Gmail because the current authorization is no longer valid.",
      );
    case "TOKEN_REVOKED":
      return blocker(
        "GMAIL_TOKEN_REVOKED",
        "CONNECTION",
        "USER",
        true,
        "REAUTHORIZE_GMAIL",
        "Reconnect Gmail because its authorization was revoked.",
      );
    case "DISCONNECTED":
      return blocker(
        "GMAIL_DISCONNECTED",
        "CONNECTION",
        "USER",
        true,
        "CONNECT_GMAIL",
        "Connect Gmail for this project.",
      );
  }
};

export function evaluateGmailReadiness(
  facts: GmailReadinessFacts,
  evaluatedAt = new Date().toISOString(),
): GmailReadinessProjection {
  const blockers: GmailReadinessBlocker[] = [];
  const connectionFailure = connectionBlocker(facts.connection);
  if (connectionFailure !== null) blockers.push(connectionFailure);
  const connected = connectionFailure === null;
  const scopes = facts.connection?.grantedScopes ?? [];

  if (!facts.projectBindingActive) {
    blockers.push(blocker(
      "PROJECT_BINDING_MISSING",
      "SEND",
      "ADMIN",
      false,
      "REPAIR_PROJECT_BINDING",
      "The selected account is not actively bound to this project and workspace.",
    ));
    blockers.push(blocker(
      "PROJECT_BINDING_MISSING",
      "SYNC",
      "ADMIN",
      false,
      "REPAIR_PROJECT_BINDING",
      "The selected account is not actively bound to this project and workspace.",
    ));
  }
  if (!scopes.includes(gmailSendScope)) {
    blockers.push(blocker(
      "GMAIL_SEND_SCOPE_MISSING",
      "SEND",
      "USER",
      true,
      "GRANT_GMAIL_SEND_SCOPE",
      "Reconnect Gmail and grant the Gmail Send scope.",
    ));
  }
  if (!scopes.includes(gmailMailReadScope)) {
    blockers.push(blocker(
      "GMAIL_SYNC_SCOPE_MISSING",
      "SYNC",
      "USER",
      true,
      "GRANT_GMAIL_SYNC_SCOPE",
      "Reconnect Gmail and grant the Gmail readonly scope.",
    ));
  }
  if (!facts.verifiedSendIdentity) {
    blockers.push(blocker(
      "GMAIL_SEND_IDENTITY_UNVERIFIED",
      "SEND",
      "ADMIN",
      false,
      "VERIFY_SEND_IDENTITY",
      "No accepted sending identity is available for the selected account.",
    ));
  }
  if (!facts.secretResolvable) {
    blockers.push(blocker(
      "GMAIL_SECRET_UNRESOLVABLE",
      "SEND",
      "ADMIN",
      true,
      "REPAIR_GMAIL_SECRET",
      "The selected Gmail credential cannot be resolved from Secret Store.",
    ));
    blockers.push(blocker(
      "GMAIL_SECRET_UNRESOLVABLE",
      "SYNC",
      "ADMIN",
      true,
      "REPAIR_GMAIL_SECRET",
      "The selected Gmail credential cannot be resolved from Secret Store.",
    ));
  }
  if (facts.connection?.sendAvailability !== "AVAILABLE") {
    blockers.push(blocker(
      "GMAIL_SEND_PAUSED",
      "SEND",
      "ADMIN",
      true,
      "RESUME_GMAIL_SEND",
      "Sending is paused for the selected Gmail account.",
    ));
  }
  if (!facts.sendRuntimeEnabled) {
    blockers.push(blocker(
      "GMAIL_SEND_RUNTIME_DISABLED",
      "SEND",
      "ADMIN",
      false,
      "ENABLE_GMAIL_SEND_RUNTIME",
      "Gmail sending is disabled for the current runtime.",
    ));
  }
  if (!facts.syncRuntimeEnabled) {
    blockers.push(blocker(
      "GMAIL_SYNC_RUNTIME_DISABLED",
      "SYNC",
      "ADMIN",
      false,
      "ENABLE_GMAIL_SYNC_RUNTIME",
      "Gmail synchronization is disabled for the current runtime.",
    ));
  }
  if (!facts.workerAvailable) {
    blockers.push(blocker(
      "GMAIL_WORKER_UNAVAILABLE",
      "SEND",
      "SYSTEM",
      true,
      "START_GMAIL_WORKER",
      "The Gmail execution worker is unavailable.",
    ));
    blockers.push(blocker(
      "GMAIL_WORKER_UNAVAILABLE",
      "SYNC",
      "SYSTEM",
      true,
      "START_GMAIL_WORKER",
      "The Gmail execution worker is unavailable.",
    ));
  }

  const sendInfrastructureBlocked = blockers.some((item) =>
    item.capability === "CONNECTION" || item.capability === "SEND");
  if (!sendInfrastructureBlocked) {
    if (facts.sendContext === null) {
      blockers.push(blocker(
        "SEND_CONTEXT_REQUIRED",
        "SEND",
        "USER",
        true,
        "OPEN_APPROVED_DRAFT",
        "Open an approved draft and recipient to evaluate send-specific readiness.",
      ));
    } else {
      if (!facts.sendContext.approvedSnapshotCurrent) {
        blockers.push(blocker(
          "APPROVED_SEND_SNAPSHOT_MISSING",
          "SEND",
          "USER",
          true,
          "REAPPROVE_CURRENT_DRAFT",
          "Approve the current draft and contact version before sending.",
        ));
      }
      if (!facts.sendContext.suppressionClear) {
        blockers.push(blocker(
          "SEND_SUPPRESSION_BLOCKED",
          "SEND",
          "ADMIN",
          false,
          "CLEAR_SEND_SUPPRESSION",
          "An active suppression or unsubscribe record blocks this recipient.",
        ));
      }
      if (!facts.sendContext.quotaAvailable) {
        blockers.push(blocker(
          "SEND_QUOTA_UNAVAILABLE",
          "SEND",
          "SYSTEM",
          true,
          "WAIT_FOR_SEND_QUOTA",
          "The rolling Gmail send quota has no available slot.",
        ));
      }
    }
  }

  const syncInfrastructureBlocked = blockers.some((item) =>
    item.capability === "CONNECTION" || item.capability === "SYNC");
  if (!syncInfrastructureBlocked) {
    if (facts.syncStatus === null) {
      blockers.push(blocker(
        "GMAIL_SYNC_STATUS_UNAVAILABLE",
        "SYNC",
        "SYSTEM",
        true,
        "REFRESH_GMAIL_READINESS",
        "The bounded Gmail synchronization status read did not complete.",
      ));
    } else {
      if (!facts.syncStatus.killSwitchOpen) {
        blockers.push(blocker(
          "GMAIL_SYNC_KILL_SWITCH_CLOSED",
          "SYNC",
          "ADMIN",
          false,
          "OPEN_GMAIL_SYNC_KILL_SWITCH",
          "The project Gmail Sync Kill Switch is closed.",
        ));
      }
      if (
        facts.syncStatus.state === "POLLING"
        && !facts.syncStatus.cursorPresent
      ) {
        blockers.push(blocker(
          "GMAIL_SYNC_CURSOR_MISSING",
          "SYNC",
          "SYSTEM",
          true,
          "REPAIR_GMAIL_SYNC_CURSOR",
          "Gmail polling has started but no durable synchronization cursor exists.",
        ));
      }
    }
  }

  const sendBlocked = blockers.some((item) =>
    item.capability === "CONNECTION" || item.capability === "SEND");
  const syncBlocked = blockers.some((item) =>
    item.capability === "CONNECTION" || item.capability === "SYNC");
  const waitingForSendContext =
    blockers.some((item) => item.code === "SEND_CONTEXT_REQUIRED")
    && blockers.every((item) =>
      item.capability === "SYNC"
      || item.code === "SEND_CONTEXT_REQUIRED");
  const healthyWaitingForAcceptedSend =
    !syncBlocked
    && facts.syncStatus?.state === "WAITING_FOR_ACCEPTED_SEND";

  return Object.freeze({
    evaluatedAt,
    connection: Object.freeze({
      state: connected ? "CONNECTED" : "NOT_CONNECTED",
      ready: connected,
    }),
    send: Object.freeze({
      state: sendBlocked
        ? waitingForSendContext
          ? "WAITING_FOR_SEND_CONTEXT"
          : "BLOCKED"
        : "SEND_READY",
      ready: !sendBlocked,
    }),
    sync: Object.freeze({
      state: syncBlocked
        ? "BLOCKED"
        : healthyWaitingForAcceptedSend
          ? "WAITING_FOR_ACCEPTED_SEND"
          : "SYNC_READY",
      ready: !syncBlocked,
    }),
    blockers: Object.freeze(blockers),
    primaryBlocker: blockers[0] ?? null,
  });
}
