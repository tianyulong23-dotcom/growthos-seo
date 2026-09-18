import { randomUUID } from "node:crypto";

import type {
  GmailConnectionCompletionGateway,
  GmailConnectionCompletionInput,
  GmailConnectionView,
} from "../gmail-connection.gateway.js";
import {
  GoogleAuthError,
  googleAuthFailureCodes,
  googleAuthTokenSetSchema,
  googleIdentitySchema,
  type GoogleAuthPort,
  type GoogleAuthTokenSet,
} from "../../ports/google-auth.port.js";
import type { ResolvedMailboxContext } from "../../ports/project-context.port.js";
import {
  secretKinds,
  type SecretEncryptionContext,
  type SecretStorePort,
  type SecretStoreReference,
} from "../../ports/secret-store.port.js";

export type GmailConnectionSecretPersistenceCreateInput = Readonly<{
  connectionId: string;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  connectedByUserId: string;
  googleSubject: string;
  primaryEmail: string;
  displayName: string | null;
  hostedDomain: string | null;
  grantedScopes: readonly string[];
  tokenSecretReference: SecretStoreReference;
  tokenExpiresAt: string;
}>;

export type GmailConnectionSecretPersistenceSaveResult = Readonly<{
  view: GmailConnectionView;
  retiredTokenSecretReference: SecretStoreReference | null;
}>;

export type GmailConnectionSecretPersistenceRefreshState = Readonly<{
  organizationId: string;
  connectionId: string;
  version: number;
  tokenSecretReference: SecretStoreReference;
  view: GmailConnectionView;
}>;

type GmailConnectionSecretPersistenceLookupInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  connectionId: string;
}>;

export type GmailConnectionSecretPersistenceReplaceInput =
  GmailConnectionSecretPersistenceLookupInput & Readonly<{
    actorId: string;
    expectedVersion: number;
    tokenSecretReference: SecretStoreReference;
    tokenExpiresAt: string;
    grantedScopes: readonly string[];
  }>;

export type GmailConnectionSecretPersistenceRefreshFailureInput =
  GmailConnectionSecretPersistenceLookupInput & Readonly<{
    actorId: string;
    expectedVersion: number;
    reason:
      | typeof googleAuthFailureCodes.rateLimited
      | typeof googleAuthFailureCodes.temporaryFailure;
  }>;

type GmailConnectionSecretPersistenceReauthInput =
  GmailConnectionSecretPersistenceLookupInput & Readonly<{
    actorId: string;
    expectedVersion: number;
    reason: "GOOGLE_AUTH_EXPIRED";
  }>;

export interface GmailConnectionSecretPersistence {
  findActiveConnectionIdBySubject(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      googleSubject: string;
    }>,
  ): Promise<string | null>;
  saveAuthorizedConnectionWithBindings(
    input: GmailConnectionSecretPersistenceCreateInput,
  ): Promise<GmailConnectionSecretPersistenceSaveResult>;
  findRefreshState(
    input: GmailConnectionSecretPersistenceLookupInput,
  ): Promise<GmailConnectionSecretPersistenceRefreshState | null>;
  replaceTokenReference(
    input: GmailConnectionSecretPersistenceReplaceInput,
  ): Promise<GmailConnectionSecretPersistenceRefreshState | null>;
  markRefreshFailure(
    input: GmailConnectionSecretPersistenceRefreshFailureInput,
  ): Promise<GmailConnectionSecretPersistenceRefreshState | null>;
  markReauthRequired(
    input: GmailConnectionSecretPersistenceReauthInput,
  ): Promise<GmailConnectionSecretPersistenceRefreshState | null>;
}

export interface GmailConnectionRefreshLock {
  withLock<Result>(
    input: Readonly<{
      organizationId: string;
      connectionId: string;
    }>,
    action: () => Promise<Result>,
  ): Promise<Result>;
}

type SecretBackedGmailConnectionRepositoryDependencies = Readonly<{
  secretStore: SecretStorePort;
  googleAuth: GoogleAuthPort;
  persistence: GmailConnectionSecretPersistence;
  refreshLock: GmailConnectionRefreshLock;
  newId?: () => string;
}>;

export type RefreshGmailConnectionInput = Readonly<{
  context: ResolvedMailboxContext;
  connectionId: string;
  expectedVersion: number;
}>;

export type RefreshGmailConnectionResult = Readonly<{
  outcome: "REFRESHED" | "ALREADY_REFRESHED" | "REAUTH_REQUIRED";
  connection: GmailConnectionView;
  version: number;
}>;

export type ResolveGmailAccessTokenInput = Readonly<{
  context: ResolvedMailboxContext;
  connectionId: string;
}>;

export class GmailConnectionSecretRepositoryError extends Error {
  readonly code = "GMAIL_CONNECTION_SECRET_REPOSITORY_FAILED";

  constructor() {
    super("Gmail connection credentials are unavailable.");
    this.name = "GmailConnectionSecretRepositoryError";
  }
}

export const gmailAccessTokenRefreshLeadTimeMs = 5 * 60_000;

const tokenContext = (
  organizationId: string,
  connectionId: string,
): SecretEncryptionContext => ({
  organizationId,
  subjectProvider: "google",
  connectionId,
});

const encodeTokens = (tokens: GoogleAuthTokenSet): string =>
  JSON.stringify(googleAuthTokenSetSchema.parse(tokens));

const decodeTokens = (plaintext: string): GoogleAuthTokenSet => {
  try {
    return googleAuthTokenSetSchema.parse(JSON.parse(plaintext));
  } catch {
    throw new GmailConnectionSecretRepositoryError();
  }
};

const lookupInput = (
  context: ResolvedMailboxContext,
  connectionId: string,
): GmailConnectionSecretPersistenceLookupInput => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  connectionId,
});

export class SecretBackedGmailConnectionRepository
implements GmailConnectionCompletionGateway {
  readonly #secretStore: SecretStorePort;
  readonly #googleAuth: GoogleAuthPort;
  readonly #persistence: GmailConnectionSecretPersistence;
  readonly #refreshLock: GmailConnectionRefreshLock;
  readonly #newId: () => string;

  constructor(
    dependencies: SecretBackedGmailConnectionRepositoryDependencies,
  ) {
    this.#secretStore = dependencies.secretStore;
    this.#googleAuth = dependencies.googleAuth;
    this.#persistence = dependencies.persistence;
    this.#refreshLock = dependencies.refreshLock;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async complete(
    input: GmailConnectionCompletionInput,
  ): Promise<GmailConnectionView> {
    const identity = googleIdentitySchema.parse(input.identity);
    const tokens = googleAuthTokenSetSchema.parse(input.tokens);
    return this.#refreshLock.withLock(
      {
        organizationId: input.context.organizationId,
        connectionId: `google-subject:${identity.subject}`,
      },
      async () => {
        const existingConnectionId =
          await this.#persistence.findActiveConnectionIdBySubject({
            organizationId: input.context.organizationId,
            workspaceId: input.context.workspaceId,
            websiteProjectId: input.context.websiteProjectId,
            googleSubject: identity.subject,
          });
        const connectionId = existingConnectionId ?? this.#newId();
        const context = tokenContext(
          input.context.organizationId,
          connectionId,
        );
        const tokenSecretReference = await this.#secretStore.create({
          secretKind: secretKinds.gmailTokenSet,
          plaintext: encodeTokens(tokens),
          context,
        });

        let saved: GmailConnectionSecretPersistenceSaveResult;
        try {
          saved =
            await this.#persistence.saveAuthorizedConnectionWithBindings({
              connectionId,
              organizationId: input.context.organizationId,
              workspaceId: input.context.workspaceId,
              websiteProjectId: input.context.websiteProjectId,
              connectedByUserId: input.context.actorId,
              googleSubject: identity.subject,
              primaryEmail: identity.email.toLowerCase(),
              displayName: identity.displayName ?? null,
              hostedDomain: identity.hostedDomain ?? null,
              grantedScopes: Object.freeze([...tokens.grantedScopes]),
              tokenSecretReference,
              tokenExpiresAt: tokens.expiresAt,
            });
        } catch (error) {
          await this.#secretStore.destroy({
            reference: tokenSecretReference,
            context,
          }).catch(() => undefined);
          throw error;
        }
        if (saved.retiredTokenSecretReference !== null) {
          await this.#secretStore.destroy({
            reference: saved.retiredTokenSecretReference,
            context,
          }).catch(() => undefined);
        }
        return saved.view;
      },
    );
  }

  async refresh(
    input: RefreshGmailConnectionInput,
  ): Promise<RefreshGmailConnectionResult> {
    if (
      input.connectionId.trim().length === 0
      || !Number.isInteger(input.expectedVersion)
      || input.expectedVersion < 1
    ) {
      throw new TypeError("A connection ID and positive version are required.");
    }

    const organizationId = input.context.tenant.organizationId;
    return this.#refreshLock.withLock(
      { organizationId, connectionId: input.connectionId },
      async () => this.refreshUnderLock(input),
    );
  }

  async resolveAccessToken(
    input: ResolveGmailAccessTokenInput,
  ): Promise<string> {
    if (input.connectionId.trim().length === 0) {
      throw new TypeError("A connection ID is required.");
    }

    const lookup = lookupInput(input.context, input.connectionId);
    let current = await this.#persistence.findRefreshState(lookup);
    if (
      current === null
      || current.view.connectionStatus !== "CONNECTED"
      || current.view.sendAvailability !== "AVAILABLE"
    ) {
      throw new GmailConnectionSecretRepositoryError();
    }

    const refreshBefore = Date.now() + gmailAccessTokenRefreshLeadTimeMs;
    if (Date.parse(current.view.tokenExpiresAt) <= refreshBefore) {
      const refreshed = await this.refresh({
        ...input,
        expectedVersion: current.version,
      });
      if (refreshed.outcome === "REAUTH_REQUIRED") {
        throw new GmailConnectionSecretRepositoryError();
      }
      current = await this.#persistence.findRefreshState(lookup);
      if (
        current === null
        || current.view.connectionStatus !== "CONNECTED"
        || current.view.sendAvailability !== "AVAILABLE"
      ) {
        throw new GmailConnectionSecretRepositoryError();
      }
    }

    const tokens = decodeTokens(await this.#secretStore.resolve({
      reference: current.tokenSecretReference,
      context: tokenContext(
        current.organizationId,
        current.connectionId,
      ),
    }));
    if (Date.parse(tokens.expiresAt) <= Date.now()) {
      throw new GmailConnectionSecretRepositoryError();
    }
    return tokens.accessToken;
  }

  private async refreshUnderLock(
    input: RefreshGmailConnectionInput,
  ): Promise<RefreshGmailConnectionResult> {
    const lookup = lookupInput(input.context, input.connectionId);
    const current = await this.#persistence.findRefreshState(lookup);
    if (current === null) {
      throw new GmailConnectionSecretRepositoryError();
    }
    if (current.version !== input.expectedVersion) {
      return {
        outcome: "ALREADY_REFRESHED",
        connection: current.view,
        version: current.version,
      };
    }

    const context = tokenContext(
      current.organizationId,
      current.connectionId,
    );
    const currentTokens = decodeTokens(await this.#secretStore.resolve({
      reference: current.tokenSecretReference,
      context,
    }));
    if (currentTokens.refreshToken === undefined) {
      throw new GmailConnectionSecretRepositoryError();
    }

    let refreshed: GoogleAuthTokenSet;
    try {
      const result = await this.#googleAuth.refresh({
        refreshToken: currentTokens.refreshToken,
      });
      refreshed = googleAuthTokenSetSchema.parse({
        ...result,
        refreshToken: result.refreshToken ?? currentTokens.refreshToken,
      });
    } catch (error) {
      if (
        error instanceof GoogleAuthError
        && error.code === googleAuthFailureCodes.authExpired
      ) {
        return this.markReauthRequired(input, current);
      }
      if (
        error instanceof GoogleAuthError
        && (
          error.code === googleAuthFailureCodes.rateLimited
          || error.code === googleAuthFailureCodes.temporaryFailure
        )
      ) {
        await this.#persistence.markRefreshFailure({
          ...lookup,
          actorId: input.context.actor.userId,
          expectedVersion: current.version,
          reason: error.code,
        });
      }
      throw error;
    }

    const nextReference = await this.#secretStore.rotate({
      reference: current.tokenSecretReference,
      plaintext: encodeTokens(refreshed),
      context,
    });
    const replaced = await this.#persistence.replaceTokenReference({
      ...lookup,
      actorId: input.context.actor.userId,
      expectedVersion: current.version,
      tokenSecretReference: nextReference,
      tokenExpiresAt: refreshed.expiresAt,
      grantedScopes: Object.freeze([...refreshed.grantedScopes]),
    });
    if (replaced === null) {
      await this.#secretStore.destroy({
        reference: nextReference,
        context,
      });
      const winner = await this.#persistence.findRefreshState(lookup);
      if (winner === null) {
        throw new GmailConnectionSecretRepositoryError();
      }
      return {
        outcome: "ALREADY_REFRESHED",
        connection: winner.view,
        version: winner.version,
      };
    }

    await this.#secretStore.destroy({
      reference: current.tokenSecretReference,
      context,
    });
    return {
      outcome: "REFRESHED",
      connection: replaced.view,
      version: replaced.version,
    };
  }

  private async markReauthRequired(
    input: RefreshGmailConnectionInput,
    current: GmailConnectionSecretPersistenceRefreshState,
  ): Promise<RefreshGmailConnectionResult> {
    const lookup = lookupInput(input.context, input.connectionId);
    const reauth = await this.#persistence.markReauthRequired({
      ...lookup,
      actorId: input.context.actor.userId,
      expectedVersion: current.version,
      reason: "GOOGLE_AUTH_EXPIRED",
    });
    if (reauth !== null) {
      return {
        outcome: "REAUTH_REQUIRED",
        connection: reauth.view,
        version: reauth.version,
      };
    }
    const winner = await this.#persistence.findRefreshState(lookup);
    if (winner === null) {
      throw new GmailConnectionSecretRepositoryError();
    }
    return {
      outcome: "ALREADY_REFRESHED",
      connection: winner.view,
      version: winner.version,
    };
  }
}
