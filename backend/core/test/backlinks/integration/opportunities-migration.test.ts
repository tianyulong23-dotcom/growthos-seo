import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlinkLifecycleEvents } from "../../../src/modules/backlinks/db/schema/jobs.js";
import {
  backlinkOpportunities, backlinkOpportunityCooperationTypes, backlinkOpportunityCycles,
} from "../../../src/modules/backlinks/db/schema/opportunities.js";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";
type Client = { connect(): Promise<void>; end(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }> };
type PgError = Error & { readonly code?: string };
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as
  { readonly Client: new (config: unknown) => Client };
const migration = (name: string) => new URL(
  `../../../src/modules/backlinks/db/migrations/${name}`, import.meta.url);
const roles = new URL("../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url);
const id = (value: number) => `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1), workspace = id(2);
const projectA = id(3), projectB = id(4), context = id(5);
const identity = (project = projectA) => `'${organization}', '${workspace}', '${project}'`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};
const opportunitySql = (opportunityId: string, site: string, sequence: number) => `
  INSERT INTO backlink_opportunities (
    id, organization_id, workspace_id, website_project_id, recommendation_id,
    prospect_id, recommendation_context_version_id, target_site_key,
    target_host_ascii, target_identity_rule_version, join_sequence, created_by, updated_by
  ) VALUES (
    '${opportunityId}', ${identity()}, '${id(201)}', '${id(101)}', '${context}',
    '${site}', 'www.${site}', 'tldts-7.4.9-v1', ${sequence}, 'test', 'test'
  )`;
const cycleSql = (cycleId: string, project: string, number: number) => `
  INSERT INTO backlink_opportunity_cycles (
    id, organization_id, workspace_id, website_project_id, opportunity_id,
    cycle_number, started_at, created_by, updated_by
  ) VALUES ('${cycleId}', ${identity(project)}, '${id(301)}', ${number}, now(),
    'test', 'test')`;
const cooperationSql = (recordId: string, method: string) => `
  INSERT INTO backlink_opportunity_cooperation_types (
    id, organization_id, workspace_id, website_project_id, opportunity_id,
    method_key, registry_version, created_by
  ) VALUES ('${recordId}', ${identity()}, '${id(301)}', '${method}', 'v1', 'test')`;
describe("BL-AI-074 opportunity persistence migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of [
      "0002_backlink_provider_seo.sql", "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql"]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(await readFile(roles, "utf8"));
    for (const name of [
      "0005_backlink_schema_role_ownership.sql", "0006_backlink_opportunities.sql"]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`
      INSERT INTO backlink_prospects (
        id, organization_id, workspace_id, website_project_id,
        recommendation_context_version_id, hostname_ascii, registrable_domain,
        normalization_version, created_by, updated_by
      ) VALUES ('${id(101)}', ${identity()}, '${context}', 'www.example.com',
        'example.com', 'tldts-7.4.9-v1', 'test', 'test'
      );
      INSERT INTO backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES ('${id(201)}', ${identity()}, '${id(101)}', '${context}',
        'accepted', 'test', 'test'
      );
    `);
  }, 120_000);
  afterAll(async () => { await client?.end(); await harness?.stop(); });
  it("declares Opportunity, Cycle, Cooperation, and shared Lifecycle tables", () => {
    const configs = [
      backlinkOpportunities, backlinkOpportunityCycles,
      backlinkOpportunityCooperationTypes, backlinkLifecycleEvents,
    ].map(getTableConfig);
    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_opportunities", "backlink_opportunity_cycles",
      "backlink_opportunity_cooperation_types", "backlink_lifecycle_events",
    ]);
    expect(configs.slice(0, 3).flatMap(({ foreignKeys }) =>
      foreignKeys.map((key) => key.getName()))).toEqual([
      "backlink_opportunity_recommendation_fk",
      "backlink_opportunity_cycle_parent_fk",
      "backlink_opportunity_cooperation_parent_fk",
    ]);
  });
  it("separates four axes and enforces tenant-safe identity constraints", async () => {
    await client.query(opportunitySql(id(301), "example.com", 1));
    expect((await client.query(`
      SELECT business_stage, management_status, outcome_status,
        fulfillment_status FROM backlink_opportunities WHERE id = '${id(301)}'
    `)).rows[0]).toEqual({
      business_stage: "JOINED", management_status: "ACTIVE",
      outcome_status: "OPEN", fulfillment_status: "NOT_EXPECTED",
    });
    await expectCode(
      client.query(opportunitySql(id(302), "example.com", 2)), "23505");
    await expectCode(
      client.query(opportunitySql(id(303), "other.example", 1)), "23505");
    await client.query(cycleSql(id(401), projectA, 1));
    await client.query(cooperationSql(id(501), "guest_post"));
    await expectCode(client.query(cycleSql(id(402), projectA, 1)), "23505");
    await expectCode(client.query(cycleSql(id(403), projectB, 2)), "23503");
    await expectCode(client.query(cooperationSql(id(502), "custom")), "23514");
    const secure = await client.query(`
      SELECT count(DISTINCT c.relname)::int AS tables,
        bool_and(c.relrowsecurity AND c.relforcerowsecurity) AS secure,
        bool_and(pg_get_userbyid(c.relowner) = 'growthos_backlinks_owner')
          AS owned,
        bool_and(has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'SELECT,INSERT,UPDATE,DELETE'
        )) AS writer_access,
        count(p.policyname)::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p
        ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'backlinks' AND c.relname IN (
        'backlink_opportunities', 'backlink_opportunity_cycles',
        'backlink_opportunity_cooperation_types', 'backlink_lifecycle_events'
      )
    `);
    expect(secure.rows[0]).toEqual({
      tables: 4, secure: true, owned: true, writer_access: true, policies: 4,
    });
  });
});
