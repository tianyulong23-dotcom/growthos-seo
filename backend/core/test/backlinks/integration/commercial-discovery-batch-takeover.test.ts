import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  claimPausedCommercialDiscoveryBatch,
} from "../../../src/modules/backlinks/application/services/commercial-recommendation-discovery.service.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import type {
  GenerationInputBinding,
} from "../../../src/modules/backlinks/ports/shared-seo-evidence.port.js";
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
const migrationDirectory = new URL(
  "../../../src/modules/backlinks/db/migrations/",
  import.meta.url,
);
const rolesMigration = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);

const id = (value: number) =>
  `018f3000-0000-7000-8000-${value.toString().padStart(12, "0")}`;

const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const contextVersionId = id(4);
const outreachProfileId = id(5);
const inputPinId = id(6);
const oldJobId = id(7);
const oldRefillId = id(8);
const newJobAId = id(9);
const newRefillAId = id(10);
const newJobBId = id(11);
const newRefillBId = id(12);
const blueprintId = id(13);
const discoveryBatchId = id(14);
const providerRequestId = id(15);
const providerBudgetId = id(16);
const providerUsageId = id(17);
const artifactId = id(18);
const candidateId = id(19);
const newerContextId = id(20);
const generationInputFingerprint = "stage2d-generation-v8";
const providerRequestFingerprint = "a".repeat(64);
const providerReservationId = "stage2d-historical-settled";
const refillKey = [
  "recommendation-refill",
  websiteProjectId,
  contextVersionId,
  "generation-1",
  "exact_product_target_market",
  "round-1",
  "window-1",
].join(":");
const providerRequestIdentity = `${refillKey}:1`;
const claimedAt = new Date("2026-08-20T02:00:00.000Z");
const scope = { organizationId, workspaceId, websiteProjectId };

const inputBinding: GenerationInputBinding = Object.freeze({
  inputPinId,
  outreachProfileRecordId: outreachProfileId,
  immutableFingerprint: generationInputFingerprint,
  pins: Object.freeze({
    organizationId,
    websiteProjectId,
    projectContextVersion: 8,
    siteProfileVersionId: "profile-v4",
    outreachProfileVersionId: outreachProfileId,
    promotionTargetVersionId: "promotion-v2",
    keywordEvidenceSnapshotIds: Object.freeze([]),
    sharedEvidenceSnapshotIds: Object.freeze([]),
    market: "ZA",
    qualificationContractVersion: "recommendation-qualification.v1",
  }),
  outreachProfile: Object.freeze({
    organizationId,
    websiteProjectId,
    profileVersionId: "profile-v4",
    promotionTargetVersionId: "promotion-v2",
    keywordsAndTopics: Object.freeze(["streaming service reviews"]),
    productsAndServices: Object.freeze(["streaming entertainment"]),
    targetUrls: Object.freeze(["https://elephtv.com/watch"]),
    targetAudiences: Object.freeze(["South African viewers"]),
    partnershipGoals: Object.freeze(["editorial review"]),
    market: "ZA",
    location: "ZA",
    language: "en",
    authorizedDiscoverySources: Object.freeze(["shared-seo-evidence"]),
    immutableFingerprint: "stage2d-profile-v4",
  }),
  sharedEvidence: Object.freeze([]),
});

async function migrateBacklinks(client: RuntimeClient): Promise<void> {
  const migrationNames = (await readdir(fileURLToPath(migrationDirectory)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames.filter(
    (item) => item >= "0002_" && item < "0005_",
  )) {
    await client.query(
      await readFile(new URL(name, migrationDirectory), "utf8"),
    );
  }
  await client.query(await readFile(rolesMigration, "utf8"));
  for (const name of migrationNames.filter(
    (item) => item >= "0005_" && !item.startsWith("0044_"),
  )) {
    await client.query(
      await readFile(new URL(name, migrationDirectory), "utf8"),
    );
  }
}

async function seedTakeoverState(client: RuntimeClient): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_project_context_snapshots (
       id,organization_id,workspace_id,website_project_id,snapshot_version,
       project_status,canonical_domain,locale,country_code,
       profile_version_id,promotion_target_version_id,products,keywords,
       target_urls,target_market,target_audiences,partnership_goals,created_by
     ) VALUES (
       $1,$2,$3,$4,8,'ACTIVE','elephtv.com','en','ZA',
       'profile-v4','promotion-v2','["streaming entertainment"]'::jsonb,
       '["streaming service reviews"]'::jsonb,
       '["https://elephtv.com/watch"]'::jsonb,
       'ZA','["South African viewers"]'::jsonb,
       '["editorial review"]'::jsonb,'stage2d-test'
     )`,
    [contextVersionId, organizationId, workspaceId, websiteProjectId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_outreach_profile_versions (
       id,organization_id,workspace_id,website_project_id,
       profile_version_id,promotion_target_version_id,keywords_and_topics,
       products_and_services,target_urls,target_audiences,partnership_goals,
       market,location,language,authorized_discovery_sources,
       immutable_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,'profile-v4','promotion-v2',
       '["streaming service reviews"]'::jsonb,
       '["streaming entertainment"]'::jsonb,
       '["https://elephtv.com/watch"]'::jsonb,
       '["South African viewers"]'::jsonb,'["editorial review"]'::jsonb,
       'ZA','ZA','en','["shared-seo-evidence"]'::jsonb,
       'stage2d-profile-v4','stage2d-test'
     )`,
    [outreachProfileId, organizationId, workspaceId, websiteProjectId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_generation_input_pins (
       id,organization_id,workspace_id,website_project_id,
       project_context_version,site_profile_version_id,
       outreach_profile_version_id,promotion_target_version_id,
       keyword_evidence_snapshot_ids,shared_evidence_snapshot_ids,market,
       qualification_contract_version,immutable_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,8,'profile-v4',$5,'promotion-v2',
       '[]'::jsonb,'[]'::jsonb,'ZA','recommendation-qualification.v1',
       $6,'stage2d-test'
     )`,
    [
      inputPinId,
      organizationId,
      workspaceId,
      websiteProjectId,
      outreachProfileId,
      generationInputFingerprint,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_jobs (
       id,organization_id,workspace_id,website_project_id,job_type,
       source_object_type,source_object_id,status,step,progress,workflow_id,
       correlation_id,result_summary,started_at,finished_at,created_by,
       updated_by
     ) VALUES
     (
       $1,$4,$5,$6,'recommendation_refill','recommendation_context',$7,
       'partial_success','provider',75,'stage2d-old-workflow',
       'stage2d-old-correlation','{"paidCalls":3}'::jsonb,
       '2026-08-19T15:00:00Z','2026-08-19T15:10:00Z',
       'stage2d-test','stage2d-test'
     ),
     (
       $2,$4,$5,$6,'recommendation_refill','recommendation_context',$7,
       'queued','queued',0,'stage2d-new-workflow-a',
       'stage2d-new-correlation-a',NULL,NULL,NULL,
       'stage2d-test','stage2d-test'
     ),
     (
       $3,$4,$5,$6,'recommendation_refill','recommendation_context',$7,
       'queued','queued',0,'stage2d-new-workflow-b',
       'stage2d-new-correlation-b',NULL,NULL,NULL,
       'stage2d-test','stage2d-test'
     )`,
    [
      oldJobId,
      newJobAId,
      newJobBId,
      organizationId,
      workspaceId,
      websiteProjectId,
      contextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_refills (
       id,organization_id,workspace_id,website_project_id,job_id,
       recommendation_context_version_id,visible_pool_generation,
       trigger_reason,low_watermark,high_watermark,refill_window_key,
       created_by,updated_by
     ) VALUES
     (
       $1,$4,$5,$6,$7,$10,1,'inventory_low',9,10,
       'stage2d-old-window','stage2d-test','stage2d-test'
     ),
     (
       $2,$4,$5,$6,$8,$10,1,'inventory_low',9,10,
       'stage2d-new-window-a','stage2d-test','stage2d-test'
     ),
     (
       $3,$4,$5,$6,$9,$10,1,'inventory_low',9,10,
       'stage2d-new-window-b','stage2d-test','stage2d-test'
     )`,
    [
      oldRefillId,
      newRefillAId,
      newRefillBId,
      organizationId,
      workspaceId,
      websiteProjectId,
      oldJobId,
      newJobAId,
      newJobBId,
      contextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
       id,organization_id,workspace_id,website_project_id,
       project_context_version_id,blueprint_version,generator,schema_version,
       prompt_version,rule_version,blueprint,evidence_refs,generated_at,
       created_by
     ) VALUES (
       $1,$2,$3,$4,$5,1,'DETERMINISTIC_FALLBACK','stage2d.v1',
       'stage2d.v1','stage2d.v1','{}'::jsonb,'[]'::jsonb,
       '2026-08-19T15:00:00Z','stage2d-test'
     )`,
    [
      blueprintId,
      organizationId,
      workspaceId,
      websiteProjectId,
      contextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_batches (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       project_context_version_id,status,idempotency_key,request_intent,
       source_types,provider_request_fingerprints,provider_collected_at,
       paid_cost_micros,pause_reason,started_at,finished_at,created_by,
       visible_pool_generation,refill_job_id,raw_candidate_count,
       eligible_candidate_count,elimination_reason_counts
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'paused',$7,'DISCOVERY',
       '["VERIFIED_COMPETITOR_BACKLINK_GAP"]'::jsonb,$8::jsonb,
       '2026-08-19T15:08:00Z',78732,'quota_exhausted',
       '2026-08-19T15:01:00Z','2026-08-19T15:10:00Z','stage2d-test',
       1,$9,25,4,'{"hard_filter":16,"insufficient_data":5}'::jsonb
     )`,
    [
      discoveryBatchId,
      organizationId,
      workspaceId,
      websiteProjectId,
      blueprintId,
      contextVersionId,
      `commercial-discovery:${refillKey}`,
      JSON.stringify([providerRequestFingerprint]),
      oldJobId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_provider_requests (
       id,organization_id,workspace_id,website_project_id,provider,endpoint,
       request_fingerprint,active_request_bucket,request_schema_version,
       request_payload,status,started_at,finished_at,created_by
     ) VALUES (
       $1,$2,$3,$4,'dataforseo','serp/google/organic/live/advanced',
       $5,'stage2d-historical-bucket',1,'{"query":"old query"}'::jsonb,
       'succeeded','2026-08-19T15:02:00Z','2026-08-19T15:03:00Z',
       'stage2d-test'
     )`,
    [
      providerRequestId,
      organizationId,
      workspaceId,
      websiteProjectId,
      providerRequestFingerprint,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.provider_batch_requests (
       id,organization_id,workspace_id,website_project_id,provider,endpoint,
       request_intent,refresh_mode,location_code,language_code,
       request_schema_version,response_schema_version,
       normalized_request_hash,request_count,succeeded_count,
       estimated_cost_micros,actual_cost_micros,status,started_at,finished_at,
       request_id,budget_reservation_id,created_by
     ) VALUES (
       $1,$2,$3,$4,'dataforseo','serp/google/organic/live/advanced',
       'DISCOVERY','FORCE_LIVE','2710','en',1,'response.v1',$5,1,1,
       80000,78732,'succeeded','2026-08-19T15:02:00Z',
       '2026-08-19T15:03:00Z',$6,$7,'stage2d-test'
     )`,
    [
      providerRequestId,
      organizationId,
      workspaceId,
      websiteProjectId,
      providerRequestFingerprint,
      providerRequestIdentity,
      providerReservationId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_provider_budgets (
       id,organization_id,workspace_id,provider,period_start,period_end,
       limit_micros,spent_micros,reserved_micros,created_by
     ) VALUES (
       $1,$2,$3,'dataforseo','2026-08-19T00:00:00Z',
       '2026-08-21T00:00:00Z',5000000,78732,0,'stage2d-test'
     )`,
    [providerBudgetId, organizationId, workspaceId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_provider_usage_ledger (
       id,organization_id,workspace_id,website_project_id,budget_id,
       provider_request_id,provider,reservation_key,estimated_cost_micros,
       actual_cost_micros,status,settled_at,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'dataforseo',$7,80000,78732,'settled',
       '2026-08-19T15:03:00Z','stage2d-test'
     )`,
    [
      providerUsageId,
      organizationId,
      workspaceId,
      websiteProjectId,
      providerBudgetId,
      providerRequestId,
      providerReservationId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.provider_fetch_leases (
       artifact_fingerprint,status,owner_request_id,lease_expires_at,
       heartbeat_at,attempt_count
     ) VALUES (
       $1,'completed',$2,'2026-08-19T15:10:00Z',
       '2026-08-19T15:03:00Z',1
     )`,
    [providerRequestFingerprint, providerRequestIdentity],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_artifacts (
       id,organization_id,workspace_id,website_project_id,
       project_context_version_id,provider,endpoint,request_intent,
       request_fingerprint,source_type,response_schema_version,
       normalized_payload,provider_task_ids,collected_at,fresh_until,
       stale_until,cost_micros,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,'dataforseo','serp/google/organic/live/advanced',
       'DISCOVERY',$6,'VERIFIED_COMPETITOR_BACKLINK_GAP','response.v1',
       '{"candidates":["publisher.example"]}'::jsonb,'["task-1"]'::jsonb,
       '2026-08-19T15:03:00Z','2026-08-20T15:03:00Z',
       '2026-08-21T15:03:00Z',78732,'stage2d-test'
     )`,
    [
      artifactId,
      organizationId,
      workspaceId,
      websiteProjectId,
      contextVersionId,
      providerRequestFingerprint,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_candidates (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       discovery_batch_id,project_context_version_id,canonical_domain,
       source_types,static_assessment,gate_decision,commercial_score,
       score_model_version,state,created_by,updated_by,visible_pool_generation
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'publisher.example',
       '["VERIFIED_COMPETITOR_BACKLINK_GAP"]'::jsonb,
       '{"decision":"ready"}'::jsonb,'{"decision":"insufficient_data"}'::jsonb,
       '{"decision":"insufficient_data","total":51.2903}'::jsonb,
       'recommendation-commercial-fit.v3','insufficient_data',
       'stage2d-test','stage2d-test',1
     )`,
    [
      candidateId,
      organizationId,
      workspaceId,
      websiteProjectId,
      blueprintId,
      discoveryBatchId,
      contextVersionId,
    ],
  );
}

function claim(
  jobId: string,
  binding: GenerationInputBinding = inputBinding,
  acceptedProviderRecoveryPending = false,
) {
  return withBacklinkTenantTransaction(
    pool,
    scope,
    (transaction) => claimPausedCommercialDiscoveryBatch({
      client: transaction,
      scope,
      contextVersionId,
      visiblePoolGeneration: 1,
      jobId,
      refillKey,
      inputBinding: binding,
      actorId: "stage2d-test",
      claimedAt,
      acceptedProviderRecoveryPending,
    }),
  );
}

async function immutableFacts(): Promise<Record<string, unknown>> {
  const providerRequest = await client.query(
    `SELECT * FROM backlinks.backlink_provider_requests WHERE id=$1`,
    [providerRequestId],
  );
  const batchRequest = await client.query(
    `SELECT * FROM backlinks.provider_batch_requests WHERE id=$1`,
    [providerRequestId],
  );
  const usage = await client.query(
    `SELECT * FROM backlinks.backlink_provider_usage_ledger WHERE id=$1`,
    [providerUsageId],
  );
  const lease = await client.query(
    `SELECT * FROM backlinks.provider_fetch_leases
      WHERE artifact_fingerprint=$1`,
    [providerRequestFingerprint],
  );
  const artifact = await client.query(
    `SELECT * FROM backlinks.backlink_commercial_discovery_artifacts
      WHERE id=$1`,
    [artifactId],
  );
  const candidate = await client.query(
    `SELECT * FROM backlinks.backlink_commercial_candidates WHERE id=$1`,
    [candidateId],
  );
  return {
    providerRequest: providerRequest.rows[0],
    batchRequest: batchRequest.rows[0],
    usage: usage.rows[0],
    lease: lease.rows[0],
    artifact: artifact.rows[0],
    candidate: candidate.rows[0],
  };
}

async function assertNoTakeoverWrites(): Promise<void> {
  const result = await client.query(
    `SELECT batch.refill_job_id AS "ownerJobId",
            new_job.result_summary AS "newJobResult",
            new_job.version AS "newJobVersion",
            (SELECT count(*)::integer FROM backlinks.backlink_lifecycle_events)
              AS "lifecycleCount",
            (SELECT count(*)::integer FROM backlinks.backlink_audit_events)
              AS "auditCount"
       FROM backlinks.backlink_commercial_discovery_batches AS batch
       JOIN backlinks.backlink_jobs AS new_job ON new_job.id=$2
      WHERE batch.id=$1`,
    [discoveryBatchId, newJobAId],
  );
  expect(result.rows[0]).toEqual({
    ownerJobId: oldJobId,
    newJobResult: null,
    newJobVersion: 1,
    lifecycleCount: 0,
    auditCount: 0,
  });
}

let harness: BacklinksPostgresHarness;
let client: RuntimeClient;
let pool: RuntimePool;

describe("paused commercial discovery batch takeover", () => {
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
      TRUNCATE backlinks.backlink_commercial_candidates,
        backlinks.backlink_commercial_discovery_artifacts,
        backlinks.provider_fetch_leases,
        backlinks.backlink_provider_usage_ledger,
        backlinks.backlink_provider_budgets,
        backlinks.provider_batch_requests,
        backlinks.backlink_provider_requests,
        backlinks.backlink_commercial_discovery_batches,
        backlinks.backlink_commercial_discovery_blueprints,
        backlinks.backlink_audit_events,
        backlinks.backlink_lifecycle_events,
        backlinks.backlink_recommendation_refills,
        backlinks.backlink_jobs,
        backlinks.backlink_generation_input_pins,
        backlinks.backlink_outreach_profile_versions,
        backlinks.backlink_project_context_snapshots
      CASCADE
    `);
    await seedTakeoverState(client);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("claims once, replays without writes, and preserves historical facts", async () => {
    const beforeFacts = await immutableFacts();

    await expect(claim(newJobAId)).resolves.toEqual({
      batchId: discoveryBatchId,
      disposition: "resumed",
    });
    await expect(claim(newJobAId)).resolves.toEqual({
      batchId: discoveryBatchId,
      disposition: "same_owner",
    });

    const state = await client.query(
      `SELECT batch.refill_job_id AS "ownerJobId",
              batch.status,batch.pause_reason AS "pauseReason",
              batch.raw_candidate_count AS "rawCandidateCount",
              batch.eligible_candidate_count AS "eligibleCandidateCount",
              batch.provider_request_fingerprints AS "requestFingerprints",
              batch.paid_cost_micros AS "paidCostMicros",
              batch.finished_at AS "finishedAt",
              job.result_summary AS "resultSummary",
              job.version AS "jobVersion",
              (SELECT count(*)::integer
                 FROM backlinks.backlink_lifecycle_events
                WHERE event_type=
                  'recommendation_refill.discovery_batch_resumed')
                AS "lifecycleCount",
              (SELECT count(*)::integer
                 FROM backlinks.backlink_audit_events
                WHERE action=
                  'recommendation_refill.discovery_batch_resumed')
                AS "auditCount"
         FROM backlinks.backlink_commercial_discovery_batches AS batch
         JOIN backlinks.backlink_jobs AS job ON job.id=$2
        WHERE batch.id=$1`,
      [discoveryBatchId, newJobAId],
    );
    expect(state.rows[0]).toMatchObject({
      ownerJobId: newJobAId,
      status: "paused",
      pauseReason: "quota_exhausted",
      rawCandidateCount: 25,
      eligibleCandidateCount: 4,
      requestFingerprints: [providerRequestFingerprint],
      paidCostMicros: "78732",
      jobVersion: 2,
      lifecycleCount: 1,
      auditCount: 1,
      resultSummary: {
        commercialDiscoveryResume: {
          resumedFromJobId: oldJobId,
          resumedFromBatchId: discoveryBatchId,
          resumedFromRefillId: oldRefillId,
          contextVersionId,
          visiblePoolGeneration: 1,
          generationInputPinId: inputPinId,
          generationInputFingerprint,
        },
      },
    });
    expect(state.rows[0]?.finishedAt).toBeInstanceOf(Date);
    expect(await immutableFacts()).toEqual(beforeFacts);
  });

  it("blocks same-owner replay while a provider lease is active", async () => {
    await expect(claim(newJobAId)).resolves.toMatchObject({
      disposition: "resumed",
    });
    await client.query(
      `UPDATE backlinks.provider_fetch_leases
          SET status='acquired'
        WHERE artifact_fingerprint=$1`,
      [providerRequestFingerprint],
    );

    await expect(claim(newJobAId)).rejects.toThrow(
      "COMMERCIAL_DISCOVERY_BATCH_TAKEOVER_BLOCKED",
    );

    const state = await client.query(
      `SELECT batch.refill_job_id AS "ownerJobId",
              job.version AS "jobVersion",
              (SELECT count(*)::integer
                 FROM backlinks.backlink_lifecycle_events
                WHERE event_type=
                  'recommendation_refill.discovery_batch_resumed')
                AS "lifecycleCount",
              (SELECT count(*)::integer
                 FROM backlinks.backlink_audit_events
                WHERE action=
                  'recommendation_refill.discovery_batch_resumed')
                AS "auditCount"
         FROM backlinks.backlink_commercial_discovery_batches AS batch
         JOIN backlinks.backlink_jobs AS job ON job.id=$2
        WHERE batch.id=$1`,
      [discoveryBatchId, newJobAId],
    );
    expect(state.rows[0]).toMatchObject({
      ownerJobId: newJobAId,
      jobVersion: 2,
      lifecycleCount: 1,
      auditCount: 1,
    });
  });

  it("allows the same job to resume a running batch for exact provider recovery", async () => {
    await client.query(
      `UPDATE backlinks.backlink_commercial_discovery_batches
          SET refill_job_id=$2,status='running',finished_at=NULL
        WHERE id=$1`,
      [discoveryBatchId, newJobAId],
    );
    await client.query(
      `UPDATE backlinks.provider_batch_requests
          SET status='unknown_charge',actual_cost_micros=NULL
        WHERE id=$1`,
      [providerRequestId],
    );
    await client.query(
      `UPDATE backlinks.backlink_provider_requests
          SET status='unknown_charge'
        WHERE id=$1`,
      [providerRequestId],
    );
    await client.query(
      `UPDATE backlinks.backlink_provider_usage_ledger
          SET status='reserved',actual_cost_micros=NULL,settled_at=NULL
        WHERE id=$1`,
      [providerUsageId],
    );
    await client.query(
      `UPDATE backlinks.provider_fetch_leases
          SET status='unknown_charge'
        WHERE artifact_fingerprint=$1`,
      [providerRequestFingerprint],
    );

    await expect(claim(newJobAId, inputBinding, true)).resolves.toEqual({
      batchId: discoveryBatchId,
      disposition: "same_owner",
    });

    const state = await client.query(
      `SELECT batch.refill_job_id AS "ownerJobId",
              batch.status,
              job.version AS "jobVersion",
              (SELECT count(*)::integer
                 FROM backlinks.backlink_lifecycle_events)
                AS "lifecycleCount",
              (SELECT count(*)::integer
                 FROM backlinks.backlink_audit_events)
                AS "auditCount"
         FROM backlinks.backlink_commercial_discovery_batches AS batch
         JOIN backlinks.backlink_jobs AS job ON job.id=$2
        WHERE batch.id=$1`,
      [discoveryBatchId, newJobAId],
    );
    expect(state.rows[0]).toEqual({
      ownerJobId: newJobAId,
      status: "running",
      jobVersion: 1,
      lifecycleCount: 0,
      auditCount: 0,
    });
  });

  it("allows only one of two concurrent new jobs to take ownership", async () => {
    const results = await Promise.allSettled([
      claim(newJobAId),
      claim(newJobBId),
    ]);
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof claim>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({ disposition: "resumed" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      message: "COMMERCIAL_DISCOVERY_BATCH_TAKEOVER_BLOCKED",
    });

    const state = await client.query(
      `SELECT batch.refill_job_id AS "ownerJobId",
              count(lifecycle.id)::integer AS "lifecycleCount",
              count(audit.id)::integer AS "auditCount"
         FROM backlinks.backlink_commercial_discovery_batches AS batch
         LEFT JOIN backlinks.backlink_lifecycle_events AS lifecycle
           ON lifecycle.event_type=
             'recommendation_refill.discovery_batch_resumed'
         LEFT JOIN backlinks.backlink_audit_events AS audit
           ON audit.action='recommendation_refill.discovery_batch_resumed'
        WHERE batch.id=$1
        GROUP BY batch.refill_job_id`,
      [discoveryBatchId],
    );
    expect([newJobAId, newJobBId]).toContain(state.rows[0]?.ownerJobId);
    expect(state.rows[0]).toMatchObject({
      lifecycleCount: 1,
      auditCount: 1,
    });
  });

  it.each([
    ["failed old job", async () => {
      await client.query(
        `UPDATE backlinks.backlink_jobs
            SET status='failed'
          WHERE id=$1`,
        [oldJobId],
      );
    }],
    ["running batch", async () => {
      await client.query(
        `UPDATE backlinks.backlink_commercial_discovery_batches
            SET status='running',finished_at=NULL
          WHERE id=$1`,
        [discoveryBatchId],
      );
    }],
    ["reserved usage", async () => {
      await client.query(
        `UPDATE backlinks.backlink_provider_usage_ledger
            SET status='reserved',actual_cost_micros=NULL,settled_at=NULL
          WHERE id=$1`,
        [providerUsageId],
      );
    }],
    ["acquired lease", async () => {
      await client.query(
        `UPDATE backlinks.provider_fetch_leases
            SET status='acquired'
          WHERE artifact_fingerprint=$1`,
        [providerRequestFingerprint],
      );
    }],
    ["unknown-charge request", async () => {
      await client.query(
        `UPDATE backlinks.provider_batch_requests
            SET status='unknown_charge'
          WHERE id=$1`,
        [providerRequestId],
      );
      await client.query(
        `UPDATE backlinks.backlink_provider_requests
            SET status='unknown_charge'
          WHERE id=$1`,
        [providerRequestId],
      );
    }],
    ["newer context", async () => {
      await client.query(
        `INSERT INTO backlinks.backlink_project_context_snapshots (
           id,organization_id,workspace_id,website_project_id,snapshot_version,
           project_status,canonical_domain,locale,country_code,
           profile_version_id,promotion_target_version_id,products,keywords,
           target_urls,target_market,target_audiences,partnership_goals,
           created_by
         ) VALUES (
           $1,$2,$3,$4,9,'ACTIVE','elephtv.com','en','ZA',
           'profile-v5','promotion-v2','["streaming entertainment"]'::jsonb,
           '["streaming service reviews"]'::jsonb,
           '["https://elephtv.com/watch"]'::jsonb,'ZA',
           '["South African viewers"]'::jsonb,
           '["editorial review"]'::jsonb,'stage2d-test'
         )`,
        [newerContextId, organizationId, workspaceId, websiteProjectId],
      );
    }],
  ])("fails closed for %s without partial audit writes", async (_name, setup) => {
    await setup();

    await expect(claim(newJobAId)).rejects.toThrow(
      "COMMERCIAL_DISCOVERY_BATCH_TAKEOVER_BLOCKED",
    );
    await assertNoTakeoverWrites();
  });

  it("fails closed when the generation input pin does not match", async () => {
    const wrongBinding: GenerationInputBinding = Object.freeze({
      ...inputBinding,
      immutableFingerprint: "wrong-generation-fingerprint",
    });

    await expect(claim(newJobAId, wrongBinding)).rejects.toThrow(
      "COMMERCIAL_DISCOVERY_BATCH_TAKEOVER_BLOCKED",
    );
    await assertNoTakeoverWrites();
  });
});
