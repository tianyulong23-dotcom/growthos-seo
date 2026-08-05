import type { ResolvedProjectContext } from "../ports/project-context.port.js";
import type {
  GoogleAuthTokenSet,
  GoogleIdentity,
} from "../ports/google-auth.port.js";

export type GmailConnectionStatus =
  | "CONNECTING"
  | "CONNECTED"
  | "REAUTH_REQUIRED"
  | "TOKEN_REVOKED"
  | "DISCONNECTED";

export type GmailSendAvailability = "AVAILABLE" | "PAUSED";

export type GmailConnectionView = Readonly<{
  connectionId: string;
  version: number;
  primaryEmail: string;
  displayName: string | null;
  hostedDomain: string | null;
  grantedScopes: readonly string[];
  connectionStatus: GmailConnectionStatus;
  sendAvailability: GmailSendAvailability;
  mailSyncCapability: boolean;
  tokenExpiresAt: string;
  connectedAt: string;
}>;

export type GmailConnectionCompletionInput = Readonly<{
  context: ResolvedProjectContext;
  identity: GoogleIdentity;
  tokens: GoogleAuthTokenSet;
}>;

export interface GmailConnectionCompletionGateway {
  /**
   * Implementations must store OAuth tokens through Secret Store and return
   * only the token-free connection projection.
   */
  complete(
    input: GmailConnectionCompletionInput,
  ): Promise<GmailConnectionView>;
}

export interface GmailConnectionReader {
  findVisibleConnection(
    context: ResolvedProjectContext,
  ): Promise<GmailConnectionView | null>;
}
