import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createJobRepository } from "../../../src/modules/backlinks/db/repositories/job.repository.js";
import { createLifecycleRepository } from "../../../src/modules/backlinks/db/repositories/lifecycle.repository.js";

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
const databaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
const migrationPath = new URL(
  "../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql",
  import.meta.url,
);
const uuid = (value: number) =>
  `018f0000-0000-7000-8000-${value.toString().padStart(12, "0")}`;

describe.skipIf(databaseUrl === undefined)("BL-AI-032 Job/Lifecycle Repository", () => {
  const schema = `bl_ai_032_${process.pid}_${Date.now()}`;
  const scope = {
    organizationId: uuid(1), workspaceId: uuid(2),
    websiteProjectId: uuid(3), actorId: "user-032",
  } as const;
  let client: RuntimeClient;
  let jobs: ReturnType<typeof createJobRepository>;
  let lifecycle: ReturnType<typeof createLifecycleRepository>;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(await readFile(migrationPath, "utf8"));
    jobs = createJobRepository(client);
    lifecycle = createLifecycleRepository(client);
  });
  beforeEach(() => client.query(
    "TRUNCATE backlink_audit_events, backlink_lifecycle_events, backlink_jobs",
  ));
  afterAll(async () => {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  });

  const createJob = (jobId = uuid(10)) => jobs.create({
    ...scope, jobId, jobType: "assessment", sourceObjectType: "opportunity",
    sourceObjectId: uuid(11), workflowId: "workflow-032",
    correlationId: "correlation-032",
  });

  it("creates and transitions a Job with status and version guards", async () => {
    await expect(createJob()).resolves.toBe(true);
    await expect(jobs.transition({
      ...scope, jobId: uuid(10), expectedVersion: 1, from: "queued",
      to: "running", step: "fetch", progress: 25,
      resultSummary: null, error: null,
    })).resolves.toBe(true);
    await expect(jobs.transition({
      ...scope, jobId: uuid(10), expectedVersion: 1, from: "queued",
      to: "failed", step: "stale", progress: 25,
      resultSummary: null, error: { code: "stale" },
    })).resolves.toBe(false);
    await expect(jobs.transition({
      ...scope, jobId: uuid(10), expectedVersion: 2, from: "running",
      to: "success", step: "done", progress: 100,
      resultSummary: { assessed: 1 }, error: null,
    })).resolves.toBe(true);
    await expect(jobs.transition({
      ...scope, jobId: uuid(10), expectedVersion: 3, from: "success",
      to: "running", step: "overwrite", progress: 50,
      resultSummary: null, error: null,
    })).resolves.toBe(false);
    const stored = await client.query(
      "SELECT status, version, progress, finished_at IS NOT NULL AS finished FROM backlink_jobs",
    );
    expect(stored.rows[0]).toEqual({
      status: "success", version: 3, progress: 100, finished: true,
    });
  });

  it("appends linked lifecycle/audit history without overwriting it", async () => {
    await createJob();
    const event = {
      ...scope, lifecycleEventId: uuid(20), auditEventId: uuid(21),
      jobId: uuid(10), aggregateType: "opportunity", aggregateId: uuid(11),
      sequence: 1, aggregateVersion: 2, eventType: "opportunity.assessed",
      actorType: "user", beforeState: { status: "pending" },
      afterState: { status: "assessed" }, reason: "assessment complete",
      correlationId: "correlation-032", causationId: null,
      idempotencyKey: "lifecycle-032", requestId: "request-032",
      outcome: "success", previousIntegrityHash: null,
      integrityHash: "sha256:event-032", eventSchemaVersion: 1,
    } as const;
    await expect(lifecycle.append(event)).resolves.toEqual({
      lifecycleEventId: event.lifecycleEventId, auditEventId: event.auditEventId,
    });
    await expect(lifecycle.append({
      ...event, lifecycleEventId: uuid(22), auditEventId: uuid(23),
      idempotencyKey: "lifecycle-032-rewrite",
      afterState: { status: "overwritten" },
    })).rejects.toMatchObject({ code: "23505" });
    const stored = await client.query(`
      SELECT l.after_state AS "afterState",
             (SELECT count(*)::int FROM backlink_lifecycle_events) AS lifecycle_count,
             (SELECT count(*)::int FROM backlink_audit_events) AS audit_count
        FROM backlink_lifecycle_events l
    `);
    expect(stored.rows[0]).toEqual({
      afterState: { status: "assessed" }, lifecycle_count: 1, audit_count: 1,
    });
  });
});
