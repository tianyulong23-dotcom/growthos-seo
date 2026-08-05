import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpportunityCommands } from "../../../src/modules/backlinks/application/commands/opportunities.command.js";
import { createOpportunityRepository } from "../../../src/modules/backlinks/db/repositories/opportunity.repository.js";
import { createActorContext, createProjectContext,
  createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
import { startBacklinksPostgresHarness,
  type BacklinksPostgresHarness } from "./harness/postgresql-container.js";
type Client = { connect(): Promise<void>; end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as
  { readonly Client: new (config: unknown) => Client };
const migration = (name: string) => new URL(
  `../../../src/modules/backlinks/db/migrations/${name}`, import.meta.url);
const roles = new URL("../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1), workspaceId = id(2), websiteProjectId = id(3);
const recommendationContextVersionId = id(4), prospectId = id(5);
const recommendationId = id(6), inventoryId = id(7);

describe("BL-AI-076 create Opportunity command", () => {
  let harness: BacklinksPostgresHarness, client: Client;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of ["0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql", "0004_backlink_contacts_opportunities.sql"])
      await client.query(await readFile(migration(name), "utf8"));
    await client.query(await readFile(roles, "utf8"));
    for (const name of ["0005_backlink_schema_role_ownership.sql",
      "0006_backlink_opportunities.sql",
      "0007_backlink_opportunity_counter.sql"])
      await client.query(await readFile(migration(name), "utf8"));
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`INSERT INTO backlink_prospects (
      id,organization_id,workspace_id,website_project_id,
      recommendation_context_version_id,hostname_ascii,registrable_domain,
      normalization_version,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,'www.example.com','example.com','tldts-v1','seed','seed')`,
    [prospectId, organizationId, workspaceId, websiteProjectId,
      recommendationContextVersionId]);
    await client.query(`INSERT INTO backlink_recommendations (
      id,organization_id,workspace_id,website_project_id,prospect_id,
      recommendation_context_version_id,status,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,'shown','seed','seed')`,
    [recommendationId, organizationId, workspaceId, websiteProjectId,
      prospectId, recommendationContextVersionId]);
    await client.query(`INSERT INTO backlink_recommendation_inventory (
      id,organization_id,workspace_id,website_project_id,recommendation_id,
      prospect_id,recommendation_context_version_id,status,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'shown','seed','seed')`,
    [inventoryId, organizationId, workspaceId, websiteProjectId,
      recommendationId, prospectId, recommendationContextVersionId]);
  }, 120_000);
  afterAll(async () => { await client?.end(); await harness?.stop(); });

  it("creates one Opportunity when the same recommendation is replayed", async () => {
    const context = {
      actor: createActorContext({ userId: "user-1", sessionId: "session-1",
        roles: ["member"] }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({ websiteProjectId, canonicalDomain: "owner.test",
        locale: "en-US", countryCode: "US", profileVersionId: "profile-v1",
        promotionTargetVersionId: "target-v1" }),
    };
    const commands = createOpportunityCommands(createOpportunityRepository(client));
    const input = { context, recommendationId, expectedVersion: 1,
      idempotencyKey: "accept-rec-1", requestId: "request-1" };
    const first = await commands.createFromRecommendation(input);
    expect(first).toMatchObject({ recommendationId, joinSequence: 1,
      businessStage: "JOINED", version: 1, replayed: false });
    expect(await commands.createFromRecommendation(input))
      .toEqual({ ...first, replayed: true });
    expect((await client.query(`SELECT
      (SELECT count(*)::int FROM backlink_opportunities) opportunities,
      (SELECT count(*)::int FROM backlink_opportunity_cycles) cycles,
      (SELECT count(*)::int FROM backlink_lifecycle_events) lifecycle,
      (SELECT count(*)::int FROM backlink_audit_events) audit,
      (SELECT count(*)::int FROM backlink_idempotency_records) idempotency,
      (SELECT status FROM backlink_recommendation_inventory WHERE id=$1) status`,
    [inventoryId])).rows[0]).toEqual({
      opportunities: 1, cycles: 1, lifecycle: 1, audit: 1,
      idempotency: 1, status: "accepted",
    });
  });
});
