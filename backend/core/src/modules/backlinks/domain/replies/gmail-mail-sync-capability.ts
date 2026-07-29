import { gmailMailReadScope } from "../sending/oauth-attempt.js";

export const gmailMailSyncCapabilityErrorCodes = Object.freeze({
  scopeMissing: "GMAIL_MAIL_SYNC_SCOPE_MISSING",
  connectionUnavailable: "GMAIL_MAIL_SYNC_CONNECTION_UNAVAILABLE",
  projectionMismatch: "GMAIL_MAIL_SYNC_CAPABILITY_MISMATCH",
} as const);

export type GmailMailSyncCapabilityErrorCode =
  (typeof gmailMailSyncCapabilityErrorCodes)[keyof typeof gmailMailSyncCapabilityErrorCodes];

const errorMessages: Readonly<
  Record<GmailMailSyncCapabilityErrorCode, string>
> = Object.freeze({
  GMAIL_MAIL_SYNC_SCOPE_MISSING:
    "The Gmail connection does not grant readonly mail synchronization.",
  GMAIL_MAIL_SYNC_CONNECTION_UNAVAILABLE:
    "The Gmail connection is unavailable for mail synchronization.",
  GMAIL_MAIL_SYNC_CAPABILITY_MISMATCH:
    "The Gmail connection capability marker does not match granted scopes.",
});

export class GmailMailSyncCapabilityError extends Error {
  readonly code: GmailMailSyncCapabilityErrorCode;

  constructor(code: GmailMailSyncCapabilityErrorCode) {
    super(errorMessages[code]);
    this.name = "GmailMailSyncCapabilityError";
    this.code = code;
  }
}

export type GmailMailSyncCapabilityConnection = Readonly<{
  connectionStatus:
    | "CONNECTING"
    | "CONNECTED"
    | "REAUTH_REQUIRED"
    | "TOKEN_REVOKED"
    | "DISCONNECTED";
  grantedScopes: readonly string[];
  mailSyncCapability: boolean;
}>;

const hasReadonlyScope = (scopes: readonly string[]) =>
  scopes.includes(gmailMailReadScope);

export function assertGmailMailSyncCapability(
  connection: GmailMailSyncCapabilityConnection,
): void {
  if (connection.mailSyncCapability !== hasReadonlyScope(connection.grantedScopes)) {
    throw new GmailMailSyncCapabilityError(
      gmailMailSyncCapabilityErrorCodes.projectionMismatch,
    );
  }
  if (connection.connectionStatus !== "CONNECTED") {
    throw new GmailMailSyncCapabilityError(
      gmailMailSyncCapabilityErrorCodes.connectionUnavailable,
    );
  }
  if (!connection.mailSyncCapability) {
    throw new GmailMailSyncCapabilityError(
      gmailMailSyncCapabilityErrorCodes.scopeMissing,
    );
  }
}

export async function runAfterGmailMailSyncCapabilityGate<Result>(
  connection: GmailMailSyncCapabilityConnection,
  operation: () => Promise<Result>,
): Promise<Result> {
  assertGmailMailSyncCapability(connection);
  return operation();
}
