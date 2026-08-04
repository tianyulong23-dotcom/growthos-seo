import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withBacklinkTenantTransaction } from "../../../src/modules/backlinks/db/tenant-transaction.js";

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
const databaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
const migrationPath = new URL(
  "../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql",
  import.meta.url,
);
const fixturePath = new URL(
  "./fixtures/backlink-foundation-rls.sql",
  import.meta.url,
);
const ids = {
  organizationA: "018f0000-0000-7000-8000-000000000001",
  workspaceA: "018f0000-0000-7000-8000-000000000002",
  projectA: "018f0000-0000-7000-8000-000000000003",
  projectB: "018f0000-0000-7000-8000-000000000004",
  jobA: "018f0000-0000-7000-8000-000000000101",
  jobProjectB: "018f0000-0000-7000-8000-000000000102",
  rolledBackJob: "018f0000-0000-7000-8000-000000000104",
} as const;

describe.skipIf(databaseUrl === undefined)("BL-AI-034 tenant transaction", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `bl_ai_034_${suffix}`;
  const role = `bl_ai_034_role_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(await readFile(migrationPath, "utf8"));
    await admin.query(await readFile(fixturePath, "utf8"));
    await admin.query(`
      CREATE ROLE "${role}"
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
    `);
    await admin.query(`ALTER ROLE "${role}" SET search_path TO "${schema}"`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );

    const tenantUrl = new URL(databaseUrl);
    tenantUrl.username = role;
    tenantUrl.password = password;
    tenantPool = new Pool({ connectionString: tenantUrl.toString(), max: 1 });
  });

  afterAll(async () => {
    await tenantPool.end();
    await admin.query("SET search_path TO public");
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  });

  it("clears committed tenant context before reusing the same connection", async () => {
    const first = await withBacklinkTenantTransaction(
      tenantPool,
      { workspaceId: ids.workspaceA, websiteProjectId: ids.projectA },
      async (transaction) => {
        const context = await transaction.query(`
          SELECT current_setting('app.current_workspace_id', true) AS "workspaceId",
                 current_setting('app.current_website_project_id', true) AS "websiteProjectId",
                 pg_backend_pid() AS pid
        `);
        const jobs = await transaction.query(
          "SELECT id FROM backlink_jobs ORDER BY id",
        );
        return { context: context.rows[0], jobs: jobs.rows };
      },
    );
    expect(first.context).toMatchObject({
      workspaceId: ids.workspaceA,
      websiteProjectId: ids.projectA,
    });
    expect(first.jobs).toEqual([{ id: ids.jobA }]);

    const released = await tenantPool.connect();
    try {
      const cleared = await released.query(`
        SELECT current_setting('app.current_workspace_id', true) AS "workspaceId",
               current_setting('app.current_website_project_id', true) AS "websiteProjectId",
               pg_backend_pid() AS pid
      `);
      expect(cleared.rows[0]?.workspaceId ?? "").toBe("");
      expect(cleared.rows[0]?.websiteProjectId ?? "").toBe("");
      expect(cleared.rows[0]?.pid).toBe(first.context?.pid);
      expect((await released.query("SELECT id FROM backlink_jobs")).rows).toEqual(
        [],
      );
    } finally {
      released.release();
    }

    const second = await withBacklinkTenantTransaction(
      tenantPool,
      { workspaceId: ids.workspaceA, websiteProjectId: ids.projectB },
      async (transaction) => ({
        context: (
          await transaction.query(`
            SELECT current_setting('app.current_website_project_id', true) AS "websiteProjectId",
                   pg_backend_pid() AS pid
          `)
        ).rows[0],
        jobs: (
          await transaction.query("SELECT id FROM backlink_jobs ORDER BY id")
        ).rows,
      }),
    );
    expect(second.context).toMatchObject({
      websiteProjectId: ids.projectB,
      pid: first.context?.pid,
    });
    expect(second.jobs).toEqual([{ id: ids.jobProjectB }]);
  });

  it("rolls back callback failures before returning the connection", async () => {
    const failure = new Error("BL-AI-034 rollback");
    let transactionPid: unknown;

    await expect(
      withBacklinkTenantTransaction(
        tenantPool,
        { workspaceId: ids.workspaceA, websiteProjectId: ids.projectA },
        async (transaction) => {
          transactionPid = (
            await transaction.query("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          await transaction.query(
            `INSERT INTO backlink_jobs (
              id, organization_id, workspace_id, website_project_id, job_type,
              source_object_type, source_object_id, workflow_id, correlation_id,
              created_by, updated_by
            ) VALUES ($1, $2, $3, $4, 'assessment', 'opportunity', $1, $5, $5, 'bl-ai-034', 'bl-ai-034')`,
            [
              ids.rolledBackJob,
              ids.organizationA,
              ids.workspaceA,
              ids.projectA,
              "workflow-034-rollback",
            ],
          );
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    const released = await tenantPool.connect();
    try {
      const cleared = await released.query(`
        SELECT current_setting('app.current_workspace_id', true) AS "workspaceId",
               current_setting('app.current_website_project_id', true) AS "websiteProjectId",
               pg_backend_pid() AS pid
      `);
      expect(cleared.rows[0]?.workspaceId ?? "").toBe("");
      expect(cleared.rows[0]?.websiteProjectId ?? "").toBe("");
      expect(cleared.rows[0]?.pid).toBe(transactionPid);
    } finally {
      released.release();
    }

    const stored = await admin.query(
      "SELECT id FROM backlink_jobs WHERE id = $1",
      [ids.rolledBackJob],
    );
    expect(stored.rows).toEqual([]);
  });
});
