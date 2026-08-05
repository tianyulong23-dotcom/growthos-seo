import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlinkProviderCacheEntries,
  backlinkProviderRequests,
  backlinkSeoSnapshots,
} from "../../../src/modules/backlinks/db/schema/provider-seo.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
};
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migrationPath = new URL(
  "../../../src/modules/backlinks/db/migrations/0002_backlink_provider_seo.sql",
  import.meta.url,
);
const tenant = { organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  projectId: "018f0000-0000-7000-8000-000000000003" };
const otherProjectId = "018f0000-0000-7000-8000-000000000004";
const identity = (projectId: string) =>
  `'${tenant.organizationId}', '${tenant.workspaceId}', '${projectId}'`;
const insertRequest = (
  client: Client, id: string, projectId: string, hashCharacter: string,
) => client.query(`
  INSERT INTO backlink_provider_requests (
    id, organization_id, workspace_id, website_project_id, provider, endpoint,
    request_fingerprint, active_request_bucket, request_schema_version,
    request_payload, created_by
  ) VALUES (
    '${id}', ${identity(projectId)}, 'dataforseo', 'backlinks.summary',
    '${hashCharacter.repeat(64)}', '2026-07-22T00', 1, '{}', 'test'
  )
`);
const insertSnapshot = (
  client: Client, id: string, projectId: string, requestId: string,
  hashCharacter: string,
) => client.query(`
  INSERT INTO backlink_seo_snapshots (
    id, organization_id, workspace_id, website_project_id, provider_request_id,
    provider, target, target_type, snapshot_type, normalized_payload,
    payload_hash, observed_at, schema_version, created_by
  ) VALUES (
    '${id}', ${identity(projectId)}, '${requestId}', 'dataforseo', 'example.com',
    'domain', 'backlink_profile', '{}', '${hashCharacter.repeat(64)}',
    now(), 1, 'test'
  )
`);
describe("BL-AI-044 provider SEO schema", () => {
  it("declares fingerprint uniqueness and tenant-safe relationships", () => {
    const [request, cache, snapshot] = [
      backlinkProviderRequests, backlinkProviderCacheEntries, backlinkSeoSnapshots,
    ].map(getTableConfig);
    expect([request.name, cache.name, snapshot.name]).toEqual([
      "backlink_provider_requests",
      "backlink_provider_cache_entries",
      "backlink_seo_snapshots",
    ]);
    expect(request.indexes.map(({ config }) => config.name)).toContain(
      "backlink_provider_request_fingerprint_bucket_uq",
    );
    expect(snapshot.foreignKeys.map((key) => key.getName())).toContain(
      "backlink_seo_snapshot_provider_request_fk",
    );
    expect(cache.foreignKeys.map((key) => key.getName())).toContain(
      "backlink_provider_cache_snapshot_fk",
    );
  });
});
describe("BL-AI-044 provider SEO migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(migrationPath, "utf8"));
  }, 120_000);
  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });
  it("enforces fingerprint uniqueness, immutable snapshots, and tenant RLS", async () => {
    const ids = {
      request: "018f0000-0000-7000-8000-000000000101",
      snapshot: "018f0000-0000-7000-8000-000000000102",
    };
    await insertRequest(client, ids.request, tenant.projectId, "a");
    await insertSnapshot(
      client, ids.snapshot, tenant.projectId, ids.request, "b",
    );
    const duplicate = await insertRequest(
      client, "018f0000-0000-7000-8000-000000000103", tenant.projectId, "a",
    ).catch((error: unknown) => error as Error & { code?: string });
    expect(duplicate).toMatchObject({ code: "23505" });

    const otherRequestId = "018f0000-0000-7000-8000-000000000104";
    await insertRequest(client, otherRequestId, otherProjectId, "c");
    const crossTenant = await insertSnapshot(
      client, "018f0000-0000-7000-8000-000000000105",
      tenant.projectId, otherRequestId, "d",
    ).catch((error: unknown) => error as Error & { code?: string });
    expect(crossTenant).toMatchObject({ code: "23503" });

    for (const statement of [
      `UPDATE backlink_seo_snapshots SET target = 'changed.test' WHERE id = '${ids.snapshot}'`,
      `DELETE FROM backlink_seo_snapshots WHERE id = '${ids.snapshot}'`,
    ]) {
      const error = await client.query(statement)
        .catch((caught: unknown) => caught as Error & { code?: string });
      expect(error).toMatchObject({ code: "P0001" });
    }

    const rls = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             count(p.policyname)::int AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policies p
          ON p.schemaname = n.nspname AND p.tablename = c.relname
       WHERE n.nspname = current_schema()
         AND c.relname IN (
           'backlink_provider_requests',
           'backlink_provider_cache_entries',
           'backlink_seo_snapshots'
         )
       GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
    `);
    expect(rls.rows).toHaveLength(3);
    expect(rls.rows.every((row) =>
      row.relrowsecurity === true &&
      row.relforcerowsecurity === true &&
      row.policies === 1,
    )).toBe(true);
  });
});
