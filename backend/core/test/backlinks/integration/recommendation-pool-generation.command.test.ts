import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRecommendationCommands } from "../../../src/modules/backlinks/application/commands/recommendations.command.js";
import { planCommercialSupplyOperationStep } from "../../../src/modules/backlinks/application/services/commercial-supply-operation.service.js";
import { reserveRecommendationRefillJob } from "../../../src/modules/backlinks/application/services/recommendation-refill-reservation.service.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { buildCommercialRefillWindowKey } from "../../../src/modules/backlinks/domain/recommendations/commercial-refill-cycle.js";
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
type DeploymentManifest = Readonly<{
  steps: readonly Readonly<{ migrationId: string; path: string }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const migrationUrl = (path: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
    import.meta.url,
  );
const id = (value: number) =>
  `018f0059-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const recommendationContextVersionId = id(4);

describe("recommendation pool generation lifecycle", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(rolesUrl, "utf8"));
    await client.query(`
      SET ROLE growthos_platform_owner;
      SET search_path = platform, pg_catalog;
      CREATE FUNCTION backlink_list_active_website_projects(text, text)
      RETURNS TABLE (website_project_id text, context_version integer)
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = platform, pg_catalog
      AS $function$ SELECT NULL::text, NULL::integer WHERE false; $function$;
      REVOKE ALL
        ON FUNCTION backlink_list_active_website_projects(text, text)
        FROM PUBLIC;
      GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
      GRANT EXECUTE
        ON FUNCTION backlink_list_active_website_projects(text, text)
        TO growthos_backlinks_owner;
      RESET ROLE;
      RESET search_path;
    `);
    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    for (const step of manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-")
        && migrationId !== "backlinks-0001",
    )) {
      await client.query(await readFile(migrationUrl(step.path), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(
      `INSERT INTO backlink_project_context_snapshots (
         id,organization_id,workspace_id,website_project_id,snapshot_version,
         project_status,canonical_domain,locale,country_code,
         profile_version_id,promotion_target_version_id,products,keywords,
         created_by
       ) VALUES (
         $1,$2,$3,$4,1,'ACTIVE','owner.test','en-US','US',
         'profile-v1','target-v1','["streaming entertainment"]'::jsonb,
         '["film reviews"]'::jsonb,'pool-test'
       )`,
      [
        recommendationContextVersionId,
        organizationId,
        workspaceId,
        websiteProjectId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_outreach_profile_versions (
         id,organization_id,workspace_id,website_project_id,
         profile_version_id,promotion_target_version_id,keywords_and_topics,
         products_and_services,target_urls,target_audiences,partnership_goals,
         market,location,language,authorized_discovery_sources,
         immutable_fingerprint,created_by
       ) VALUES (
         $1,$2,$3,$4,'profile-v1','target-v1',
         '["film reviews"]'::jsonb,'["streaming entertainment"]'::jsonb,
         '[]'::jsonb,'["streaming viewers"]'::jsonb,
         '["editorial review"]'::jsonb,'US','US','en',
         '["shared-seo-evidence"]'::jsonb,'pool-profile-v1','pool-test'
       )`,
      [id(5), organizationId, workspaceId, websiteProjectId],
    );
    await client.query(
      `INSERT INTO backlink_generation_input_pins (
         id,organization_id,workspace_id,website_project_id,
         project_context_version,site_profile_version_id,
         outreach_profile_version_id,promotion_target_version_id,
         keyword_evidence_snapshot_ids,shared_evidence_snapshot_ids,market,
         qualification_contract_version,immutable_fingerprint,created_by
       ) VALUES (
         $1,$2,$3,$4,1,'profile-v1',$5,'target-v1',
         '[]'::jsonb,'[]'::jsonb,'US','recommendation-qualification.v1',
         'pool-generation-input-v1','pool-test'
       )`,
      [id(6), organizationId, workspaceId, websiteProjectId, id(5)],
    );
    await client.query(
      `INSERT INTO backlink_commercial_inventory_policies (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,visible_pool_generation,
         visible_pool_state,updated_by
       ) VALUES ($1,$2,$3,$4,1,'active','pool-test')`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
      ],
    );
    for (let index = 0; index < 20; index += 1) {
      const prospectId = id(100 + index);
      const recommendationId = id(200 + index);
      await client.query(
        `INSERT INTO backlink_prospects (
           id,organization_id,workspace_id,website_project_id,
           recommendation_context_version_id,hostname_ascii,
           registrable_domain,normalization_version,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'tldts-v1','pool-test','pool-test')`,
        [
          prospectId,
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationContextVersionId,
          `publisher-${index}.test`,
          `publisher-${index}.test`,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendations (
           id,organization_id,workspace_id,website_project_id,prospect_id,
           recommendation_context_version_id,status,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,'shown','pool-test','pool-test')`,
        [
          recommendationId,
          organizationId,
          workspaceId,
          websiteProjectId,
          prospectId,
          recommendationContextVersionId,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendation_inventory (
           id,organization_id,workspace_id,website_project_id,
           recommendation_id,prospect_id,recommendation_context_version_id,
           visible_pool_generation,status,created_by,updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'shown','pool-test','pool-test')`,
        [
          id(300 + index),
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationId,
          prospectId,
          recommendationContextVersionId,
        ],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("archives a complete generation and waits for an explicit next generation", async () => {
    const context = {
      actor: createActorContext({
        userId: "pool-operator",
        sessionId: "pool-session",
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
    };
    const commands = createRecommendationCommands(client);
    const archiveInput = {
      context,
      requestId: "archive-request-1",
      idempotencyKey:
        `recommendation-pool-archive:${recommendationContextVersionId}:g1`,
      recommendationContextVersionId,
      visiblePoolGeneration: 1,
    } as const;

    expect(await commands.archivePool(archiveInput)).toMatchObject({
      archivedGeneration: 1,
      nextGeneration: 2,
      archivedCount: 20,
      state: "awaiting_refresh",
      replayed: false,
    });
    expect(await commands.archivePool(archiveInput)).toMatchObject({
      archivedGeneration: 1,
      nextGeneration: 2,
      archivedCount: 20,
      state: "awaiting_refresh",
      replayed: true,
    });

    expect(
      (
        await client.query(
          `SELECT visible_pool_generation AS "generation",
                  visible_pool_state AS "state",
                  archived_visible_pool_count AS "archivedCount"
             FROM backlink_commercial_inventory_policies
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND project_context_version_id=$4`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([{
      generation: 2,
      state: "awaiting_refresh",
      archivedCount: 20,
    }]);
    expect(
      (
        await client.query(
          `SELECT status,count(*)::integer AS count
             FROM backlink_recommendation_inventory
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND recommendation_context_version_id=$4
              AND visible_pool_generation=1
            GROUP BY status`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([{ status: "archived", count: 20 }]);
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_recommendation_refills)
               AS "refillCount",
             (SELECT count(*)::integer FROM backlink_jobs) AS "jobCount",
             (SELECT count(*)::integer FROM backlink_outbox_events)
               AS "outboxCount"`,
        )
      ).rows,
    ).toEqual([{ refillCount: 0, jobCount: 0, outboxCount: 0 }]);

    const refillInput = {
      context,
      requestId: "refill-request-2",
      expectedVersion: 0,
      recommendationContextVersionId,
      visiblePoolGeneration: 2,
      lowWatermark: 9,
      highWatermark: 10,
      providerBudgetAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
      },
    } as const;
    const started = await commands.requestRefill(refillInput);
    expect(started).toMatchObject({ status: "queued", replayed: false });
    expect(await commands.requestRefill(refillInput)).toMatchObject({
      operationId: started.operationId,
      jobId: started.jobId,
      status: "queued",
      replayed: true,
    });

    expect(
      (
        await client.query(
          `SELECT visible_pool_generation AS "generation",
                  visible_pool_state AS "state"
             FROM backlink_commercial_inventory_policies
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND project_context_version_id=$4`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([{ generation: 2, state: "building" }]);
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_recommendation_refills)
               AS "refillCount",
             (SELECT count(*)::integer FROM backlink_jobs) AS "jobCount",
             (SELECT count(*)::integer
                FROM backlink_commercial_supply_operations)
               AS "supplyOperationCount",
             (SELECT count(*)::integer FROM backlink_outbox_events)
               AS "outboxCount"`,
        )
      ).rows,
    ).toEqual([{
      refillCount: 1,
      jobCount: 1,
      supplyOperationCount: 1,
      outboxCount: 1,
    }]);
    const providerOperationId =
      `commercial-refill-operation:${started.jobId}`;
    expect(
      (
        await client.query(
          `SELECT
             operation.id AS "operationId",
             operation.project_context_version_id AS "operationContextId",
             operation.visible_pool_generation AS "operationGeneration",
             operation.job_id AS "operationJobId",
             operation.authorization_snapshot AS "operationAuthorization",
             operation.authorization_hash AS "operationAuthorizationHash",
             operation.status AS "operationStatus",
             operation.idempotency_key AS "operationIdempotencyKey",
             job.result_summary->>'providerOperationId'
               AS "jobOperationId",
             job.result_summary->'providerBudgetAuthorization'
               AS "jobAuthorization",
             lifecycle.after_state->>'providerOperationId'
               AS "lifecycleOperationId",
             lifecycle.after_state->'providerBudgetAuthorization'
               AS "lifecycleAuthorization",
             audit.after_redacted->>'providerOperationId'
               AS "auditOperationId",
             audit.after_redacted->'providerBudgetAuthorization'
               AS "auditAuthorization",
             event.payload->>'providerOperationId'
               AS "outboxOperationId",
             event.payload->'providerBudgetAuthorization'
               AS "outboxAuthorization"
             FROM backlink_jobs AS job
             JOIN backlink_commercial_supply_operations AS operation
               ON operation.organization_id=job.organization_id
              AND operation.workspace_id=job.workspace_id
              AND operation.website_project_id=job.website_project_id
              AND operation.job_id=job.id
             JOIN backlink_lifecycle_events AS lifecycle
               ON lifecycle.job_id=job.id
             JOIN backlink_audit_events AS audit
               ON audit.job_id=job.id
             JOIN backlink_outbox_events AS event
               ON event.aggregate_id=job.id
            WHERE job.id=$1`,
          [started.jobId],
        )
      ).rows,
    ).toEqual([expect.objectContaining({
      operationId: providerOperationId,
      operationContextId: recommendationContextVersionId,
      operationGeneration: 2,
      operationJobId: started.jobId,
      operationAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      operationAuthorizationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      operationStatus: "authorized",
      operationIdempotencyKey:
        `recommendation-refill:manual:${recommendationContextVersionId}:g2:blueprint-v5`,
      jobOperationId: providerOperationId,
      jobAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      lifecycleOperationId: `commercial-refill-operation:${started.jobId}`,
      lifecycleAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      auditOperationId: `commercial-refill-operation:${started.jobId}`,
      auditAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      outboxOperationId: `commercial-refill-operation:${started.jobId}`,
      outboxAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
    })]);

    await expect(
      reserveRecommendationRefillJob(client, {
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        visiblePoolGeneration: 2,
        jobId: started.jobId,
        targetPublishedCount: 10,
      }),
    ).resolves.toMatchObject({
      status: "started",
      jobId: started.jobId,
    });
    await expect(
      reserveRecommendationRefillJob(client, {
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        visiblePoolGeneration: 2,
        jobId: started.jobId,
        targetPublishedCount: 10,
      }),
    ).resolves.toMatchObject({
      status: "already_started",
      jobId: started.jobId,
    });
    expect(
      (
        await client.query(
          `SELECT
             job.result_summary->>'providerOperationId'
               AS "jobOperationId",
             job.result_summary->'providerBudgetAuthorization'
               AS "jobAuthorization",
             operation.authorization_snapshot AS "operationAuthorization",
             operation.authorization_hash AS "operationAuthorizationHash",
             operation.status AS "operationStatus",
             operation.visible_pool_generation AS "operationGeneration",
             operation.job_id AS "operationJobId",
             event.payload->>'providerOperationId'
               AS "outboxOperationId",
             event.payload->'providerBudgetAuthorization'
               AS "outboxAuthorization"
             FROM backlink_jobs AS job
             JOIN backlink_commercial_supply_operations AS operation
               ON operation.organization_id=job.organization_id
              AND operation.workspace_id=job.workspace_id
              AND operation.website_project_id=job.website_project_id
              AND operation.job_id=job.id
             JOIN backlink_outbox_events AS event
               ON event.aggregate_id=job.id
            WHERE job.id=$1`,
          [started.jobId],
        )
      ).rows,
    ).toEqual([{
      jobOperationId: providerOperationId,
      jobAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      operationAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      operationAuthorizationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      operationStatus: "authorized",
      operationGeneration: 2,
      operationJobId: started.jobId,
      outboxOperationId: providerOperationId,
      outboxAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
    }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::integer AS count
             FROM backlink_provider_budgets
            WHERE organization_id=$1 AND workspace_id=$2
              AND provider='dataforseo'
              AND period_start<=$3 AND period_end>$3`,
          [
            organizationId,
            workspaceId,
            new Date("2026-08-20T12:00:00.000Z"),
          ],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    await client.query(
      `INSERT INTO backlink_recommendation_generation_contracts (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,visible_pool_generation,
         input_pin_id,qualification_contract_version,
         visibility_contract_version,score_model_version,metric_scope,
         market,location,language,traffic_location_code,
         traffic_language_code,request_fingerprints,
         creator_worker_contract_version,created_by
       ) VALUES (
         $1,$2,$3,$4,$5,2,$6,'recommendation-qualification.v1',
         'recommendation-visibility.v1','recommendation-commercial-fit.v4',
         'TARGET_MARKET','US','United States','en',2840,'en',
         '{}'::jsonb,'recommendation-qualification.v1','pool-test'
       )`,
      [
        id(699),
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        id(6),
      ],
    );
    await client.query(
      `UPDATE backlink_commercial_inventory_policies
          SET visible_pool_state='active',
              paid_refill_tier='exact_product_target_market',
              paid_refill_round=1,
              resource_refill_tier='curated_resource_library',
              resource_refill_round=1,
              attempted_refill_tiers=$5::jsonb
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND project_context_version_id=$4`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        JSON.stringify([
          {
            tier: "curated_resource_library",
            round: 1,
            window: 1,
            rawCandidateCount: 0,
            eligibleCandidateCount: 0,
          },
          {
            tier: "curated_resource_library",
            round: 1,
            window: 2,
            rawCandidateCount: 0,
            eligibleCandidateCount: 0,
          },
        ]),
      ],
    );
    const historicalJobId = id(700);
    const historicalRefillId = id(701);
    const historicalWindowKey = buildCommercialRefillWindowKey({
      websiteProjectId,
      projectContextVersionId: recommendationContextVersionId,
      visiblePoolGeneration: 2,
      tier: "exact_product_target_market",
      round: 1,
      window: 1,
    });
    await client.query(
      `INSERT INTO backlink_jobs (
         id,organization_id,workspace_id,website_project_id,job_type,
         source_object_type,source_object_id,status,step,progress,workflow_id,
         correlation_id,result_summary,finished_at,created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,'recommendation_refill','project_context_version',$5,
         'partial_success','paused_budget',99,$6,$7,
         '{"outcome":"PAUSED_BUDGET"}'::jsonb,$8,'historical-test',
         'historical-test'
       )`,
      [
        historicalJobId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        `recommendation-refill:${historicalJobId}`,
        `historical-refill:${historicalJobId}`,
        new Date("2026-08-19T12:00:00.000Z"),
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_refills (
         id,organization_id,workspace_id,website_project_id,job_id,
         recommendation_context_version_id,visible_pool_generation,
         trigger_reason,low_watermark,high_watermark,refill_window_key,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,2,'manual',9,10,$7,
         'historical-test','historical-test'
       )`,
      [
        historicalRefillId,
        organizationId,
        workspaceId,
        websiteProjectId,
        historicalJobId,
        recommendationContextVersionId,
        historicalWindowKey,
      ],
    );
    await expect(
      planCommercialSupplyOperationStep(client, {
        organizationId,
        workspaceId,
        websiteProjectId,
        projectContextVersionId: recommendationContextVersionId,
        visiblePoolGeneration: 2,
        jobId: started.jobId,
        actorId: "pool-operator",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId,
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls: 4,
          maxCostMicros: 1_000_000,
          authorizedBy: "pool-operator",
        },
        now: new Date("2026-08-20T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "execute",
      source: "paid",
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 2,
    });
    await expect(
      planCommercialSupplyOperationStep(client, {
        organizationId,
        workspaceId,
        websiteProjectId,
        projectContextVersionId: recommendationContextVersionId,
        visiblePoolGeneration: 2,
        jobId: started.jobId,
        actorId: "pool-operator",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId,
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls: 4,
          maxCostMicros: 1_000_000,
          authorizedBy: "pool-operator",
        },
        now: new Date("2026-08-20T12:01:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "execute",
      source: "paid",
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 2,
    });
    const [activePolicy] = (
      await client.query(
        `SELECT visible_pool_state AS "visiblePoolState",
                attempted_refill_tiers AS "attemptedRefillTiers"
           FROM backlink_commercial_inventory_policies
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
            AND project_context_version_id=$4`,
        [
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationContextVersionId,
        ],
      )
    ).rows as readonly Readonly<{
      visiblePoolState: string;
      attemptedRefillTiers: readonly Record<string, unknown>[];
    }>[];
    expect(activePolicy?.visiblePoolState).toBe("active");
    expect(activePolicy?.attemptedRefillTiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "exact_product_target_market",
          round: 1,
          window: 2,
        }),
      ]),
    );
    expect(
      (
        await client.query(
          `SELECT job_id AS "jobId",refill_window_key AS "refillWindowKey"
             FROM backlink_recommendation_refills
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND recommendation_context_version_id=$4
              AND visible_pool_generation=2
            ORDER BY job_id`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([
      {
        jobId: started.jobId,
        refillWindowKey: buildCommercialRefillWindowKey({
          websiteProjectId,
          projectContextVersionId: recommendationContextVersionId,
          visiblePoolGeneration: 2,
          tier: "exact_product_target_market",
          round: 1,
          window: 2,
        }),
      },
      {
        jobId: historicalJobId,
        refillWindowKey: historicalWindowKey,
      },
    ].sort((left, right) => left.jobId.localeCompare(right.jobId)));

    const settledAttempts = (activePolicy?.attemptedRefillTiers ?? []).map(
      (attempt) =>
        attempt.tier === "exact_product_target_market"
        && attempt.round === 1
        && attempt.window === 2
          ? {
              ...attempt,
              rawCandidateCount: 25,
              eligibleCandidateCount: 7,
            }
          : attempt,
    );
    expect(settledAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tier: "exact_product_target_market",
          round: 1,
          window: 2,
          rawCandidateCount: 25,
          eligibleCandidateCount: 7,
        }),
      ]),
    );
    await client.query(
      `UPDATE backlink_commercial_inventory_policies
          SET attempted_refill_tiers=$5::jsonb
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND project_context_version_id=$4`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        JSON.stringify(settledAttempts),
      ],
    );

    await expect(
      planCommercialSupplyOperationStep(client, {
        organizationId,
        workspaceId,
        websiteProjectId,
        projectContextVersionId: recommendationContextVersionId,
        visiblePoolGeneration: 2,
        jobId: started.jobId,
        actorId: "pool-operator",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId,
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls: 4,
          maxCostMicros: 1_000_000,
          authorizedBy: "pool-operator",
        },
        now: new Date("2026-08-20T12:02:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "execute",
      source: "paid",
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 3,
    });
    expect(
      (
        await client.query(
          `SELECT job_id AS "jobId",refill_window_key AS "refillWindowKey"
             FROM backlink_recommendation_refills
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND recommendation_context_version_id=$4
              AND visible_pool_generation=2
            ORDER BY job_id`,
          [
            organizationId,
            workspaceId,
            websiteProjectId,
            recommendationContextVersionId,
          ],
        )
      ).rows,
    ).toEqual([
      {
        jobId: started.jobId,
        refillWindowKey: buildCommercialRefillWindowKey({
          websiteProjectId,
          projectContextVersionId: recommendationContextVersionId,
          visiblePoolGeneration: 2,
          tier: "exact_product_target_market",
          round: 1,
          window: 3,
        }),
      },
      {
        jobId: historicalJobId,
        refillWindowKey: historicalWindowKey,
      },
    ].sort((left, right) => left.jobId.localeCompare(right.jobId)));
    expect(
      (
        await client.query(
          `SELECT
             job.result_summary->>'providerOperationId'
               AS "jobOperationId",
             job.result_summary->'providerBudgetAuthorization'
               AS "jobAuthorization",
             job.result_summary->>'supplyMode' AS "jobSupplyMode",
             operation.authorization_snapshot AS "operationAuthorization",
             operation.status AS "operationStatus"
             FROM backlink_jobs AS job
             JOIN backlink_commercial_supply_operations AS operation
               ON operation.organization_id=job.organization_id
              AND operation.workspace_id=job.workspace_id
              AND operation.website_project_id=job.website_project_id
              AND operation.job_id=job.id
            WHERE job.id=$1`,
          [started.jobId],
        )
      ).rows,
    ).toEqual([{
      jobOperationId: providerOperationId,
      jobAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      jobSupplyMode: null,
      operationAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
        authorizedBy: "pool-operator",
      },
      operationStatus: "authorized",
    }]);
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_provider_requests)
               AS "providerRequestCount",
             (SELECT count(*)::integer
                FROM backlink_provider_usage_ledger) AS "usageCount",
             (SELECT count(*)::integer FROM provider_fetch_leases)
               AS "leaseCount"`,
        )
      ).rows,
    ).toEqual([{
      providerRequestCount: 0,
      usageCount: 0,
      leaseCount: 0,
    }]);

    const historicalWindowJobIds = [id(770), id(771)] as const;
    const historicalWindowRefillIds = [id(772), id(773)] as const;
    const historicalWindowKeys = [3, 4].map((window) =>
      buildCommercialRefillWindowKey({
        websiteProjectId,
        projectContextVersionId: recommendationContextVersionId,
        visiblePoolGeneration: 2,
        tier: "exact_product_target_market",
        round: 1,
        window,
      })
    );
    const completedWindowKeys = [5, 6].map((window) =>
      buildCommercialRefillWindowKey({
        websiteProjectId,
        projectContextVersionId: recommendationContextVersionId,
        visiblePoolGeneration: 2,
        tier: "exact_product_target_market",
        round: 1,
        window,
      })
    );
    await client.query(
      `UPDATE backlink_recommendation_refills
          SET refill_window_key=$5,updated_by='immutable-window-test'
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND job_id=$4`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        started.jobId,
        completedWindowKeys[1],
      ],
    );
    await client.query(
      `UPDATE backlink_commercial_inventory_policies
          SET attempted_refill_tiers=$5::jsonb
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND project_context_version_id=$4`,
      [
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        JSON.stringify([
          ...settledAttempts,
          {
            tier: "exact_product_target_market",
            round: 1,
            window: 6,
            rawCandidateCount: 25,
            eligibleCandidateCount: 4,
          },
        ]),
      ],
    );
    await client.query(
      `INSERT INTO backlink_jobs (
         id,organization_id,workspace_id,website_project_id,job_type,
         source_object_type,source_object_id,status,step,progress,workflow_id,
         correlation_id,result_summary,finished_at,created_by,updated_by
       ) VALUES
       (
         $1,$3,$4,$5,'recommendation_refill','project_context_version',$6,
         'partial_success','paused_budget',99,$7,$8,
         '{"outcome":"PAUSED_BUDGET"}'::jsonb,$9,'historical-test',
         'historical-test'
       ),
       (
         $2,$3,$4,$5,'recommendation_refill','project_context_version',$6,
         'partial_success','paused_budget',99,$10,$11,
         '{"outcome":"PAUSED_BUDGET"}'::jsonb,$9,'historical-test',
         'historical-test'
       )`,
      [
        historicalWindowJobIds[0],
        historicalWindowJobIds[1],
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        `recommendation-refill:${historicalWindowJobIds[0]}`,
        `historical-refill:${historicalWindowJobIds[0]}`,
        new Date("2026-08-19T13:00:00.000Z"),
        `recommendation-refill:${historicalWindowJobIds[1]}`,
        `historical-refill:${historicalWindowJobIds[1]}`,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_refills (
         id,organization_id,workspace_id,website_project_id,job_id,
         recommendation_context_version_id,visible_pool_generation,
         trigger_reason,low_watermark,high_watermark,refill_window_key,
         created_by,updated_by
       ) VALUES
       ($1,$3,$4,$5,$6,$8,2,'manual',9,10,$9,'historical-test',
        'historical-test'),
       ($2,$3,$4,$5,$7,$8,2,'manual',9,10,$10,'historical-test',
        'historical-test')`,
      [
        historicalWindowRefillIds[0],
        historicalWindowRefillIds[1],
        organizationId,
        workspaceId,
        websiteProjectId,
        historicalWindowJobIds[0],
        historicalWindowJobIds[1],
        recommendationContextVersionId,
        historicalWindowKeys[0],
        historicalWindowKeys[1],
      ],
    );
    const immutableBlueprintId = id(774);
    await client.query(
      `INSERT INTO backlink_commercial_discovery_blueprints (
         id,organization_id,workspace_id,website_project_id,
         project_context_version_id,blueprint_version,generator,schema_version,
         prompt_version,rule_version,blueprint,evidence_refs,generated_at,
         created_by
       ) VALUES (
         $1,$2,$3,$4,$5,3,'DETERMINISTIC_FALLBACK',
         'immutable-window.v1','immutable-window.v1','immutable-window.v1',
         '{}'::jsonb,'[]'::jsonb,$6,'immutable-window-test'
       )`,
      [
        immutableBlueprintId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
        new Date("2026-08-20T12:03:00.000Z"),
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_discovery_batches (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         project_context_version_id,status,idempotency_key,request_intent,
         source_types,provider_request_fingerprints,paid_cost_micros,
         started_at,finished_at,created_by,visible_pool_generation,
         refill_job_id,refill_tier,refill_round,raw_candidate_count,
         eligible_candidate_count
       ) VALUES
       (
         $1,$3,$4,$5,$6,$7,'completed',$8,'DISCOVERY',
         '["SERP"]'::jsonb,'[]'::jsonb,0,$9,$10,'immutable-window-test',2,
         $11,'exact_product_target_market',1,25,4
       ),
       (
         $2,$3,$4,$5,$6,$7,'completed',$12,'DISCOVERY',
         '["SERP"]'::jsonb,'[]'::jsonb,0,$9,$10,'immutable-window-test',2,
         $11,'exact_product_target_market',1,25,4
       )`,
      [
        id(775),
        id(776),
        organizationId,
        workspaceId,
        websiteProjectId,
        immutableBlueprintId,
        recommendationContextVersionId,
        `commercial-discovery:${completedWindowKeys[0]}`,
        new Date("2026-08-20T12:03:00.000Z"),
        new Date("2026-08-20T12:04:00.000Z"),
        historicalJobId,
        `commercial-discovery:${completedWindowKeys[1]}`,
      ],
    );
    const planAfterImmutableHistory = () =>
      planCommercialSupplyOperationStep(client, {
        organizationId,
        workspaceId,
        websiteProjectId,
        projectContextVersionId: recommendationContextVersionId,
        visiblePoolGeneration: 2,
        jobId: started.jobId,
        actorId: "pool-operator",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId,
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_bounded_real_refill",
          maxPaidCalls: 4,
          maxCostMicros: 1_000_000,
          authorizedBy: "pool-operator",
        },
        now: new Date("2026-08-20T12:05:00.000Z"),
      });
    await expect(planAfterImmutableHistory()).resolves.toMatchObject({
      status: "execute",
      source: "paid",
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 7,
    });
    await expect(planAfterImmutableHistory()).resolves.toMatchObject({
      status: "execute",
      source: "paid",
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 7,
    });
    expect(
      (
        await client.query(
          `SELECT refill_window_key AS "refillWindowKey"
             FROM backlink_recommendation_refills
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND job_id=$4`,
          [organizationId, workspaceId, websiteProjectId, started.jobId],
        )
      ).rows,
    ).toEqual([{
      refillWindowKey: buildCommercialRefillWindowKey({
        websiteProjectId,
        projectContextVersionId: recommendationContextVersionId,
        visiblePoolGeneration: 2,
        tier: "exact_product_target_market",
        round: 1,
        window: 7,
      }),
    }]);
    expect(
      (
        await client.query(
          `SELECT idempotency_key AS "idempotencyKey",status
             FROM backlink_commercial_discovery_batches
            WHERE id IN ($1,$2)
            ORDER BY id`,
          [id(775), id(776)],
        )
      ).rows,
    ).toEqual(completedWindowKeys.map((key) => ({
      idempotencyKey: `commercial-discovery:${key}`,
      status: "completed",
    })));
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_provider_requests)
               AS "providerRequestCount",
             (SELECT count(*)::integer
                FROM backlink_provider_usage_ledger) AS "usageCount",
             (SELECT count(*)::integer FROM provider_fetch_leases)
               AS "leaseCount"`,
        )
      ).rows,
    ).toEqual([{
      providerRequestCount: 0,
      usageCount: 0,
      leaseCount: 0,
    }]);

    await expect(
      commands.requestRefill({
        ...refillInput,
        visiblePoolGeneration: 1,
      }),
    ).rejects.toThrow(
      "ExpectedVersion does not match the current resource version.",
    );
  });

  it("queues one idempotent existing-evidence reassessment without provider state", async () => {
    const reassessmentProjectId = id(503);
    const reassessmentContextId = id(504);
    const context = {
      actor: createActorContext({
        userId: "reassessment-operator",
        sessionId: "reassessment-session",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId: reassessmentProjectId,
        canonicalDomain: "reassessment-owner.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-reassessment-v1",
        promotionTargetVersionId: "target-reassessment-v1",
      }),
    };
    await client.query(
      `INSERT INTO backlink_commercial_inventory_policies (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,visible_pool_generation,
         visible_pool_state,updated_by
       ) VALUES ($1,$2,$3,$4,1,'active','reassessment-test')`,
      [
        organizationId,
        workspaceId,
        reassessmentProjectId,
        reassessmentContextId,
      ],
    );
    const commands = createRecommendationCommands(client);
    const input = {
      context,
      requestId: "reassessment-request-1",
      idempotencyKey:
        `recommendation-v4-reassessment:${reassessmentContextId}:g1`,
      expectedVersion: 0,
      recommendationContextVersionId: reassessmentContextId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      refillWindowKey:
        `v4-reassessment:${reassessmentContextId}:g1:rule-current`,
      supplyMode: "existing_evidence",
    } as const;

    const started = await commands.requestRefill(input);
    expect(started).toMatchObject({ status: "queued", replayed: false });
    expect(await commands.requestRefill(input)).toMatchObject({
      operationId: started.operationId,
      jobId: started.jobId,
      outboxEventId: started.outboxEventId,
      status: "queued",
      replayed: true,
    });

    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer
                FROM backlink_recommendation_refills
               WHERE website_project_id=$1) AS "refillCount",
             (SELECT count(*)::integer
                FROM backlink_jobs
               WHERE website_project_id=$1) AS "jobCount",
             (SELECT count(*)::integer
                FROM backlink_outbox_events
               WHERE website_project_id=$1) AS "outboxCount",
             (SELECT count(*)::integer
                FROM backlink_commercial_supply_operations
               WHERE website_project_id=$1) AS "supplyOperationCount",
             (SELECT count(*)::integer
                FROM provider_batch_requests
               WHERE website_project_id=$1) AS "providerRequestCount",
             (SELECT count(*)::integer
                FROM backlink_provider_usage_ledger
               WHERE website_project_id=$1) AS "usageCount",
             (SELECT count(*)::integer
                FROM provider_fetch_leases) AS "leaseCount"`,
          [reassessmentProjectId],
        )
      ).rows,
    ).toEqual([{
      refillCount: 1,
      jobCount: 1,
      outboxCount: 1,
      supplyOperationCount: 0,
      providerRequestCount: 0,
      usageCount: 0,
      leaseCount: 0,
    }]);
    expect(
      (
        await client.query(
          `SELECT job.result_summary->>'supplyMode' AS "jobSupplyMode",
                  event.payload->>'supplyMode' AS "outboxSupplyMode",
                  job.result_summary ? 'providerBudgetAuthorization'
                    AS "hasProviderBudget",
                  job.result_summary ? 'providerOperationId'
                    AS "hasProviderOperation",
                  event.payload ? 'providerBudgetAuthorization'
                    AS "outboxHasProviderBudget",
                  event.payload ? 'providerOperationId'
                    AS "outboxHasProviderOperation"
             FROM backlink_jobs AS job
             JOIN backlink_outbox_events AS event
               ON event.aggregate_id=job.id
            WHERE job.id=$1`,
          [started.jobId],
        )
      ).rows,
    ).toEqual([{
      jobSupplyMode: "existing_evidence",
      outboxSupplyMode: "existing_evidence",
      hasProviderBudget: false,
      hasProviderOperation: false,
      outboxHasProviderBudget: false,
      outboxHasProviderOperation: false,
    }]);
    await client.query(
      `UPDATE backlink_commercial_inventory_policies
          SET visible_pool_state='building'
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND project_context_version_id=$4`,
      [
        organizationId,
        workspaceId,
        reassessmentProjectId,
        reassessmentContextId,
      ],
    );
    await expect(
      reserveRecommendationRefillJob(client, {
        organizationId,
        workspaceId,
        websiteProjectId: reassessmentProjectId,
        recommendationContextVersionId: reassessmentContextId,
        visiblePoolGeneration: 1,
        jobId: started.jobId,
        targetPublishedCount: 10,
      }),
    ).resolves.toMatchObject({
      status: "started",
      jobId: started.jobId,
    });
    expect(
      (
        await client.query(
          `SELECT result_summary->>'supplyMode' AS "supplyMode",
                  result_summary ? 'providerOperationId'
                    AS "hasProviderOperation",
                  result_summary ? 'providerBudgetAuthorization'
                    AS "hasProviderBudget"
             FROM backlink_jobs
            WHERE id=$1`,
          [started.jobId],
        )
      ).rows,
    ).toEqual([{
      supplyMode: "existing_evidence",
      hasProviderOperation: false,
      hasProviderBudget: false,
    }]);
  });

  it("rearms one unpublished existing-evidence terminal under concurrent recovery", async () => {
    const recoveryProjectId = id(803);
    const recoveryContextId = id(804);
    const outreachProfileId = id(805);
    const inputPinId = id(806);
    const generationContractId = id(807);
    const blueprintId = id(808);
    const discoveryBatchId = id(809);
    const eligibleCandidateId = id(810);
    const ineligibleCandidateId = id(811);
    const staleQualificationFactId = id(812);
    const recoveryWindowKey =
      `commercial-existing:${recoveryProjectId}:${recoveryContextId}:g1:publication`;
    const context = {
      actor: createActorContext({
        userId: "publication-recovery-operator",
        sessionId: "publication-recovery-session",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId: recoveryProjectId,
        canonicalDomain: "publication-recovery-owner.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-publication-recovery-v1",
        promotionTargetVersionId: "target-publication-recovery-v1",
      }),
    };
    await client.query(
      `INSERT INTO backlink_project_context_snapshots (
         id,organization_id,workspace_id,website_project_id,snapshot_version,
         project_status,canonical_domain,locale,country_code,
         profile_version_id,promotion_target_version_id,products,keywords,
         created_by
       ) VALUES (
         $1,$2,$3,$4,1,'ACTIVE','publication-recovery-owner.test',
         'en-US','US','profile-publication-recovery-v1',
         'target-publication-recovery-v1','["streaming entertainment"]'::jsonb,
         '["film reviews"]'::jsonb,'publication-recovery-test'
       )`,
      [recoveryContextId, organizationId, workspaceId, recoveryProjectId],
    );
    await client.query(
      `INSERT INTO backlink_outreach_profile_versions (
         id,organization_id,workspace_id,website_project_id,
         profile_version_id,promotion_target_version_id,keywords_and_topics,
         products_and_services,target_urls,target_audiences,partnership_goals,
         market,location,language,authorized_discovery_sources,
         immutable_fingerprint,created_by
       ) VALUES (
         $1,$2,$3,$4,'profile-publication-recovery-v1',
         'target-publication-recovery-v1','["film reviews"]'::jsonb,
         '["streaming entertainment"]'::jsonb,'[]'::jsonb,
         '["streaming viewers"]'::jsonb,'["editorial review"]'::jsonb,
         'US','US','en','["shared-seo-evidence"]'::jsonb,
         'publication-recovery-profile-v1','publication-recovery-test'
       )`,
      [outreachProfileId, organizationId, workspaceId, recoveryProjectId],
    );
    await client.query(
      `INSERT INTO backlink_generation_input_pins (
         id,organization_id,workspace_id,website_project_id,
         project_context_version,site_profile_version_id,
         outreach_profile_version_id,promotion_target_version_id,
         keyword_evidence_snapshot_ids,shared_evidence_snapshot_ids,market,
         qualification_contract_version,immutable_fingerprint,created_by
       ) VALUES (
         $1,$2,$3,$4,1,'profile-publication-recovery-v1',$5,
         'target-publication-recovery-v1','[]'::jsonb,'[]'::jsonb,'US',
         'recommendation-qualification.v1',
         'publication-recovery-input-v1','publication-recovery-test'
       )`,
      [
        inputPinId,
        organizationId,
        workspaceId,
        recoveryProjectId,
        outreachProfileId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_inventory_policies (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,visible_pool_generation,
         visible_pool_state,updated_by
       ) VALUES ($1,$2,$3,$4,1,'active','publication-recovery-test')`,
      [organizationId, workspaceId, recoveryProjectId, recoveryContextId],
    );
    const input = {
      context,
      requestId: "publication-recovery-start",
      idempotencyKey:
        `recommendation-publication-recovery:${recoveryContextId}:g1`,
      expectedVersion: 0,
      recommendationContextVersionId: recoveryContextId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      refillWindowKey: recoveryWindowKey,
      supplyMode: "existing_evidence",
    } as const;
    const started = await createRecommendationCommands(client).requestRefill(
      input,
    );
    await client.query(
      `INSERT INTO backlink_recommendation_generation_contracts (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,visible_pool_generation,
         input_pin_id,qualification_contract_version,
         visibility_contract_version,score_model_version,metric_scope,
         market,location,language,traffic_location_code,
         traffic_language_code,request_fingerprints,
         creator_worker_contract_version,created_by
       ) VALUES (
         $1,$2,$3,$4,$5,1,$6,'recommendation-qualification.v1',
         'recommendation-visibility.v1','recommendation-commercial-fit.v4',
         'TARGET_MARKET','US','United States','en',2840,'en',
         '{}'::jsonb,'recommendation-qualification.v1',
         'publication-recovery-test'
       )`,
      [
        generationContractId,
        organizationId,
        workspaceId,
        recoveryProjectId,
        recoveryContextId,
        inputPinId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_discovery_blueprints (
         id,organization_id,workspace_id,website_project_id,
         project_context_version_id,blueprint_version,generator,schema_version,
         prompt_version,rule_version,blueprint,evidence_refs,generated_at,
         created_by
       ) VALUES (
         $1,$2,$3,$4,$5,1,'DETERMINISTIC_FALLBACK',
         'publication-recovery.v1','publication-recovery.v1',
         'publication-recovery.v1','{}'::jsonb,'[]'::jsonb,now(),
         'publication-recovery-test'
       )`,
      [
        blueprintId,
        organizationId,
        workspaceId,
        recoveryProjectId,
        recoveryContextId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_discovery_batches (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         project_context_version_id,status,idempotency_key,request_intent,
         source_types,provider_request_fingerprints,paid_cost_micros,
         started_at,finished_at,created_by,visible_pool_generation,
         refill_job_id,raw_candidate_count,eligible_candidate_count
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'completed',$7,'DISCOVERY',
         '["EXISTING_HISTORY"]'::jsonb,'[]'::jsonb,0,now(),now(),
         'publication-recovery-test',1,$8,2,1
       )`,
      [
        discoveryBatchId,
        organizationId,
        workspaceId,
        recoveryProjectId,
        blueprintId,
        recoveryContextId,
        `commercial-discovery:${recoveryWindowKey}`,
        started.jobId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_candidates (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         discovery_batch_id,project_context_version_id,canonical_domain,
         source_types,static_assessment,gate_decision,commercial_score,
         score_model_version,state,created_by,updated_by,visible_pool_generation
       ) VALUES
       (
         $1,$3,$4,$5,$6,$7,$8,'eligible-publication.test',
         '["EXISTING_HISTORY"]'::jsonb,'{}'::jsonb,
         '{"decision":"eligible","hitGates":[],"missingEvidence":[]}'::jsonb,
         '{"decision":"eligible","total":57,"scoreModelVersion":"recommendation-commercial-fit.v4","ruleVersion":"recommendation-commercial-fit-rules.v4.2","admission":{"appliedThreshold":50}}'::jsonb,
         'recommendation-commercial-fit.v4','candidate_ready',
         'publication-recovery-test','publication-recovery-test',1
       ),
       (
         $2,$3,$4,$5,$6,$7,$8,'ineligible-publication.test',
         '["EXISTING_HISTORY"]'::jsonb,'{}'::jsonb,
         '{"decision":"ineligible","hitGates":["pbn_or_link_farm"],"missingEvidence":[]}'::jsonb,
         '{"decision":"ineligible","total":80,"scoreModelVersion":"recommendation-commercial-fit.v4","ruleVersion":"recommendation-commercial-fit-rules.v4.2","admission":{"appliedThreshold":50}}'::jsonb,
         'recommendation-commercial-fit.v4','candidate_ready',
         'publication-recovery-test','publication-recovery-test',1
       )`,
      [
        eligibleCandidateId,
        ineligibleCandidateId,
        organizationId,
        workspaceId,
        recoveryProjectId,
        blueprintId,
        discoveryBatchId,
        recoveryContextId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_qualification_facts (
         id,organization_id,workspace_id,website_project_id,
         generation_contract_id,recommendation_context_version_id,candidate_id,
         canonical_domain,metric_scope,accessibility_decision,attempt,decision,
         decision_reason_code,score_model_version,rule_version,
         fact_contract_version,worker_contract_version,request_fingerprints,
         evidence,observed_at,created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'eligible-publication.test','TARGET_MARKET',
         'insufficient_data',1,'ineligible','STALE_PRODUCER_MAPPING',
         'recommendation-commercial-fit.v4',
         'recommendation-commercial-fit-rules.v4.2',
         'recommendation-qualification.v1','recommendation-qualification.v1',
         '{}'::jsonb,'{}'::jsonb,now(),'publication-recovery-test'
       )`,
      [
        staleQualificationFactId,
        organizationId,
        workspaceId,
        recoveryProjectId,
        generationContractId,
        recoveryContextId,
        eligibleCandidateId,
      ],
    );
    const terminalSummary = {
      supplyMode: "existing_evidence",
      outcome: "SUPPLY_FLOOR_REACHED",
      terminalReason: "EXISTING_EVIDENCE_NO_PROGRESS",
      existingCandidatesCompleted: true,
      refillWindowKey: recoveryWindowKey,
    };
    await client.query(
      `UPDATE backlink_jobs
          SET status='partial_success',
              step='existing_evidence_no_progress',
              progress=100,
              result_summary=$2::jsonb,
              finished_at=now(),
              version=version+1
        WHERE id=$1`,
      [started.jobId, JSON.stringify(terminalSummary)],
    );
    await client.query(
      `UPDATE backlink_outbox_events
          SET status='published',published_at=now()
        WHERE id=$1`,
      [started.outboxEventId],
    );
    const beforeRecovery = (
      await client.query(
        `SELECT version FROM backlink_jobs WHERE id=$1`,
        [started.jobId],
      )
    ).rows[0] as { version: number };
    const recoveryInput = {
      context,
      requestId: "publication-recovery-request",
      expectedVersion: 0,
      recommendationContextVersionId: recoveryContextId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      operationId: started.operationId,
    } as const;
    const concurrentClients = [
      new PgClient({ connectionString: harness.connectionString }),
      new PgClient({ connectionString: harness.connectionString }),
    ];
    await Promise.all(concurrentClients.map(async (concurrentClient) => {
      await concurrentClient.connect();
      await concurrentClient.query("SET search_path = backlinks, pg_catalog");
    }));
    try {
      const recovered = await Promise.all(
        concurrentClients.map(async (concurrentClient) => {
          await concurrentClient.query("BEGIN");
          try {
            const result = await createRecommendationCommands(
              concurrentClient,
            ).requestRefill(recoveryInput);
            await concurrentClient.query("COMMIT");
            return result;
          } catch (error) {
            await concurrentClient.query("ROLLBACK");
            throw error;
          }
        }),
      );
      expect(recovered.every(({ replayed }) => replayed)).toBe(true);
      expect(new Set(recovered.map(({ jobId }) => jobId))).toEqual(
        new Set([started.jobId]),
      );
    } finally {
      await Promise.all(concurrentClients.map((concurrentClient) =>
        concurrentClient.end()
      ));
    }
    const recoveryKey =
      `existing-evidence-publication-recovery:${started.jobId}:${recoveryWindowKey}`;
    expect(
      (
        await client.query(
          `SELECT job.status,job.step,job.version,
                  job.result_summary ? 'existingCandidatesCompleted'
                    AS "existingCandidatesCompleted",
                  job.result_summary->>'existingEvidencePublicationRecoveryKey'
                    AS "jobRecoveryKey",
                  event.status AS "outboxStatus",
                  event.attempt_count AS "outboxAttemptCount",
                  event.published_at AS "outboxPublishedAt",
                  idempotency.response_body
                    ->>'existingEvidencePublicationRecoveryKey'
                    AS "idempotencyRecoveryKey"
             FROM backlink_jobs AS job
             JOIN backlink_outbox_events AS event
               ON event.id=$2
             JOIN backlink_idempotency_records AS idempotency
               ON idempotency.workspace_id=job.workspace_id
              AND idempotency.command_type='recommendation.refill'
              AND idempotency.response_body->>'jobId'=job.id::text
            WHERE job.id=$1`,
          [started.jobId, started.outboxEventId],
        )
      ).rows,
    ).toEqual([{
      status: "queued",
      step: "recovery_queued",
      version: Number(beforeRecovery.version) + 1,
      existingCandidatesCompleted: false,
      jobRecoveryKey: recoveryKey,
      outboxStatus: "pending",
      outboxAttemptCount: 0,
      outboxPublishedAt: null,
      idempotencyRecoveryKey: recoveryKey,
    }]);
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_recommendation_refills
               WHERE website_project_id=$1) AS "refillCount",
             (SELECT count(*)::integer FROM backlink_jobs
               WHERE website_project_id=$1) AS "jobCount",
             (SELECT count(*)::integer FROM backlink_outbox_events
               WHERE website_project_id=$1) AS "outboxCount",
             (SELECT count(*)::integer FROM provider_batch_requests
               WHERE website_project_id=$1) AS "providerRequestCount",
             (SELECT count(*)::integer FROM backlink_provider_usage_ledger
               WHERE website_project_id=$1) AS "usageCount"`,
          [recoveryProjectId],
        )
      ).rows,
    ).toEqual([{
      refillCount: 1,
      jobCount: 1,
      outboxCount: 1,
      providerRequestCount: 0,
      usageCount: 0,
    }]);

    await client.query(
      `UPDATE backlink_jobs
          SET status='partial_success',
              step='existing_evidence_no_progress',
              result_summary=$2::jsonb,
              finished_at=now()
        WHERE id=$1`,
      [
        started.jobId,
        JSON.stringify({
          ...terminalSummary,
          existingEvidencePublicationRecoveryKey: recoveryKey,
        }),
      ],
    );
    await client.query(
      `UPDATE backlink_outbox_events
          SET status='published',published_at=now()
        WHERE id=$1`,
      [started.outboxEventId],
    );
    await expect(
      createRecommendationCommands(client).requestRefill(recoveryInput),
    ).rejects.toThrow(
      "ExpectedVersion does not match the current resource version.",
    );
    expect(
      (
        await client.query(
          `SELECT status,step,version FROM backlink_jobs WHERE id=$1`,
          [started.jobId],
        )
      ).rows,
    ).toEqual([{
      status: "partial_success",
      step: "existing_evidence_no_progress",
      version: Number(beforeRecovery.version) + 1,
    }]);

    await client.query(
      `UPDATE backlink_commercial_candidates
          SET state='excluded'
        WHERE id=$1`,
      [eligibleCandidateId],
    );
    await client.query(
      `UPDATE backlink_idempotency_records
          SET response_body=response_body-'existingEvidencePublicationRecoveryKey'
        WHERE workspace_id=$1
          AND command_type='recommendation.refill'
          AND response_body->>'jobId'=$2`,
      [workspaceId, started.jobId],
    );
    await expect(
      createRecommendationCommands(client).requestRefill(recoveryInput),
    ).rejects.toThrow(
      "ExpectedVersion does not match the current resource version.",
    );
    expect(
      (
        await client.query(
          `SELECT status FROM backlink_outbox_events WHERE id=$1`,
          [started.outboxEventId],
        )
      ).rows,
    ).toEqual([{ status: "published" }]);

    await client.query(
      `UPDATE backlink_commercial_candidates
          SET state='candidate_ready'
        WHERE id=$1`,
      [eligibleCandidateId],
    );
    await client.query(
      `UPDATE backlink_jobs
          SET result_summary=jsonb_set(
                result_summary,'{terminalReason}',
                '"OTHER_TERMINAL_REASON"'::jsonb
              )
        WHERE id=$1`,
      [started.jobId],
    );
    await expect(
      createRecommendationCommands(client).requestRefill(recoveryInput),
    ).rejects.toThrow(
      "ExpectedVersion does not match the current resource version.",
    );
    expect(
      (
        await client.query(
          `SELECT
             (SELECT count(*)::integer FROM backlink_recommendation_refills
               WHERE website_project_id=$1) AS "refillCount",
             (SELECT count(*)::integer FROM provider_batch_requests
               WHERE website_project_id=$1) AS "providerRequestCount",
             (SELECT count(*)::integer FROM backlink_provider_usage_ledger
               WHERE website_project_id=$1) AS "usageCount"`,
          [recoveryProjectId],
        )
      ).rows,
    ).toEqual([{
      refillCount: 1,
      providerRequestCount: 0,
      usageCount: 0,
    }]);
  });

  it("creates one paid supply operation under concurrent idempotent refill requests", async () => {
    const concurrentProjectId = id(603);
    const concurrentContextId = id(604);
    const context = {
      actor: createActorContext({
        userId: "concurrent-operator",
        sessionId: "concurrent-session",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId: concurrentProjectId,
        canonicalDomain: "concurrent-owner.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-concurrent-v1",
        promotionTargetVersionId: "target-concurrent-v1",
      }),
    };
    await client.query(
      `INSERT INTO backlink_project_context_snapshots (
         id,organization_id,workspace_id,website_project_id,snapshot_version,
         project_status,canonical_domain,locale,country_code,
         profile_version_id,promotion_target_version_id,created_by
       ) VALUES (
         $1,$2,$3,$4,1,'ACTIVE','concurrent-owner.test','en-US','US',
         'profile-concurrent-v1','target-concurrent-v1','concurrent-test'
       )`,
      [
        concurrentContextId,
        organizationId,
        workspaceId,
        concurrentProjectId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_commercial_inventory_policies (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,visible_pool_generation,
         visible_pool_state,updated_by
       ) VALUES ($1,$2,$3,$4,1,'active','concurrent-test')`,
      [organizationId, workspaceId, concurrentProjectId, concurrentContextId],
    );
    const input = {
      context,
      requestId: "concurrent-refill-request",
      idempotencyKey:
        `recommendation-paid-refill:${concurrentContextId}:g1`,
      expectedVersion: 0,
      recommendationContextVersionId: concurrentContextId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      providerBudgetAuthorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 4,
        maxCostMicros: 1_000_000,
      },
    } as const;
    const clients = [
      new PgClient({ connectionString: harness.connectionString }),
      new PgClient({ connectionString: harness.connectionString }),
    ];
    await Promise.all(clients.map(async (concurrentClient) => {
      await concurrentClient.connect();
      await concurrentClient.query("SET search_path = backlinks, pg_catalog");
    }));
    try {
      const results = await Promise.all(
        clients.map(async (concurrentClient) => {
          await concurrentClient.query("BEGIN");
          try {
            const result = await createRecommendationCommands(
              concurrentClient,
            ).requestRefill(input);
            await concurrentClient.query("COMMIT");
            return result;
          } catch (error) {
            await concurrentClient.query("ROLLBACK");
            throw error;
          }
        }),
      );
      expect(results.map(({ replayed }) => replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(new Set(results.map(({ jobId }) => jobId)).size).toBe(1);
      expect(
        (
          await client.query(
            `SELECT count(*)::integer AS count,
                    (array_agg(id ORDER BY id))[1] AS "operationId",
                    (array_agg(job_id ORDER BY job_id))[1] AS "jobId"
               FROM backlink_commercial_supply_operations
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
                AND project_context_version_id=$4`,
            [
              organizationId,
              workspaceId,
              concurrentProjectId,
              concurrentContextId,
            ],
          )
        ).rows,
      ).toEqual([{
        count: 1,
        operationId:
          `commercial-refill-operation:${results[0]?.jobId as string}`,
        jobId: results[0]?.jobId,
      }]);
      expect(
        (
          await client.query(
            `SELECT
               (SELECT count(*)::integer
                  FROM provider_batch_requests
                 WHERE website_project_id=$1) AS "providerRequestCount",
               (SELECT count(*)::integer
                  FROM backlink_provider_usage_ledger
                 WHERE website_project_id=$1) AS "usageCount"`,
            [concurrentProjectId],
          )
        ).rows,
      ).toEqual([{ providerRequestCount: 0, usageCount: 0 }]);
    } finally {
      await Promise.all(clients.map((concurrentClient) =>
        concurrentClient.end()
      ));
    }
  });
});
