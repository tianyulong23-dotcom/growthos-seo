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
const { Client: PgClient } = createRequire(import.meta.url)("pg") as
  { Client: new (config: unknown) => Client };
const migration = (name: string) => new URL(
  `../../../src/modules/backlinks/db/migrations/${name}`, import.meta.url);
const roles = new URL("../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1), workspaceId = id(2), websiteProjectId = id(3);
const opportunityId = id(78), recommendationContextVersionId = id(4);
const prospectId = id(5), recommendationId = id(6);

describe("BL-AI-078 Opportunity transition command", () => {
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
      "0006_backlink_opportunities.sql", "0007_backlink_opportunity_counter.sql"])
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
    ) VALUES ($1,$2,$3,$4,$5,$6,'accepted','seed','seed')`,
    [recommendationId, organizationId, workspaceId, websiteProjectId,
      prospectId, recommendationContextVersionId]);
    await client.query(`INSERT INTO backlink_opportunities (
      id,organization_id,workspace_id,website_project_id,recommendation_id,
      prospect_id,recommendation_context_version_id,target_site_key,
      target_host_ascii,target_identity_rule_version,join_sequence,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'example.com','www.example.com','tldts-v1',1,'seed','seed')`,
    [opportunityId, organizationId, workspaceId, websiteProjectId,
      recommendationId, prospectId, recommendationContextVersionId]);
  }, 120_000);
  afterAll(async () => { await client?.end(); await harness?.stop(); });

  it("persists guarded transition and management changes without collapsing axes", async () => {
    const commands = createOpportunityCommands(createOpportunityRepository(client));
    const context = {
      actor: createActorContext({ userId: "user-78", sessionId: "session-78",
        roles: ["member"] }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({ websiteProjectId, canonicalDomain: "owner.test",
        locale: "en-US", countryCode: "US", profileVersionId: "profile-v1",
        promotionTargetVersionId: "target-v1" }),
    };
    const input = { context, opportunityId, expectedVersion: 1,
      toBusinessStage: "CONTACT_PREPARING" as const, reason: "Prepare contact.",
      idempotencyKey: "transition-78", requestId: "request-78" };
    const first = await commands.transitionBusinessStage(input);
    expect(first).toMatchObject({ opportunityId, businessStage: "CONTACT_PREPARING",
      managementStatus: "ACTIVE", outcomeStatus: "OPEN",
      fulfillmentStatus: "NOT_EXPECTED", version: 2, replayed: false });
    expect(await commands.transitionBusinessStage(input)).toEqual({ ...first, replayed: true });
    await expect(commands.transitionBusinessStage({ ...input,
      idempotencyKey: "transition-stale", toBusinessStage: "READY_TO_CONTACT" }))
      .rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    await expect(commands.transitionBusinessStage({ ...input, expectedVersion: 2,
      idempotencyKey: "transition-illegal", toBusinessStage: "AGREED" }))
      .rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    const management = { context, opportunityId, expectedVersion: 2,
      managementStatus: "PAUSED" as const, reason: "Pause outreach.",
      idempotencyKey: "management-79", requestId: "request-79" };
    const patched = await commands.patchManagement(management);
    expect(patched).toMatchObject({ opportunityId,
      businessStage: "CONTACT_PREPARING", managementStatus: "PAUSED",
      outcomeStatus: "OPEN", fulfillmentStatus: "NOT_EXPECTED",
      version: 3, replayed: false });
    expect(await commands.patchManagement(management))
      .toEqual({ ...patched, replayed: true });
    await expect(commands.patchManagement({ ...management,
      idempotencyKey: "management-stale", managementStatus: "ACTIVE" }))
      .rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    await expect(commands.patchManagement({ ...management, expectedVersion: 3,
      idempotencyKey: "management-unchanged" }))
      .rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    expect((await client.query(`SELECT business_stage "businessStage",
      management_status "managementStatus",outcome_status "outcomeStatus",
      fulfillment_status "fulfillmentStatus",version,
      (SELECT count(*)::int FROM backlink_lifecycle_events) lifecycle,
      (SELECT count(*)::int FROM backlink_audit_events) audit,
      (SELECT count(*)::int FROM backlink_idempotency_records) idempotency
      FROM backlink_opportunities WHERE id=$1`, [opportunityId])).rows[0])
      .toEqual({ businessStage: "CONTACT_PREPARING", managementStatus: "PAUSED",
        outcomeStatus: "OPEN", fulfillmentStatus: "NOT_EXPECTED", version: 3,
        lifecycle: 2, audit: 2, idempotency: 2 });
  });
});
