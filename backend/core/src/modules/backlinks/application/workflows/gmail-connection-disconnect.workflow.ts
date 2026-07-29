import type {
  GmailConnectionView,
} from "../gmail-connection.gateway.js";
import {
  googleAuthTokenSetSchema,
  type GoogleAuthPort,
} from "../../ports/google-auth.port.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import type {
  SecretStorePort,
  SecretStoreReference,
} from "../../ports/secret-store.port.js";

export const gmailConnectionRevocationFailureCodes = {
  googleRevokeUnconfirmed: "GOOGLE_REVOKE_UNCONFIRMED",
  localSecretDeleteUnconfirmed: "LOCAL_SECRET_DELETE_UNCONFIRMED",
} as const;

export type GmailConnectionRevocationFailureCode =
  (typeof gmailConnectionRevocationFailureCodes)[
    keyof typeof gmailConnectionRevocationFailureCodes
  ];

export type GmailConnectionRevocationScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  connectionId: string;
}>;

export type PendingGmailConnectionRevocation =
  GmailConnectionRevocationScope & Readonly<{
    connection: GmailConnectionView;
    tokenSecretReference: SecretStoreReference;
    googleRevoked: boolean;
  }>;

export interface GmailConnectionDisconnectPersistence {
  /**
   * Atomically disconnects the connection, pauses send/sync access, and moves
   * the active credential reference into a revoke-only pending record.
   */
  prepareDisconnect(
    input: GmailConnectionRevocationScope & Readonly<{
      actorId: string;
      expectedVersion: number;
    }>,
  ): Promise<PendingGmailConnectionRevocation | null>;
  loadPendingRevocation(
    input: GmailConnectionRevocationScope,
  ): Promise<PendingGmailConnectionRevocation | null>;
  markGoogleRevoked(input: GmailConnectionRevocationScope): Promise<void>;
  recordRevocationFailure(
    input: GmailConnectionRevocationScope & Readonly<{
      failureCode: GmailConnectionRevocationFailureCode;
    }>,
  ): Promise<void>;
  /**
   * Removes the pending reference after Secret Store confirms destruction.
   */
  completeCredentialDeletion(
    input: GmailConnectionRevocationScope,
  ): Promise<GmailConnectionView>;
}

export interface GmailConnectionRevocationRetryScheduler {
  schedule(
    input: GmailConnectionRevocationScope & Readonly<{
      reason: GmailConnectionRevocationFailureCode;
    }>,
  ): Promise<void>;
}

export type DisconnectGmailConnectionInput = Readonly<{
  context: ResolvedProjectContext;
  connectionId: string;
  expectedVersion: number;
}>;

export type GmailConnectionDisconnectResult = Readonly<{
  connection: GmailConnectionView;
  revocationStatus: "COMPLETED" | "PENDING";
}>;

export const gmailConnectionDisconnectErrorCodes = {
  notFound: "GMAIL_CONNECTION_NOT_FOUND",
  versionConflict: "GMAIL_CONNECTION_VERSION_CONFLICT",
  localDisconnectIncomplete: "GMAIL_LOCAL_DISCONNECT_INCOMPLETE",
} as const;

export type GmailConnectionDisconnectErrorCode =
  (typeof gmailConnectionDisconnectErrorCodes)[
    keyof typeof gmailConnectionDisconnectErrorCodes
  ];

export class GmailConnectionDisconnectError extends Error {
  readonly code: GmailConnectionDisconnectErrorCode;

  constructor(code: GmailConnectionDisconnectErrorCode) {
    super("Gmail connection disconnect could not be completed.");
    this.name = "GmailConnectionDisconnectError";
    this.code = code;
  }
}

type GmailConnectionDisconnectWorkflowDependencies = Readonly<{
  persistence: GmailConnectionDisconnectPersistence;
  googleAuth: GoogleAuthPort;
  secretStore: SecretStorePort;
  retryScheduler: GmailConnectionRevocationRetryScheduler;
}>;

const scopeFromContext = (
  context: ResolvedProjectContext,
  connectionId: string,
): GmailConnectionRevocationScope => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  connectionId,
});

function assertInput(connectionId: string, expectedVersion?: number): void {
  if (
    connectionId.trim().length === 0
    || (
      expectedVersion !== undefined
      && (
        !Number.isInteger(expectedVersion)
        || expectedVersion < 1
      )
    )
  ) {
    throw new TypeError("A connection ID and positive version are required.");
  }
}

function assertLocallyDisabled(
  pending: PendingGmailConnectionRevocation,
): void {
  if (
    pending.connection.connectionStatus !== "DISCONNECTED"
    || pending.connection.sendAvailability !== "PAUSED"
  ) {
    throw new GmailConnectionDisconnectError(
      gmailConnectionDisconnectErrorCodes.localDisconnectIncomplete,
    );
  }
}

const tokenContext = (
  pending: PendingGmailConnectionRevocation,
) => ({
  organizationId: pending.organizationId,
  subjectProvider: "google" as const,
  connectionId: pending.connectionId,
});

const decodeRevocationToken = (plaintext: string): string => {
  try {
    const tokens = googleAuthTokenSetSchema.parse(JSON.parse(plaintext));
    return tokens.refreshToken ?? tokens.accessToken;
  } catch {
    throw new GmailConnectionDisconnectError(
      gmailConnectionDisconnectErrorCodes.localDisconnectIncomplete,
    );
  }
};

export class GmailConnectionDisconnectWorkflow {
  readonly #persistence: GmailConnectionDisconnectPersistence;
  readonly #googleAuth: GoogleAuthPort;
  readonly #secretStore: SecretStorePort;
  readonly #retryScheduler: GmailConnectionRevocationRetryScheduler;

  constructor(dependencies: GmailConnectionDisconnectWorkflowDependencies) {
    this.#persistence = dependencies.persistence;
    this.#googleAuth = dependencies.googleAuth;
    this.#secretStore = dependencies.secretStore;
    this.#retryScheduler = dependencies.retryScheduler;
  }

  async disconnect(
    input: DisconnectGmailConnectionInput,
  ): Promise<GmailConnectionDisconnectResult> {
    assertInput(input.connectionId, input.expectedVersion);
    const scope = scopeFromContext(input.context, input.connectionId);
    const pending = await this.#persistence.prepareDisconnect({
      ...scope,
      actorId: input.context.actor.userId,
      expectedVersion: input.expectedVersion,
    });
    if (pending === null) {
      throw new GmailConnectionDisconnectError(
        gmailConnectionDisconnectErrorCodes.notFound,
      );
    }
    assertLocallyDisabled(pending);
    return this.processPending(pending);
  }

  async retry(
    input: GmailConnectionRevocationScope,
  ): Promise<GmailConnectionDisconnectResult | null> {
    assertInput(input.connectionId);
    const pending = await this.#persistence.loadPendingRevocation(input);
    if (pending === null) {
      return null;
    }
    assertLocallyDisabled(pending);
    return this.processPending(pending);
  }

  private async processPending(
    pending: PendingGmailConnectionRevocation,
  ): Promise<GmailConnectionDisconnectResult> {
    if (!pending.googleRevoked) {
      try {
        const token = decodeRevocationToken(
          await this.#secretStore.resolve({
            reference: pending.tokenSecretReference,
            context: tokenContext(pending),
          }),
        );
        await this.#googleAuth.revoke({ token });
        await this.#persistence.markGoogleRevoked(pending);
        pending = { ...pending, googleRevoked: true };
      } catch {
        return this.defer(
          pending,
          gmailConnectionRevocationFailureCodes.googleRevokeUnconfirmed,
        );
      }
    }

    try {
      await this.#secretStore.destroy({
        reference: pending.tokenSecretReference,
        context: tokenContext(pending),
      });
      return {
        connection:
          await this.#persistence.completeCredentialDeletion(pending),
        revocationStatus: "COMPLETED",
      };
    } catch {
      return this.defer(
        pending,
        gmailConnectionRevocationFailureCodes.localSecretDeleteUnconfirmed,
      );
    }
  }

  private async defer(
    pending: PendingGmailConnectionRevocation,
    failureCode: GmailConnectionRevocationFailureCode,
  ): Promise<GmailConnectionDisconnectResult> {
    const scope: GmailConnectionRevocationScope = {
      organizationId: pending.organizationId,
      workspaceId: pending.workspaceId,
      websiteProjectId: pending.websiteProjectId,
      connectionId: pending.connectionId,
    };
    await this.#persistence.recordRevocationFailure({
      ...scope,
      failureCode,
    });
    await this.#retryScheduler.schedule({
      ...scope,
      reason: failureCode,
    }).catch(() => undefined);
    return {
      connection: pending.connection,
      revocationStatus: "PENDING",
    };
  }
}
