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
  createProjectContextProjectionCommand,
  type ProjectContextProjectionInput,
} from "../../../src/modules/backlinks/application/commands/project-context-projection.command.js";
import {
  createBacklinkProjectAnalysisActivities,
  createProjectAnalysisJobWriter,
} from "../../../src/modules/backlinks/activities/backlink-project-analysis.activity.js";
import {
  ensureCommercialRecommendationRefill,
} from "../../../src/modules/backlinks/application/services/commercial-inventory-refill.service.js";
import {
  createProjectContextSnapshotRepository,
} from "../../../src/modules/backlinks/db/repositories/project-context-snapshot.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
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

const uuid = (value: number) =>
  `018f0000-0000-7000-8000-${value.toString().padStart(12, "0")}`;

function projectionInput(seed: number): ProjectContextProjectionInput {
  const organizationId = uuid(seed + 1);
  const workspaceId = uuid(seed + 2);
  const websiteProjectId = uuid(seed + 3);
  const snapshotId = uuid(seed + 4);
  const profileVersionId = uuid(seed + 5);
  const promotionTargetVersionId = uuid(seed + 6);
  const outreachProfileRecordId = uuid(seed + 9);
  const siteProfileEvidenceId = uuid(seed + 10);
  const keywordEvidenceId = uuid(seed + 11);
  return {
    organizationId,
    workspaceId,
    websiteProjectId,
    actorId: `projector-${seed}`,
    actorSessionId: `session-${seed}`,
    actorRoles: ["member"],
    correlationId: `correlation-${seed}`,
    snapshotId,
    snapshotVersion: 4,
    projectStatus: "ACTIVE",
    canonicalDomain: `example-${seed}.com`,
    locale: "en-US",
    countryCode: "US",
    targetMarket: "United States home cinema",
    profileVersionId,
    promotionTargetVersionId,
    products: ["Home cinema projector"],
    keywords: ["home cinema"],
    targetUrls: [`https://example-${seed}.com/`],
    targetAudiences: ["home cinema buyers"],
    partnershipGoals: ["editorial review"],
    inputComplete: true,
    jobId: uuid(seed + 7),
    outboxEventId: uuid(seed + 8),
    outreachProfile: {
      recordId: outreachProfileRecordId,
      immutableFingerprint: `outreach-profile-${seed}`,
      profile: {
        organizationId,
        websiteProjectId,
        profileVersionId,
        promotionTargetVersionId,
        keywordsAndTopics: ["home cinema"],
        productsAndServices: ["Home cinema projector"],
        targetUrls: [`https://example-${seed}.com/`],
        targetAudiences: ["home cinema buyers"],
        partnershipGoals: ["editorial review"],
        market: "United States home cinema",
        location: "US",
        language: "en-US",
        authorizedDiscoverySources: ["KEYWORDS"],
        immutableFingerprint: `outreach-profile-${seed}`,
      },
    },
    sharedSeoEvidence: [
      {
        recordId: siteProfileEvidenceId,
        snapshot: {
          organizationId,
          websiteProjectId,
          evidenceType: "site-profile",
          sourceModule: "site-profile",
          sourceRecordId: profileVersionId,
          sourceVersion: "4",
          provider: "website-project",
          endpoint: "website-project",
          normalizedParameters: {},
          requestFingerprint: `site-profile-${seed}`,
          market: "United States home cinema",
          location: "US",
          language: "en-US",
          fetchedAt: "2026-08-18T00:00:00.000Z",
          expiresAt: "2027-08-18T00:00:00.000Z",
          providerRequestId: `website-project:site-profile:${seed}`,
          providerTaskId: null,
          costMicros: 0,
          artifactRef: `website-project://site-profile/${seed}`,
          status: "ready",
        },
      },
      {
        recordId: keywordEvidenceId,
        snapshot: {
          organizationId,
          websiteProjectId,
          evidenceType: "keywords",
          sourceModule: "keywords",
          sourceRecordId: keywordEvidenceId,
          sourceVersion: "4",
          provider: "website-project",
          endpoint: "website-project",
          normalizedParameters: {},
          requestFingerprint: `keywords-${seed}`,
          market: "United States home cinema",
          location: "US",
          language: "en-US",
          fetchedAt: "2026-08-18T00:00:00.000Z",
          expiresAt: "2027-08-18T00:00:00.000Z",
          providerRequestId: `website-project:keywords:${seed}`,
          providerTaskId: null,
          costMicros: 0,
          artifactRef: `website-project://keywords/${seed}`,
          status: "ready",
        },
      },
    ],
    generationInputPins: {
      recordId: uuid(seed + 12),
      outreachProfileRecordId,
      immutableFingerprint: `generation-pin-${seed}`,
      pins: {
        organizationId,
        websiteProjectId,
        projectContextVersion: 4,
        siteProfileVersionId: profileVersionId,
        outreachProfileVersionId: profileVersionId,
        promotionTargetVersionId,
        keywordEvidenceSnapshotIds: [keywordEvidenceId],
        sharedEvidenceSnapshotIds: [
          siteProfileEvidenceId,
          keywordEvidenceId,
        ],
        market: "United States home cinema",
        qualificationContractVersion: "recommendation-qualification.v1",
      },
    },
  };
}

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

describe("Website Project recommendation demand projection", () => {
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
        backlinks.backlink_outbox_events,
        backlinks.backlink_jobs,
        backlinks.backlink_generation_input_pins,
        backlinks.backlink_shared_seo_evidence_references,
        backlinks.backlink_outreach_profile_versions,
        backlinks.backlink_commercial_inventory_policies,
        backlinks.backlink_project_context_snapshots,
        backlinks.provider_batch_requests,
        backlinks.backlink_provider_usage_ledger,
        backlinks.backlink_provider_budgets,
        backlinks.backlink_provider_requests,
        backlinks.backlink_recommendation_refills
      CASCADE
    `);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("creates recommendation demand without a paid-discovery authorization gate", async () => {
    const createdInput = projectionInput(100);
    const restoredInput = projectionInput(200);
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_inventory_policies (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,updated_by
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        restoredInput.organizationId,
        restoredInput.workspaceId,
        restoredInput.websiteProjectId,
        restoredInput.snapshotId,
        "cancel-before-dispatch",
      ],
    );

    const command = createProjectContextProjectionCommand(pool);
    await expect(command.project(createdInput)).resolves.toMatchObject({
      state: "projected",
      inputRequired: false,
      jobScheduled: true,
    });
    await expect(command.project(restoredInput)).resolves.toMatchObject({
      state: "projected",
      inputRequired: false,
      jobScheduled: true,
    });
    await expect(command.project(createdInput)).resolves.toMatchObject({
      state: "replayed",
      inputRequired: false,
      jobScheduled: false,
    });

    const policies = await client.query(`
      SELECT website_project_id::text AS "websiteProjectId",
             visible_pool_state AS "visiblePoolState",
             refill_state AS "refillState",
             termination_reason AS "terminationReason",
             pause_reason AS "pauseReason",
             next_refill_at AS "nextRefillAt",
             version
        FROM backlinks.backlink_commercial_inventory_policies
       ORDER BY website_project_id
    `);
    expect(policies.rows).toEqual([
      {
        websiteProjectId: createdInput.websiteProjectId,
        visiblePoolState: "idle",
        refillState: "idle",
        terminationReason: null,
        pauseReason: null,
        nextRefillAt: null,
        version: 1,
      },
      {
        websiteProjectId: restoredInput.websiteProjectId,
        visiblePoolState: "idle",
        refillState: "idle",
        terminationReason: null,
        pauseReason: null,
        nextRefillAt: null,
        version: 1,
      },
    ]);

    const lifecycle = await client.query(`
      SELECT website_project_id::text AS "websiteProjectId",
             after_state->>'policyAction' AS "policyAction",
             (after_state->>'snapshotVersion')::integer AS "snapshotVersion"
        FROM backlinks.backlink_lifecycle_events
       WHERE event_type='recommendation.demand.ready'
       ORDER BY website_project_id
    `);
    expect(lifecycle.rows).toEqual([
      {
        websiteProjectId: createdInput.websiteProjectId,
        policyAction: "created",
        snapshotVersion: createdInput.snapshotVersion,
      },
    ]);

    const effects = await client.query(`
      SELECT
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='project-analysis') AS "projectAnalysisJobs",
        (SELECT count(*)::int FROM backlinks.backlink_outbox_events
          WHERE event_type='backlinks.project-analysis.requested.v1')
          AS "projectAnalysisOutboxes",
        (SELECT count(*)::int FROM backlinks.backlink_recommendation_refills)
          AS "recommendationRefills",
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='recommendation_refill') AS "recommendationJobs",
        (SELECT count(*)::int FROM backlinks.backlink_outbox_events
          WHERE event_type='backlinks.recommendation-refill.requested.v1')
          AS "recommendationOutboxes",
        (SELECT count(*)::int FROM backlinks.backlink_provider_requests)
          AS "providerRequests",
        (SELECT count(*)::int FROM backlinks.provider_batch_requests)
          AS "providerBatches",
        (SELECT count(*)::int FROM backlinks.backlink_provider_budgets)
          AS "providerBudgets",
        (SELECT count(*)::int FROM backlinks.backlink_provider_usage_ledger)
          AS "providerLedger"
    `);
    expect(effects.rows).toEqual([{
      projectAnalysisJobs: 2,
      projectAnalysisOutboxes: 2,
      recommendationRefills: 0,
      recommendationJobs: 0,
      recommendationOutboxes: 0,
      providerRequests: 0,
      providerBatches: 0,
      providerBudgets: 0,
      providerLedger: 0,
    }]);

    const analysisJob = await client.query(
      `SELECT workflow_id AS "workflowId"
         FROM backlinks.backlink_jobs
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$4
          AND job_type='project-analysis'`,
      [
        createdInput.organizationId,
        createdInput.workspaceId,
        createdInput.websiteProjectId,
        createdInput.jobId,
      ],
    );
    const workflowId = analysisJob.rows[0]?.workflowId;
    expect(typeof workflowId).toBe("string");
    const completeProjectAnalysis = () =>
      withBacklinkTenantTransaction(
        pool,
        createdInput,
        async (transaction) =>
          createBacklinkProjectAnalysisActivities(
            createProjectContextSnapshotRepository(transaction),
            undefined,
            createProjectAnalysisJobWriter(transaction),
            {
              ensure: async (input) => {
                await ensureCommercialRecommendationRefill(transaction, {
                  ...input,
                  estimatedCostMicros: 27_600,
                  absoluteBudgetMicros: 1_000_000,
                  maxPaidCalls: 6,
                  candidateLimit: 25,
                  now: new Date("2026-08-25T00:00:00.000Z"),
                });
              },
            },
          ).loadBacklinkProjectAnalysisContext({
            organizationId: createdInput.organizationId,
            workspaceId: createdInput.workspaceId,
            websiteProjectId: createdInput.websiteProjectId,
            jobId: createdInput.jobId,
            workflowId: String(workflowId),
            snapshotVersion: createdInput.snapshotVersion,
          }),
      );
    await expect(completeProjectAnalysis()).resolves.toMatchObject({
      snapshotId: createdInput.snapshotId,
      snapshotVersion: createdInput.snapshotVersion,
    });
    await expect(completeProjectAnalysis()).resolves.toMatchObject({
      snapshotId: createdInput.snapshotId,
      snapshotVersion: createdInput.snapshotVersion,
    });

    const automaticEffects = await client.query(`
      SELECT
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='project-analysis' AND status='success')
          AS "completedProjectAnalysisJobs",
        (SELECT count(*)::int FROM backlinks.backlink_recommendation_refills)
          AS "recommendationRefills",
        (SELECT count(*)::int FROM backlinks.backlink_jobs
          WHERE job_type='recommendation_refill') AS "recommendationJobs",
        (SELECT count(*)::int FROM backlinks.backlink_outbox_events
          WHERE event_type='backlinks.recommendation-refill.requested.v1')
          AS "recommendationOutboxes",
        (SELECT count(*)::int FROM backlinks.backlink_provider_requests)
          AS "providerRequests",
        (SELECT count(*)::int FROM backlinks.provider_batch_requests)
          AS "providerBatches",
        (SELECT count(*)::int FROM backlinks.backlink_provider_budgets)
          AS "providerBudgets",
        (SELECT count(*)::int FROM backlinks.backlink_provider_usage_ledger)
          AS "providerLedger"
    `);
    expect(automaticEffects.rows).toEqual([{
      completedProjectAnalysisJobs: 1,
      recommendationRefills: 1,
      recommendationJobs: 1,
      recommendationOutboxes: 1,
      providerRequests: 0,
      providerBatches: 0,
      providerBudgets: 1,
      providerLedger: 0,
    }]);

    const audits = await client.query(`
      SELECT count(*)::int AS count
        FROM backlinks.backlink_audit_events
       WHERE action='recommendation.demand.ready'
         AND (after_redacted->>'snapshotVersion')::integer=4
    `);
    expect(audits.rows).toEqual([{ count: 1 }]);
  }, 60_000);
});
