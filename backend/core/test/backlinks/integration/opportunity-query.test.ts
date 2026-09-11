import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpportunitiesQuery } from "../../../src/modules/backlinks/application/queries/opportunities.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
const { Client: PgClient } = createRequire(import.meta.url)("pg") as {
  Client: new (config: unknown) => Client;
};
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1),
  workspaceId = id(2);
const projectA = id(3),
  projectB = id(30);

describe("BL-AI-080 Opportunity PostgreSQL query", () => {
  let harness: BacklinksPostgresHarness, client: Client;
  const seed = async (
    projectId: string,
    value: number,
    joinSequence: number,
    managementStatus = "ACTIVE",
  ) => {
    const contextId = id(value),
      prospectId = id(value + 1);
    const recommendationId = id(value + 2),
      opportunityId = id(value + 3);
    const domain = `site-${value}.example`;
    await client.query(
      `INSERT INTO backlink_prospects (
      id,organization_id,workspace_id,website_project_id,
      recommendation_context_version_id,hostname_ascii,registrable_domain,
      normalization_version,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$6,'tldts-v1','seed','seed')`,
      [prospectId, organizationId, workspaceId, projectId, contextId, domain],
    );
    await client.query(
      `INSERT INTO backlink_recommendations (
      id,organization_id,workspace_id,website_project_id,prospect_id,
      recommendation_context_version_id,status,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,'accepted','seed','seed')`,
      [
        recommendationId,
        organizationId,
        workspaceId,
        projectId,
        prospectId,
        contextId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_opportunities (
      id,organization_id,workspace_id,website_project_id,recommendation_id,
      prospect_id,recommendation_context_version_id,target_site_key,
      target_host_ascii,target_identity_rule_version,join_sequence,
      management_status,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'tldts-v1',$9,$10,'seed','seed')`,
      [
        opportunityId,
        organizationId,
        workspaceId,
        projectId,
        recommendationId,
        prospectId,
        contextId,
        domain,
        joinSequence,
        managementStatus,
      ],
    );
    return opportunityId;
  };

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await installBacklinksManifestAfterFoundation(client, "0092");
    await client.query("SET search_path = backlinks, pg_catalog");

    await seed(projectA, 100, 1);
    await seed(projectA, 110, 3, "PAUSED");
    await seed(projectA, 115, 5, "ARCHIVED");
    await seed(projectA, 120, 7);
    const downstreamOpportunityId = await seed(projectA, 130, 9);
    await client.query(
      `INSERT INTO backlink_email_drafts (
      id,organization_id,workspace_id,website_project_id,opportunity_id,
      logical_draft_key,status,version,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,'opportunity-query-draft','draft',1,'seed','seed')`,
      [id(140), organizationId, workspaceId, projectA, downstreamOpportunityId],
    );
    await seed(projectB, 200, 1);
  }, 120_000);
  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("keeps project isolation, filters, gaps, and cursor order on real PostgreSQL", async () => {
    const query = createOpportunitiesQuery(client);
    const context = (websiteProjectId: string) => ({
      actor: createActorContext({
        userId: "user-80",
        sessionId: "session-80",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "owner.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "target-v1",
      }),
    });

    const first = await query.listOpportunities(context(projectA), {
      limit: 2,
    });
    expect(first.items.map((item) => item.joinSequence)).toEqual([9, 7]);
    expect(first.items[0]?.hasDownstreamFacts).toBe(true);
    expect(first.items[1]?.hasDownstreamFacts).toBe(false);
    expect(first).toMatchObject({ hasMore: true });
    await seed(projectA, 150, 11);
    const second = await query.listOpportunities(context(projectA), {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((item) => item.joinSequence)).toEqual([3, 1]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    const archived = await query.listOpportunities(context(projectA), {
      limit: 10,
      managementStatus: "ARCHIVED",
    });
    expect(archived.items.map((item) => item.joinSequence)).toEqual([5]);
    const paused = await query.listOpportunities(context(projectA), {
      limit: 10,
      managementStatus: "PAUSED",
    });
    expect(paused.items.map((item) => item.joinSequence)).toEqual([3]);
    const searched = await query.listOpportunities(context(projectA), {
      limit: 10,
      search: "site-110",
    });
    expect(searched.items.map((item) => item.joinSequence)).toEqual([3]);
    const foreignProject = await query.listOpportunities(context(projectB), {
      limit: 10,
    });
    expect(foreignProject.items).toHaveLength(1);
    const foreignOpportunity = foreignProject.items[0];
    if (!foreignOpportunity) {
      throw new Error("Expected a foreign-project opportunity fixture");
    }
    await expect(
      query.getOpportunity(context(projectA), foreignOpportunity.id),
    ).rejects.toMatchObject({ code: "BACKLINK_NOT_FOUND" });
  });
});
