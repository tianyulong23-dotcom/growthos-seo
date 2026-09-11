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

const expectedMigrationId = "backlinks-0088";
const expectedPrerequisite = "backlinks-0087";
const expectedPath =
  "backend/core/src/modules/backlinks/db/migrations/" +
  "0088_backlink_recommendation_pool_v2_evidence_replay.sql";
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
    throw new Error("BACKLINKS_V2_EVIDENCE_REPLAY_MANIFEST_INVALID");
  }
  const sql = await readFile(resolve(repositoryRoot, expectedPath), "utf8");
  const sha256 = createHash("sha256")
    .update(sql.replace(/\r\n/gu, "\n"))
    .digest("hex");
  if (step.sha256 !== sha256) {
    throw new Error("BACKLINKS_V2_EVIDENCE_REPLAY_HASH_MISMATCH");
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
      has_0087: boolean;
      has_0088: boolean;
    }>(`
      SELECT
        to_regprocedure(
          'backlinks.backlink_recommendation_pool_v2_generation_compatibility_verify()'
        ) IS NOT NULL AS has_0087,
        to_regprocedure(
          'backlinks.backlink_recommendation_pool_v2_evidence_replay_verify()'
        ) IS NOT NULL AS has_0088
    `);
    if (before.rows[0]?.has_0087 !== true) {
      throw new Error("BACKLINKS_V2_EVIDENCE_REPLAY_REQUIRES_0087");
    }
    if (before.rows[0]?.has_0088 !== true) {
      await pool.query(sql);
    }
    const after = await pool.query<{
      evidence_replay_columns_present: boolean;
      outcome_trigger_supports_evidence_replay: boolean;
      v1_writes_frozen: boolean;
    }>(`
      SELECT
        (verification->>'evidenceReplayColumnsPresent')::boolean
          AS evidence_replay_columns_present,
        (verification->>'outcomeTriggerSupportsEvidenceReplay')::boolean
          AS outcome_trigger_supports_evidence_replay,
        (verification->>'v1WritesFrozen')::boolean
          AS v1_writes_frozen
      FROM (
        SELECT
          backlinks.backlink_recommendation_pool_v2_evidence_replay_verify()
            AS verification
      ) verified
    `);
    if (
      after.rows[0]?.evidence_replay_columns_present !== true ||
      after.rows[0]?.outcome_trigger_supports_evidence_replay !== true ||
      after.rows[0]?.v1_writes_frozen !== true
    ) {
      throw new Error("BACKLINKS_V2_EVIDENCE_REPLAY_VERIFY_FAILED");
    }
    console.log(
      JSON.stringify({
        migrationId: expectedMigrationId,
        prerequisite: expectedPrerequisite,
        applied: before.rows[0]?.has_0088 !== true,
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
      : "BACKLINKS_V2_EVIDENCE_REPLAY_MIGRATION_FAILED",
  );
  process.exitCode = 1;
});
