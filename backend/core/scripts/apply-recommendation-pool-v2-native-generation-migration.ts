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

const expectedMigrationId = "backlinks-0086";
const expectedPrerequisite = "backlinks-0085";
const expectedPath =
  "backend/core/src/modules/backlinks/db/migrations/" +
  "0086_backlink_recommendation_pool_v2_native_generation.sql";
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
    throw new Error("BACKLINKS_V2_NATIVE_GENERATION_MANIFEST_INVALID");
  }
  const sql = await readFile(resolve(repositoryRoot, expectedPath), "utf8");
  const sha256 = createHash("sha256")
    .update(sql.replace(/\r\n/gu, "\n"))
    .digest("hex");
  if (step.sha256 !== sha256) {
    throw new Error("BACKLINKS_V2_NATIVE_GENERATION_HASH_MISMATCH");
  }
  return sql;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  const sql = await loadMigration();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const before = await pool.query<{
      has_0085: boolean;
      has_0086: boolean;
    }>(`
      SELECT
        to_regprocedure(
          'backlinks.backlink_recommendation_pool_v2_phase9_verify()'
        ) IS NOT NULL AS has_0085,
        to_regprocedure(
          'backlinks.backlink_recommendation_pool_v2_native_generation_verify()'
        ) IS NOT NULL AS has_0086
    `);
    if (before.rows[0]?.has_0085 !== true) {
      throw new Error("BACKLINKS_V2_NATIVE_GENERATION_REQUIRES_0085");
    }
    if (before.rows[0]?.has_0086 !== true) {
      await pool.query(sql);
    }
    const after = await pool.query<{
      v2_generation_job_allowed: boolean;
      v1_writes_frozen: boolean;
    }>(`
      SELECT
        (verification->>'v2GenerationJobAllowed')::boolean
          AS v2_generation_job_allowed,
        (verification->>'v1WritesFrozen')::boolean
          AS v1_writes_frozen
      FROM (
        SELECT
          backlinks.backlink_recommendation_pool_v2_native_generation_verify()
            AS verification
      ) verified
    `);
    if (
      after.rows[0]?.v2_generation_job_allowed !== true ||
      after.rows[0]?.v1_writes_frozen !== true
    ) {
      throw new Error("BACKLINKS_V2_NATIVE_GENERATION_VERIFY_FAILED");
    }
    console.log(
      JSON.stringify({
        migrationId: expectedMigrationId,
        prerequisite: expectedPrerequisite,
        applied: before.rows[0]?.has_0086 !== true,
        verified: true,
        v1WritesFrozen: true,
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
      : "BACKLINKS_V2_NATIVE_GENERATION_MIGRATION_FAILED",
  );
  process.exitCode = 1;
});
