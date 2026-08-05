import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ContactDiscoveryService } from "../../../src/modules/backlinks/application/services/contact-discovery.service.js";
import { createContactDiscoveryRepository } from "../../../src/modules/backlinks/db/repositories/contact-discovery.repository.js";
import type { SafeFetchPort, SafeFetchResult } from "../../../src/modules/backlinks/ports/safe-fetch.port.js";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";

type Client = { connect(): Promise<void>; end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[]; rowCount: number | null;
  }> };
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as { readonly Client: new (config: unknown) => Client };
const migration = (name: string) => new URL(`../../../src/modules/backlinks/db/migrations/${name}`, import.meta.url);
const id = (value: number) => `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1), workspaceId = id(2), websiteProjectId = id(3);
const recommendationContextVersionId = id(5), prospectId = id(101);
const input = {
  organizationId, workspaceId, websiteProjectId, recommendationContextVersionId,
  prospectId, prospectRegistrableDomain: "example.com",
  targetUrl: "https://example.com/contact", actorId: "test",
};
const page: SafeFetchResult = {
  requestedUrl: input.targetUrl, finalUrl: input.targetUrl, status: 200,
  contentType: "text/html; charset=utf-8",
  body: new TextEncoder().encode("<title>Contact</title><body><a href='mailto:editor@example.com'>editor@example.com</a></body>"),
  redirectChain: [], resolvedIps: ["203.0.113.10"], fetchedAt: "2026-07-23T02:00:00.000Z",
};
const unknownPage: SafeFetchResult = {
  ...page,
  body: new TextEncoder().encode(
    "<title>No Smart TV? No Problem</title><body><a href='mailto:legal@elephtv.com'>Privacy</a></body>",
  ),
};

describe("BL-AI-072 contact discovery", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;
  let nextId = 200;
  const service = (safeFetch: SafeFetchPort) => new ContactDiscoveryService({
    safeFetch, repository: createContactDiscoveryRepository({
      connect: async () => ({ query: client.query.bind(client), release: () => undefined }),
    }),
    newId: () => id(nextId++),
  });

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of ["0002_backlink_provider_seo.sql", "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql"]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(await readFile(new URL(
      "../../../../database/roles/0001_growthos_schema_roles.sql", import.meta.url,
    ), "utf8"));
    for (const name of ["0005_backlink_schema_role_ownership.sql",
      "0011_backlink_contact_purpose_correction.sql",
      "0038_backlink_contact_enrichment.sql"]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`
      INSERT INTO backlink_prospects (
        id, organization_id, workspace_id, website_project_id, recommendation_context_version_id,
        hostname_ascii, registrable_domain, normalization_version, created_by, updated_by
      ) VALUES ($1, $2, $3, $4, $5, 'example.com', 'example.com', 'tldts-7.4.9-v1', 'test', 'test')
    `, [prospectId, organizationId, workspaceId, websiteProjectId, recommendationContextVersionId]);
  }, 120_000);
  beforeEach(async () => {
    nextId = 200;
    await client.query("TRUNCATE backlink_contacts, backlink_contact_evidence, backlink_contact_candidates");
  });
  afterAll(async () => { await client?.end(); await harness?.stop(); });

  it("leaves the prospect and contact storage unchanged when fetching fails", async () => {
    const before = (await client.query("SELECT hostname_ascii, updated_by FROM backlink_prospects WHERE id = $1", [prospectId])).rows[0];
    await expect(service({ fetch: async () => { throw new Error("fetch failed"); } }).discover(input))
      .rejects.toThrow("fetch failed");
    expect((await client.query(`
      SELECT (SELECT count(*)::int FROM backlink_contact_candidates) candidates,
        (SELECT count(*)::int FROM backlink_contact_evidence) evidence,
        (SELECT count(*)::int FROM backlink_contacts) contacts
    `)).rows[0]).toEqual({ candidates: 0, evidence: 0, contacts: 0 });
    expect((await client.query("SELECT hostname_ascii, updated_by FROM backlink_prospects WHERE id = $1", [prospectId])).rows[0]).toEqual(before);
  });

  it("merges repeated email candidates and identical evidence without promotion", async () => {
    const discovery = service({ fetch: async () => page });
    expect(await discovery.discover(input)).toEqual({ candidateCount: 1, evidenceInserted: 1, evidenceMerged: 0 });
    expect(await discovery.discover(input)).toEqual({ candidateCount: 1, evidenceInserted: 0, evidenceMerged: 1 });
    expect((await client.query(`
      SELECT c.normalized_email email, c.domain_relation relation, c.confidence,
        c.observed_role "observedRole", c.inferred_purpose "inferredPurpose",
        c.purpose_confidence "purposeConfidence",
        c.purpose_rule_version "purposeRuleVersion",
        c.purpose_evidence "purposeEvidence",
        count(e.id)::int "evidenceCount", min(e.source_url) "sourceUrl",
        min(e.extraction_method) method, min(e.evidence_snippet) snippet,
        (SELECT count(*)::int FROM backlink_contacts) contacts
      FROM backlink_contact_candidates c LEFT JOIN backlink_contact_evidence e ON e.candidate_id = c.id
      GROUP BY c.normalized_email, c.domain_relation, c.confidence, c.observed_role,
        c.inferred_purpose, c.purpose_confidence, c.purpose_rule_version,
        c.purpose_evidence
    `)).rows[0]).toEqual({
      email: "editor@example.com", relation: "same_registrable_domain", confidence: 90,
      observedRole: "editor", inferredPurpose: "editorial", purposeConfidence: 98,
      purposeRuleVersion: "contact-purpose-rules.v1",
      purposeEvidence: [expect.objectContaining({
        tier: "high", field: "email_local_part", matchedToken: "editor",
        ruleId: "editorial.editor",
      }), expect.objectContaining({
        tier: "high", field: "mailto_label", matchedToken: "editor",
        ruleId: "editorial.editor",
      }), expect.objectContaining({
        tier: "low", field: "page_title", matchedToken: "contact",
        ruleId: "general.contact",
      })],
      evidenceCount: 1, sourceUrl: input.targetUrl, method: "mailto",
      snippet: "editor@example.com mailto:editor@example.com", contacts: 0,
    });
  });

  it("retains an unknown verified email as a candidate without promotion", async () => {
    expect(await service({ fetch: async () => unknownPage }).discover(input)).toEqual({
      candidateCount: 1, evidenceInserted: 1, evidenceMerged: 0,
    });
    expect((await client.query(`
      SELECT normalized_email email, inferred_purpose purpose,
        purpose_confidence confidence,
        (SELECT count(*)::int FROM backlink_contacts) contacts
      FROM backlink_contact_candidates
    `)).rows[0]).toEqual({
      email: "legal@elephtv.com", purpose: "unknown", confidence: 0, contacts: 0,
    });
  });
});
