import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";
import { createRecommendationHybridSupplyRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-hybrid-supply.repository.js";
import { withBacklinkTenantTransaction, type BacklinkTenantPool, type BacklinkTransactionClient } from "../../../src/modules/backlinks/db/tenant-transaction.js";

type Client = BacklinkTransactionClient & { connect(): Promise<void>; end(): Promise<void> };
const { Client: PgClient } = createRequire(import.meta.url)("pg") as {
  Client: new (config: { connectionString: string; connectionTimeoutMillis: number }) => Client;
};
const scope = {
  organizationId: "97000000-0000-4000-8000-000000000001",
  workspaceId: "97000000-0000-4000-8000-000000000002",
  websiteProjectId: "97000000-0000-4000-8000-000000000003",
};
const other = { ...scope, websiteProjectId: "97000000-0000-4000-8000-000000000004" };
const value = {
  target: "aiper.com", value: 0, observedAt: "2026-09-10T06:00:00.000Z",
  expiresAt: "2026-10-10T06:00:00.000Z", failureCode: null,
};
let harness: BacklinksPostgresHarness | undefined;
let admin: Client | undefined;
let writer: Client | undefined;
let pool: BacklinkTenantPool;

beforeAll(async () => {
  // Never use an externally configured admin URL for this isolated migration test.
  if (process.env.BACKLINKS_TEST_POSTGRES_ADMIN_URL) throw new Error("This test requires an isolated container");
  harness = await startBacklinksPostgresHarness();
  const connection = new URL(harness.connectionString);
  if (connection.hostname === "localhost") connection.hostname = "127.0.0.1";
  admin = new PgClient({ connectionString: connection.toString(), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  await admin.query(await readFile(new URL("../../../../database/roles/0001_growthos_schema_roles.sql", import.meta.url), "utf8"));
  await admin.query(await readFile(new URL("../../../src/modules/backlinks/db/migrations/0099_backlink_project_domain_rating.sql", import.meta.url), "utf8"));
  writer = new PgClient({ connectionString: connection.toString(), connectionTimeoutMillis: 10_000 });
  await writer.connect();
  await writer.query("SET ROLE growthos_backlinks_writer");
  const writerClient = writer;
  pool = { connect: async () => ({ query: (sql, parameters) => writerClient.query(sql, parameters), release: () => undefined }) };
}, 120_000);

afterAll(async () => {
  await writer?.end();
  await admin?.end();
  await harness?.stop();
}, 30_000);

describe("project DR cache migration and real repository", () => {
  it("round trips zero and upserts independently for each project", async () => {
    await withBacklinkTenantTransaction(pool, scope, async (client) => {
      const repository = createRecommendationHybridSupplyRepository(client);
      await repository.saveRating(scope, value);
      expect(await repository.readRating(scope, value.target)).toEqual(value);
    });
    await withBacklinkTenantTransaction(pool, other, async (client) => {
      const repository = createRecommendationHybridSupplyRepository(client);
      expect(await repository.readRating(other, value.target)).toBeNull();
      await repository.saveRating(other, { ...value, value: 61 });
      expect((await repository.readRating(other, value.target))?.value).toBe(61);
      expect(await repository.readRating(scope, value.target)).toBeNull();
    });
  });
  it("enforces RLS even when a caller passes another project's scope", async () => {
    await expect(withBacklinkTenantTransaction(pool, other, (client) =>
      createRecommendationHybridSupplyRepository(client).saveRating(scope, value)))
      .rejects.toThrow(/row-level security/u);
  });
  it("stores sanitized failure state as null, not DR zero", async () => {
    await withBacklinkTenantTransaction(pool, scope, async (client) => {
      const repository = createRecommendationHybridSupplyRepository(client);
      await repository.saveRating(scope, { ...value, value: null, failureCode: "AHREFS_HTTP_401" });
      expect(await repository.readRating(scope, value.target)).toMatchObject({
        value: null, failureCode: "AHREFS_HTTP_401",
      });
    });
  });
  it.each([
    { ...value, value: -1 }, { ...value, value: 101 },
    { ...value, value: null }, { ...value, expiresAt: value.observedAt },
  ])("rejects invalid cache facts %#", async (invalid) => {
    await expect(withBacklinkTenantTransaction(pool, scope, (client) =>
      createRecommendationHybridSupplyRepository(client).saveRating(scope, invalid)))
      .rejects.toThrow(/check constraint/u);
  });
  it("forces RLS and denies deletion to the application writer", async () => {
    if (admin === undefined) throw new Error("Postgres fixture is not initialized");
    const flags = await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='backlinks.backlink_project_domain_ratings'::regclass");
    expect(flags.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    await expect(withBacklinkTenantTransaction(pool, scope, (client) =>
      client.query("DELETE FROM backlinks.backlink_project_domain_ratings"))).rejects.toThrow(/permission denied/u);
  });
});
