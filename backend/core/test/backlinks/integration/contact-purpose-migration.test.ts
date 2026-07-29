import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
};
type PgError = Error & { readonly code?: string };

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migration = (name: string) =>
  new URL(`../../../src/modules/backlinks/db/migrations/${name}`, import.meta.url);
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1);
const workspace = id(2);
const project = id(3);
const context = id(5);
const prospect = id(101);
const candidate = id(201);
const contact = id(301);
const identity = `'${organization}', '${workspace}', '${project}'`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-CORR-3C-001 contact purpose migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

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
    await client.query(`
      INSERT INTO backlink_prospects (
        id, organization_id, workspace_id, website_project_id,
        recommendation_context_version_id, hostname_ascii,
        registrable_domain, normalization_version, created_by, updated_by
      ) VALUES (
        '${prospect}', ${identity}, '${context}', 'example.com', 'example.com',
        'tldts-7.4.9-v1', 'test', 'test'
      );
      INSERT INTO backlink_contact_candidates (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, normalized_email, email_domain_ascii,
        domain_relation, syntax_validator_version, confidence, created_by, updated_by
      ) VALUES (
        '${candidate}', ${identity}, '${prospect}', '${context}',
        'editor@example.com', 'example.com', 'same_registrable_domain',
        'validator@13.15.35', 88, 'test', 'test'
      );
      INSERT INTO backlink_contacts (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, source_candidate_id, normalized_email,
        contact_role, confidence, confirmed_at, confirmed_by, created_by, updated_by
      ) VALUES (
        '${contact}', ${identity}, '${prospect}', '${context}', '${candidate}',
        'editor@example.com', 'editorial', 88, now(), 'user-1', 'test', 'test'
      );
    `);
    await client.query(await readFile(roles, "utf8"));
    await client.query(await readFile(
      migration("0005_backlink_schema_role_ownership.sql"), "utf8",
    ));
    await client.query(await readFile(
      migration("0011_backlink_contact_purpose_correction.sql"), "utf8",
    ));
    await client.query("SET search_path = backlinks, pg_catalog");
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("backfills legacy contacts and leaves unclassified candidates unknown", async () => {
    expect((await client.query(`
      SELECT inferred_purpose purpose, purpose_confidence confidence,
        purpose_rule_version "ruleVersion", purpose_evidence evidence
      FROM backlink_contact_candidates WHERE id = '${candidate}'
    `)).rows[0]).toEqual({
      purpose: "unknown", confidence: 0,
      ruleVersion: "contact-purpose-rules.v1", evidence: [],
    });
    expect((await client.query(`
      SELECT observed_role "observedRole", inferred_purpose purpose,
        purpose_confidence confidence, purpose_rule_version "ruleVersion",
        purpose_evidence evidence
      FROM backlink_contacts WHERE id = '${contact}'
    `)).rows[0]).toEqual({
      observedRole: "editorial", purpose: "editorial", confidence: 88,
      ruleVersion: "legacy-contact-role-backfill.v1",
      evidence: [expect.objectContaining({
        tier: "legacy", field: "legacy_contact_role",
        matchedToken: "editorial", ruleId: "legacy.contact-role",
      })],
    });
  });

  it("rejects invalid purpose, confidence, rule, and evidence shapes", async () => {
    await expectCode(client.query(`
      UPDATE backlink_contact_candidates
      SET inferred_purpose = 'privacy' WHERE id = '${candidate}'
    `), "23514");
    await expectCode(client.query(`
      UPDATE backlink_contact_candidates
      SET purpose_confidence = 101 WHERE id = '${candidate}'
    `), "23514");
    await expectCode(client.query(`
      UPDATE backlink_contact_candidates
      SET purpose_rule_version = ' ' WHERE id = '${candidate}'
    `), "23514");
    await expectCode(client.query(`
      UPDATE backlink_contact_candidates
      SET purpose_evidence = '{}'::jsonb WHERE id = '${candidate}'
    `), "23514");
  });
});
