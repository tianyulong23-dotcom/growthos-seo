import { describe, expect, it, vi } from "vitest";

import {
  GmailConnectionDisconnectWorkflow,
  gmailConnectionRevocationFailureCodes,
  type GmailConnectionDisconnectPersistence,
  type PendingGmailConnectionRevocation,
} from "../../src/modules/backlinks/application/workflows/gmail-connection-disconnect.workflow.js";
import { gmailOAuthScopes } from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";
import {
  GoogleAuthError,
  googleAuthFailureCodes,
} from "../../src/modules/backlinks/ports/google-auth.port.js";
import {
  secretKinds,
  SecretStoreError,
  secretStoreFailureCodes,
  type SecretStoreReference,
} from "../../src/modules/backlinks/ports/secret-store.port.js";

const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const context = {
  actor: {
    userId: "user-105",
    sessionId: "session-105",
    roles: ["owner"],
  },
  tenant: {
    organizationId: id(1),
    workspaceId: id(2),
  },
  project: {
    websiteProjectId: id(3),
    websiteProjectKey: "project-105",
    canonicalDomain: "example.test",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: id(4),
    promotionTargetVersionId: id(5),
  },
} as const;

const connectionId = id(100);
const reference: SecretStoreReference = {
  provider: "platform-secret-store",
  secretKind: secretKinds.gmailTokenSet,
  externalSecretId: "gmail-connection-105",
  externalSecretVersion: "1",
};
const tokens = {
  accessToken: "access-token-105",
  refreshToken: "refresh-token-105",
  tokenType: "Bearer",
  expiresAt: "2026-07-27T06:00:00.000Z",
  grantedScopes: gmailOAuthScopes,
} as const;
const disconnectedConnection = {
  connectionId,
  primaryEmail: "owner@example.test",
  displayName: "Owner",
  hostedDomain: null,
  grantedScopes: gmailOAuthScopes,
  connectionStatus: "DISCONNECTED",
  sendAvailability: "PAUSED",
  mailSyncCapability: true,
  tokenExpiresAt: tokens.expiresAt,
  connectedAt: "2026-07-27T04:00:00.000Z",
} as const;
const retryInput = {
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  connectionId,
} as const;

class FakeDisconnectPersistence
implements GmailConnectionDisconnectPersistence {
  readonly events: string[];
  pending: PendingGmailConnectionRevocation | null = {
    ...retryInput,
    connection: disconnectedConnection,
    tokenSecretReference: reference,
    googleRevoked: false,
  };
  failureCodes: string[] = [];

  constructor(events: string[]) {
    this.events = events;
  }

  async prepareDisconnect() {
    this.events.push("local.disconnect-and-pause");
    return this.pending;
  }

  async loadPendingRevocation() {
    this.events.push("local.load-pending");
    return this.pending;
  }

  async markGoogleRevoked() {
    this.events.push("local.google-revoked");
    if (this.pending !== null) {
      this.pending = { ...this.pending, googleRevoked: true };
    }
  }

  async recordRevocationFailure(
    input: Readonly<{ failureCode: string }>,
  ) {
    this.events.push(`local.failure:${input.failureCode}`);
    this.failureCodes.push(input.failureCode);
  }

  async completeCredentialDeletion() {
    this.events.push("local.reference-deleted");
    this.pending = null;
    return disconnectedConnection;
  }
}

function setup() {
  const events: string[] = [];
  const persistence = new FakeDisconnectPersistence(events);
  const revoke = vi.fn(async () => {
    events.push("google.revoke");
    return { revoked: true as const };
  });
  const destroy = vi.fn(async () => {
    events.push("secret.destroy");
    return { destroyed: true as const };
  });
  const schedule = vi.fn(async () => {
    events.push("retry.schedule");
  });
  const workflow = new GmailConnectionDisconnectWorkflow({
    persistence,
    googleAuth: {
      authorize: vi.fn(),
      callback: vi.fn(),
      refresh: vi.fn(),
      revoke,
    },
    secretStore: {
      create: vi.fn(),
      resolve: vi.fn(async () => {
        events.push("secret.resolve");
        return JSON.stringify(tokens);
      }),
      rotate: vi.fn(),
      destroy,
    },
    retryScheduler: { schedule },
  });
  return { workflow, persistence, events, revoke, destroy, schedule };
}

describe("BL-AI-105 Gmail disconnect and revoke workflow", () => {
  it("stops local access before revoking and then deletes the local reference", async () => {
    const test = setup();

    await expect(test.workflow.disconnect({
      context,
      connectionId,
      expectedVersion: 1,
    })).resolves.toEqual({
      connection: disconnectedConnection,
      revocationStatus: "COMPLETED",
    });

    expect(test.events).toEqual([
      "local.disconnect-and-pause",
      "secret.resolve",
      "google.revoke",
      "local.google-revoked",
      "secret.destroy",
      "local.reference-deleted",
    ]);
    expect(test.revoke).toHaveBeenCalledWith({
      token: tokens.refreshToken,
    });
    expect(test.destroy).toHaveBeenCalledWith({
      reference,
      context: {
        organizationId: context.tenant.organizationId,
        subjectProvider: "google",
        connectionId,
      },
    });
    expect(test.persistence.pending).toBeNull();
    expect(test.schedule).not.toHaveBeenCalled();
  });

  it("keeps the connection locally disabled and retries an unconfirmed Google revoke", async () => {
    const test = setup();
    test.revoke.mockRejectedValueOnce(new GoogleAuthError({
      operation: "revoke",
      code: googleAuthFailureCodes.temporaryFailure,
      retryable: true,
    }));

    const first = await test.workflow.disconnect({
      context,
      connectionId,
      expectedVersion: 1,
    });

    expect(first).toEqual({
      connection: disconnectedConnection,
      revocationStatus: "PENDING",
    });
    expect(test.events).toEqual([
      "local.disconnect-and-pause",
      "secret.resolve",
      "local.failure:GOOGLE_REVOKE_UNCONFIRMED",
      "retry.schedule",
    ]);
    expect(test.persistence.pending?.connection).toMatchObject({
      connectionStatus: "DISCONNECTED",
      sendAvailability: "PAUSED",
    });
    expect(test.persistence.failureCodes).toEqual([
      gmailConnectionRevocationFailureCodes.googleRevokeUnconfirmed,
    ]);
    expect(test.schedule).toHaveBeenCalledWith({
      ...retryInput,
      reason: gmailConnectionRevocationFailureCodes.googleRevokeUnconfirmed,
    });
    expect(JSON.stringify(test.schedule.mock.calls)).not.toMatch(
      /refresh-token-105|access-token-105|externalSecretId|tokenSecretReference/,
    );
    expect(test.destroy).not.toHaveBeenCalled();

    test.events.length = 0;
    await expect(test.workflow.retry(retryInput)).resolves.toEqual({
      connection: disconnectedConnection,
      revocationStatus: "COMPLETED",
    });
    expect(test.events).toEqual([
      "local.load-pending",
      "secret.resolve",
      "google.revoke",
      "local.google-revoked",
      "secret.destroy",
      "local.reference-deleted",
    ]);
    expect(test.revoke).toHaveBeenCalledTimes(2);
    expect(test.persistence.pending).toBeNull();
  });

  it("retries only local deletion after Google has already revoked the token", async () => {
    const test = setup();
    test.destroy.mockRejectedValueOnce(new SecretStoreError({
      operation: "destroy",
      code: secretStoreFailureCodes.temporaryFailure,
      retryable: true,
    }));

    await expect(test.workflow.disconnect({
      context,
      connectionId,
      expectedVersion: 1,
    })).resolves.toEqual({
      connection: disconnectedConnection,
      revocationStatus: "PENDING",
    });
    expect(test.persistence.pending?.googleRevoked).toBe(true);
    expect(test.persistence.failureCodes).toEqual([
      gmailConnectionRevocationFailureCodes.localSecretDeleteUnconfirmed,
    ]);
    expect(test.schedule).toHaveBeenCalledWith({
      ...retryInput,
      reason:
        gmailConnectionRevocationFailureCodes.localSecretDeleteUnconfirmed,
    });

    test.events.length = 0;
    await expect(test.workflow.retry(retryInput)).resolves.toEqual({
      connection: disconnectedConnection,
      revocationStatus: "COMPLETED",
    });
    expect(test.events).toEqual([
      "local.load-pending",
      "secret.destroy",
      "local.reference-deleted",
    ]);
    expect(test.revoke).toHaveBeenCalledOnce();
    expect(test.destroy).toHaveBeenCalledTimes(2);
    expect(test.persistence.pending).toBeNull();
  });
});
