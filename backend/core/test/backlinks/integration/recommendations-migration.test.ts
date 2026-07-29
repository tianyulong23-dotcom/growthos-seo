import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";
type Client = { connect(): Promise<void>; end(): Promise<void>;
  query(text: string): Promise<{ rows: Record<string, unknown>[] }> };
type PostgresError = Error & { readonly code?: string };
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migrationPath = new URL("../../../src/modules/backlinks/db/migrations/"
  + "0003_backlink_recommendations.sql", import.meta.url);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1), workspace = id(2), project = id(3);
const context = id(4), nextContext = id(5), inventoryContext = id(6);
const identity = () => `'${organization}', '${workspace}', '${project}'`;
const insertProspect = (
  client: Client, prospectId: string, contextId: string,
) => client.query(`
  INSERT INTO backlink_prospects (
    id, organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, hostname_ascii, registrable_domain,
    normalization_version, created_by, updated_by
  ) VALUES (
    '${prospectId}', ${identity()}, '${contextId}', 'example.com',
    'example.com', 'tldts-7.4.9-v1', 'test', 'test'
  )
`);
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PostgresError);
  expect(error).toMatchObject({ code });
};
describe("recommendation persistence migration", () => {
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
  it("enforces context identity, immutable strategy evidence, and RLS", async () => {
    const prospect = id(101), recommendation = id(201), score = id(301);
    await insertProspect(client, prospect, context);
    const duplicate = await insertProspect(client, id(102), context)
      .catch((error: unknown) => error as PostgresError);
    expect(duplicate).toMatchObject({ code: "23505" });
    await insertProspect(client, id(103), nextContext);
    await client.query(`
      INSERT INTO backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES (
        '${recommendation}', ${identity()}, '${prospect}', '${context}',
        'evaluating', 'test', 'test'
      )
    `);
    const wrongContext = await client.query(`
      INSERT INTO backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES (
        '${id(202)}', ${identity()}, '${prospect}', '${nextContext}',
        'evaluating', 'test', 'test'
      )
    `).catch((error: unknown) => error as PostgresError);
    expect(wrongContext).toMatchObject({ code: "23503" });
    await client.query(`
      INSERT INTO backlink_recommendation_scores (
        id, organization_id, workspace_id, website_project_id,
        recommendation_id, prospect_id, recommendation_context_version_id,
        score_model_version, rule_version, total_score, components, weights,
        evidence, generated_at, created_by
      ) VALUES (
        '${score}', ${identity()}, '${recommendation}', '${prospect}',
        '${context}', 'score-v1', 'rules-v1', 86.25,
        '[{"id":"seo","points":30}]', '{"seo":30}',
        '{"sourceEvidenceIds":["snapshot-1"]}', now(), 'test'
      )
    `);
    expect((await client.query(`
      SELECT score_model_version, rule_version, components, weights, evidence
        FROM backlink_recommendation_scores WHERE id = '${score}'
    `)).rows[0]).toMatchObject({
      score_model_version: "score-v1",
      rule_version: "rules-v1",
      components: [{ id: "seo", points: 30 }],
      weights: { seo: 30 },
      evidence: { sourceEvidenceIds: ["snapshot-1"] },
    });
    for (const statement of [
      `UPDATE backlink_recommendation_scores SET total_score = 0 WHERE id = '${score}'`,
      `DELETE FROM backlink_recommendation_scores WHERE id = '${score}'`,
    ]) {
      const error = await client.query(statement)
        .catch((caught: unknown) => caught as PostgresError);
      expect(error).toMatchObject({ code: "P0001" });
    }
    const rls = await client.query(`
      SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) AS secure,
             count(DISTINCT c.relname)::int AS tables,
             count(p.policyname)::int AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policies p
          ON p.schemaname = n.nspname AND p.tablename = c.relname
       WHERE n.nspname = current_schema()
         AND c.relname IN (
           'backlink_prospects', 'backlink_recommendations',
           'backlink_recommendation_scores',
           'backlink_recommendation_inventory',
           'backlink_recommendation_claims',
           'backlink_recommendation_rejections',
           'backlink_recommendation_refills'
         )
    `);
    expect(rls.rows[0]).toEqual({ secure: true, tables: 7, policies: 7 });
  });
  it("enforces recyclable claims, rejection cooldowns, and refill windows", async () => {
    const prospect = id(111), recommendation = id(211);
    const inventory = id(311), claim = id(411), refillJob = id(511);
    const insertClaim = (
      claimId: string, token: string, claimedAt: string, expiresAt: string,
    ) => client.query(`
      INSERT INTO backlink_recommendation_claims (
        id, organization_id, workspace_id, website_project_id, inventory_id,
        recommendation_id, prospect_id, recommendation_context_version_id,
        claim_token, claimed_by, claimed_at, lease_expires_at,
        created_by, updated_by
      ) VALUES (
        '${claimId}', ${identity()}, '${inventory}', '${recommendation}',
        '${prospect}', '${inventoryContext}', '${token}', 'worker',
        '${claimedAt}', '${expiresAt}', 'test', 'test'
      )
    `);
    const insertRejection = (rejectionId: string, cooldown: string) =>
      client.query(`
        INSERT INTO backlink_recommendation_rejections (
          id, organization_id, workspace_id, website_project_id, inventory_id,
          recommendation_id, prospect_id, recommendation_context_version_id,
          rejection_type, reason_code, rejected_at, cooldown_until,
          rejected_by, created_by
        ) VALUES (
          '${rejectionId}', ${identity()}, '${inventory}', '${recommendation}',
          '${prospect}', '${inventoryContext}', 'skipped', 'not_relevant',
          '2026-07-23T00:07:00Z', ${cooldown}, 'user-1', 'test'
        )
      `);
    const insertRefill = (refillId: string, jobId: string) => client.query(`
      INSERT INTO backlink_recommendation_refills (
        id, organization_id, workspace_id, website_project_id, job_id,
        recommendation_context_version_id, trigger_reason, low_watermark,
        high_watermark, refill_window_key, created_by, updated_by
      ) VALUES (
        '${refillId}', ${identity()}, '${jobId}', '${inventoryContext}',
        'inventory_low', 2, 5, 'window-1', 'test', 'test'
      )
    `);
    await insertProspect(client, prospect, inventoryContext);
    await client.query(`
      INSERT INTO backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES (
        '${recommendation}', ${identity()}, '${prospect}', '${inventoryContext}',
        'ready', 'test', 'test'
      );
      INSERT INTO backlink_recommendation_inventory (
        id, organization_id, workspace_id, website_project_id,
        recommendation_id, prospect_id, recommendation_context_version_id,
        status, created_by, updated_by
      ) VALUES (
        '${inventory}', ${identity()}, '${recommendation}', '${prospect}',
        '${inventoryContext}', 'ready', 'test', 'test'
      );
      INSERT INTO backlink_jobs (
        id, organization_id, workspace_id, website_project_id, job_type,
        source_object_type, source_object_id, workflow_id, correlation_id,
        created_by, updated_by
      ) VALUES (
        '${refillJob}', ${identity()}, 'recommendation_refill',
        'recommendation_context', '${inventoryContext}', 'refill-window-1',
        'correlation-1', 'test', 'test'
      ), (
        '${id(512)}', ${identity()}, 'recommendation_refill',
        'recommendation_context', '${inventoryContext}', 'refill-window-2',
        'correlation-2', 'test', 'test'
      );
    `);
    await insertClaim(
      claim, "claim-1", "2026-07-23T00:00:00Z", "2026-07-23T00:05:00Z",
    );
    await expectCode(insertClaim(
      id(412), "claim-2", "2026-07-23T00:01:00Z",
      "2026-07-23T00:06:00Z",
    ), "23505");
    await expectCode(client.query(`
      UPDATE backlink_recommendation_claims
         SET lease_expires_at = claimed_at
       WHERE id = '${claim}'
    `), "23514");
    await client.query(`
      UPDATE backlink_recommendation_claims
         SET claim_token = 'claim-2', claimed_by = 'worker-2',
             claimed_at = '2026-07-23T00:06:00Z',
             lease_expires_at = '2026-07-23T00:11:00Z',
             version = version + 1
       WHERE id = '${claim}'
         AND lease_expires_at <= '2026-07-23T00:06:00Z'
    `);
    expect((await client.query(`
      SELECT claim_token, version
        FROM backlink_recommendation_claims WHERE id = '${claim}'
    `)).rows[0]).toMatchObject({ claim_token: "claim-2", version: 2 });
    await expectCode(insertRejection(id(611), "NULL"), "23514");
    await insertRejection(id(612), "'2026-07-30T00:07:00Z'");
    await insertRefill(id(711), refillJob);
    await expectCode(client.query(`
      UPDATE backlink_recommendation_refills
         SET high_watermark = low_watermark
       WHERE id = '${id(711)}'
    `), "23514");
    await expectCode(insertRefill(id(712), id(512)), "23505");
  });
});
