import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresqlInitialMailSyncRepository,
  type PersistedInitialMailMessage,
} from "../../../src/modules/backlinks/application/services/mail-initial-sync.repository.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BacklinkTransactionQueryResult>;
};

type RuntimePool = BacklinkTenantPool & {
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
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
const context = {
  organizationId: id(1),
  workspaceId: id(2),
  websiteProjectId: id(3),
  gmailConnectionId: id(501),
  actorId: "worker-128",
};
const startedAt = new Date("2026-07-28T06:00:00.000Z");
const readSyncScopes = JSON.stringify([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
]);
const message = (
  providerMessageId: string,
  providerThreadId: string,
  historyId = "700",
): PersistedInitialMailMessage => ({
  providerMessageId,
  providerThreadId,
  historyId,
  receivedAt: new Date("2026-07-27T06:00:00.000Z"),
  rawObjectKey: `mail/raw/${providerMessageId}`,
  rawContentSha256: "a".repeat(64),
  rawSizeBytes: 42,
  fetchedAt: new Date("2026-07-28T06:01:00.000Z"),
  retentionExpiresAt: new Date("2026-08-27T06:01:00.000Z"),
});

describe("BL-AI-128 PostgreSQL Initial Mail Sync Repository", () => {
  const loginRole = `bl_ai_128_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;
  let nextId = 600;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    for (const name of [
      "0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql",
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    await admin.query(await readFile(roles, "utf8"));
    for (const name of [
      "0005_backlink_schema_role_ownership.sql",
      "0006_backlink_opportunities.sql",
      "0007_backlink_opportunity_counter.sql",
      "0010_backlink_assessments.sql",
      "0011_backlink_contact_purpose_correction.sql",
      "0012_backlink_gmail_connections.sql",
      "0013_backlink_drafts.sql",
      "0014_backlink_send_intents.sql",
      "0015_backlink_gmail_sync_capabilities.sql",
      "0016_backlink_mail_sync.sql",
      "0041_backlink_gmail_project_bindings.sql",
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    await admin.query(`
      CREATE ROLE "${loginRole}"
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${loginRole}";

      INSERT INTO backlinks.backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES (
        '${id(401)}', '${context.organizationId}', 'gcp-secret-manager',
        'GMAIL_TOKEN_SET', 'projects/test/secrets/mail-sync-128', '1',
        'test', 'test'
      );
      INSERT INTO backlinks.backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES (
        '${context.gmailConnectionId}', '${context.organizationId}', 'user-128',
        'mail-sync-128', 'sender128@example.test', '${readSyncScopes}'::jsonb,
        '${id(401)}', statement_timestamp() + interval '1 hour',
        'test', 'test'
      );
      INSERT INTO backlinks.backlink_gmail_workspace_bindings (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, created_by, updated_by
      ) VALUES (
        '${id(502)}', '${context.organizationId}', '${context.workspaceId}',
        '${context.websiteProjectId}', '${context.gmailConnectionId}',
        'test', 'test'
      );
    `);
    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = loginRole;
    tenantUrl.password = password;
    tenantPool = new PgPool({ connectionString: tenantUrl.toString(), max: 4 });
  }, 120_000);

  beforeEach(async () => {
    nextId = 600;
    await admin.query(`
      TRUNCATE backlinks.backlink_reply_match_candidates,
               backlinks.backlink_inbound_messages,
               backlinks.backlink_mail_messages,
               backlinks.backlink_mail_threads,
               backlinks.backlink_mail_raw_message_references,
               backlinks.backlink_mail_sync_cursors
    `);
  });

  afterAll(async () => {
    await tenantPool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP OWNED BY "${loginRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${loginRole}"`);
      await admin.end();
    }
    await harness?.stop();
  });

  const repository = (newId = () => id(nextId++)) =>
    new PostgresqlInitialMailSyncRepository({
      pool: tenantPool,
      newId,
    });

  it("advances each page only after deduplicated message references commit", async () => {
    const repo = repository();

    await expect(repo.loadOrCreateCheckpoint({
      ...context,
      startedAt,
    })).resolves.toEqual({
      state: "pending",
      startedAt,
      snapshotHistoryId: null,
      nextPageToken: null,
    });
    await expect(repo.persistPage({
      ...context,
      expectedPageToken: null,
      snapshotHistoryId: "700",
      nextPageToken: "initial-page-2",
      messages: [message("gmail-message-1", "gmail-thread-1")],
      persistedAt: new Date("2026-07-28T06:02:00.000Z"),
    })).resolves.toMatchObject({
      state: "advanced",
      insertedMessages: 1,
      checkpoint: {
        snapshotHistoryId: "700",
        nextPageToken: "initial-page-2",
      },
    });

    await expect(repo.persistPage({
      ...context,
      expectedPageToken: null,
      snapshotHistoryId: "700",
      nextPageToken: "initial-page-2",
      messages: [message("gmail-message-1", "gmail-thread-1")],
      persistedAt: new Date("2026-07-28T06:03:00.000Z"),
    })).resolves.toMatchObject({
      state: "stale",
      insertedMessages: 0,
      checkpoint: {
        nextPageToken: "initial-page-2",
      },
    });

    const completedAt = new Date("2026-07-28T06:04:00.000Z");
    await expect(repo.persistPage({
      ...context,
      expectedPageToken: "initial-page-2",
      snapshotHistoryId: "700",
      nextPageToken: null,
      messages: [
        message("gmail-message-1", "gmail-thread-1"),
        message("gmail-message-2", "gmail-thread-2"),
      ],
      persistedAt: completedAt,
    })).resolves.toEqual({
      state: "completed",
      insertedMessages: 1,
      checkpoint: {
        state: "completed",
        startedAt,
        snapshotHistoryId: "700",
        completedAt,
      },
    });

    const persisted = await admin.query(`
      SELECT
        (SELECT count(*)::integer
           FROM backlinks.backlink_mail_raw_message_references) AS messages,
        cursor.history_id AS "historyId",
        cursor.next_page_token AS "nextPageToken",
        cursor.initial_sync_completed_at AS "completedAt",
        cursor.version
      FROM backlinks.backlink_mail_sync_cursors AS cursor
    `);
    expect(persisted.rows).toEqual([{
      messages: 2,
      historyId: "700",
      nextPageToken: null,
      completedAt,
      version: 3,
    }]);
    await expect(repo.loadOrCreateCheckpoint({
      ...context,
      startedAt: new Date("2026-07-29T06:00:00.000Z"),
    })).resolves.toEqual({
      state: "completed",
      startedAt,
      snapshotHistoryId: "700",
      completedAt,
    });
  });

  it("rolls back inserted messages and leaves the prior cursor on page failure", async () => {
    const repo = repository(() => id(600));
    await repo.loadOrCreateCheckpoint({ ...context, startedAt });

    await expect(repo.persistPage({
      ...context,
      expectedPageToken: null,
      snapshotHistoryId: "701",
      nextPageToken: "initial-page-2",
      messages: [
        message("gmail-message-a", "gmail-thread-a", "701"),
        message("gmail-message-b", "gmail-thread-b", "701"),
      ],
      persistedAt: new Date("2026-07-28T06:02:00.000Z"),
    })).rejects.toMatchObject({ code: "23505" });

    const persisted = await admin.query(`
      SELECT
        (SELECT count(*)::integer
           FROM backlinks.backlink_mail_raw_message_references) AS messages,
        cursor.history_id AS "historyId",
        cursor.next_page_token AS "nextPageToken",
        cursor.version
      FROM backlinks.backlink_mail_sync_cursors AS cursor
    `);
    expect(persisted.rows).toEqual([{
      messages: 0,
      historyId: null,
      nextPageToken: null,
      version: 1,
    }]);
  });

  it("rechecks connection capability before resuming an existing cursor", async () => {
    const repo = repository();
    await repo.loadOrCreateCheckpoint({ ...context, startedAt });
    await admin.query(`
      UPDATE backlinks.backlink_gmail_connections
         SET connection_status = 'REAUTH_REQUIRED',
             send_availability = 'PAUSED',
             reauth_reason = 'TEST_REAUTH_REQUIRED',
             updated_at = statement_timestamp(),
             updated_by = 'test'
       WHERE id = '${context.gmailConnectionId}'
    `);

    try {
      await expect(repo.loadOrCreateCheckpoint({
        ...context,
        startedAt: new Date("2026-07-29T06:00:00.000Z"),
      })).rejects.toThrow(
        "Gmail connection is unavailable for Initial Mail Sync.",
      );
    } finally {
      await admin.query(`
        UPDATE backlinks.backlink_gmail_connections
           SET connection_status = 'CONNECTED',
               send_availability = 'AVAILABLE',
               reauth_reason = NULL,
               updated_at = statement_timestamp(),
               updated_by = 'test'
         WHERE id = '${context.gmailConnectionId}'
      `);
    }
  });
});
