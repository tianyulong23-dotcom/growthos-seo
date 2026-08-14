import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresqlIncrementalMailSyncRepository,
  type PersistedIncrementalMailMessage,
} from "../../../src/modules/backlinks/application/services/mail-incremental-sync.repository.js";
import {
  PostgresqlMailHistoryRepairRepository,
} from "../../../src/modules/backlinks/application/services/mail-history-repair.repository.js";
import {
  PostgresqlInitialMailSyncRepository,
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
  actorId: "worker-129",
};
const startedAt = new Date("2026-07-28T06:00:00.000Z");
const initialCompletedAt = new Date("2026-07-28T06:05:00.000Z");
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
  historyId: string,
): PersistedIncrementalMailMessage => ({
  providerMessageId,
  providerThreadId,
  historyId,
  receivedAt: new Date("2026-07-28T06:30:00.000Z"),
  rawObjectKey: `mail/raw/${providerMessageId}`,
  rawContentSha256: "b".repeat(64),
  rawSizeBytes: 48,
  fetchedAt: new Date("2026-07-28T07:00:00.000Z"),
  retentionExpiresAt: new Date("2026-08-27T07:00:00.000Z"),
});

describe("BL-AI-129 PostgreSQL Incremental Mail Sync Repository", () => {
  const loginRole = `bl_ai_129_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;
  let nextId = 700;

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
        'GMAIL_TOKEN_SET', 'projects/test/secrets/mail-sync-129', '1',
        'test', 'test'
      );
      INSERT INTO backlinks.backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES (
        '${context.gmailConnectionId}', '${context.organizationId}', 'user-129',
        'mail-sync-129', 'sender129@example.test', '${readSyncScopes}'::jsonb,
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
    await admin.query(
      await readFile(
        migration("0047_backlink_gmail_organization_reuse.sql"),
        "utf8",
      ),
    );
    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = loginRole;
    tenantUrl.password = password;
    tenantPool = new PgPool({ connectionString: tenantUrl.toString(), max: 4 });
  }, 120_000);

  beforeEach(async () => {
    nextId = 700;
    await admin.query(`
      TRUNCATE backlinks.backlink_audit_events,
               backlinks.backlink_reply_match_candidates,
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

  const completeInitialSync = async (historyId = "700") => {
    const initialRepository = new PostgresqlInitialMailSyncRepository({
      pool: tenantPool,
      newId: () => id(600),
    });
    await initialRepository.loadOrCreateCheckpoint({ ...context, startedAt });
    await initialRepository.persistPage({
      ...context,
      expectedPageToken: null,
      snapshotHistoryId: historyId,
      nextPageToken: null,
      messages: [],
      persistedAt: initialCompletedAt,
    });
  };
  const repository = (newId = () => id(nextId++)) =>
    new PostgresqlIncrementalMailSyncRepository({
      pool: tenantPool,
      newId,
    });
  const repairRepository = (newId = () => id(nextId++)) =>
    new PostgresqlMailHistoryRepairRepository({
      pool: tenantPool,
      newId,
    });

  it("persists page messages before advancing the incremental cursor", async () => {
    await completeInitialSync();
    const repo = repository();

    await expect(repo.loadCheckpoint(context)).resolves.toEqual({
      historyId: "700",
      nextPageToken: null,
      initialSyncCompletedAt: initialCompletedAt,
      lastSyncedAt: initialCompletedAt,
    });
    await expect(repo.persistPage({
      ...context,
      expectedHistoryId: "700",
      expectedPageToken: null,
      latestHistoryId: "710",
      nextPageToken: "history-page-2",
      messages: [message("gmail-message-1", "gmail-thread-1", "705")],
      persistedAt: new Date("2026-07-28T07:00:00.000Z"),
    })).resolves.toMatchObject({
      state: "advanced",
      insertedMessages: 1,
      checkpoint: {
        historyId: "700",
        nextPageToken: "history-page-2",
      },
    });
    await expect(repo.persistPage({
      ...context,
      expectedHistoryId: "700",
      expectedPageToken: "history-page-2",
      latestHistoryId: "715",
      nextPageToken: null,
      messages: [message("gmail-message-2", "gmail-thread-2", "712")],
      persistedAt: new Date("2026-07-28T07:01:00.000Z"),
    })).resolves.toMatchObject({
      state: "completed",
      insertedMessages: 1,
      checkpoint: {
        historyId: "715",
        nextPageToken: null,
      },
    });

    const persisted = await admin.query(`
      SELECT
        (SELECT count(*)::integer
           FROM backlinks.backlink_mail_raw_message_references) AS messages,
        cursor.history_id AS "historyId",
        cursor.next_page_token AS "nextPageToken",
        cursor.last_synced_at AS "lastSyncedAt",
        cursor.version
      FROM backlinks.backlink_mail_sync_cursors AS cursor
    `);
    expect(persisted.rows).toEqual([{
      messages: 2,
      historyId: "715",
      nextPageToken: null,
      lastSyncedAt: new Date("2026-07-28T07:01:00.000Z"),
      version: 4,
    }]);
  });

  it("rolls back inserted messages and preserves the original cursor", async () => {
    await completeInitialSync();
    const repo = repository(() => id(700));

    await expect(repo.persistPage({
      ...context,
      expectedHistoryId: "700",
      expectedPageToken: null,
      latestHistoryId: "710",
      nextPageToken: "history-page-2",
      messages: [
        message("gmail-message-a", "gmail-thread-a", "705"),
        message("gmail-message-b", "gmail-thread-b", "706"),
      ],
      persistedAt: new Date("2026-07-28T07:00:00.000Z"),
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
      historyId: "700",
      nextPageToken: null,
      version: 2,
    }]);
  });

  it("rechecks connection capability before reading the cursor", async () => {
    await completeInitialSync();
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
      await expect(repository().loadCheckpoint(context)).rejects.toThrow(
        "Gmail connection is unavailable for Incremental Mail Sync.",
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

  it("commits a bounded History repair with its audit event", async () => {
    await completeInitialSync();
    const repairedAt = new Date("2026-07-28T08:00:00.000Z");

    await expect(repairRepository().commitRepair({
      ...context,
      expectedHistoryId: "700",
      expectedPageToken: null,
      repairedHistoryId: "800",
      messages: [
        message("gmail-repair-1", "gmail-repair-thread-1", "790"),
        message("gmail-repair-2", "gmail-repair-thread-2", "800"),
      ],
      repairWindowStartedAt: new Date("2026-07-21T08:00:00.000Z"),
      repairWindowEndedAt: repairedAt,
      pagesScanned: 2,
      messagesScanned: 2,
      repairedAt,
    })).resolves.toMatchObject({
      state: "completed",
      insertedMessages: 2,
      checkpoint: {
        historyId: "800",
        nextPageToken: null,
        lastSyncedAt: repairedAt,
      },
    });

    const persisted = await admin.query(`
      SELECT
        (SELECT count(*)::integer
           FROM backlinks.backlink_mail_raw_message_references) AS messages,
        (SELECT count(*)::integer
           FROM backlinks.backlink_audit_events
          WHERE action = 'gmail.history.repair.completed') AS audits,
        cursor.history_id AS "historyId",
        cursor.next_page_token AS "nextPageToken"
      FROM backlinks.backlink_mail_sync_cursors AS cursor
    `);
    expect(persisted.rows).toEqual([{
      messages: 2,
      audits: 1,
      historyId: "800",
      nextPageToken: null,
    }]);

    const audit = await admin.query(`
      SELECT actor_kind AS "actorKind", action, target_type AS "targetType",
             target_id AS "targetId", outcome, reason,
             before_redacted AS "beforeRedacted",
             after_redacted AS "afterRedacted"
        FROM backlinks.backlink_audit_events
       WHERE action = 'gmail.history.repair.completed'
    `);
    expect(audit.rows).toEqual([{
      actorKind: "system",
      action: "gmail.history.repair.completed",
      targetType: "gmail_connection",
      targetId: context.gmailConnectionId,
      outcome: "success",
      reason: "history_expired",
      beforeRedacted: {
        historyId: "700",
        pageTokenPresent: false,
      },
      afterRedacted: {
        historyId: "800",
        lookbackDays: 7,
        pagesScanned: 2,
        messagesScanned: 2,
        messagesInserted: 2,
      },
    }]);
  });

  it("does not write repair messages or audit when the cursor is stale", async () => {
    await completeInitialSync("701");

    await expect(repairRepository().commitRepair({
      ...context,
      expectedHistoryId: "700",
      expectedPageToken: null,
      repairedHistoryId: "800",
      messages: [message("gmail-repair-stale", "gmail-thread-stale", "800")],
      repairWindowStartedAt: new Date("2026-07-21T08:00:00.000Z"),
      repairWindowEndedAt: new Date("2026-07-28T08:00:00.000Z"),
      pagesScanned: 1,
      messagesScanned: 1,
      repairedAt: new Date("2026-07-28T08:00:00.000Z"),
    })).resolves.toMatchObject({
      state: "stale",
      insertedMessages: 0,
      checkpoint: { historyId: "701" },
    });

    const persisted = await admin.query(`
      SELECT
        (SELECT count(*)::integer
           FROM backlinks.backlink_mail_raw_message_references) AS messages,
        (SELECT count(*)::integer
           FROM backlinks.backlink_audit_events
          WHERE action = 'gmail.history.repair.completed') AS audits
    `);
    expect(persisted.rows).toEqual([{ messages: 0, audits: 0 }]);
  });
});
