import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { bundleWorkflowCode } from "@temporalio/worker";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DataForSeoProviderError } from "../../../src/modules/backlinks/adapters/dataforseo/error-mapper.js";
import { FakeDataForSeoAdapter } from "../../../src/modules/backlinks/adapters/dataforseo/fake-dataforseo.adapter.js";
import { DataForSeoCallPolicy } from "../../../src/modules/backlinks/application/policies/dataforseo-call.policy.js";
import { DataForSeoRequestService } from "../../../src/modules/backlinks/application/services/dataforseo-request.service.js";
import {
  createBacklinkProjectAnalysisActivities,
  createProjectAnalysisJobWriter,
} from "../../../src/modules/backlinks/activities/backlink-project-analysis.activity.js";
import { createJobRepository } from "../../../src/modules/backlinks/db/repositories/job.repository.js";
import { createProviderAnalysisRepository } from "../../../src/modules/backlinks/db/repositories/provider-analysis.repository.js";
import { createProjectContextSnapshotRepository } from "../../../src/modules/backlinks/db/repositories/project-context-snapshot.repository.js";
import type { DataForSeoPort } from "../../../src/modules/backlinks/ports/dataforseo.port.js";
import { runBacklinkProjectAnalysisWorkflow } from "../../../src/modules/backlinks/workflows/definitions/backlink-project-analysis.orchestration.js";
import {
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
} from "../../../src/modules/backlinks/workflows/namespaces.js";
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
  ): Promise<{
    rows: Record<string, unknown>[];
  }>;
};
const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};
const uuid = (value: number) =>
  `018f0000-0000-7000-8000-${value.toString().padStart(12, "0")}`;
const scope = {
  organizationId: uuid(1),
  workspaceId: uuid(2),
  websiteProjectId: uuid(3),
} as const;
const workflowInput = {
  ...scope,
  jobId: uuid(10),
  workflowId: buildBacklinksWorkflowId({
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    websiteProjectId: scope.websiteProjectId,
    workflow: "project-analysis",
    instanceId: uuid(10),
  }),
  snapshotVersion: 1,
} as const;
const now = new Date("2026-07-22T09:00:00.000Z");
const providerMigration = new URL(
  "../../../src/modules/backlinks/db/migrations/0002_backlink_provider_seo.sql",
  import.meta.url,
);
const migration = (name: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${name}`,
    import.meta.url,
  );
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const providerSnapshot = {
  provider: "dataforseo" as const,
  schemaVersion: "dataforseo.backlinks-referring-domains.v1",
  requestedAt: "2026-07-22T09:00:00.000Z",
  completedAt: "2026-07-22T09:00:01.000Z",
  costMicros: 20_000,
  payloadHash: "a".repeat(64),
  referringDomains: [],
};

describe("BL-AI-039/051 BacklinkProjectAnalysisWorkflow", () => {
  let harness: BacklinksPostgresHarness;
  let client: RuntimeClient;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new Client({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(providerMigration, "utf8"));
    for (const name of [
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(await readFile(roles, "utf8"));
    await client.query(
      await readFile(
        migration("0005_backlink_schema_role_ownership.sql"),
        "utf8",
      ),
    );
    await client.query(
      await readFile(migration("0032_dataforseo_cost_control.sql"), "utf8"),
    );
    await client.query(
      await readFile(
        migration("0042_backlink_project_recommendation_context.sql"),
        "utf8",
      ),
    );
    await client.query(`
      ALTER TABLE backlinks.backlink_project_context_snapshots
        ADD COLUMN target_market text NOT NULL DEFAULT '',
        ADD COLUMN target_audiences jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN partnership_goals jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await client.query("SET search_path = backlinks, pg_catalog");
  }, 120_000);
  beforeEach(() =>
    client.query(
      `TRUNCATE provider_artifact_usages, workspace_evidence_projections,
       provider_artifacts, provider_fetch_leases, provider_batch_requests,
       backlink_provider_usage_ledger, backlink_provider_cache_entries,
       backlink_seo_snapshots, backlink_provider_requests,
       backlink_provider_budgets, backlink_audit_events, backlink_lifecycle_events,
       backlink_project_context_snapshots, backlink_jobs CASCADE`,
    ),
  );
  afterAll(async () => {
    await client.end();
    await harness.stop();
  });

  it("bundles and replays Analysis without a second Provider charge", async () => {
    const bundle = await bundleWorkflowCode({
      workflowsPath: resolve(
        "src/modules/backlinks/workflows/definitions/index.ts",
      ),
    });
    expect(bundle.code).toContain(
      backlinksRuntimeContract.workflows.projectAnalysis.workflowType,
    );
    const provider = new FakeDataForSeoAdapter({
      outcome: "success",
      snapshot: providerSnapshot,
    });
    const activities = await createProviderActivities(provider);
    const load = activities.loadBacklinkProjectAnalysisContext;
    const first = await runBacklinkProjectAnalysisWorkflow(workflowInput, load);
    const replay = await runBacklinkProjectAnalysisWorkflow(
      workflowInput,
      load,
    );
    expect(replay).toEqual(first);
    expect(provider.calls).toHaveLength(1);
    expect(
      (
        await client.query(`
      SELECT l.status, l.actual_cost_micros, b.spent_micros, b.reserved_micros,
        batch.status AS batch_status,
        count(usage.id)::int AS usage_count
      FROM backlink_provider_usage_ledger l
      JOIN backlink_provider_budgets b ON b.id=l.budget_id
      JOIN provider_batch_requests batch ON batch.id=l.provider_request_id
      JOIN provider_artifacts artifact ON artifact.source_batch_id=batch.id
      JOIN provider_artifact_usages usage
        ON usage.artifact_id=artifact.id
      GROUP BY l.status,l.actual_cost_micros,b.spent_micros,b.reserved_micros,
        batch.status
    `)
      ).rows,
    ).toEqual([
      {
        status: "settled",
        actual_cost_micros: "20000",
        spent_micros: "20000",
        reserved_micros: "0",
        batch_status: "succeeded",
        usage_count: 2,
      },
    ]);
  }, 60_000);

  async function createProviderActivities(provider: DataForSeoPort) {
    const snapshots = createProjectContextSnapshotRepository(client);
    await snapshots.append({
      ...scope,
      snapshotId: uuid(20),
      snapshotVersion: 1,
      projectStatus: "ACTIVE",
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      targetMarket: "United States",
      profileVersionId: "profile-v1",
      promotionTargetVersionId: "promotion-v1",
      products: ["Example product"],
      keywords: ["example keyword"],
      targetUrls: ["https://example.com/"],
      targetAudiences: ["site owners"],
      partnershipGoals: ["editorial review"],
      actorId: "user-051",
    });
    await client.query(
      `INSERT INTO backlink_provider_budgets (
      id, organization_id, workspace_id, provider, period_start, period_end,
      limit_micros, created_by
    ) VALUES ($1,$2,$3,'dataforseo',$4,$5,100000,'user-051')`,
      [
        uuid(30),
        scope.organizationId,
        scope.workspaceId,
        "2026-07-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ],
    );
    const repository = createProviderAnalysisRepository(client, () => now);
    const gate = new DataForSeoCallPolicy({
      checkKillSwitch: async () => "allow",
      checkQuota: async () => "allow",
      reserveBudget: repository.reserveBudget,
    });
    const service = new DataForSeoRequestService({
      coordinator: repository,
      provider,
      gate,
      now: () => now,
    });
    return createBacklinkProjectAnalysisActivities(snapshots, {
      dataForSeo: service,
      cacheSchemaVersion: 1,
      estimatedCostMicros: 20_000,
      limit: 100,
    });
  }

  it("persists an uncertain local failure and blocks replay", async () => {
    const fetchBacklinkSnapshot = vi.fn(async () => {
      throw new DataForSeoProviderError({
        code: "DATAFORSEO_RESULT_UNKNOWN",
        providerRequestStatus: "unknown_charge",
        reconciliationRequired: true,
      });
    });
    const activities = await createProviderActivities({
      fetchBacklinkSnapshot,
    });

    await expect(
      runBacklinkProjectAnalysisWorkflow(
        workflowInput,
        activities.loadBacklinkProjectAnalysisContext,
      ),
    ).rejects.toMatchObject({ providerRequestStatus: "unknown_charge" });
    await expect(
      runBacklinkProjectAnalysisWorkflow(
        workflowInput,
        activities.loadBacklinkProjectAnalysisContext,
      ),
    ).rejects.toThrow("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");

    expect(fetchBacklinkSnapshot).toHaveBeenCalledOnce();
    const stored = await client.query(`
      SELECT r.status, l.status AS ledger_status, b.reserved_micros,
        batch.status AS batch_status, lease.status AS lease_status
        FROM backlink_provider_requests r
        JOIN backlink_provider_usage_ledger l ON l.provider_request_id=r.id
        JOIN backlink_provider_budgets b ON b.id=l.budget_id
        JOIN provider_batch_requests batch ON batch.id=r.id
        JOIN provider_fetch_leases lease
          ON lease.artifact_fingerprint=batch.normalized_request_hash
    `);
    expect(stored.rows).toEqual([
      {
        status: "unknown_charge",
        ledger_status: "reserved",
        reserved_micros: "20000",
        batch_status: "unknown_charge",
        lease_status: "unknown_charge",
      },
    ]);
  }, 60_000);

  it("closes zero-provider Analysis without recommendation side effects", async () => {
    const snapshots = createProjectContextSnapshotRepository(client);
    await snapshots.append({
      ...scope,
      snapshotId: uuid(20),
      snapshotVersion: 1,
      projectStatus: "ACTIVE",
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      targetMarket: "United States",
      profileVersionId: "profile-v1",
      promotionTargetVersionId: "promotion-v1",
      products: ["Example product"],
      keywords: ["example keyword"],
      targetUrls: ["https://example.com/"],
      targetAudiences: ["site owners"],
      partnershipGoals: ["editorial review"],
      actorId: "user-039",
    });
    const jobs = createJobRepository(client);
    const job = {
      ...scope,
      jobId: workflowInput.jobId,
      jobType: "project-analysis",
      sourceObjectType: "website_project",
      sourceObjectId: scope.websiteProjectId,
      workflowId: workflowInput.workflowId,
      correlationId: "correlation-039",
      actorId: "user-039",
    } as const;
    await expect(jobs.create(job)).resolves.toBe(true);
    const activities = createBacklinkProjectAnalysisActivities(
      snapshots,
      undefined,
      createProjectAnalysisJobWriter(client),
    );
    await expect(
      activities.loadBacklinkProjectAnalysisContext(workflowInput),
    ).resolves.toMatchObject({
      workflowId: workflowInput.workflowId,
      snapshotId: uuid(20),
      snapshotVersion: 1,
    });
    const completed = await client.query(
      `SELECT status,step,progress,started_at,finished_at,result_summary
         FROM backlink_jobs WHERE id=$1`,
      [workflowInput.jobId],
    );
    expect(completed.rows[0]).toMatchObject({
      status: "success",
      step: "completed",
      progress: 100,
      result_summary: {
        snapshotId: uuid(20),
        snapshotVersion: 1,
        canonicalDomain: "example.com",
      },
    });
    expect(completed.rows[0]?.started_at).not.toBeNull();
    expect(completed.rows[0]?.finished_at).not.toBeNull();
    await expect(jobs.create({ ...job, jobId: uuid(11) })).resolves.toBe(false);
    const stored = await client.query(
      "SELECT count(*)::int AS count FROM backlink_jobs WHERE workflow_id=$1",
      [workflowInput.workflowId],
    );
    expect(stored.rows[0]).toEqual({ count: 1 });
    const sideEffects = await client.query(`
      SELECT
        (SELECT count(*)::int FROM backlink_provider_requests)
          AS provider_request_count,
        (SELECT count(*)::int FROM backlink_provider_usage_ledger)
          AS provider_ledger_count,
        (SELECT count(*)::int FROM backlink_provider_budgets)
          AS provider_budget_count,
        (SELECT count(*)::int FROM provider_batch_requests)
          AS provider_batch_count,
        (SELECT count(*)::int FROM backlink_recommendation_refills)
          AS recommendation_refill_count,
        (SELECT count(*)::int
           FROM backlink_jobs
          WHERE job_type='recommendation_refill')
          AS recommendation_job_count,
        (SELECT count(*)::int
           FROM backlink_outbox_events
          WHERE event_type='backlinks.recommendation-refill.requested.v1')
          AS recommendation_outbox_count
    `);
    expect(sideEffects.rows[0]).toEqual({
      provider_request_count: 0,
      provider_ledger_count: 0,
      provider_budget_count: 0,
      provider_batch_count: 0,
      recommendation_refill_count: 0,
      recommendation_job_count: 0,
      recommendation_outbox_count: 0,
    });
  }, 60_000);

  it("closes a superseded snapshot job instead of leaving it recoverable", async () => {
    const snapshots = createProjectContextSnapshotRepository(client);
    const appendSnapshot = (
      snapshotId: string,
      snapshotVersion: number,
    ) => snapshots.append({
      ...scope,
      snapshotId,
      snapshotVersion,
      projectStatus: "ACTIVE",
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      targetMarket: "United States",
      profileVersionId: `profile-v${snapshotVersion}`,
      promotionTargetVersionId: `promotion-v${snapshotVersion}`,
      products: ["Example product"],
      keywords: ["example keyword"],
      targetUrls: ["https://example.com/"],
      targetAudiences: ["site owners"],
      partnershipGoals: ["editorial review"],
      actorId: "worker-analysis",
    });
    await appendSnapshot(uuid(20), 1);
    await appendSnapshot(uuid(21), 2);
    await expect(createJobRepository(client).create({
      ...scope,
      actorId: "worker-analysis",
      jobId: workflowInput.jobId,
      jobType: "project-analysis",
      sourceObjectType: "project-context-snapshot",
      sourceObjectId: uuid(20),
      workflowId: workflowInput.workflowId,
      correlationId: "correlation-superseded",
    })).resolves.toBe(true);

    const activities = createBacklinkProjectAnalysisActivities(
      snapshots,
      undefined,
      createProjectAnalysisJobWriter(client),
    );
    await expect(
      activities.loadBacklinkProjectAnalysisContext(workflowInput),
    ).rejects.toThrow("BACKLINK_PROJECT_CONTEXT_SNAPSHOT_VERSION_MISMATCH");

    expect((await client.query(
      `SELECT status,step,progress,result_summary,error,finished_at
         FROM backlink_jobs WHERE id=$1`,
      [workflowInput.jobId],
    )).rows[0]).toMatchObject({
      status: "cancelled",
      step: "superseded_project_context",
      progress: 100,
      result_summary: {
        outcome: "superseded",
        requestedSnapshotVersion: 1,
        authoritativeSnapshotId: uuid(21),
        authoritativeSnapshotVersion: 2,
      },
      error: null,
    });
  }, 60_000);

  it("fails a job terminally when its project snapshot is unavailable", async () => {
    await expect(createJobRepository(client).create({
      ...scope,
      actorId: "worker-analysis",
      jobId: workflowInput.jobId,
      jobType: "project-analysis",
      sourceObjectType: "project-context-snapshot",
      sourceObjectId: uuid(20),
      workflowId: workflowInput.workflowId,
      correlationId: "correlation-missing",
    })).resolves.toBe(true);
    const activities = createBacklinkProjectAnalysisActivities(
      createProjectContextSnapshotRepository(client),
      undefined,
      createProjectAnalysisJobWriter(client),
    );

    await expect(
      activities.loadBacklinkProjectAnalysisContext(workflowInput),
    ).rejects.toThrow("BACKLINK_PROJECT_CONTEXT_SNAPSHOT_NOT_FOUND");

    expect((await client.query(
      `SELECT status,step,progress,result_summary,error,finished_at
         FROM backlink_jobs WHERE id=$1`,
      [workflowInput.jobId],
    )).rows[0]).toMatchObject({
      status: "failed",
      step: "project_context_snapshot_invalid",
      progress: 100,
      result_summary: {
        outcome: "input_invalid",
        requestedSnapshotVersion: 1,
      },
      error: {
        code: "BACKLINK_PROJECT_CONTEXT_SNAPSHOT_NOT_FOUND",
        retryable: false,
      },
    });
  }, 60_000);
});
