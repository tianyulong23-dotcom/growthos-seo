import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backlinkContactCandidates, backlinkContactEvidence, backlinkContacts } from "../../../src/modules/backlinks/db/schema/contacts.js";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";

type Client = { connect(): Promise<void>; end(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }> };
type PgError = Error & { readonly code?: string };
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as
  { readonly Client: new (config: unknown) => Client };
const migration = (name: string) => new URL(`../../../src/modules/backlinks/db/migrations/${name}`, import.meta.url);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1), workspace = id(2);
const projectA = id(3), projectB = id(4), context = id(5);
const identity = (project: string) => `'${organization}', '${workspace}', '${project}'`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};
const evidenceInsert = (evidenceId: string, project: string, confidence: number,
  expiry: string) => `
  INSERT INTO backlink_contact_evidence (
    id, organization_id, workspace_id, website_project_id, candidate_id,
    source_url, observed_at, extraction_method, evidence_snippet, parser_version,
    content_sha256, confidence, expires_at, created_by
  ) VALUES (
    '${evidenceId}', ${identity(project)}, '${id(201)}',
    'https://example.com/contact', now(), 'visible_text', 'Email our editor',
    'cheerio@1.1.2', '${"a".repeat(64)}', ${confidence}, ${expiry}, 'test'
  )`;

describe("BL-AI-071 contact persistence migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of ["0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql"]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(`
      INSERT INTO backlink_prospects (
        id, organization_id, workspace_id, website_project_id, recommendation_context_version_id,
        hostname_ascii, registrable_domain, normalization_version, created_by, updated_by
      ) VALUES
        ('${id(101)}', ${identity(projectA)}, '${context}', 'example.com', 'example.com',
          'tldts-7.4.9-v1', 'test', 'test'),
        ('${id(102)}', ${identity(projectB)}, '${context}', 'other.test', 'other.test',
          'tldts-7.4.9-v1', 'test', 'test');
      INSERT INTO backlink_contact_candidates (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, normalized_email, email_domain_ascii,
        domain_relation, syntax_validator_version,
        confidence, created_by, updated_by
      ) VALUES (
        '${id(201)}', ${identity(projectA)}, '${id(101)}', '${context}',
        'editor@example.com', 'example.com', 'same_registrable_domain',
        'validator@13.15.35', 82, 'test', 'test'
      );
    `);
  }, 120_000);
  afterAll(async () => { await client?.end(); await harness?.stop(); });

  it("declares the three tenant-safe relationships", () => {
    const configs = [backlinkContactCandidates, backlinkContactEvidence, backlinkContacts].map(getTableConfig);
    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_contact_candidates", "backlink_contact_evidence",
      "backlink_contacts",
    ]);
    expect(configs.flatMap(({ foreignKeys }) =>
      foreignKeys.map((key) => key.getName()))).toEqual([
      "backlink_contact_candidate_prospect_fk",
      "backlink_contact_evidence_candidate_fk",
      "backlink_contact_source_candidate_fk",
    ]);
  });

  it("requires complete evidence and tenant-safe promotion", async () => {
    await client.query(`${evidenceInsert(id(301), projectA, 90,
      "'2027-07-23T01:00:00Z'")};
      INSERT INTO backlink_contacts (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, source_candidate_id, normalized_email,
        contact_role, confidence, confirmed_at, confirmed_by, created_by, updated_by
      ) VALUES (
        '${id(401)}', ${identity(projectA)}, '${id(101)}', '${context}', '${id(201)}',
        'editor@example.com', 'editorial', 90, '2026-07-23T02:00:00Z', 'user-1',
        'test', 'test'
      );
    `);
    expect((await client.query(`
      SELECT source_url, extraction_method, evidence_snippet, parser_version,
        confidence FROM backlink_contact_evidence WHERE id = '${id(301)}'
    `)).rows[0]).toMatchObject({
      source_url: "https://example.com/contact",
      extraction_method: "visible_text", evidence_snippet: "Email our editor",
      parser_version: "cheerio@1.1.2", confidence: 90,
    });
    await expectCode(client.query(evidenceInsert(id(302), projectB, 80,
      "now() + interval '1 year'")), "23503");
    await expectCode(client.query(`
      UPDATE backlink_contacts SET status = 'invalid' WHERE id = '${id(401)}'
    `), "23514");
    await expectCode(client.query(evidenceInsert(id(303), projectA, 101,
      "now() + interval '1 year'")), "23514");
    await expectCode(client.query(evidenceInsert(id(304), projectA, 80, "now()")),
      "23514");
    const rls = await client.query(`
      SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) AS secure,
        count(DISTINCT c.relname)::int AS tables, count(p.policyname)::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = current_schema() AND c.relname IN
        ('backlink_contact_candidates', 'backlink_contact_evidence', 'backlink_contacts')
    `);
    expect(rls.rows[0]).toEqual({ secure: true, tables: 3, policies: 3 });
  });
});
