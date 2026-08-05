import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresqlGmailConnectionRefreshLock,
  PostgresqlGmailConnectionRepository,
} from "../../../src/modules/backlinks/db/repositories/gmail-connection.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { PostgresqlOAuthAttemptRepository } from "../../../src/modules/backlinks/db/repositories/oauth-attempt.repository.js";
import type { BacklinkTenantPool } from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { gmailOAuthScopes } from "../../../src/modules/backlinks/domain/sending/oauth-attempt.js";
import {
  secretKinds,
  type SecretStoreCreateInput,
  type SecretStoreDestroyInput,
  type SecretStorePort,
  type SecretStoreReference,
  type SecretStoreResolveInput,
  type SecretStoreRotateInput,
} from "../../../src/modules/backlinks/ports/secret-store.port.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
  readonly Pool: new (config: unknown) => BacklinkTenantPool & {
    end(): Promise<void>;
  };
};
const migration = (name: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${name}`,
    import.meta.url,
  );
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const connectionId = id(100);

const referenceKey = (reference: SecretStoreReference) =>
  `${reference.externalSecretId}:${reference.externalSecretVersion}`;

class InMemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  readonly destroyed: SecretStoreReference[] = [];
  private version = 0;

  async create(input: SecretStoreCreateInput): Promise<SecretStoreReference> {
    const reference = {
      provider: "integration-secret-store",
      secretKind: input.secretKind,
      externalSecretId:
        input.context.oauthAttemptId
        ?? input.context.connectionId
        ?? "unknown",
      externalSecretVersion: String(++this.version),
    } as const;
    this.values.set(referenceKey(reference), input.plaintext);
    return reference;
  }

  async resolve(input: SecretStoreResolveInput): Promise<string> {
    const value = this.values.get(referenceKey(input.reference));
    if (value === undefined) {
      throw new Error("Secret not found.");
    }
    return value;
  }

  async rotate(input: SecretStoreRotateInput): Promise<SecretStoreReference> {
    const reference = {
      ...input.reference,
      externalSecretVersion: String(++this.version),
    };
    this.values.set(referenceKey(reference), input.plaintext);
    return reference;
  }

  async destroy(input: SecretStoreDestroyInput) {
    this.values.delete(referenceKey(input.reference));
    this.destroyed.push(input.reference);
    return { destroyed: true as const };
  }
}

describe("PB-C1 Gmail authorization PostgreSQL repositories", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let pool: BacklinkTenantPool & { end(): Promise<void> };

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of [
      "0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(await readFile(roles, "utf8"));
    for (const name of [
      "0005_backlink_schema_role_ownership.sql",
      "0006_backlink_opportunities.sql",
      "0007_backlink_opportunity_counter.sql",
      "0010_backlink_assessments.sql",
      "0011_backlink_contact_purpose_correction.sql",
      "0012_backlink_gmail_connections.sql",
      "0015_backlink_gmail_sync_capabilities.sql",
      "0041_backlink_gmail_project_bindings.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    pool = new PgPool({ connectionString: harness.connectionString });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("consumes OAuth state once and persists only the PKCE Secret Ref", async () => {
    const secretStore = new InMemorySecretStore();
    const repository = new PostgresqlOAuthAttemptRepository({
      pool,
      secretStore,
      newId: () => id(201),
    });
    const createdAt = new Date("2026-07-27T06:00:00.000Z");
    const input = {
      id: id(200),
      organizationId,
      workspaceId,
      websiteProjectId,
      initiatedByUserId: "user-pb-c1",
      stateHash: "a".repeat(64),
      sessionBindingHash: "b".repeat(64),
      pkceVerifier: "pkce-verifier-pb-c1",
      requestedScopes: gmailOAuthScopes,
      redirectUri: "https://app.example.test/oauth/google/callback",
      returnPath: "/backlinks/settings",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
    };

    await repository.create(input);
    const persisted = await client.query(
      `SELECT attempt.state_hash AS "stateHash",
              secret.external_secret_id AS "externalSecretId",
              to_jsonb(attempt)::text AS "attemptJson",
              to_jsonb(secret)::text AS "secretJson"
         FROM backlinks.backlink_oauth_attempts AS attempt
         JOIN backlinks.backlink_secret_references AS secret
           ON secret.organization_id = attempt.organization_id
          AND secret.id = attempt.pkce_verifier_secret_reference_id
        WHERE attempt.id = $1`,
      [input.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      stateHash: input.stateHash,
      externalSecretId: input.id,
    });
    expect(JSON.stringify(persisted.rows[0])).not.toContain(input.pkceVerifier);

    const consumeInput = {
      organizationId,
      workspaceId,
      websiteProjectId,
      initiatedByUserId: input.initiatedByUserId,
      stateHash: input.stateHash,
      sessionBindingHash: input.sessionBindingHash,
      consumedAt: new Date("2026-07-27T06:05:00.000Z"),
    };
    await expect(repository.consume(consumeInput)).resolves.toMatchObject({
      attemptId: input.id,
      pkceVerifier: input.pkceVerifier,
      requestedScopes: gmailOAuthScopes,
    });
    await expect(repository.consume(consumeInput)).resolves.toBeNull();
    expect(secretStore.values.size).toBe(0);
    expect(
      (
        await client.query(
          `SELECT status FROM backlinks.backlink_secret_references
            WHERE id = $1`,
          [id(201)],
        )
    ).rows,
    ).toEqual([{ status: "DESTROYED" }]);
  });

  it("destroys expired unconsumed PKCE secrets before marking references destroyed", async () => {
    const secretStore = new InMemorySecretStore();
    let nextReferenceId = 220;
    const repository = new PostgresqlOAuthAttemptRepository({
      pool,
      secretStore,
      newId: () => id(nextReferenceId++),
    });
    const expiredAt = new Date("2026-07-27T07:30:00.000Z");
    const attempts = [
      {
        id: id(210),
        stateHash: "c".repeat(64),
        createdAt: new Date("2026-07-27T07:00:00.000Z"),
        expiresAt: new Date("2026-07-27T07:10:00.000Z"),
      },
      {
        id: id(211),
        stateHash: "d".repeat(64),
        createdAt: new Date("2026-07-27T07:25:00.000Z"),
        expiresAt: new Date("2026-07-27T07:35:00.000Z"),
      },
    ] as const;
    for (const attempt of attempts) {
      await repository.create({
        ...attempt,
        organizationId,
        workspaceId,
        websiteProjectId,
        initiatedByUserId: "user-pb-c1",
        sessionBindingHash: "e".repeat(64),
        pkceVerifier: `pkce-${attempt.id}`,
        requestedScopes: gmailOAuthScopes,
        redirectUri: "https://app.example.test/oauth/google/callback",
        returnPath: "/backlinks/settings",
      });
    }

    await expect(repository.cleanupExpired({
      organizationId,
      workspaceId,
      websiteProjectId,
      cleanedByUserId: "user-pb-c1",
      expiredAt,
    })).resolves.toBe(1);
    expect(secretStore.values.size).toBe(1);
    expect(secretStore.destroyed).toHaveLength(1);
    expect(
      (
        await client.query(
          `SELECT attempt.id, secret.status
             FROM backlinks.backlink_oauth_attempts AS attempt
             JOIN backlinks.backlink_secret_references AS secret
               ON secret.organization_id = attempt.organization_id
              AND secret.id = attempt.pkce_verifier_secret_reference_id
            WHERE attempt.id = ANY($1::uuid[])
            ORDER BY attempt.id`,
          [attempts.map((attempt) => attempt.id)],
        )
      ).rows,
    ).toEqual([
      { id: attempts[0].id, status: "DESTROYED" },
      { id: attempts[1].id, status: "ACTIVE" },
    ]);
  });

  it("persists connection, binding, verified identity, refresh, and revocation atomically", async () => {
    let nextId = 300;
    let repositoryNow = new Date("2026-07-27T08:00:00.000Z");
    const repository = new PostgresqlGmailConnectionRepository({
      pool,
      newId: () => id(nextId++),
      now: () => new Date(repositoryNow),
    });
    const firstReference = {
      provider: "integration-secret-store",
      secretKind: secretKinds.gmailTokenSet,
      externalSecretId: connectionId,
      externalSecretVersion: "1",
    } as const;
    const created = await repository.createConnectionWithWorkspaceBinding({
      connectionId,
      organizationId,
      workspaceId,
      websiteProjectId,
      connectedByUserId: "user-pb-c1",
      googleSubject: "google-subject-pb-c1",
      primaryEmail: "owner@example.test",
      displayName: "Example Owner",
      hostedDomain: "example.test",
      grantedScopes: gmailOAuthScopes,
      tokenSecretReference: firstReference,
      tokenExpiresAt: "2026-07-27T08:00:00.000Z",
    });
    expect(created).toMatchObject({
      connectionId,
      version: 1,
      primaryEmail: "owner@example.test",
      connectionStatus: "CONNECTED",
      sendAvailability: "AVAILABLE",
    });
    repositoryNow = new Date(new Date(created.connectedAt).getTime() + 1_000);
    expect(
      (
        await client.query(
          `SELECT binding.binding_status AS "bindingStatus",
                  identity.normalized_email AS "normalizedEmail",
                  identity.verification_status AS "verificationStatus",
                  identity.source
             FROM backlinks.backlink_gmail_workspace_bindings AS binding
             JOIN backlinks.backlink_gmail_send_identities AS identity
               ON identity.organization_id = binding.organization_id
              AND identity.gmail_connection_id = binding.gmail_connection_id
            WHERE binding.gmail_connection_id = $1`,
          [connectionId],
        )
      ).rows,
    ).toEqual([{
      bindingStatus: "ACTIVE",
      normalizedEmail: "owner@example.test",
      verificationStatus: "accepted",
      source: "OIDC_PRIMARY",
    }]);

    const nextReference = {
      ...firstReference,
      externalSecretVersion: "2",
    };
    const refreshed = await repository.replaceTokenReference({
      organizationId,
      workspaceId,
      websiteProjectId,
      connectionId,
      actorId: "user-pb-c1",
      expectedVersion: 1,
      tokenSecretReference: nextReference,
      tokenExpiresAt: "2026-07-27T09:00:00.000Z",
      grantedScopes: gmailOAuthScopes,
    });
    expect(refreshed).toMatchObject({
      version: 2,
      tokenSecretReference: nextReference,
      view: { version: 2, tokenExpiresAt: "2026-07-27T09:00:00.000Z" },
    });
    expect(
      (
        await client.query(
          `SELECT external_secret_version AS version, status
             FROM backlinks.backlink_secret_references
            WHERE organization_id = $1
              AND external_secret_id = $2
            ORDER BY external_secret_version`,
          [organizationId, connectionId],
        )
      ).rows,
    ).toEqual([
      { version: "1", status: "RETIRED" },
      { version: "2", status: "ACTIVE" },
    ]);

    const pending = await repository.prepareDisconnect({
      organizationId,
      workspaceId,
      websiteProjectId,
      connectionId,
      actorId: "user-pb-c1",
      expectedVersion: 2,
    });
    expect(pending).toMatchObject({
      connection: {
        version: 3,
        connectionStatus: "DISCONNECTED",
        sendAvailability: "PAUSED",
      },
      tokenSecretReference: nextReference,
      googleRevoked: false,
    });
    expect(
      (
        await client.query(
          `SELECT connection.token_secret_reference_id AS "tokenReferenceId",
                  binding.binding_status AS "bindingStatus",
                  revocation.google_revoked AS "googleRevoked"
             FROM backlinks.backlink_gmail_connections AS connection
             JOIN backlinks.backlink_gmail_workspace_bindings AS binding
               ON binding.gmail_connection_id = connection.id
             JOIN backlinks.backlink_gmail_connection_revocations AS revocation
               ON revocation.gmail_connection_id = connection.id
            WHERE connection.id = $1`,
          [connectionId],
        )
      ).rows,
    ).toEqual([{
      tokenReferenceId: null,
      bindingStatus: "INACTIVE",
      googleRevoked: false,
    }]);

    await repository.markGoogleRevoked({
      organizationId,
      workspaceId,
      websiteProjectId,
      connectionId,
    });
    await expect(repository.completeCredentialDeletion({
      organizationId,
      workspaceId,
      websiteProjectId,
      connectionId,
    })).resolves.toMatchObject({
      connectionId,
      connectionStatus: "DISCONNECTED",
      sendAvailability: "PAUSED",
    });
    expect(
      (
        await client.query(
          `SELECT status FROM backlinks.backlink_secret_references
            WHERE organization_id = $1
              AND external_secret_id = $2
              AND external_secret_version = '2'`,
          [organizationId, connectionId],
        )
      ).rows,
    ).toEqual([{ status: "DESTROYED" }]);
  });

  it("requires a separate connection even when two projects authorize the same Gmail account", async () => {
    let nextId = 800;
    const repository = new PostgresqlGmailConnectionRepository({
      pool,
      newId: () => id(nextId++),
    });
    const secondProjectId = id(4);
    const firstConnectionId = id(110);
    const secondConnectionId = id(111);
    const sharedIdentity = {
      connectedByUserId: "user-pb-c1",
      googleSubject: "shared-google-subject-pb-c1",
      primaryEmail: "shared-owner@example.test",
      displayName: "Shared Owner",
      hostedDomain: "example.test",
      grantedScopes: gmailOAuthScopes,
      tokenExpiresAt: "2026-07-27T10:00:00.000Z",
    } as const;

    await repository.createConnectionWithWorkspaceBinding({
      connectionId: firstConnectionId,
      organizationId,
      workspaceId,
      websiteProjectId,
      ...sharedIdentity,
      tokenSecretReference: {
        provider: "integration-secret-store",
        secretKind: secretKinds.gmailTokenSet,
        externalSecretId: firstConnectionId,
        externalSecretVersion: "1",
      },
    });
    await repository.createConnectionWithWorkspaceBinding({
      connectionId: secondConnectionId,
      organizationId,
      workspaceId,
      websiteProjectId: secondProjectId,
      ...sharedIdentity,
      tokenSecretReference: {
        provider: "integration-secret-store",
        secretKind: secretKinds.gmailTokenSet,
        externalSecretId: secondConnectionId,
        externalSecretVersion: "1",
      },
    });

    const contextFor = (projectId: string, domain: string) => ({
      actor: createActorContext({
        userId: "user-pb-c1",
        sessionId: `session-${projectId}`,
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId: projectId,
        canonicalDomain: domain,
        locale: "en-US",
        countryCode: "US",
        profileVersionId: id(120),
        promotionTargetVersionId: id(121),
      }),
    });

    await expect(
      repository.findVisibleConnection(
        contextFor(websiteProjectId, "first.example.test"),
      ),
    ).resolves.toMatchObject({ connectionId: firstConnectionId });
    await expect(
      repository.findVisibleConnection(
        contextFor(secondProjectId, "second.example.test"),
      ),
    ).resolves.toMatchObject({ connectionId: secondConnectionId });
    expect(
      (
        await client.query(
          `SELECT website_project_id AS "websiteProjectId",
                  gmail_connection_id AS "connectionId"
             FROM backlinks.backlink_gmail_workspace_bindings
            WHERE gmail_connection_id = ANY($1::uuid[])
            ORDER BY website_project_id`,
          [[firstConnectionId, secondConnectionId]],
        )
      ).rows,
    ).toEqual([
      { websiteProjectId, connectionId: firstConnectionId },
      { websiteProjectId: secondProjectId, connectionId: secondConnectionId },
    ]);
  });

  it("serializes twenty refresh contenders with the PostgreSQL advisory lock", async () => {
    const lock = new PostgresqlGmailConnectionRefreshLock(pool);
    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        lock.withLock({ organizationId, connectionId }, async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active -= 1;
        }),
      ),
    );
    expect(maximumActive).toBe(1);
  });
});
