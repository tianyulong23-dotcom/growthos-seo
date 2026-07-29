import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresqlDeliveryFeedbackRepository,
} from "../../../src/modules/backlinks/application/services/delivery-feedback.repository.js";
import {
  deliveryFeedbackKinds,
  suppressionReleaseActorRoles,
} from "../../../src/modules/backlinks/domain/sending/delivery-feedback.js";
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
};
const target = (fill: string) => ({
  targetType: "EMAIL" as const,
  targetHmac: fill.repeat(64),
  hashKeyVersion: 1,
});

describe("BL-AI-120 PostgreSQL delivery feedback repository", () => {
  const loginRole = `bl_ai_120_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  let nextId = 100;
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;

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
      "0022_backlink_draft_documents.sql",
      "0023_backlink_send_quota_connection_scope.sql",
      "0024_backlink_send_attempt_settlement.sql",
      "0025_backlink_send_reconciliation.sql",
      "0026_backlink_suppression_feedback.sql",
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    await admin.query(`
      CREATE ROLE "${loginRole}"
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${loginRole}";
    `);
    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = loginRole;
    tenantUrl.password = password;
    tenantPool = new PgPool({ connectionString: tenantUrl.toString(), max: 4 });
  }, 120_000);

  beforeEach(async () => {
    nextId = 100;
    await admin.query(`
      TRUNCATE backlinks.backlink_suppression_feedback_events,
               backlinks.backlink_suppression_entries
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

  const repository = () => new PostgresqlDeliveryFeedbackRepository({
    pool: tenantPool,
    newId: () => id(nextId++),
  });
  const input = (
    feedbackId: string,
    kind: (typeof deliveryFeedbackKinds)[keyof typeof deliveryFeedbackKinds],
    hmac = target("a"),
    observedAt = new Date("2026-07-28T08:00:00.000Z"),
  ) => ({
    ...context,
    target: hmac,
    feedbackId,
    kind,
    observedAt,
    recordedAt: new Date(observedAt.getTime() + 60_000),
    actorId: "worker-120",
  });

  it("persists a HMAC-only hard bounce exactly once and suppresses immediately", async () => {
    const repo = repository();
    const firstInput = input(
      "gmail-event-hard-120",
      deliveryFeedbackKinds.hardBounce,
    );

    await expect(repo.record(firstInput)).resolves.toEqual({
      feedbackId: id(100),
      action: "SUPPRESS",
      suppressionReason: "HARD_BOUNCE",
    });
    await expect(repo.record(firstInput)).resolves.toEqual({
      feedbackId: id(100),
      action: "SUPPRESS",
      suppressionReason: "HARD_BOUNCE",
    });

    const persisted = await admin.query(`
      SELECT
        (SELECT count(*)::integer
           FROM backlinks.backlink_suppression_feedback_events) AS feedbacks,
        (SELECT reason
           FROM backlinks.backlink_suppression_entries) AS "suppressionReason",
        (SELECT to_jsonb(feedback)::text
           FROM backlinks.backlink_suppression_feedback_events AS feedback)
          AS payload
    `);
    expect(persisted.rows).toEqual([{
      feedbacks: 1,
      suppressionReason: "HARD_BOUNCE",
      payload: expect.stringContaining(firstInput.target.targetHmac),
    }]);
    expect(JSON.stringify(persisted.rows)).not.toContain("person@example.test");
  });

  it("thresholds soft bounces and protects unsubscribe release from ordinary users", async () => {
    const repo = repository();
    const softTarget = target("b");
    await expect(repo.record(input(
      "gmail-event-soft-1",
      deliveryFeedbackKinds.softBounce,
      softTarget,
      new Date("2026-07-26T08:00:00.000Z"),
    ))).resolves.toMatchObject({
      action: "RECORD_ONLY",
      suppressionReason: null,
    });
    await expect(repo.record(input(
      "gmail-event-soft-2",
      deliveryFeedbackKinds.softBounce,
      softTarget,
      new Date("2026-07-27T08:00:00.000Z"),
    ))).resolves.toMatchObject({
      action: "RECORD_ONLY",
      suppressionReason: null,
    });
    await expect(repo.record(input(
      "gmail-event-soft-3",
      deliveryFeedbackKinds.softBounce,
      softTarget,
      new Date("2026-07-28T08:00:00.000Z"),
    ))).resolves.toMatchObject({
      action: "SUPPRESS",
      suppressionReason: "SOFT_BOUNCE_THRESHOLD",
    });

    await repo.record(input(
      "gmail-event-unsubscribe",
      deliveryFeedbackKinds.unsubscribe,
      target("c"),
    ));
    const unsubscribe = await admin.query(`
      SELECT id
        FROM backlinks.backlink_suppression_entries
       WHERE reason = 'UNSUBSCRIBE'
    `);
    const suppressionId = unsubscribe.rows[0]?.id;
    if (typeof suppressionId !== "string") {
      throw new Error("Expected an unsubscribe suppression.");
    }

    const releaseInput = {
      ...context,
      suppressionId,
      suppressionReason: "UNSUBSCRIBE" as const,
      releaseReason: "verified consent repair",
      releasedAt: new Date("2026-07-28T09:00:00.000Z"),
      actorId: "user-120",
    };
    await expect(repo.release({
      ...releaseInput,
      actorRole: suppressionReleaseActorRoles.ordinaryUser,
    })).rejects.toMatchObject({
      code: "SUPPRESSION_UNSUBSCRIBE_RELEASE_FORBIDDEN",
    });
    await expect(repo.release({
      ...releaseInput,
      actorRole: suppressionReleaseActorRoles.complianceAdministrator,
      actorId: "compliance-120",
    })).resolves.toEqual({
      suppressionId,
      reason: "UNSUBSCRIBE",
      status: "RELEASED",
      version: 2,
    });

    await expect(admin.query(`
      UPDATE backlinks.backlink_suppression_feedback_events
         SET source_event_id = 'mutated'
       WHERE source_event_id = 'gmail-event-soft-1'
    `)).rejects.toMatchObject({ code: "55000" });
  });
});
