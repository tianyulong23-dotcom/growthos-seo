import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresqlEmailSuppressionRepository,
  suppressionScopeTypes,
} from "../../../src/modules/backlinks/application/services/send-suppression.repository.js";
import type {
  BacklinkTenantPool,
  BacklinkTenantPoolClient,
  BacklinkTransactionQueryResult,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import {
  createEmailSuppressionTarget,
  createEmailSuppressionTargets,
} from "../../../src/modules/backlinks/domain/sending/suppression.js";
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
const organizationId = id(1);
const otherOrganizationId = id(2);
const workspaceId = id(3);
const websiteProjectId = id(4);
const otherWebsiteProjectId = id(5);
const context = { organizationId, workspaceId, websiteProjectId };
const currentKey = { version: 2, secret: Buffer.alloc(32, 0x22) };
const legacyKey = { version: 1, secret: Buffer.alloc(32, 0x11) };

describe("BL-AI-108 PostgreSQL email suppression repository", () => {
  const loginRole = `bl_ai_108_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  const queryValues: unknown[][] = [];
  let nextId = 100;
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;
  let auditedPool: BacklinkTenantPool;

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
    tenantPool = new PgPool({
      connectionString: tenantUrl.toString(),
      max: 4,
    });
    auditedPool = {
      async connect(): Promise<BacklinkTenantPoolClient> {
        const client = await tenantPool.connect();
        return {
          async query(text, values) {
            if (values !== undefined) {
              queryValues.push([...values]);
            }
            return client.query(text, values);
          },
          release() {
            client.release();
          },
        };
      },
    };
  }, 120_000);

  beforeEach(async () => {
    queryValues.length = 0;
    nextId = 100;
    await admin.query(
      "TRUNCATE backlinks.backlink_suppression_entries",
    );
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

  const repository = () =>
    new PostgresqlEmailSuppressionRepository({
      pool: auditedPool,
      newId: () => id(nextId++),
    });

  it("stores one idempotent project suppression without plaintext SQL or DB values", async () => {
    const plaintext = " Person+Sales@Example.TEST ";
    const target = createEmailSuppressionTarget(plaintext, currentKey);
    const repo = repository();
    const input = {
      ...context,
      scopeType: suppressionScopeTypes.websiteProject,
      target,
      reason: "REJECTION" as const,
      actorId: "user-bl-ai-108",
      recordedAt: new Date("2026-07-27T10:00:00.000Z"),
    };

    const first = await repo.addEmail(input);
    const replay = await repo.addEmail(input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      suppressionId: id(100),
      scopeType: "WEBSITE_PROJECT",
      reason: "REJECTION",
      createdAt: "2026-07-27T10:00:00.000Z",
      version: 1,
    });
    const persisted = await admin.query(
      `SELECT to_jsonb(suppression)::text AS payload
         FROM backlinks.backlink_suppression_entries AS suppression`,
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.payload).toContain(target.targetHmac);
    expect(JSON.stringify(persisted.rows)).not.toContain(
      "person+sales@example.test",
    );
    expect(JSON.stringify(queryValues)).not.toContain(
      "person+sales@example.test",
    );
  });

  it("checks current and legacy HMACs with organization and project isolation", async () => {
    const repo = repository();
    const legacyTargets = createEmailSuppressionTargets(
      "legacy@example.test",
      [currentKey, legacyKey],
    );
    const organizationTarget = createEmailSuppressionTarget(
      "global@example.test",
      currentKey,
    );
    const legacyTarget = legacyTargets[1];
    if (legacyTarget === undefined) {
      throw new Error("Legacy suppression target was not generated.");
    }

    const projectSuppression = await repo.addEmail({
      ...context,
      scopeType: suppressionScopeTypes.websiteProject,
      target: legacyTarget,
      reason: "MANUAL",
      actorId: "user-bl-ai-108",
      recordedAt: new Date("2026-07-27T10:01:00.000Z"),
    });
    const organizationSuppression = await repo.addEmail({
      ...context,
      scopeType: suppressionScopeTypes.organization,
      target: organizationTarget,
      reason: "COMPLAINT",
      actorId: "user-bl-ai-108",
      recordedAt: new Date("2026-07-27T10:02:00.000Z"),
    });

    await expect(repo.findActiveEmail({
      ...context,
      targets: legacyTargets,
    })).resolves.toEqual(projectSuppression);
    await expect(repo.findActiveEmail({
      ...context,
      websiteProjectId: otherWebsiteProjectId,
      targets: legacyTargets,
    })).resolves.toBeNull();
    await expect(repo.findActiveEmail({
      ...context,
      websiteProjectId: otherWebsiteProjectId,
      targets: [organizationTarget],
    })).resolves.toEqual(organizationSuppression);
    await expect(repo.findActiveEmail({
      organizationId: otherOrganizationId,
      workspaceId,
      websiteProjectId,
      targets: [organizationTarget],
    })).resolves.toBeNull();
  });
});
