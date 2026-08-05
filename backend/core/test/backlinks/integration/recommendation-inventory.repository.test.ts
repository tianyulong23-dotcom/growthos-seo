import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecommendationInventoryRepository } from "../../../src/modules/backlinks/db/repositories/recommendation-inventory.repository.js";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";
type Client = { connect(): Promise<void>; end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as { readonly Client: new (config: unknown) => Client };
const migration = new URL("../../../src/modules/backlinks/db/migrations/0003_backlink_recommendations.sql", import.meta.url);
const id = (value: number) => `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const scope = { organizationId: id(1), workspaceId: id(2), websiteProjectId: id(3),
  recommendationContextVersionId: id(4) } as const;

describe("BL-AI-060 Ready inventory repository", () => {
  let harness: BacklinksPostgresHarness, clientA: Client, clientB: Client;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    clientA = new PgClient({ connectionString: harness.connectionString });
    clientB = new PgClient({ connectionString: harness.connectionString });
    await Promise.all([clientA.connect(), clientB.connect()]);
    await clientA.query(await readFile(migration, "utf8"));
  }, 120_000);
  beforeEach(() => clientA.query(`TRUNCATE backlink_recommendation_rejections,
    backlink_recommendation_claims,backlink_recommendation_inventory,
    backlink_recommendation_scores,backlink_recommendations,backlink_prospects CASCADE`));
  afterAll(async () => {
    await Promise.all([clientA?.end(), clientB?.end()]);
    await harness?.stop();
  });
  async function seed() {
    await clientA.query(`
      WITH p AS (
        INSERT INTO backlink_prospects (
          id,organization_id,workspace_id,website_project_id,
          recommendation_context_version_id,hostname_ascii,registrable_domain,
          normalization_version,created_by,updated_by
        ) VALUES ($1,$2,$3,$4,$5,'example.com','example.com','v1','test','test')
        RETURNING id
      ), r AS (
        INSERT INTO backlink_recommendations (
          id,organization_id,workspace_id,website_project_id,prospect_id,
          recommendation_context_version_id,status,created_by,updated_by
        ) SELECT $6,$2,$3,$4,id,$5,'ready','test','test' FROM p
        RETURNING id,prospect_id
      ), s AS (
        INSERT INTO backlink_recommendation_scores (
          id,organization_id,workspace_id,website_project_id,recommendation_id,
          prospect_id,recommendation_context_version_id,score_model_version,
          rule_version,total_score,components,weights,evidence,generated_at,created_by
        ) SELECT $7,$2,$3,$4,id,prospect_id,$5,'score-v1','rules-v1',90,
          '[]','{}','{}',now(),'test' FROM r RETURNING recommendation_id
      )
      INSERT INTO backlink_recommendation_inventory (
        id,organization_id,workspace_id,website_project_id,recommendation_id,
        prospect_id,recommendation_context_version_id,status,created_by,updated_by
      ) SELECT $8,$2,$3,$4,r.id,r.prospect_id,$5,'ready','test','test'
          FROM r JOIN s ON s.recommendation_id=r.id
    `, [id(101), scope.organizationId, scope.workspaceId, scope.websiteProjectId,
      scope.recommendationContextVersionId, id(201), id(301), id(401)]);
  }
  const claim = (claimId: string, claimToken: string, claimedBy: string,
    claimedAt: string, leaseExpiresAt: string) => ({ ...scope, claimId, claimToken,
      claimedBy, claimedAt: new Date(claimedAt), leaseExpiresAt: new Date(leaseExpiresAt) });

  it("never returns one Ready item to two concurrent claimers", async () => {
    await seed();
    const [left, right] = await Promise.all([
      createRecommendationInventoryRepository(clientA).claim(claim(
        id(501), "claim-a", "worker-a", "2026-07-23T00:00:00Z", "2026-07-23T00:05:00Z")),
      createRecommendationInventoryRepository(clientB).claim(claim(
        id(502), "claim-b", "worker-b", "2026-07-23T00:00:00Z", "2026-07-23T00:05:00Z")),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    expect(left?.inventoryId ?? right?.inventoryId).toBe(id(401));
  });
  it("reclaims an expired lease, then releases and rejects by token", async () => {
    await seed();
    const repository = createRecommendationInventoryRepository(clientA);
    await repository.claim(claim(id(511), "crashed", "worker-a",
      "2026-07-23T00:00:00Z", "2026-07-23T00:05:00Z"));
    expect(await repository.claim(claim(id(512), "reclaimed", "worker-b",
      "2026-07-23T00:06:00Z", "2026-07-23T00:11:00Z"))).toMatchObject({
      inventoryId: id(401), claimToken: "reclaimed", claimVersion: 2 });
    expect(await repository.release({ ...scope, inventoryId: id(401),
      claimToken: "reclaimed", actorId: "worker-b",
      releasedAt: new Date("2026-07-23T00:07:00Z") })).toBe(true);
    await repository.claim(claim(id(513), "final", "worker-c",
      "2026-07-23T00:08:00Z", "2026-07-23T00:13:00Z"));
    expect(await repository.reject({ ...scope, inventoryId: id(401),
      claimToken: "final", rejectionId: id(601), rejectionType: "skipped",
      reasonCode: "not_relevant", rejectedBy: "worker-c",
      rejectedAt: new Date("2026-07-23T00:09:00Z"),
      cooldownUntil: new Date("2026-07-30T00:09:00Z") })).toBe(true);
    expect((await clientA.query(`SELECT i.status,c.status claim_status,r.rejection_type
      FROM backlink_recommendation_inventory i JOIN backlink_recommendation_claims c
      ON c.inventory_id=i.id JOIN backlink_recommendation_rejections r
      ON r.inventory_id=i.id`)).rows[0]).toEqual({
      status: "rejected", claim_status: "consumed", rejection_type: "skipped" });
  });
});
