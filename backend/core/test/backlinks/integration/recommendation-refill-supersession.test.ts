import { createRequire } from "node:module";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  arbitrateRecommendationRefillFailure,
  assertRecommendationRefillProviderExecutionCurrent,
  completeRecommendationRefillSupersession,
  requestRecommendationRefillSupersession,
} from "../../../src/modules/backlinks/application/services/recommendation-refill-supersession.service.js";
import { reconcileRecommendationRefillOrphans } from "../../../src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import type { RecommendationRefillSupersessionSignal } from "../../../src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

type RuntimePool = BacklinkTenantPool & {
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
};
const id = (value: number) =>
  `018f1000-0000-7000-8000-${value.toString().padStart(12, "0")}`;

const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const oldContextVersionId = id(4);
const newContextVersionId = id(5);
const oldOutreachProfileId = id(6);
const newOutreachProfileId = id(7);
const oldPinId = id(8);
const newPinId = id(9);
const jobId = id(10);
const refillId = id(11);
const blueprintId = id(12);
const discoveryBatchId = id(13);
const requestedLifecycleId = id(14);
const supersededLifecycleId = id(15);
const supersededAuditId = id(16);
const providerRequestId = id(17);
const providerBudgetId = id(18);
const providerUsageId = id(19);
const siblingJobId = id(20);
const siblingRefillId = id(21);
const generationContractId = id(22);
const projectContractId = id(23);
const workflowId = "backlinks-recommendation-refill:legacy-v7";
const siblingWorkflowId = "backlinks-recommendation-refill:legacy-v7-sibling";
const batchIdempotencyKey =
  "commercial-discovery:recommendation-refill:legacy-v7";
const providerRequestIdentity = "recommendation-refill:legacy-v7:provider";
const providerRequestFingerprint = "b".repeat(64);
const providerBudgetReservationId = "reservation-v7";
const now = new Date("2026-08-19T06:00:00.000Z");

const signal: RecommendationRefillSupersessionSignal = Object.freeze({
  contractVersion: 1,
  organizationId,
  workspaceId,
  websiteProjectId,
  jobId,
  workflowId,
  oldContext: Object.freeze({
    contextVersionId: oldContextVersionId,
    snapshotVersion: 7,
    profileVersionId: "profile-v3",
    promotionTargetVersionId: "promotion-v2",
    generationInputFingerprint: "generation-v7",
  }),
  authoritativeContext: Object.freeze({
    contextVersionId: newContextVersionId,
    snapshotVersion: 8,
    profileVersionId: "profile-v4",
    promotionTargetVersionId: "promotion-v2",
    generationInputFingerprint: "generation-v8",
  }),
  actorId: "stage2e-reconciliation",
  correlationId: "stage2e-supersession",
  requestId: "stage2e-supersession",
  idempotencyKey: "recommendation-refill.supersede:legacy-v7:v8",
  lifecycleEventId: supersededLifecycleId,
  auditEventId: supersededAuditId,
});

async function migrateBacklinks(client: RuntimeClient): Promise<void> {
  await installBacklinksManifestAfterFoundation(client, "0092");
}

async function seedSupersededRefill(client: RuntimeClient): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_project_context_snapshots (
       id,organization_id,workspace_id,website_project_id,snapshot_version,
       project_status,canonical_domain,locale,country_code,
       profile_version_id,promotion_target_version_id,products,keywords,
       target_urls,target_market,target_audiences,partnership_goals,created_by
     ) VALUES
     (
       $1,$3,$4,$5,7,'ACTIVE','example.test','en','ZA',
       'profile-v3','promotion-v2','["film reviews"]'::jsonb,
       '["film reviews"]'::jsonb,'["https://example.test/watch"]'::jsonb,
       'ZA','["viewers"]'::jsonb,'["editorial"]'::jsonb,'stage2e-test'
     ),
     (
       $2,$3,$4,$5,8,'ACTIVE','example.test','en','ZA',
       'profile-v4','promotion-v2','["film reviews"]'::jsonb,
       '["film reviews"]'::jsonb,'["https://example.test/watch"]'::jsonb,
       'ZA','["viewers"]'::jsonb,'["editorial"]'::jsonb,'stage2e-test'
     )`,
    [
      oldContextVersionId,
      newContextVersionId,
      organizationId,
      workspaceId,
      websiteProjectId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_outreach_profile_versions (
       id,organization_id,workspace_id,website_project_id,
       profile_version_id,promotion_target_version_id,keywords_and_topics,
       products_and_services,target_urls,target_audiences,partnership_goals,
       market,location,language,authorized_discovery_sources,
       immutable_fingerprint,created_by
     ) VALUES
     (
       $1,$3,$4,$5,'profile-v3','promotion-v2','["film reviews"]'::jsonb,
       '["film reviews"]'::jsonb,'["https://example.test/watch"]'::jsonb,
       '["viewers"]'::jsonb,'["editorial"]'::jsonb,'ZA','ZA','en',
       '["shared-seo-evidence"]'::jsonb,'profile-fingerprint-v3','stage2e-test'
     ),
     (
       $2,$3,$4,$5,'profile-v4','promotion-v2','["film reviews"]'::jsonb,
       '["film reviews"]'::jsonb,'["https://example.test/watch"]'::jsonb,
       '["viewers"]'::jsonb,'["editorial"]'::jsonb,'ZA','ZA','en',
       '["shared-seo-evidence"]'::jsonb,'profile-fingerprint-v4','stage2e-test'
     )`,
    [
      oldOutreachProfileId,
      newOutreachProfileId,
      organizationId,
      workspaceId,
      websiteProjectId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_generation_input_pins (
       id,organization_id,workspace_id,website_project_id,
       project_context_version,site_profile_version_id,
       outreach_profile_version_id,promotion_target_version_id,
       keyword_evidence_snapshot_ids,shared_evidence_snapshot_ids,market,
       qualification_contract_version,immutable_fingerprint,created_by
     ) VALUES
     (
       $1,$3,$4,$5,7,'profile-v3',$6,'promotion-v2','[]'::jsonb,'[]'::jsonb,
       'ZA','recommendation-qualification.v1','generation-v7','stage2e-test'
     ),
     (
       $2,$3,$4,$5,8,'profile-v4',$7,'promotion-v2','[]'::jsonb,'[]'::jsonb,
       'ZA','recommendation-qualification.v1','generation-v8','stage2e-test'
     )`,
    [
      oldPinId,
      newPinId,
      organizationId,
      workspaceId,
      websiteProjectId,
      oldOutreachProfileId,
      newOutreachProfileId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
       id,organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,input_pin_id,
       qualification_contract_version,visibility_contract_version,
       score_model_version,metric_scope,market,location,language,
       traffic_location_code,traffic_language_code,request_fingerprints,
       creator_worker_contract_version,created_by,pool_contract_version
     ) VALUES (
       $1,$2,$3,$4,$5,1,$6,'recommendation-qualification.v1',
       'recommendation-visibility.v1','recommendation-commercial-fit.v4',
       'TARGET_MARKET','ZA','ZA','en',2710,'en','{}'::jsonb,
       'recommendation-qualification.v1','stage2e-test',
       'recommendation-pool.v1'
     )`,
    [
      generationContractId,
      organizationId,
      workspaceId,
      websiteProjectId,
      oldContextVersionId,
      oldPinId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
       id,organization_id,workspace_id,website_project_id,
       pool_contract_version,migration_state,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,'recommendation-pool.v1','V1_ACTIVE',
       'stage2e-test','stage2e-test'
     )`,
    [projectContractId, organizationId, workspaceId, websiteProjectId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_jobs (
       id,organization_id,workspace_id,website_project_id,job_type,
       source_object_type,source_object_id,status,step,progress,workflow_id,
       correlation_id,started_at,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,'recommendation_refill','recommendation_context',$5,
       'running','provider',50,$6,'legacy-v7-correlation',
       '2026-08-19T05:00:00Z','stage2e-test','stage2e-test'
     )`,
    [
      jobId,
      organizationId,
      workspaceId,
      websiteProjectId,
      oldContextVersionId,
      workflowId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_refills (
       id,organization_id,workspace_id,website_project_id,job_id,
       recommendation_context_version_id,visible_pool_generation,
       trigger_reason,low_watermark,high_watermark,refill_window_key,
       created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,1,'inventory_low',9,10,'legacy-v7-window',
       'stage2e-test','stage2e-test'
     )`,
    [
      refillId,
      organizationId,
      workspaceId,
      websiteProjectId,
      jobId,
      oldContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
       id,organization_id,workspace_id,website_project_id,
       project_context_version_id,blueprint_version,generator,schema_version,
       prompt_version,rule_version,blueprint,evidence_refs,generated_at,
       created_by
     ) VALUES (
       $1,$2,$3,$4,$5,1,'DETERMINISTIC_FALLBACK','stage2e.v1',
       'stage2e.v1','stage2e.v1','{}'::jsonb,'[]'::jsonb,
       '2026-08-19T05:00:00Z','stage2e-test'
     )`,
    [
      blueprintId,
      organizationId,
      workspaceId,
      websiteProjectId,
      oldContextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_batches (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       project_context_version_id,status,idempotency_key,request_intent,
       source_types,started_at,created_by,visible_pool_generation,refill_job_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'running',$7,'DISCOVERY','["EXISTING_HISTORY"]',
       '2026-08-19T05:01:00Z','stage2e-test',1,$8
     )`,
    [
      discoveryBatchId,
      organizationId,
      workspaceId,
      websiteProjectId,
      blueprintId,
      oldContextVersionId,
      batchIdempotencyKey,
      jobId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_inventory_policies (
       organization_id,workspace_id,website_project_id,
       project_context_version_id,refill_state,visible_pool_state,
       visible_pool_generation,updated_by
     ) VALUES ($1,$2,$3,$4,'running','building',1,'stage2e-test')`,
    [organizationId, workspaceId, websiteProjectId, oldContextVersionId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_lifecycle_events (
       id,organization_id,workspace_id,website_project_id,job_id,
       aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
       actor_type,actor_id,after_state,reason,correlation_id,idempotency_key
     ) VALUES (
       $1,$2,$3,$4,$5,'recommendation_refill',$6,1,1,
       'recommendation_refill.requested','system','stage2e-test',
       '{"status":"running"}'::jsonb,'inventory_low',
       'legacy-v7-correlation','legacy-v7-requested'
     )`,
    [
      requestedLifecycleId,
      organizationId,
      workspaceId,
      websiteProjectId,
      jobId,
      refillId,
    ],
  );
}

async function seedProviderRequest(
  client: RuntimeClient,
  status: "running" | "succeeded" | "unknown_charge",
): Promise<void> {
  const finishedAt = status === "running" ? null : "2026-08-19T05:03:00Z";
  await client.query(
    `INSERT INTO backlinks.provider_batch_requests (
       id,organization_id,workspace_id,website_project_id,provider,endpoint,
       request_intent,refresh_mode,location_code,language_code,
       request_schema_version,response_schema_version,
       normalized_request_hash,request_count,estimated_cost_micros,status,
       started_at,finished_at,request_id,budget_reservation_id,created_by
     ) VALUES (
       $1,$2,$3,$4,'dataforseo','serp/google/organic/live/advanced',
       'DISCOVERY','FORCE_LIVE','2710','en',1,'response.v1',$5,1,1000,$6,
       '2026-08-19T05:02:00Z',$7,$8,$9,'stage2e-test'
     )`,
    [
      providerRequestId,
      organizationId,
      workspaceId,
      websiteProjectId,
      providerRequestFingerprint,
      status,
      finishedAt,
      providerRequestIdentity,
      providerBudgetReservationId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_provider_requests (
       id,organization_id,workspace_id,website_project_id,provider,endpoint,
       request_fingerprint,active_request_bucket,request_schema_version,
       request_payload,status,started_at,finished_at,created_by
     ) VALUES (
       $1,$2,$3,$4,'dataforseo','serp/google/organic/live/advanced',
       $5,$9,1,'{}'::jsonb,$6,'2026-08-19T05:02:00Z',$7,$8
     )`,
    [
      providerRequestId,
      organizationId,
      workspaceId,
      websiteProjectId,
      providerRequestFingerprint,
      status,
      finishedAt,
      providerRequestIdentity,
      providerRequestId,
    ],
  );
}

describe("recommendation refill cooperative supersession persistence", () => {
  let harness: BacklinksPostgresHarness;
  let client: RuntimeClient;
  let pool: RuntimePool;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new Client({ connectionString: harness.connectionString });
    await client.connect();
    await migrateBacklinks(client);
    pool = new Pool({
      connectionString: harness.connectionString,
      options: "-c search_path=backlinks,pg_catalog",
    });
  }, 180_000);

  beforeEach(async () => {
    await client.query(`
      TRUNCATE backlinks.backlink_audit_events,
        backlinks.backlink_lifecycle_events,
        backlinks.backlink_commercial_discovery_batches,
        backlinks.backlink_commercial_discovery_blueprints,
        backlinks.backlink_commercial_inventory_policies,
        backlinks.backlink_recommendation_refills,
        backlinks.backlink_jobs,
        backlinks.provider_fetch_leases,
        backlinks.provider_batch_requests,
        backlinks.backlink_provider_usage_ledger,
        backlinks.backlink_provider_budgets,
        backlinks.backlink_provider_requests,
        backlinks.backlink_recommendation_pool_project_contracts,
        backlinks.backlink_recommendation_generation_contracts,
        backlinks.backlink_generation_input_pins,
        backlinks.backlink_outreach_profile_versions,
        backlinks.backlink_project_context_snapshots
      CASCADE
    `);
    await seedSupersededRefill(client);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("atomically closes the old refill once and replays without new records", async () => {
    const execute = () =>
      withBacklinkTenantTransaction(
        pool,
        { organizationId, workspaceId, websiteProjectId },
        (transaction) =>
          completeRecommendationRefillSupersession(transaction, {
            signal,
            now,
            integrityHash: "a".repeat(64),
          }),
      );

    await expect(execute()).resolves.toEqual({
      status: "cancelled",
      replayed: false,
    });
    await expect(execute()).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    const state = (
      await client.query(
        `SELECT
         (SELECT jsonb_build_object(
            'status',status,'step',step,'progress',progress,'version',version,
            'reason',result_summary->>'reason'
          ) FROM backlinks.backlink_jobs WHERE id=$1) job,
         (SELECT jsonb_build_object(
            'status',status,'pauseReason',pause_reason,
            'finished',finished_at IS NOT NULL
          ) FROM backlinks.backlink_commercial_discovery_batches
            WHERE id=$2) batch,
         (SELECT jsonb_build_object(
            'visiblePoolState',visible_pool_state,'refillState',refill_state,
            'terminationReason',termination_reason,'pauseReason',pause_reason,
            'version',version
          ) FROM backlinks.backlink_commercial_inventory_policies
            WHERE project_context_version_id=$3) policy,
         (SELECT count(*)::int FROM backlinks.backlink_lifecycle_events
            WHERE event_type='recommendation_refill.superseded') lifecycle_count,
         (SELECT count(*)::int FROM backlinks.backlink_audit_events
            WHERE action='recommendation_refill.superseded') audit_count`,
        [jobId, discoveryBatchId, oldContextVersionId],
      )
    ).rows[0];

    expect(state).toEqual({
      job: {
        status: "cancelled",
        step: "superseded_project_context",
        progress: 100,
        version: 2,
        reason: "superseded_project_context",
      },
      batch: {
        status: "stale_context",
        pauseReason: "superseded_project_context",
        finished: true,
      },
      policy: {
        visiblePoolState: "idle",
        refillState: "paused",
        terminationReason: "PROJECT_CONTEXT",
        pauseReason: "superseded_project_context",
        version: 2,
      },
      lifecycle_count: 1,
      audit_count: 1,
    });

    const lifecycle = (
      await client.query(
        `SELECT aggregate_type,"aggregate_id" AS "aggregateId",sequence,
              aggregate_version "aggregateVersion",idempotency_key
                "idempotencyKey"
         FROM backlinks.backlink_lifecycle_events
        WHERE event_type='recommendation_refill.superseded'`,
      )
    ).rows[0];
    expect(lifecycle).toEqual({
      aggregate_type: "recommendation_refill",
      aggregateId: refillId,
      sequence: 2,
      aggregateVersion: 2,
      idempotencyKey: signal.idempotencyKey,
    });
  });

  it("persists one non-terminal supersession request and replays it", async () => {
    const execute = () =>
      withBacklinkTenantTransaction(
        pool,
        { organizationId, workspaceId, websiteProjectId },
        (transaction) =>
          requestRecommendationRefillSupersession(transaction, {
            signal,
            now,
            integrityHash: "1".repeat(64),
          }),
      );

    await expect(execute()).resolves.toEqual({
      status: "requested",
      replayed: false,
    });
    await expect(execute()).resolves.toEqual({
      status: "requested",
      replayed: true,
    });

    const state = (
      await client.query(
        `SELECT
         (SELECT jsonb_build_object(
            'status',status,
            'version',version,
            'requestState',
              result_summary->'supersessionRequest'->>'state'
          ) FROM backlinks.backlink_jobs WHERE id=$1) job,
         (SELECT count(*)::int FROM backlinks.backlink_lifecycle_events
            WHERE event_type='recommendation_refill.supersession_requested')
              lifecycle_count,
         (SELECT count(*)::int FROM backlinks.backlink_audit_events
            WHERE action='recommendation_refill.supersession_requested')
              audit_count`,
        [jobId],
      )
    ).rows[0];
    expect(state).toEqual({
      job: {
        status: "running",
        version: 2,
        requestState: "requested",
      },
      lifecycle_count: 1,
      audit_count: 1,
    });
  });

  it("compensates a historical failed terminal only after a durable request", async () => {
    await client.query(
      `UPDATE backlinks.backlink_jobs
          SET status='failed',
              step='provider_request_failed',
              progress=100,
              finished_at='2026-08-19T05:05:00Z',
              error='{"code":"UNKNOWN_INTERNAL"}'::jsonb
        WHERE id=$1`,
      [jobId],
    );
    const complete = () =>
      withBacklinkTenantTransaction(
        pool,
        { organizationId, workspaceId, websiteProjectId },
        (transaction) =>
          completeRecommendationRefillSupersession(transaction, {
            signal,
            now,
            integrityHash: "2".repeat(64),
          }),
      );

    await expect(complete()).resolves.toEqual({
      status: "no_change",
      replayed: false,
    });
    await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        requestRecommendationRefillSupersession(transaction, {
          signal,
          now,
          integrityHash: "3".repeat(64),
        }),
    );
    await expect(complete()).resolves.toEqual({
      status: "cancelled",
      replayed: false,
    });
    await expect(complete()).resolves.toEqual({
      status: "cancelled",
      replayed: true,
    });

    const state = (
      await client.query(
        `SELECT status,step,result_summary->>'reason' reason
         FROM backlinks.backlink_jobs
        WHERE id=$1`,
        [jobId],
      )
    ).rows[0];
    expect(state).toEqual({
      status: "cancelled",
      step: "superseded_project_context",
      reason: "superseded_project_context",
    });
  });

  it("compensates only the explicitly selected historical execution", async () => {
    await client.query(
      `UPDATE backlinks.backlink_jobs
          SET status='failed',
              step='provider_request_failed',
              progress=100,
              finished_at='2026-08-19T05:05:00Z',
              error='{"code":"UNKNOWN_INTERNAL"}'::jsonb
        WHERE id=$1`,
      [jobId],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_jobs (
         id,organization_id,workspace_id,website_project_id,job_type,
         source_object_type,source_object_id,status,step,progress,workflow_id,
         correlation_id,started_at,finished_at,created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,'recommendation_refill','recommendation_context',$5,
         'failed','provider_request_failed',100,$6,'legacy-v7-sibling',
         '2026-08-19T05:00:00Z','2026-08-19T05:05:00Z',
         'stage2f-test','stage2f-test'
       )`,
      [
        siblingJobId,
        organizationId,
        workspaceId,
        websiteProjectId,
        oldContextVersionId,
        siblingWorkflowId,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_refills (
         id,organization_id,workspace_id,website_project_id,job_id,
         recommendation_context_version_id,visible_pool_generation,
         trigger_reason,low_watermark,high_watermark,refill_window_key,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,1,'inventory_low',9,10,
         'legacy-v7-sibling-window','stage2f-test','stage2f-test'
       )`,
      [
        siblingRefillId,
        organizationId,
        workspaceId,
        websiteProjectId,
        siblingJobId,
        oldContextVersionId,
      ],
    );
    const execute = () =>
      reconcileRecommendationRefillOrphans({
        pool,
        scope: { organizationId, workspaceId, websiteProjectId },
        actorId: "stage2f-reconciliation",
        mode: "apply",
        operation: { jobId, workflowId },
        workflowProbe: {
          inspect: async () => "closed",
          readSupersession: async () => null,
          signalSuperseded: async () => {
            throw new Error("CLOSED_WORKFLOW_MUST_NOT_BE_SIGNALLED");
          },
        },
        now: () => now,
      });

    await expect(execute()).resolves.toMatchObject({
      scannedRunningCount: 1,
      plannedChangeCount: 1,
      appliedChangeCount: 1,
      entries: [
        {
          jobId,
          workflowId,
          plannedAction: "COMPENSATE_SUPERSEDED_TERMINAL",
          applied: true,
        },
      ],
    });
    await expect(execute()).resolves.toMatchObject({
      scannedRunningCount: 0,
      plannedChangeCount: 0,
      appliedChangeCount: 0,
      entries: [],
    });

    const state = (
      await client.query(
        `SELECT
         (SELECT status FROM backlinks.backlink_jobs WHERE id=$1)
           selected_status,
         (SELECT status FROM backlinks.backlink_jobs WHERE id=$2)
           sibling_status,
         (SELECT count(*)::int FROM backlinks.backlink_lifecycle_events
            WHERE job_id=$1
              AND event_type='recommendation_refill.superseded')
           selected_lifecycle_count,
         (SELECT count(*)::int FROM backlinks.backlink_lifecycle_events
            WHERE job_id=$2
              AND event_type='recommendation_refill.superseded')
           sibling_lifecycle_count,
         (SELECT count(*)::int FROM backlinks.backlink_audit_events
            WHERE job_id=$1
              AND action='recommendation_refill.superseded')
           selected_audit_count,
         (SELECT count(*)::int FROM backlinks.backlink_audit_events
            WHERE job_id=$2
              AND action='recommendation_refill.superseded')
           sibling_audit_count`,
        [jobId, siblingJobId],
      )
    ).rows[0];
    expect(state).toEqual({
      selected_status: "cancelled",
      sibling_status: "failed",
      selected_lifecycle_count: 1,
      sibling_lifecycle_count: 0,
      selected_audit_count: 1,
      sibling_audit_count: 0,
    });
  });

  it("arbitrates an earlier provider failure to superseded terminal", async () => {
    await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        requestRecommendationRefillSupersession(transaction, {
          signal,
          now,
          integrityHash: "4".repeat(64),
        }),
    );

    const result = await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        arbitrateRecommendationRefillFailure(transaction, {
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationContextVersionId: oldContextVersionId,
          jobId,
          errorCode: "BACKLINK_INTERNAL",
          rootCause: "UNKNOWN_INTERNAL",
          recovery: "CONTACT_SUPPORT",
          diagnosticId: "historical-provider-timeout",
          message: "Historical provider timeout.",
          actorId: "stage2f-test",
          now,
          integrityHash: "5".repeat(64),
        }),
    );

    expect(result).toMatchObject({
      status: "superseded",
      supersession: signal,
    });
    expect(
      (
        await client.query(
          `SELECT status,step FROM backlinks.backlink_jobs WHERE id=$1`,
          [jobId],
        )
      ).rows[0],
    ).toEqual({
      status: "cancelled",
      step: "superseded_project_context",
    });
  });

  it("records an ordinary failure when no supersession was requested", async () => {
    const result = await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        arbitrateRecommendationRefillFailure(transaction, {
          organizationId,
          workspaceId,
          websiteProjectId,
          recommendationContextVersionId: oldContextVersionId,
          jobId,
          errorCode: "BACKLINK_INTERNAL",
          rootCause: "UNKNOWN_INTERNAL",
          recovery: "CONTACT_SUPPORT",
          diagnosticId: "ordinary-failure",
          message: "Ordinary failure.",
          actorId: "stage2f-test",
          now,
          integrityHash: "6".repeat(64),
        }),
    );

    expect(result).toEqual({ status: "failed" });
    expect(
      (
        await client.query(
          `SELECT status,step,error->>'rootCause' "rootCause"
         FROM backlinks.backlink_jobs WHERE id=$1`,
          [jobId],
        )
      ).rows[0],
    ).toEqual({
      status: "failed",
      step: "provider_request_failed",
      rootCause: "UNKNOWN_INTERNAL",
    });
  });

  it("blocks a queued provider activity after supersession is requested", async () => {
    await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        requestRecommendationRefillSupersession(transaction, {
          signal,
          now,
          integrityHash: "7".repeat(64),
        }),
    );

    await expect(
      withBacklinkTenantTransaction(
        pool,
        { organizationId, workspaceId, websiteProjectId },
        (transaction) =>
          assertRecommendationRefillProviderExecutionCurrent(transaction, {
            organizationId,
            workspaceId,
            websiteProjectId,
            jobId,
            recommendationContextVersionId: oldContextVersionId,
          }),
      ),
    ).rejects.toThrow(
      "BACKLINK_RECOMMENDATION_REFILL_SUPERSEDED_PROJECT_CONTEXT",
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::int count
         FROM backlinks.provider_batch_requests`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it.each(["running", "unknown_charge"] as const)(
    "does not terminalize while an exact provider request is %s",
    async (status) => {
      await seedProviderRequest(client, status);

      const result = await withBacklinkTenantTransaction(
        pool,
        { organizationId, workspaceId, websiteProjectId },
        (transaction) =>
          completeRecommendationRefillSupersession(transaction, {
            signal,
            now,
            integrityHash: "c".repeat(64),
          }),
      );
      expect(result).toEqual({
        status: "awaiting_provider_reconciliation",
        replayed: false,
      });

      const state = (
        await client.query(
          `SELECT
           (SELECT status FROM backlinks.backlink_jobs WHERE id=$1) job_status,
           (SELECT status FROM backlinks.backlink_commercial_discovery_batches
             WHERE id=$2) batch_status,
           (SELECT refill_state
              FROM backlinks.backlink_commercial_inventory_policies
             WHERE project_context_version_id=$3) refill_state,
           (SELECT count(*)::int FROM backlinks.backlink_lifecycle_events
              WHERE event_type='recommendation_refill.superseded')
                lifecycle_count,
           (SELECT count(*)::int FROM backlinks.backlink_audit_events
              WHERE action='recommendation_refill.superseded') audit_count`,
          [jobId, discoveryBatchId, oldContextVersionId],
        )
      ).rows[0];
      expect(state).toEqual({
        job_status: "running",
        batch_status: "running",
        refill_state: "running",
        lifecycle_count: 0,
        audit_count: 0,
      });
    },
  );

  it("does not terminalize while an exact provider lease is acquired", async () => {
    await seedProviderRequest(client, "succeeded");
    await client.query(
      `INSERT INTO backlinks.provider_fetch_leases (
         artifact_fingerprint,status,owner_request_id,lease_expires_at,
         heartbeat_at,attempt_count
       ) VALUES (
         $1,'acquired',$2,'2026-08-19T06:10:00Z',
         '2026-08-19T06:00:00Z',1
       )`,
      [providerRequestFingerprint, providerRequestIdentity],
    );

    const result = await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        completeRecommendationRefillSupersession(transaction, {
          signal,
          now,
          integrityHash: "d".repeat(64),
        }),
    );
    expect(result).toEqual({
      status: "awaiting_provider_reconciliation",
      replayed: false,
    });
    expect(
      (
        await client.query(
          `SELECT status FROM backlinks.backlink_jobs WHERE id=$1`,
          [jobId],
        )
      ).rows[0]?.status,
    ).toBe("running");
  });

  it("does not terminalize while an exact cost reservation is unsettled", async () => {
    await seedProviderRequest(client, "succeeded");
    await client.query(
      `INSERT INTO backlinks.backlink_provider_budgets (
         id,organization_id,workspace_id,provider,period_start,period_end,
         limit_micros,reserved_micros,created_by
       ) VALUES (
         $1,$2,$3,'dataforseo','2026-08-19T00:00:00Z',
         '2026-08-20T00:00:00Z',5000000,1000,'stage2e-test'
       )`,
      [providerBudgetId, organizationId, workspaceId],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_provider_usage_ledger (
         id,organization_id,workspace_id,website_project_id,budget_id,
         provider_request_id,provider,reservation_key,estimated_cost_micros,
         created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'dataforseo',$7,1000,'stage2e-test'
       )`,
      [
        providerUsageId,
        organizationId,
        workspaceId,
        websiteProjectId,
        providerBudgetId,
        providerRequestId,
        providerBudgetReservationId,
      ],
    );

    const result = await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        completeRecommendationRefillSupersession(transaction, {
          signal,
          now,
          integrityHash: "e".repeat(64),
        }),
    );
    expect(result).toEqual({
      status: "awaiting_provider_reconciliation",
      replayed: false,
    });
    expect(
      (
        await client.query(
          `SELECT status FROM backlinks.backlink_jobs WHERE id=$1`,
          [jobId],
        )
      ).rows[0]?.status,
    ).toBe("running");
  });

  it("fails closed when the authoritative context pins do not match", async () => {
    const mismatchedSignal: RecommendationRefillSupersessionSignal =
      Object.freeze({
        ...signal,
        authoritativeContext: Object.freeze({
          ...signal.authoritativeContext,
          generationInputFingerprint: "different-generation-v8",
        }),
      });

    const result = await withBacklinkTenantTransaction(
      pool,
      { organizationId, workspaceId, websiteProjectId },
      (transaction) =>
        completeRecommendationRefillSupersession(transaction, {
          signal: mismatchedSignal,
          now,
          integrityHash: "f".repeat(64),
        }),
    );
    expect(result).toEqual({
      status: "no_change",
      replayed: false,
    });

    const state = (
      await client.query(
        `SELECT
         (SELECT status FROM backlinks.backlink_jobs WHERE id=$1) job_status,
         (SELECT status FROM backlinks.backlink_commercial_discovery_batches
           WHERE id=$2) batch_status,
         (SELECT refill_state
            FROM backlinks.backlink_commercial_inventory_policies
           WHERE project_context_version_id=$3) refill_state,
         (SELECT count(*)::int FROM backlinks.backlink_lifecycle_events
            WHERE event_type='recommendation_refill.superseded')
              lifecycle_count,
         (SELECT count(*)::int FROM backlinks.backlink_audit_events
            WHERE action='recommendation_refill.superseded') audit_count`,
        [jobId, discoveryBatchId, oldContextVersionId],
      )
    ).rows[0];
    expect(state).toEqual({
      job_status: "running",
      batch_status: "running",
      refill_state: "running",
      lifecycle_count: 0,
      audit_count: 0,
    });
  });
});
