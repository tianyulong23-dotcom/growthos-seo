import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { bundleWorkflowCode } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DataForSeoProviderError } from "../../../src/modules/backlinks/adapters/dataforseo/error-mapper.js";
import { FakeDataForSeoAdapter } from "../../../src/modules/backlinks/adapters/dataforseo/fake-dataforseo.adapter.js";
import { DataForSeoCallPolicy } from "../../../src/modules/backlinks/application/policies/dataforseo-call.policy.js";
import { DataForSeoRequestService } from "../../../src/modules/backlinks/application/services/dataforseo-request.service.js";
import {
  createBacklinkProjectAnalysisActivities,
} from "../../../src/modules/backlinks/activities/backlink-project-analysis.activity.js";
import { createJobRepository } from "../../../src/modules/backlinks/db/repositories/job.repository.js";
import { createProviderAnalysisRepository } from "../../../src/modules/backlinks/db/repositories/provider-analysis.repository.js";
import {
  createProjectContextSnapshotRepository,
} from "../../../src/modules/backlinks/db/repositories/project-context-snapshot.repository.js";
import type { DataForSeoPort } from "../../../src/modules/backlinks/ports/dataforseo.port.js";
import {
  runBacklinkProjectAnalysisWorkflow,
} from "../../../src/modules/backlinks/workflows/definitions/backlink-project-analysis.orchestration.js";
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
  query(text: string, values?: readonly unknown[]): Promise<{
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
  }, 120_000);
  beforeEach(() => client.query(
    `TRUNCATE backlink_provider_usage_ledger, backlink_provider_cache_entries,
       backlink_seo_snapshots, backlink_provider_requests,
       backlink_provider_budgets, backlink_audit_events, backlink_lifecycle_events,
       backlink_project_context_snapshots, backlink_jobs`,
  ));
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
    const replay = await runBacklinkProjectAnalysisWorkflow(workflowInput, load);
    expect(replay).toEqual(first);
    expect(provider.calls).toHaveLength(1);
    expect((await client.query(`
      SELECT l.status, l.actual_cost_micros, b.spent_micros, b.reserved_micros
      FROM backlink_provider_usage_ledger l
      JOIN backlink_provider_budgets b ON b.id=l.budget_id
    `)).rows).toEqual([{
      status: "settled",
      actual_cost_micros: "20000",
      spent_micros: "20000",
      reserved_micros: "0",
    }]);
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
      profileVersionId: "profile-v1",
      promotionTargetVersionId: "promotion-v1",
      actorId: "user-051",
    });
    await client.query(`INSERT INTO backlink_provider_budgets (
      id, organization_id, workspace_id, provider, period_start, period_end,
      limit_micros, created_by
    ) VALUES ($1,$2,$3,'dataforseo',$4,$5,100000,'user-051')`, [
      uuid(30),
      scope.organizationId,
      scope.workspaceId,
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
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
      cacheTtlMs: 60_000,
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

    await expect(runBacklinkProjectAnalysisWorkflow(
      workflowInput,
      activities.loadBacklinkProjectAnalysisContext,
    )).rejects.toMatchObject({ providerRequestStatus: "unknown_charge" });
    await expect(runBacklinkProjectAnalysisWorkflow(
      workflowInput,
      activities.loadBacklinkProjectAnalysisContext,
    )).rejects.toThrow("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");

    expect(fetchBacklinkSnapshot).toHaveBeenCalledOnce();
    const stored = await client.query(`
      SELECT r.status, l.status AS ledger_status, b.reserved_micros
        FROM backlink_provider_requests r
        JOIN backlink_provider_usage_ledger l ON l.provider_request_id=r.id
        JOIN backlink_provider_budgets b ON b.id=l.budget_id
    `);
    expect(stored.rows).toEqual([{
      status: "unknown_charge",
      ledger_status: "reserved",
      reserved_micros: "20000",
    }]);
  }, 60_000);

  it("keeps the Activity read-only and rejects a second Job for one workflow ID", async () => {
    const snapshots = createProjectContextSnapshotRepository(client);
    await snapshots.append({
      ...scope,
      snapshotId: uuid(20),
      snapshotVersion: 1,
      projectStatus: "ACTIVE",
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "profile-v1",
      promotionTargetVersionId: "promotion-v1",
      actorId: "user-039",
    });
    const activities = createBacklinkProjectAnalysisActivities(snapshots);
    await expect(
      activities.loadBacklinkProjectAnalysisContext(workflowInput),
    ).resolves.toMatchObject({
      workflowId: workflowInput.workflowId,
      snapshotId: uuid(20),
      snapshotVersion: 1,
    });

    const jobs = createJobRepository(client);
    const job = {
      ...scope,
      jobId: workflowInput.jobId,
      jobType: "backlink_project_analysis",
      sourceObjectType: "website_project",
      sourceObjectId: scope.websiteProjectId,
      workflowId: workflowInput.workflowId,
      correlationId: "correlation-039",
      actorId: "user-039",
    } as const;
    await expect(jobs.create(job)).resolves.toBe(true);
    await expect(jobs.create({ ...job, jobId: uuid(11) })).resolves.toBe(false);
    const stored = await client.query(
      "SELECT count(*)::int AS count FROM backlink_jobs WHERE workflow_id=$1",
      [workflowInput.workflowId],
    );
    expect(stored.rows[0]).toEqual({ count: 1 });
  }, 60_000);

});
