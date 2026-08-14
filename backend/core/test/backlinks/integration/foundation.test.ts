import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runProjectScopedLane } from "../../../src/modules/backlinks/application/services/project-scope-scheduler.js";
import { createIdempotencyRepository } from "../../../src/modules/backlinks/db/repositories/idempotency.repository.js";
import { createJobRepository } from "../../../src/modules/backlinks/db/repositories/job.repository.js";
import { withBacklinkTenantTransaction } from "../../../src/modules/backlinks/db/tenant-transaction.js";
import { buildBacklinksWorkflowId } from "../../../src/modules/backlinks/workflows/namespaces.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type RuntimeQueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};
type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<RuntimeQueryResult>;
};
type RuntimePoolClient = {
  query(text: string, values?: readonly unknown[]): Promise<RuntimeQueryResult>;
  release(): void;
};
type RuntimePool = {
  connect(): Promise<RuntimePoolClient>;
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
};
const fixtureUrl = new URL("./foundation.fixture.sql", import.meta.url);
const foundationTables = [
  "backlink_idempotency_records",
  "backlink_outbox_events",
  "backlink_jobs",
  "backlink_lifecycle_events",
  "backlink_audit_events",
] as const;
const ids = {
  organizationA: "018f0000-0000-7000-8000-000000000001",
  workspaceA: "018f0000-0000-7000-8000-000000000002",
  projectA: "018f0000-0000-7000-8000-000000000003",
  projectB: "018f0000-0000-7000-8000-000000000004",
  workspaceB: "018f0000-0000-7000-8000-000000000006",
  projectC: "018f0000-0000-7000-8000-000000000007",
  rowA: "018f0000-0000-7000-8000-000000000101",
  rowProjectB: "018f0000-0000-7000-8000-000000000102",
  rowWorkspaceB: "018f0000-0000-7000-8000-000000000103",
  concurrentJob: "018f0000-0000-7000-8000-000000000501",
  sourceObject: "018f0000-0000-7000-8000-000000000601",
} as const;
const saasMatrix = Array.from({ length: 2 }, (_, organizationIndex) =>
  Array.from({ length: 2 }, (_, workspaceIndex) =>
    Array.from({ length: 2 }, (_, projectIndex) => {
      const suffix =
        (organizationIndex + 1) * 100
        + (workspaceIndex + 1) * 10
        + projectIndex
        + 1;
      return {
        organizationId:
          `11000000-0000-4000-8000-${String(organizationIndex + 1).padStart(12, "0")}`,
        workspaceId:
          `22000000-0000-4000-8000-${String(
            (organizationIndex + 1) * 10 + workspaceIndex + 1,
          ).padStart(12, "0")}`,
        websiteProjectId:
          `33000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
        projectContextSnapshotId:
          `66000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
        projectContextSnapshotVersion: 1,
        jobId:
          `44000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
        sourceObjectId:
          `55000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
      };
    }),
  ),
).flat(2);

describe("BL-AI-036 foundation isolation and idempotency", () => {
  const role = `bl_ai_036_role_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;
  let fixture: string;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    fixture = await readFile(fixtureUrl, "utf8");
    admin = new Client({ connectionString: harness.connectionString });
    await admin.connect();
    await admin.query(`
      CREATE ROLE "${role}"
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
    `);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    );

    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = role;
    tenantUrl.password = password;
    tenantPool = new Pool({
      connectionString: tenantUrl.toString(),
      max: 20,
    });
  }, 120_000);

  beforeEach(async () => {
    await admin.query(`
      TRUNCATE backlink_audit_events, backlink_lifecycle_events,
               backlink_jobs, backlink_outbox_events,
               backlink_idempotency_records
    `);
  });

  afterAll(async () => {
    await tenantPool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
    await harness?.stop();
  }, 30_000);

  it("blocks every foundation table across Project and Workspace tenants", async () => {
    await admin.query(fixture);
    const foreignIds = [ids.rowProjectB, ids.rowWorkspaceB];

    const observations = await withBacklinkTenantTransaction(
      tenantPool,
      {
        organizationId: ids.organizationA,
        workspaceId: ids.workspaceA,
        websiteProjectId: ids.projectA,
      },
      async (transaction) => {
        const rows = [];
        for (const table of foundationTables) {
          const visible = await transaction.query(
            `SELECT id FROM ${table} ORDER BY id`,
          );
          const foreign = await transaction.query(
            `SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`,
            [foreignIds],
          );
          const updated = await transaction.query(
            `UPDATE ${table} SET created_at = created_at
              WHERE id = ANY($1::uuid[])`,
            [foreignIds],
          );
          const deleted = await transaction.query(
            `DELETE FROM ${table} WHERE id = ANY($1::uuid[])`,
            [foreignIds],
          );
          rows.push({
            table,
            visible: visible.rows,
            foreign: foreign.rows,
            updated: updated.rowCount,
            deleted: deleted.rowCount,
          });
        }
        return rows;
      },
    );

    expect(observations).toEqual(
      foundationTables.map((table) => ({
        table,
        visible: [{ id: ids.rowA }],
        foreign: [],
        updated: 0,
        deleted: 0,
      })),
    );
    for (const table of foundationTables) {
      const retained = await admin.query(
        `SELECT count(*)::int AS count
           FROM ${table}
          WHERE id = ANY($1::uuid[])`,
        [foreignIds],
      );
      expect(retained.rows).toEqual([{ count: 2 }]);
    }
  });

  it("isolates a 2x2x2 SaaS matrix and continues after one project fails", async () => {
    for (const scope of saasMatrix) {
      await admin.query(
        `INSERT INTO backlink_jobs (
           id, organization_id, workspace_id, website_project_id, job_type,
           source_object_type, source_object_id, workflow_id, correlation_id,
           created_by, updated_by
         ) VALUES ($1,$2,$3,$4,'local_product_022_isolation_probe','project',
           $5,$6,$7,'local-product-022','local-product-022')`,
        [
          scope.jobId,
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
          scope.sourceObjectId,
          buildBacklinksWorkflowId({
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId,
            websiteProjectId: scope.websiteProjectId,
            workflow: "draft-generation",
            instanceId: scope.jobId,
          }),
          `local-product-022:${scope.websiteProjectId}`,
        ],
      );
    }

    for (const scope of saasMatrix) {
      const visible = await withBacklinkTenantTransaction(
        tenantPool,
        scope,
        async (transaction) => {
          const rows = await transaction.query(
            `SELECT id, organization_id, workspace_id, website_project_id,
                    workflow_id
               FROM backlink_jobs`,
          );
          const foreignUpdate = await transaction.query(
            `UPDATE backlink_jobs
                SET step = 'cross-tenant-write'
              WHERE id <> $1`,
            [scope.jobId],
          );
          return { rows: rows.rows, foreignUpdate: foreignUpdate.rowCount };
        },
      );
      expect(visible).toMatchObject({
        rows: [{
          id: scope.jobId,
          organization_id: scope.organizationId,
          workspace_id: scope.workspaceId,
          website_project_id: scope.websiteProjectId,
        }],
        foreignUpdate: 0,
      });
      expect(String(visible.rows[0]?.workflow_id)).toContain(
        `${scope.organizationId}:${scope.workspaceId}:${scope.websiteProjectId}`,
      );
    }

    const workflowIds = await admin.query(
      `SELECT workflow_id
         FROM backlink_jobs
        WHERE job_type = 'local_product_022_isolation_probe'`,
    );
    expect(new Set(workflowIds.rows.map(({ workflow_id }) => workflow_id)).size)
      .toBe(8);

    const failedProjectId = saasMatrix[3]?.websiteProjectId;
    const visited: string[] = [];
    const failures: string[] = [];
    let completed = 0;
    let failed = 0;
    const workspaceScopes = Map.groupBy(
      saasMatrix,
      ({ organizationId, workspaceId }) => `${organizationId}:${workspaceId}`,
    );
    for (const [workspaceKey, scopes] of workspaceScopes) {
      const [organizationId, workspaceId] = workspaceKey.split(":");
      const outcome = await runProjectScopedLane({
        provider: {
          async listActiveProjectScopes(input) {
            expect(input).toMatchObject({
              organizationId,
              workspaceId,
              cursor: null,
            });
            return { scopes, nextCursor: null };
          },
        },
        organizationId: organizationId ?? "",
        workspaceId: workspaceId ?? "",
        lane: "placement-monitoring",
        pageLimit: 2,
        async run(scope) {
          visited.push(scope.websiteProjectId);
          if (scope.websiteProjectId === failedProjectId) {
            throw new Error("LOCAL_PRODUCT_022_EXPECTED_SCOPE_FAILURE");
          }
        },
        onProjectError(scope, error) {
          failures.push(
            `${scope.websiteProjectId}:${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      });
      completed += outcome.completed;
      failed += outcome.failed;
    }

    expect(visited).toHaveLength(8);
    expect(completed).toBe(7);
    expect(failed).toBe(1);
    expect(failures).toEqual([
      `${failedProjectId}:LOCAL_PRODUCT_022_EXPECTED_SCOPE_FAILURE`,
    ]);
  });

  it("creates one logical Job for 20 concurrent identical commands", async () => {
    const attempts = Array.from({ length: 20 }, (_, index) =>
      withBacklinkTenantTransaction(
        tenantPool,
        {
          organizationId: ids.organizationA,
          workspaceId: ids.workspaceA,
          websiteProjectId: ids.projectA,
        },
        async (transaction) => {
          const idempotency = createIdempotencyRepository(transaction);
          const jobs = createJobRepository(transaction);
          const recordId =
            `018f0000-0000-7000-8000-${String(index + 400).padStart(12, "0")}`;
          const scope = {
            organizationId: ids.organizationA,
            workspaceId: ids.workspaceA,
            websiteProjectId: ids.projectA,
            actorId: "bl-ai-036",
          } as const;
          const begun = await idempotency.begin({
            ...scope,
            recordId,
            idempotencyKey: "foundation-concurrent-command",
            commandType: "CREATE_FOUNDATION_JOB",
            requestHash: "sha256:foundation-concurrent",
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          });

          if (begun.state === "begun") {
            expect(
              await jobs.create({
                ...scope,
                jobId: ids.concurrentJob,
                jobType: "foundation",
                sourceObjectType: "project",
                sourceObjectId: ids.sourceObject,
                workflowId: "workflow-036-concurrent",
                correlationId: "correlation-036-concurrent",
              }),
            ).toBe(true);
            const completed = await idempotency.complete({
              ...scope,
              recordId: begun.recordId,
              response: {
                status: 202,
                body: { jobId: ids.concurrentJob },
                schemaVersion: 1,
              },
            });
            return {
              state: begun.state,
              jobId: (completed.response.body as { jobId?: unknown }).jobId,
            };
          }
          return {
            state: begun.state,
            jobId:
              begun.state === "completed"
                ? (begun.response.body as { jobId?: unknown }).jobId
                : undefined,
          };
        },
      ),
    );
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result.state === "begun")).toHaveLength(1);
    expect(results.map((result) => result.jobId)).toEqual(
      Array.from({ length: 20 }, () => ids.concurrentJob),
    );
    await expect(
      admin.query(`
        SELECT
          (SELECT count(*)::int FROM backlink_idempotency_records) AS idempotency_count,
          (SELECT count(*)::int FROM backlink_jobs) AS job_count
      `),
    ).resolves.toMatchObject({
      rows: [{ idempotency_count: 1, job_count: 1 }],
    });
  });
});
