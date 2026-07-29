import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PackageScripts = Readonly<Record<string, string | undefined>>;
type DeploymentManifest = Readonly<{
  heads?: Readonly<{ backlinks?: string }>;
  steps?: readonly Readonly<{
    migrationId?: string;
    path?: string;
    sha256?: string;
  }>[];
}>;

const migrationsDirectory = fileURLToPath(
  new URL("../src/modules/backlinks/db/migrations/", import.meta.url),
);
const migrationPath = resolve(
  migrationsDirectory,
  "0001_backlink_foundation.sql",
);
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const deploymentManifestPath = fileURLToPath(
  new URL("../../database/deployment-manifest.v1.json", import.meta.url),
);
const backlinksMigrationPathPrefix =
  "backend/core/src/modules/backlinks/db/migrations/";

const requiredColumns = [
  "id uuid PRIMARY KEY",
  "organization_id uuid NOT NULL",
  "workspace_id uuid NOT NULL",
  "website_project_id uuid NOT NULL",
  "idempotency_key text NOT NULL",
  "command_type text NOT NULL",
  "request_hash text NOT NULL",
  "expires_at timestamptz NOT NULL",
] as const;
const requiredOutboxColumns = [
  "event_type text NOT NULL",
  "aggregate_id uuid NOT NULL",
  "aggregate_version integer NOT NULL",
  "idempotency_key text NOT NULL",
  "payload jsonb NOT NULL",
  "payload_schema_version integer NOT NULL",
  "status text NOT NULL DEFAULT 'pending'",
  "available_at timestamptz NOT NULL DEFAULT now()",
] as const;
const requiredJobEventSql = [
  ["CREATE TABLE backlink_jobs (", "0001 must create backlink_jobs."],
  ["CREATE TABLE backlink_lifecycle_events (", "0001 must create backlink_lifecycle_events."],
  ["CREATE TABLE backlink_audit_events (", "0001 must create backlink_audit_events."],
  ["job_type text NOT NULL", "Missing required Job/Event column: job_type."],
  ["version integer NOT NULL DEFAULT 1", "Missing required Job/Event version column."],
  ["aggregate_version integer NOT NULL", "Missing aggregate version column."],
  ["event_schema_version integer NOT NULL DEFAULT 1", "Missing event schema version column."],
  ["CONSTRAINT backlink_job_tenant_identity_uq UNIQUE (organization_id, workspace_id, website_project_id, id)", "Missing Job tenant identity constraint."],
  ["CONSTRAINT backlink_lifecycle_tenant_identity_uq UNIQUE (organization_id, workspace_id, website_project_id, id)", "Missing Lifecycle tenant identity constraint."],
  ["CONSTRAINT backlink_lifecycle_job_fk FOREIGN KEY ( organization_id, workspace_id, website_project_id, job_id ) REFERENCES backlink_jobs ( organization_id, workspace_id, website_project_id, id )", "Missing Lifecycle-to-Job foreign key."],
  ["CONSTRAINT backlink_audit_job_fk FOREIGN KEY ( organization_id, workspace_id, website_project_id, job_id ) REFERENCES backlink_jobs ( organization_id, workspace_id, website_project_id, id )", "Missing Audit-to-Job foreign key."],
  ["CONSTRAINT backlink_audit_lifecycle_event_fk FOREIGN KEY ( organization_id, workspace_id, website_project_id, lifecycle_event_id ) REFERENCES backlink_lifecycle_events ( organization_id, workspace_id, website_project_id, id )", "Missing Audit-to-Lifecycle foreign key."],
] as const;
const requiredTenantPolicies = [
  ["backlink_idempotency_records", "backlink_idempotency_tenant_policy"],
  ["backlink_outbox_events", "backlink_outbox_tenant_policy"],
  ["backlink_jobs", "backlink_job_tenant_policy"],
  ["backlink_lifecycle_events", "backlink_lifecycle_tenant_policy"],
  ["backlink_audit_events", "backlink_audit_tenant_policy"],
] as const;
const tenantPredicate =
  "workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid AND website_project_id = NULLIF( current_setting('app.current_website_project_id', true), '' )::uuid";

export function findBacklinksMigrationViolations(
  sql: string,
  scripts: PackageScripts,
): string[] {
  const normalizedSql = sql
    .replace(/--.*$/gmu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const violations: string[] = [];

  if (!/^CREATE TABLE backlink_idempotency_records \(/iu.test(normalizedSql)) {
    violations.push("0001 must create backlink_idempotency_records.");
  }
  if (!/CREATE TABLE backlink_outbox_events \(/iu.test(normalizedSql)) {
    violations.push("0001 must create backlink_outbox_events.");
  }
  for (const column of requiredColumns) {
    if (!normalizedSql.includes(column)) {
      violations.push(`Missing required migration column: ${column}.`);
    }
  }
  for (const column of requiredOutboxColumns) {
    if (!normalizedSql.includes(column)) {
      violations.push(`Missing required Outbox column: ${column}.`);
    }
  }
  for (const [fragment, message] of requiredJobEventSql) {
    if (!normalizedSql.includes(fragment)) {
      violations.push(message);
    }
  }
  for (const [table, policy] of requiredTenantPolicies) {
    if (!normalizedSql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)) {
      violations.push(`Missing ENABLE ROW LEVEL SECURITY for ${table}.`);
    }
    if (!normalizedSql.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)) {
      violations.push(`Missing FORCE ROW LEVEL SECURITY for ${table}.`);
    }
    const policySql =
      `CREATE POLICY ${policy} ON ${table} USING ( ${tenantPredicate} ) ` +
      `WITH CHECK ( ${tenantPredicate} )`;
    if (!normalizedSql.includes(policySql)) {
      violations.push(`Missing Workspace/Project RLS policy for ${table}.`);
    }
  }
  if (
    !/UNIQUE \(workspace_id, idempotency_key, command_type\)/iu.test(
      normalizedSql,
    )
  ) {
    violations.push(
      "Missing unique constraint on (workspace_id, idempotency_key, command_type).",
    );
  }
  if (!/UNIQUE \(event_type, aggregate_id, aggregate_version\)/iu.test(normalizedSql)) {
    violations.push(
      "Missing unique constraint on (event_type, aggregate_id, aggregate_version).",
    );
  }
  if (!/UNIQUE \(workspace_id, idempotency_key\)/iu.test(normalizedSql)) {
    violations.push(
      "Missing Outbox unique constraint on (workspace_id, idempotency_key).",
    );
  }
  if (!/CHECK \(status IN \('pending', 'processing', 'published', 'failed'\)\)/iu.test(normalizedSql)) {
    violations.push("Missing fixed Outbox status constraint.");
  }
  if (/\b(?:DROP|TRUNCATE)\b/iu.test(normalizedSql)) {
    violations.push("0001 must be a forward-only migration.");
  }
  if (Object.values(scripts).some((script) => script?.includes("drizzle-kit push"))) {
    violations.push("Package scripts must not use drizzle-kit push.");
  }

  return violations;
}

export async function checkBacklinksMigrations(): Promise<void> {
  const [sql, packageJson, deploymentManifestJson, migrationEntries] =
    await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(packagePath, "utf8"),
      readFile(deploymentManifestPath, "utf8"),
      readdir(migrationsDirectory, { withFileTypes: true }),
    ]);
  const parsedPackage = JSON.parse(packageJson) as { scripts?: PackageScripts };
  const deploymentManifest = JSON.parse(
    deploymentManifestJson,
  ) as DeploymentManifest;
  const violations = findBacklinksMigrationViolations(
    sql,
    parsedPackage.scripts ?? {},
  );
  const migrationNames = migrationEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const manifestStepsByFileName = new Map<
    string,
    Readonly<{ migrationId?: string; sha256?: string }>
  >();

  for (const step of deploymentManifest.steps ?? []) {
    if (step.path?.startsWith(backlinksMigrationPathPrefix) !== true) {
      continue;
    }
    const fileName = step.path.slice(backlinksMigrationPathPrefix.length);
    if (manifestStepsByFileName.has(fileName)) {
      violations.push(`Deployment manifest repeats ${fileName}.`);
      continue;
    }
    manifestStepsByFileName.set(fileName, step);
  }

  for (const migrationName of migrationNames) {
    const manifestStep = manifestStepsByFileName.get(migrationName);
    if (manifestStep === undefined) {
      violations.push(
        `Deployment manifest is missing Backlinks migration ${migrationName}.`,
      );
      continue;
    }
    const migrationSql = await readFile(
      resolve(migrationsDirectory, migrationName),
    );
    const sha256 = createHash("sha256").update(migrationSql).digest("hex");
    if (manifestStep.sha256 !== sha256) {
      violations.push(
        `Deployment manifest checksum does not match ${migrationName}.`,
      );
    }
    const expectedMigrationId = `backlinks-${migrationName.slice(0, 4)}`;
    if (manifestStep.migrationId !== expectedMigrationId) {
      violations.push(
        `Deployment manifest migrationId for ${migrationName} must be ${expectedMigrationId}.`,
      );
    }
  }

  for (const manifestFileName of manifestStepsByFileName.keys()) {
    if (!migrationNames.includes(manifestFileName)) {
      violations.push(
        `Deployment manifest references missing Backlinks migration ${manifestFileName}.`,
      );
    }
  }

  const latestMigration = migrationNames.at(-1);
  const latestRevision = latestMigration?.slice(0, 4);
  if (
    latestRevision === undefined ||
    deploymentManifest.heads?.backlinks !== latestRevision
  ) {
    violations.push(
      `Deployment manifest Backlinks head must be ${latestRevision ?? "defined"}.`,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `Invalid Backlinks migrations:\n- ${violations.join("\n- ")}`,
    );
  }
  console.log(
    `Backlinks migrations valid: ${migrationNames.length} files through ${latestRevision}.`,
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  fileURLToPath(import.meta.url) === resolve(entrypoint)
) {
  checkBacklinksMigrations().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
