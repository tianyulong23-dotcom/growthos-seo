import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = {
  rows: Record<string, unknown>[];
};
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type DeploymentManifest = Readonly<{
  steps: readonly Readonly<{ migrationId: string; path: string }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const migrationUrl = (path: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
    import.meta.url,
  );
const uuid = (value: number) =>
  `99000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const organizationId = uuid(1);
const workspaceId = uuid(2);
const actorId = "project-analysis-recovery-test";
const staleAt = "2026-08-24T00:00:00.000Z";
const staleBefore = "2026-08-25T00:00:00.000Z";

describe("project-analysis recovery migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    const backlinkSteps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-") &&
        migrationId !== "backlinks-0001",
    );
    const migration0076 = backlinkSteps.find(
      ({ migrationId }) => migrationId === "backlinks-0076",
    );
    if (migration0076 === undefined) {
      throw new Error("BACKLINKS_MIGRATION_0076_MISSING");
    }
    await installBacklinksManifestAfterFoundation(client, "0075");
    await seedProjectAnalysisJob({
      websiteProjectId: uuid(10),
      jobId: uuid(11),
      eventId: uuid(12),
      sourceSnapshotId: uuid(13),
      latestSnapshotId: uuid(14),
      eventSnapshotVersion: 1,
    });
    await seedProjectAnalysisJob({
      websiteProjectId: uuid(20),
      jobId: uuid(21),
      eventId: uuid(22),
      sourceSnapshotId: uuid(23),
      eventSnapshotVersion: 1,
    });
    await seedProjectAnalysisJob({
      websiteProjectId: uuid(30),
      jobId: uuid(31),
      eventId: uuid(32),
      sourceSnapshotId: uuid(33),
      eventSnapshotVersion: 2,
    });
    await client.query(
      await readFile(migrationUrl(migration0076.path), "utf8"),
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  async function seedProjectAnalysisJob(
    input: Readonly<{
      websiteProjectId: string;
      jobId: string;
      eventId: string;
      sourceSnapshotId: string;
      latestSnapshotId?: string;
      eventSnapshotVersion: number;
    }>,
  ) {
    const workflowId = `project-analysis:${input.jobId}`;
    await client.query(
      `
      INSERT INTO backlinks.backlink_project_context_snapshots (
        id,organization_id,workspace_id,website_project_id,snapshot_version,
        project_status,canonical_domain,locale,country_code,
        profile_version_id,promotion_target_version_id,created_by
      ) VALUES (
        $1,$2,$3,$4,1,'ACTIVE','recovery.test','en-US','US',
        'profile-v1','target-v1',$5
      )
    `,
      [
        input.sourceSnapshotId,
        organizationId,
        workspaceId,
        input.websiteProjectId,
        actorId,
      ],
    );
    if (input.latestSnapshotId !== undefined) {
      await client.query(
        `
        INSERT INTO backlinks.backlink_project_context_snapshots (
          id,organization_id,workspace_id,website_project_id,snapshot_version,
          project_status,canonical_domain,locale,country_code,
          profile_version_id,promotion_target_version_id,created_by
        ) VALUES (
          $1,$2,$3,$4,2,'ACTIVE','recovery.test','en-US','US',
          'profile-v2','target-v2',$5
        )
      `,
        [
          input.latestSnapshotId,
          organizationId,
          workspaceId,
          input.websiteProjectId,
          actorId,
        ],
      );
    }
    await client.query(
      `
      INSERT INTO backlinks.backlink_jobs (
        id,organization_id,workspace_id,website_project_id,job_type,
        source_object_type,source_object_id,status,workflow_id,correlation_id,
        created_at,updated_at,created_by,updated_by
      ) VALUES (
        $1,$2,$3,$4,'project-analysis','project-context-snapshot',$5,
        'queued',$6,$7,$8,$8,$9,$9
      )
    `,
      [
        input.jobId,
        organizationId,
        workspaceId,
        input.websiteProjectId,
        input.sourceSnapshotId,
        workflowId,
        `correlation:${input.jobId}`,
        staleAt,
        actorId,
      ],
    );
    await client.query(
      `
      INSERT INTO backlinks.backlink_outbox_events (
        id,organization_id,workspace_id,website_project_id,event_type,
        aggregate_id,aggregate_version,idempotency_key,payload,
        payload_schema_version,status,published_at,created_at,updated_at,
        created_by,updated_by
      ) VALUES (
        $1,$2,$3,$4,'backlinks.project-analysis.requested.v1',
        $5,$6,$7,$8::jsonb,1,'published',$9,$9,$9,$10,$10
      )
    `,
      [
        input.eventId,
        organizationId,
        workspaceId,
        input.websiteProjectId,
        input.sourceSnapshotId,
        input.eventSnapshotVersion,
        `project-analysis:${input.websiteProjectId}:${input.eventSnapshotVersion}`,
        JSON.stringify({
          organizationId,
          workspaceId,
          websiteProjectId: input.websiteProjectId,
          jobId: input.jobId,
          workflowId,
          snapshotVersion: input.eventSnapshotVersion,
        }),
        staleAt,
        actorId,
      ],
    );
  }

  it("closes superseded and invalid jobs during migration", async () => {
    expect(
      (
        await client.query(`
      SELECT website_project_id AS "websiteProjectId",status,step,
             progress,result_summary AS "resultSummary",error
        FROM backlinks.backlink_jobs
       ORDER BY website_project_id
    `)
      ).rows,
    ).toEqual([
      expect.objectContaining({
        websiteProjectId: uuid(10),
        status: "cancelled",
        step: "superseded_project_context",
        progress: 100,
        resultSummary: expect.objectContaining({
          outcome: "superseded",
          sourceSnapshotVersion: 1,
          authoritativeSnapshotVersion: 2,
        }),
        error: null,
      }),
      expect.objectContaining({
        websiteProjectId: uuid(20),
        status: "queued",
        step: null,
        progress: 0,
      }),
      expect.objectContaining({
        websiteProjectId: uuid(30),
        status: "failed",
        step: "project_context_snapshot_invalid",
        progress: 100,
        error: {
          code: "BACKLINK_PROJECT_CONTEXT_EVENT_VERSION_INVALID",
          retryable: false,
        },
      }),
    ]);
  });

  it("rearms only the job pinned to the current authoritative snapshot", async () => {
    expect(
      (
        await client.query(
          `
      SELECT active_jobs AS "activeJobs",
             recoverable_queued_project_analysis AS "recoverableQueued",
             unrecoverable_stale_queued_project_analysis AS
               "unrecoverableQueued"
        FROM backlinks.backlink_project_task_runtime_health($1)
    `,
          [staleBefore],
        )
      ).rows,
    ).toEqual([
      {
        activeJobs: 1,
        recoverableQueued: 1,
        unrecoverableQueued: 0,
      },
    ]);

    expect(
      (
        await client.query(
          `
      SELECT backlinks.backlink_rearm_stale_project_analysis_events(
        $1,$2,$3
      ) AS "rearmedCount"
    `,
          [actorId, staleBefore, 10],
        )
      ).rows,
    ).toEqual([{ rearmedCount: 1 }]);
    expect(
      (
        await client.query(
          `
      SELECT job.status,job.step,job.retry_count AS "retryCount",
             event.status AS "eventStatus",event.published_at AS "publishedAt"
        FROM backlinks.backlink_jobs AS job
        JOIN backlinks.backlink_outbox_events AS event
          ON event.payload->>'jobId'=job.id::text
       WHERE job.website_project_id=$1
    `,
          [uuid(20)],
        )
      ).rows,
    ).toEqual([
      {
        status: "queued",
        step: "recovery_queued",
        retryCount: 1,
        eventStatus: "pending",
        publishedAt: null,
      },
    ]);
  });
});
