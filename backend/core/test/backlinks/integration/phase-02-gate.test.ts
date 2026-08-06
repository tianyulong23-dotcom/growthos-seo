import { createRequire } from "node:module";
import { resolve } from "node:path";

import { Client as TemporalClient, Connection } from "@temporalio/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBacklinkProjectAnalysisActivities,
  type BacklinkProjectAnalysisActivities,
} from "../../../src/modules/backlinks/activities/backlink-project-analysis.activity.js";
import { createJobRepository } from "../../../src/modules/backlinks/db/repositories/job.repository.js";
import {
  createProjectContextSnapshotRepository,
} from "../../../src/modules/backlinks/db/repositories/project-context-snapshot.repository.js";
import {
  backlinksTemporalConfigSchema,
} from "../../../src/modules/backlinks/workflows/client.js";
import {
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
} from "../../../src/modules/backlinks/workflows/namespaces.js";
import {
  startBacklinksWorker,
  type RunningBacklinksWorker,
} from "../../../src/modules/backlinks/workflows/worker.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";
import {
  startBacklinksTemporalHarness,
  type BacklinksTemporalHarness,
} from "./harness/temporal-server.js";

type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
  }>;
};
const require = createRequire(import.meta.url);
const { Client: PostgresClient } = require("pg") as {
  readonly Client: new (config: unknown) => PgClient;
};
const scope = {
  organizationId: "10000000-0000-4000-8000-000000000041",
  workspaceId: "20000000-0000-4000-8000-000000000041",
  websiteProjectId: "30000000-0000-4000-8000-000000000041",
} as const;
const jobId = "40000000-0000-4000-8000-000000000041";
const snapshotId = "50000000-0000-4000-8000-000000000041";
const workflowId = buildBacklinksWorkflowId({
  organizationId: scope.organizationId,
  workspaceId: scope.workspaceId,
  websiteProjectId: scope.websiteProjectId,
  workflow: "project-analysis",
  instanceId: jobId,
});
const taskQueue = backlinksRuntimeContract.taskQueue;
const buildId = "backlinks-2026.07.22.041";

describe("BL-AI-041 Phase 02 gate", () => {
  let postgres: BacklinksPostgresHarness;
  let temporal: BacklinksTemporalHarness;
  let database: PgClient;

  beforeAll(async () => {
    postgres = await startBacklinksPostgresHarness();
    await postgres.migrate();
    temporal = await startBacklinksTemporalHarness();
    database = new PostgresClient({ connectionString: postgres.connectionString });
    await database.connect();
    await database.query(`
      ALTER TABLE backlink_project_context_snapshots
        ADD COLUMN products jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN target_urls jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
  }, 120_000);
  afterAll(async () => {
    await database?.end();
    await temporal?.stop();
    await postgres?.stop();
  });

  it("resumes after Worker restart while PostgreSQL facts survive shutdown", async () => {
    const snapshots = createProjectContextSnapshotRepository(database);
    await snapshots.append({
      ...scope,
      snapshotId,
      snapshotVersion: 1,
      projectStatus: "ACTIVE",
      canonicalDomain: "example.com",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "profile-v1",
      promotionTargetVersionId: "promotion-v1",
      products: ["Example product"],
      keywords: ["example keyword"],
      targetUrls: ["https://example.com/"],
      actorId: "gate-test",
    });
    await createJobRepository(database).create({
      ...scope,
      jobId,
      jobType: "backlink_project_analysis",
      sourceObjectType: "website_project",
      sourceObjectId: scope.websiteProjectId,
      workflowId,
      correlationId: "correlation-041",
      actorId: "gate-test",
    });

    const connection = await Connection.connect({ address: temporal.address });
    const client = new TemporalClient({
      connection,
      namespace: temporal.namespace,
    });
    const config = backlinksTemporalConfigSchema.parse({
      BACKLINKS_WORKER_ENABLED: "true",
      TEMPORAL_ADDRESS: temporal.address,
      TEMPORAL_NAMESPACE: temporal.namespace,
      TEMPORAL_BACKLINKS_TASK_QUEUE: taskQueue,
      TEMPORAL_BUILD_ID: buildId,
    });
    const workflowsPath = resolve(
      "src/modules/backlinks/workflows/definitions/index.ts",
    );
    const stableActivities = createBacklinkProjectAnalysisActivities(snapshots);
    let rejectFirstAttempt: (() => void) | undefined;
    const firstAttemptRejected = new Promise<void>((resolveAttempt) => {
      rejectFirstAttempt = resolveAttempt;
    });
    const failingActivities: BacklinkProjectAnalysisActivities = {
      async loadBacklinkProjectAnalysisContext(input) {
        await stableActivities.loadBacklinkProjectAnalysisContext(input);
        rejectFirstAttempt?.();
        throw new Error("BL_AI_041_INJECTED_WORKER_INTERRUPTION");
      },
    };
    let firstWorker: RunningBacklinksWorker | undefined;
    let replacementWorker: RunningBacklinksWorker | undefined;

    try {
      firstWorker = await startBacklinksWorker(
        config,
        { activities: {
          backlinksLoadProjectAnalysisContextV1:
            failingActivities.loadBacklinkProjectAnalysisContext,
        }, workflowsPath },
      );
      const handle = await client.workflow.start(
        backlinksRuntimeContract.workflows.projectAnalysis.workflowType,
        {
          workflowId,
          taskQueue,
          args: [{ ...scope, jobId, workflowId, snapshotVersion: 1 }],
        },
      );
      await firstAttemptRejected;
      await firstWorker.stop();
      firstWorker = undefined;

      const factsAfterStop = await database.query(
        `SELECT
           (SELECT count(*)::int FROM backlink_jobs WHERE id=$1) AS job_count,
           (SELECT count(*)::int FROM backlink_project_context_snapshots
             WHERE id=$2) AS snapshot_count`,
        [jobId, snapshotId],
      );
      expect(factsAfterStop.rows[0]).toEqual({
        job_count: 1,
        snapshot_count: 1,
      });

      replacementWorker = await startBacklinksWorker(
        config,
        { activities: {
          backlinksLoadProjectAnalysisContextV1:
            stableActivities.loadBacklinkProjectAnalysisContext,
        }, workflowsPath },
      );
      await expect(handle.result()).resolves.toMatchObject({
        ...scope,
        jobId,
        workflowId,
        snapshotId,
        snapshotVersion: 1,
      });
    } finally {
      await replacementWorker?.stop();
      await firstWorker?.stop();
      await connection.close();
    }
  }, 120_000);
});
