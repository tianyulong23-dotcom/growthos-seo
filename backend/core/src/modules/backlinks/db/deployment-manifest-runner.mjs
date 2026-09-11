import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const backlinksPathPrefix = "backend/core/src/modules/backlinks/db/migrations/";
const defaultManifestUrl = new URL(
  "../../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
const defaultMigrationsDirectoryUrl = new URL("./migrations/", import.meta.url);
const defaultBootstrapUrl = new URL(
  "./operations/0093_pristine_v1_freeze_bootstrap.sql",
  import.meta.url,
);

function normalizeSql(sql) {
  return sql.replace(/\r\n/gu, "\n");
}

function parseRevision(value, label) {
  if (typeof value !== "string" || !/^\d{4}$/u.test(value)) {
    throw new Error(`${label} must be a four-digit Backlinks revision.`);
  }
  return Number.parseInt(value, 10);
}

function unwrapMigrationTransaction(sql, migrationId) {
  const match = /^\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/u.exec(
    normalizeSql(sql),
  );
  if (match?.[1] === undefined) {
    throw new Error(
      `${migrationId} must have one outer BEGIN/COMMIT transaction.`,
    );
  }
  return match[1].trim();
}

function compose0093Transaction(bootstrapSql, migrationSql) {
  if (/^\s*(?:BEGIN|COMMIT)\s*;/imu.test(bootstrapSql)) {
    throw new Error(
      "The 0093 pristine bootstrap operation must be transaction-neutral.",
    );
  }
  const migrationBody = unwrapMigrationTransaction(
    migrationSql,
    "backlinks-0093",
  );
  return [
    "BEGIN;",
    normalizeSql(bootstrapSql).trim(),
    migrationBody,
    "COMMIT;",
    "",
  ].join("\n\n");
}

export async function planBacklinksDeploymentManifest({
  startRevision,
  targetRevision,
  manifestUrl = defaultManifestUrl,
  migrationsDirectoryUrl = defaultMigrationsDirectoryUrl,
  bootstrapUrl = defaultBootstrapUrl,
}) {
  const start = parseRevision(startRevision, "startRevision");
  const target = parseRevision(targetRevision, "targetRevision");
  if (start > target) {
    throw new Error("startRevision must not be later than targetRevision.");
  }

  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const manifestHead = parseRevision(
    manifest?.heads?.backlinks,
    "deployment manifest Backlinks head",
  );
  if (target > manifestHead) {
    throw new Error(
      `targetRevision ${targetRevision} exceeds manifest head ` +
        `${manifest.heads.backlinks}.`,
    );
  }
  if (!Array.isArray(manifest?.steps)) {
    throw new Error("Deployment manifest steps must be an array.");
  }

  const backlinksSteps = manifest.steps
    .filter(
      (step) =>
        typeof step?.migrationId === "string" &&
        step.migrationId.startsWith("backlinks-"),
    )
    .map((step) => {
      const revisionText = step.migrationId.slice("backlinks-".length);
      return {
        step,
        revision: parseRevision(
          revisionText,
          `deployment manifest migrationId ${step.migrationId}`,
        ),
      };
    })
    .sort((left, right) => left.revision - right.revision);

  for (let index = 1; index < backlinksSteps.length; index += 1) {
    if (backlinksSteps[index - 1].revision === backlinksSteps[index].revision) {
      throw new Error(
        `Deployment manifest repeats Backlinks revision ` +
          `${String(backlinksSteps[index].revision).padStart(4, "0")}.`,
      );
    }
  }

  const selectedSteps = backlinksSteps.filter(
    ({ revision }) => revision >= start && revision <= target,
  );
  if (selectedSteps.length === 0 || selectedSteps.at(-1)?.revision !== target) {
    throw new Error(
      `Deployment manifest does not contain target Backlinks revision ` +
        `${targetRevision}.`,
    );
  }

  const bootstrapSql =
    target >= 93 && start <= 93
      ? await readFile(bootstrapUrl, "utf8")
      : undefined;
  const plannedSteps = [];

  for (const selected of selectedSteps) {
    const revisionText = String(selected.revision).padStart(4, "0");
    const expectedMigrationId = `backlinks-${revisionText}`;
    const { step } = selected;
    if (step.migrationId !== expectedMigrationId) {
      throw new Error(
        `Deployment manifest migrationId must be ${expectedMigrationId}.`,
      );
    }
    if (
      typeof step.path !== "string" ||
      !step.path.startsWith(backlinksPathPrefix)
    ) {
      throw new Error(`${expectedMigrationId} has an invalid migration path.`);
    }
    const fileName = step.path.slice(backlinksPathPrefix.length);
    if (
      !new RegExp(`^${revisionText}_[A-Za-z0-9_]+\\.sql$`, "u").test(fileName)
    ) {
      throw new Error(`${expectedMigrationId} has an unsafe migration path.`);
    }
    if (
      typeof step.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(step.sha256)
    ) {
      throw new Error(`${expectedMigrationId} has an invalid checksum.`);
    }

    const migrationSql = normalizeSql(
      await readFile(new URL(fileName, migrationsDirectoryUrl), "utf8"),
    );
    const actualChecksum = createHash("sha256")
      .update(migrationSql)
      .digest("hex");
    if (actualChecksum !== step.sha256) {
      throw new Error(
        `Deployment manifest checksum does not match ${fileName}.`,
      );
    }

    plannedSteps.push({
      migrationId: expectedMigrationId,
      fileName,
      sql:
        selected.revision === 93
          ? compose0093Transaction(bootstrapSql, migrationSql)
          : migrationSql,
    });
  }

  return plannedSteps;
}

export async function applyBacklinksDeploymentManifest({
  query,
  ...planOptions
}) {
  if (typeof query !== "function") {
    throw new Error("query must be a database query function.");
  }
  const steps = await planBacklinksDeploymentManifest(planOptions);
  for (const step of steps) {
    try {
      await query(step.sql);
    } catch (error) {
      await query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
  return steps;
}
