import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  runProjectScopedLane,
} from "../../../src/modules/backlinks/application/services/project-scope-scheduler.js";
import { createJobRepository } from "../../../src/modules/backlinks/db/repositories/job.repository.js";
import {
  createOutboxRepository,
  createScopedOutboxRelayRepository,
} from "../../../src/modules/backlinks/db/repositories/outbox.repository.js";
import {
  createPostgresqlProjectScopeProvider,
} from "../../../src/modules/backlinks/db/repositories/project-scope.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import type {
  ActiveProjectScope,
} from "../../../src/modules/backlinks/ports/project-scope-provider.port.js";
import {
  buildBacklinksWorkflowId,
} from "../../../src/modules/backlinks/workflows/namespaces.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type RuntimePool = BacklinkTenantPool & { end(): Promise<void> };
type DeploymentManifest = Readonly<{
  steps: readonly Readonly<{ migrationId: string; path: string }>[];
}>;

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
  readonly Pool: new (config: unknown) => RuntimePool;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const migrationUrl = (path: string) => new URL(
  `../../../src/modules/backlinks/db/migrations/${basename(path)}`,
  import.meta.url,
);
const organizationId = "10000000-0000-4000-8000-000000000014";
const workspaceId = "20000000-0000-4000-8000-000000000014";
const projects = [
  {
    name: "ElephTV",
    websiteProjectId: "30000000-0000-4000-8000-000000000001",
    snapshotId: "40000000-0000-4000-8000-000000000001",
    jobId: "50000000-0000-4000-8000-000000000001",
    eventId: "60000000-0000-4000-8000-000000000001",
  },
  {
    name: "AWOL Vision",
    websiteProjectId: "30000000-0000-4000-8000-000000000002",
    snapshotId: "40000000-0000-4000-8000-000000000002",
    jobId: "50000000-0000-4000-8000-000000000002",
    eventId: "60000000-0000-4000-8000-000000000002",
  },
  {
    name: "Temporary acceptance project",
    websiteProjectId: "30000000-0000-4000-8000-000000000003",
    snapshotId: "40000000-0000-4000-8000-000000000003",
    jobId: "50000000-0000-4000-8000-000000000003",
    eventId: "60000000-0000-4000-8000-000000000003",
  },
] as const;
const runtimeRole = "local_product_014_runtime";
const runtimePassword = "local-product-014-password";
const eventType = "backlinks.project-scope-probe.requested.v1";
const legacyJobId = "50000000-0000-4000-8000-000000000014";
const legacyEventId = "60000000-0000-4000-8000-000000000014";
const orphanProjectId = "30000000-0000-4000-8000-000000000099";
const orphanSnapshotId = "40000000-0000-4000-8000-000000000099";
const legacyWorkflowId =
  "backlinks:20000000-0000-4000-8000-000000000014:" +
  "30000000-0000-4000-8000-000000000001:project-analysis:v1:" +
  legacyJobId;
const scopedLegacyWorkflowId =
  "backlinks:10000000-0000-4000-8000-000000000014:" +
  "20000000-0000-4000-8000-000000000014:" +
  "30000000-0000-4000-8000-000000000001:project-analysis:v1:" +
  legacyJobId;

function runtimeConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.username = runtimeRole;
  url.password = runtimePassword;
  return url.toString();
}

function projectFixture(scope: ActiveProjectScope) {
  const fixture = projects.find(
    ({ websiteProjectId }) => websiteProjectId === scope.websiteProjectId,
  );
  if (fixture === undefined) {
    throw new Error("PROJECT_SCOPE_FIXTURE_MISSING");
  }
  return fixture;
}

describe("LOCAL-PRODUCT-014 project scope provider", () => {
  let harness: BacklinksPostgresHarness;
  let admin: Client;
  let runtimePool: RuntimePool;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    await admin.query(await readFile(rolesUrl, "utf8"));
    await admin.query(`
      SET ROLE growthos_platform_owner;
      SET search_path = platform, pg_catalog;

      CREATE TABLE projects (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        status text NOT NULL,
        context_version integer NOT NULL
      );
      ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE projects FORCE ROW LEVEL SECURITY;
      CREATE POLICY platform_projects_tenant_policy
        ON projects
        USING (
          organization_id =
            NULLIF(
              current_setting('app.current_organization_id', true),
              ''
            )
          AND (
            NULLIF(current_setting('app.current_project_id', true), '')
              IS NULL
            OR id =
              NULLIF(current_setting('app.current_project_id', true), '')
          )
        );

      CREATE FUNCTION backlink_list_active_website_projects(
        p_organization_id text,
        p_workspace_id text
      )
      RETURNS TABLE (
        website_project_id text,
        context_version integer
      )
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = platform, pg_catalog
      AS $function$
        SELECT project.id,
               project.context_version
          FROM platform.projects AS project
         WHERE p_organization_id =
           NULLIF(
             current_setting('app.current_organization_id', true),
             ''
           )
           AND p_workspace_id =
             NULLIF(
               current_setting('app.current_workspace_id', true),
               ''
             )
           AND project.organization_id = p_organization_id
           AND project.workspace_id = p_workspace_id
           AND project.status = 'ACTIVE'
         ORDER BY project.id;
      $function$;
      REVOKE ALL
        ON FUNCTION backlink_list_active_website_projects(text, text)
        FROM PUBLIC;
      GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
      GRANT EXECUTE
        ON FUNCTION backlink_list_active_website_projects(text, text)
        TO growthos_backlinks_owner;

      RESET ROLE;
      RESET search_path;
    `);
    for (const project of projects) {
      await admin.query(
        `INSERT INTO platform.projects (
           id, organization_id, workspace_id, status, context_version
         ) VALUES ($1,$2,$3,'ACTIVE',1)`,
        [project.websiteProjectId, organizationId, workspaceId],
      );
    }

    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    const backlinkSteps = manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-")
        && migrationId !== "backlinks-0001"
    );
    for (const step of backlinkSteps.filter(
      ({ migrationId }) =>
        !["backlinks-0043", "backlinks-0044"].includes(migrationId),
    )) {
      await admin.query(await readFile(migrationUrl(step.path), "utf8"));
    }
    await admin.query("SET search_path = backlinks, pg_catalog");
    for (const [index, project] of projects.entries()) {
      await admin.query(
        `INSERT INTO backlink_project_context_snapshots (
           id, organization_id, workspace_id, website_project_id,
           snapshot_version, project_status, canonical_domain, locale,
           country_code, profile_version_id, promotion_target_version_id,
           products, keywords, target_urls, created_by
         ) VALUES (
           $1,$2,$3,$4,1,'ACTIVE',$5,'en-US','US',$6,$7,
           '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'local-product-014'
         )`,
        [
          project.snapshotId,
          organizationId,
          workspaceId,
          project.websiteProjectId,
          `project-${index + 1}.example`,
          `profile-${index + 1}`,
          `target-${index + 1}`,
        ],
      );
    }
    await admin.query(
      `INSERT INTO backlink_project_context_snapshots (
         id, organization_id, workspace_id, website_project_id,
         snapshot_version, project_status, canonical_domain, locale,
         country_code, profile_version_id, promotion_target_version_id,
         products, keywords, target_urls, created_by
       ) VALUES (
         $1,$2,$3,$4,1,'ACTIVE','orphan.example','en-US','US',
         'orphan-profile','orphan-target','[]'::jsonb,'[]'::jsonb,
         '[]'::jsonb,'local-product-014'
       )`,
      [orphanSnapshotId, organizationId, workspaceId, orphanProjectId],
    );
    await admin.query(
      `INSERT INTO backlink_jobs (
         id, organization_id, workspace_id, website_project_id,
         job_type, source_object_type, source_object_id, workflow_id,
         correlation_id, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,'project_analysis','project_context_snapshot',$5,$6,
         'local-product-014-upgrade','local-product-014','local-product-014'
       )`,
      [
        legacyJobId,
        organizationId,
        workspaceId,
        projects[0].websiteProjectId,
        projects[0].snapshotId,
        legacyWorkflowId,
      ],
    );
    await admin.query(
      `INSERT INTO backlink_outbox_events (
         id, organization_id, workspace_id, website_project_id,
         event_type, aggregate_id, aggregate_version, idempotency_key,
         payload, payload_schema_version, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,'backlinks.project-analysis.requested.v1',$5::uuid,1,
         $6::text,
         jsonb_build_object('jobId',$5::uuid::text,'workflowId',$6::text),
         1,'local-product-014','local-product-014'
       )`,
      [
        legacyEventId,
        organizationId,
        workspaceId,
        projects[0].websiteProjectId,
        legacyJobId,
        legacyWorkflowId,
      ],
    );
    const scopeMigrations = backlinkSteps.filter(
      ({ migrationId }) =>
        ["backlinks-0043", "backlinks-0044"].includes(migrationId),
    );
    if (scopeMigrations.length !== 2) {
      throw new Error("BACKLINKS_PROJECT_SCOPE_MIGRATIONS_MISSING");
    }
    for (const migration of scopeMigrations) {
      await admin.query(await readFile(
        migrationUrl(migration.path),
        "utf8",
      ));
    }
    await admin.query(`
      CREATE ROLE ${runtimeRole}
        LOGIN PASSWORD '${runtimePassword}'
        IN ROLE growthos_backlinks_writer
    `);
    await admin.query(
      `ALTER ROLE ${runtimeRole} SET search_path = backlinks, pg_catalog`,
    );
    runtimePool = new PgPool({
      connectionString: runtimeConnectionString(harness.connectionString),
      max: 4,
    });
  }, 180_000);

  afterAll(async () => {
    await runtimePool?.end();
    await admin?.end();
    await harness?.stop();
  });

  it("enumerates three projects fairly, isolates RLS, and recovers from PostgreSQL", async () => {
    await expect(admin.query(
      `SELECT workflow_id AS "workflowId"
         FROM backlink_jobs
        WHERE id=$1`,
      [legacyJobId],
    )).resolves.toMatchObject({
      rows: [{ workflowId: scopedLegacyWorkflowId }],
    });
    await expect(admin.query(
      `SELECT idempotency_key AS "idempotencyKey",
              payload->>'workflowId' AS "workflowId"
         FROM backlink_outbox_events
        WHERE id=$1`,
      [legacyEventId],
    )).resolves.toMatchObject({
      rows: [{
        idempotencyKey: scopedLegacyWorkflowId,
        workflowId: scopedLegacyWorkflowId,
      }],
    });

    const firstProvider = createPostgresqlProjectScopeProvider(runtimePool);
    await expect(firstProvider.listActiveProjectScopes({
      organizationId,
      workspaceId,
      lane: "draft-generation",
      cursor: null,
      limit: 2,
    })).resolves.toMatchObject({
      scopes: [
        { websiteProjectId: projects[0].websiteProjectId },
        { websiteProjectId: projects[1].websiteProjectId },
      ],
      nextCursor: projects[1].websiteProjectId,
    });

    const firstCreated = await runNoProviderProbe(runtimePool);
    expect(firstCreated).toEqual({
      outcome: { visited: 3, completed: 3, failed: 0 },
      created: 3,
      visited: projects.map(({ websiteProjectId }) => websiteProjectId),
      errors: [],
    });
    expect(await admin.query(
      `SELECT count(*)::int AS count
         FROM backlink_jobs
        WHERE job_type='local_product_014_no_provider_probe'`,
    )).toMatchObject({ rows: [{ count: 3 }] });

    for (const project of projects) {
      const repository = createScopedOutboxRelayRepository(runtimePool, {
        organizationId,
        workspaceId,
        websiteProjectId: project.websiteProjectId,
      });
      const claimed = await repository.claim({
        workerId: `local-product-014:${project.websiteProjectId}`,
        limit: 10,
        eventType,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.websiteProjectId).toBe(project.websiteProjectId);
      await expect(repository.mark({
        eventId: project.eventId,
        workerId: `local-product-014:${project.websiteProjectId}`,
        outcome: "published",
      })).resolves.toBe(true);
    }

    await admin.query(
      `INSERT INTO backlink_project_context_snapshots (
         id, organization_id, workspace_id, website_project_id,
         snapshot_version, project_status, canonical_domain, locale,
         country_code, profile_version_id, promotion_target_version_id,
         products, keywords, target_urls, created_by
       ) VALUES (
         $1,$2,$3,$4,2,'PAUSED','project-2.example','en-US','US',
         'profile-2','target-2','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
         'local-product-014'
       )`,
      [
        "40000000-0000-4000-8000-000000000012",
        organizationId,
        workspaceId,
        projects[1].websiteProjectId,
      ],
    );
    await admin.query(
      `UPDATE platform.projects
          SET context_version=2
        WHERE id=$1`,
      [projects[1].websiteProjectId],
    );

    const afterPause = await runNoProviderProbe(runtimePool);
    expect(afterPause).toEqual({
      outcome: { visited: 2, completed: 2, failed: 0 },
      created: 0,
      visited: [
        projects[0].websiteProjectId,
        projects[2].websiteProjectId,
      ],
      errors: [],
    });

    await runtimePool.end();
    runtimePool = new PgPool({
      connectionString: runtimeConnectionString(harness.connectionString),
      max: 4,
    });
    const afterRestart = await runNoProviderProbe(runtimePool);
    expect(afterRestart).toEqual(afterPause);
    expect(await admin.query(
      `SELECT count(*)::int AS count
         FROM backlink_jobs
        WHERE job_type='local_product_014_no_provider_probe'`,
    )).toMatchObject({ rows: [{ count: 3 }] });
    expect(await admin.query(
      `SELECT count(*)::int AS count
         FROM backlink_outbox_events
        WHERE event_type=$1`,
      [eventType],
    )).toMatchObject({ rows: [{ count: 3 }] });
  }, 60_000);
});

async function runNoProviderProbe(pool: RuntimePool) {
  let created = 0;
  const visited: string[] = [];
  const errors: string[] = [];
  const outcome = await runProjectScopedLane({
    provider: createPostgresqlProjectScopeProvider(pool),
    organizationId,
    workspaceId,
    lane: "draft-generation",
    pageLimit: 2,
    async run(scope) {
      visited.push(scope.websiteProjectId);
      const fixture = projectFixture(scope);
      await withBacklinkTenantTransaction(pool, scope, async (client) => {
        const visible = await client.query(
          `SELECT website_project_id AS "websiteProjectId"
             FROM backlink_project_context_snapshots
            ORDER BY snapshot_version`,
        );
        expect([
          ...new Set(visible.rows.map(({ websiteProjectId }) =>
            String(websiteProjectId))),
        ]).toEqual([scope.websiteProjectId]);

        const workflowId = buildBacklinksWorkflowId({
          organizationId,
          workspaceId,
          websiteProjectId: scope.websiteProjectId,
          workflow: "draft-generation",
          instanceId: scope.projectContextSnapshotId,
        });
        if (await createJobRepository(client).create({
          organizationId,
          workspaceId,
          websiteProjectId: scope.websiteProjectId,
          jobId: fixture.jobId,
          jobType: "local_product_014_no_provider_probe",
          sourceObjectType: "project_context_snapshot",
          sourceObjectId: scope.projectContextSnapshotId,
          workflowId,
          correlationId: `local-product-014:${scope.websiteProjectId}`,
          actorId: "local-product-014",
        })) {
          created += 1;
        }
        await createOutboxRepository(client).append({
          eventId: fixture.eventId,
          organizationId,
          workspaceId,
          websiteProjectId: scope.websiteProjectId,
          eventType,
          aggregateId: fixture.jobId,
          aggregateVersion: 1,
          idempotencyKey: workflowId,
          payload: {
            organizationId,
            workspaceId,
            websiteProjectId: scope.websiteProjectId,
            projectContextSnapshotId: scope.projectContextSnapshotId,
          },
          payloadSchemaVersion: 1,
          actorId: "local-product-014",
        });
      });
    },
    onProjectError(_scope, error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });
  return { outcome, created, visited, errors };
}
