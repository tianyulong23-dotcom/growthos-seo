import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  SecretStoreClientAdapter,
  type SecretStoreClient,
} from "../../src/modules/backlinks/adapters/security/secret-store-client.js";
import {
  SecretBackedGmailConnectionRepository,
  type GmailConnectionRefreshLock,
  type GmailConnectionSecretPersistence,
  type GmailConnectionSecretPersistenceCreateInput,
  type GmailConnectionSecretPersistenceRefreshState,
  type GmailConnectionSecretPersistenceReplaceInput,
} from "../../src/modules/backlinks/application/services/gmail-connection-secret.repository.js";
import { gmailOAuthScopes } from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";
import {
  secretKinds,
  secretStoreFailureCodes,
  type SecretEncryptionContext,
  type SecretStorePort,
  type SecretStoreReference,
} from "../../src/modules/backlinks/ports/secret-store.port.js";

const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const context = {
  actor: {
    userId: "user-104",
    sessionId: "session-104",
    roles: ["owner"],
  },
  tenant: {
    organizationId: id(1),
    workspaceId: id(2),
  },
  project: {
    websiteProjectId: id(3),
    websiteProjectKey: "project-104",
    canonicalDomain: "example.test",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: id(4),
    promotionTargetVersionId: id(5),
  },
} as const;

const initialTokens = {
  accessToken: "access-token-104-initial",
  refreshToken: "refresh-token-104",
  tokenType: "Bearer",
  expiresAt: "2026-07-27T05:00:00.000Z",
  grantedScopes: gmailOAuthScopes,
} as const;

const refreshedTokens = {
  accessToken: "access-token-104-refreshed",
  tokenType: "Bearer",
  expiresAt: "2026-07-27T06:00:00.000Z",
  grantedScopes: gmailOAuthScopes,
} as const;

const identity = {
  subject: "google-subject-104",
  email: "owner@example.test",
  emailVerified: true,
  displayName: "Owner",
} as const;

const tokenContext = (
  connectionId: string,
): SecretEncryptionContext => ({
  organizationId: context.tenant.organizationId,
  subjectProvider: "google",
  connectionId,
});

const reference = (
  externalSecretVersion: string,
): SecretStoreReference => ({
  provider: "platform-secret-store",
  secretKind: secretKinds.gmailTokenSet,
  externalSecretId: "gmail-connection-104",
  externalSecretVersion,
});

const view = (connectionId: string, expiresAt: string) => ({
  connectionId,
  primaryEmail: identity.email,
  displayName: identity.displayName,
  hostedDomain: null,
  grantedScopes: gmailOAuthScopes,
  connectionStatus: "CONNECTED",
  sendAvailability: "AVAILABLE",
  mailSyncCapability: true,
  tokenExpiresAt: expiresAt,
  connectedAt: "2026-07-27T04:00:00.000Z",
} as const);

class SerialRefreshLock implements GmailConnectionRefreshLock {
  private tail = Promise.resolve();

  async withLock<Result>(
    _input: Readonly<{ organizationId: string; connectionId: string }>,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const predecessor = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

class FakeSecretStore implements SecretStorePort {
  readonly create = vi.fn(async () => reference("1"));
  readonly resolve = vi.fn(async () => JSON.stringify(initialTokens));
  readonly rotate = vi.fn(async () => reference("2"));
  readonly destroy = vi.fn(async () => ({ destroyed: true as const }));
}

class FakePersistence implements GmailConnectionSecretPersistence {
  readonly creates: GmailConnectionSecretPersistenceCreateInput[] = [];
  readonly replaces: GmailConnectionSecretPersistenceReplaceInput[] = [];
  state: GmailConnectionSecretPersistenceRefreshState | null = null;

  async createConnectionWithWorkspaceBinding(
    input: GmailConnectionSecretPersistenceCreateInput,
  ) {
    this.creates.push(input);
    return view(input.connectionId, input.tokenExpiresAt);
  }

  async findRefreshState() {
    return this.state;
  }

  async replaceTokenReference(
    input: GmailConnectionSecretPersistenceReplaceInput,
  ) {
    this.replaces.push(input);
    if (this.state === null || this.state.version !== input.expectedVersion) {
      return null;
    }
    this.state = {
      ...this.state,
      version: this.state.version + 1,
      tokenSecretReference: input.tokenSecretReference,
      view: view(this.state.connectionId, input.tokenExpiresAt),
    };
    return this.state;
  }

  async markReauthRequired() {
    throw new Error("Unexpected reauth transition.");
  }
}

describe("BL-AI-104 Secret Store and Gmail Token repository", () => {
  it("defaults the Secret Store provider off without invoking its client", async () => {
    const client: SecretStoreClient = {
      create: vi.fn(),
      resolve: vi.fn(),
      rotate: vi.fn(),
      destroy: vi.fn(),
    };
    const adapter = new SecretStoreClientAdapter({ client });

    await expect(adapter.create({
      secretKind: secretKinds.gmailTokenSet,
      plaintext: JSON.stringify(initialTokens),
      context: tokenContext(id(100)),
    })).rejects.toMatchObject({
      operation: "create",
      code: secretStoreFailureCodes.disabled,
      retryable: false,
    });
    expect(client.create).not.toHaveBeenCalled();
    expect(client.resolve).not.toHaveBeenCalled();
    expect(client.rotate).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();

    const source = readFileSync(new URL(
      "../../src/modules/backlinks/adapters/security/secret-store-client.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(
      /\bfetch\s*\(|SecretManagerServiceClient|KeyManagementServiceClient|@google-cloud/,
    );
  });

  it("delegates enabled Secret Store operations without leaking plaintext", async () => {
    const client: SecretStoreClient = {
      create: vi.fn(async () => ({
        externalSecretId: "gmail-connection-104",
        externalSecretVersion: "1",
      })),
      resolve: vi.fn(async () => JSON.stringify(initialTokens)),
      rotate: vi.fn(async () => ({
        externalSecretId: "gmail-connection-104",
        externalSecretVersion: "2",
      })),
      destroy: vi.fn(async () => undefined),
    };
    const adapter = new SecretStoreClientAdapter({
      client,
      config: { enabled: true, timeoutMs: 1_000 },
    });
    const firstReference = await adapter.create({
      secretKind: secretKinds.gmailTokenSet,
      plaintext: JSON.stringify(initialTokens),
      context: tokenContext(id(100)),
    });

    await expect(adapter.resolve({
      reference: firstReference,
      context: tokenContext(id(100)),
    })).resolves.toBe(JSON.stringify(initialTokens));
    const nextReference = await adapter.rotate({
      reference: firstReference,
      plaintext: JSON.stringify(refreshedTokens),
      context: tokenContext(id(100)),
    });
    await expect(adapter.destroy({
      reference: firstReference,
      context: tokenContext(id(100)),
    })).resolves.toEqual({ destroyed: true });

    expect(firstReference).toEqual(reference("1"));
    expect(nextReference).toEqual(reference("2"));
    expect(client.create).toHaveBeenCalledOnce();
    expect(client.resolve).toHaveBeenCalledOnce();
    expect(client.rotate).toHaveBeenCalledOnce();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(JSON.stringify(adapter)).not.toMatch(
      /access-token-104-initial|refresh-token-104|access-token-104-refreshed/,
    );

    const failingClient: SecretStoreClient = {
      ...client,
      resolve: vi.fn(async () => {
        throw new Error(initialTokens.refreshToken);
      }),
    };
    const failingAdapter = new SecretStoreClientAdapter({
      client: failingClient,
      config: { enabled: true },
    });
    try {
      await failingAdapter.resolve({
        reference: firstReference,
        context: tokenContext(id(100)),
      });
    } catch (error) {
      expect(error).toMatchObject({
        operation: "resolve",
        code: secretStoreFailureCodes.temporaryFailure,
        retryable: true,
      });
      expect(JSON.stringify(error)).not.toContain(initialTokens.refreshToken);
    }
  });

  it("persists only an opaque Token Secret Ref when completing Gmail OAuth", async () => {
    const secretStore = new FakeSecretStore();
    const persistence = new FakePersistence();
    const repository = new SecretBackedGmailConnectionRepository({
      secretStore,
      googleAuth: {
        authorize: vi.fn(),
        callback: vi.fn(),
        refresh: vi.fn(),
        revoke: vi.fn(),
      },
      persistence,
      refreshLock: new SerialRefreshLock(),
      newId: () => id(100),
    });

    await expect(repository.complete({
      context,
      identity,
      tokens: initialTokens,
    })).resolves.toEqual(view(id(100), initialTokens.expiresAt));

    expect(secretStore.create).toHaveBeenCalledWith({
      secretKind: secretKinds.gmailTokenSet,
      plaintext: JSON.stringify(initialTokens),
      context: tokenContext(id(100)),
    });
    expect(persistence.creates).toHaveLength(1);
    expect(persistence.creates[0]?.tokenSecretReference).toEqual(reference("1"));
    expect(JSON.stringify(persistence.creates)).not.toMatch(
      /access-token-104-initial|refresh-token-104|accessToken|refreshToken/,
    );
  });

  it("executes one provider refresh for 20 concurrent stale-version callers", async () => {
    const secretStore = new FakeSecretStore();
    const persistence = new FakePersistence();
    persistence.state = {
      organizationId: context.tenant.organizationId,
      connectionId: id(100),
      version: 1,
      tokenSecretReference: reference("1"),
      view: view(id(100), initialTokens.expiresAt),
    };
    const refresh = vi.fn(async () => refreshedTokens);
    const repository = new SecretBackedGmailConnectionRepository({
      secretStore,
      googleAuth: {
        authorize: vi.fn(),
        callback: vi.fn(),
        refresh,
        revoke: vi.fn(),
      },
      persistence,
      refreshLock: new SerialRefreshLock(),
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.refresh({
        context,
        connectionId: id(100),
        expectedVersion: 1,
      })),
    );

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith({
      refreshToken: initialTokens.refreshToken,
    });
    expect(secretStore.resolve).toHaveBeenCalledOnce();
    expect(secretStore.rotate).toHaveBeenCalledOnce();
    expect(secretStore.rotate).toHaveBeenCalledWith(expect.objectContaining({
      reference: reference("1"),
      context: tokenContext(id(100)),
    }));
    const rotatedPlaintext = secretStore.rotate.mock.calls[0]?.[0].plaintext;
    expect(JSON.parse(rotatedPlaintext ?? "")).toEqual({
      ...refreshedTokens,
      refreshToken: initialTokens.refreshToken,
    });
    expect(secretStore.destroy).toHaveBeenCalledOnce();
    expect(secretStore.destroy).toHaveBeenCalledWith({
      reference: reference("1"),
      context: tokenContext(id(100)),
    });
    expect(persistence.replaces).toHaveLength(1);
    expect(JSON.stringify(persistence.replaces)).not.toMatch(
      /access-token-104-refreshed|refresh-token-104|accessToken|refreshToken/,
    );
    expect(results.filter((result) => result.outcome === "REFRESHED")).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "ALREADY_REFRESHED"),
    ).toHaveLength(19);
    expect(results.every((result) => result.version === 2)).toBe(true);
  });
});
