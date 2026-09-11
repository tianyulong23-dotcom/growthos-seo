import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

type DeploymentStep = Readonly<{
  migrationId?: string;
  path?: string;
  sha256?: string;
  prerequisites?: readonly string[];
  recovery?: string;
  tool?: string;
}>;

type DeploymentManifest = Readonly<{
  heads?: Readonly<{ backlinks?: string }>;
  steps?: readonly DeploymentStep[];
}>;

const expectedMigrationId = "backlinks-0085";
const expectedPrerequisite = "backlinks-0084";
const expectedPath =
  "backend/core/src/modules/backlinks/db/migrations/" +
  "0085_backlink_recommendation_pool_v2_phase9_v1_freeze.sql";
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifestPath = resolve(
  repositoryRoot,
  "backend/database/deployment-manifest.v1.json",
);

async function loadMigration(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as DeploymentManifest;
  const steps = manifest.steps ?? [];
  const migrationStepIndex = steps.findIndex(
    (candidate) => candidate.migrationId === expectedMigrationId,
  );
  const headStepIndex = steps.findIndex(
    (candidate) =>
      candidate.migrationId === `backlinks-${manifest.heads?.backlinks ?? ""}`,
  );
  const step = steps[migrationStepIndex];
  if (
    migrationStepIndex < 0 ||
    headStepIndex < migrationStepIndex ||
    step?.path !== expectedPath ||
    step.tool !== "psql" ||
    step.recovery !== "forward-only" ||
    step.prerequisites?.length !== 1 ||
    step.prerequisites[0] !== expectedPrerequisite
  ) {
    throw new Error("BACKLINKS_PHASE9_MIGRATION_MANIFEST_INVALID");
  }

  const sql = await readFile(resolve(repositoryRoot, expectedPath), "utf8");
  const sha256 = createHash("sha256")
    .update(sql.replace(/\r\n/gu, "\n"))
    .digest("hex");
  if (step.sha256 !== sha256) {
    throw new Error("BACKLINKS_PHASE9_MIGRATION_HASH_MISMATCH");
  }
  return sql;
}

async function readSchemaState(
  pool: Pool,
): Promise<Readonly<{ has0084: boolean; has0085: boolean }>> {
  const result = await pool.query<{
    has_0084: boolean;
    has_0085: boolean;
  }>(`
    SELECT
      EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'backlinks'
           AND table_name =
             'backlink_recommendation_legacy_source_lineage_facts'
           AND column_name = 'source_candidate_qualification_fact_id'
      )
      AND EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'backlinks'
           AND table_name =
             'backlink_recommendation_legacy_source_lineage_facts'
           AND column_name = 'source_visibility_qualification_fact_id'
      ) AS has_0084,
      to_regprocedure(
        'backlinks.backlink_recommendation_pool_v2_phase9_verify()'
      ) IS NOT NULL AS has_0085
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("BACKLINKS_PHASE9_MIGRATION_SCHEMA_STATE_MISSING");
  }
  return Object.freeze({ has0084: row.has_0084, has0085: row.has_0085 });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  const sql = await loadMigration();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const before = await readSchemaState(pool);
    if (!before.has0084) {
      throw new Error("BACKLINKS_PHASE9_MIGRATION_REQUIRES_0084");
    }
    if (!before.has0085) {
      await pool.query(sql);
    }
    const after = await readSchemaState(pool);
    if (!after.has0085) {
      throw new Error("BACKLINKS_PHASE9_MIGRATION_VERIFY_FAILED");
    }
    console.log(
      JSON.stringify({
        migrationId: expectedMigrationId,
        prerequisite: expectedPrerequisite,
        applied: !before.has0085,
        verified: true,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "BACKLINKS_PHASE9_MIGRATION_FAILED",
  );
  process.exitCode = 1;
});
