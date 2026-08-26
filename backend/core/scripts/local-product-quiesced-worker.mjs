import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`LOCAL_PRODUCT_CONFIGURATION_MISSING:${name}`);
  }
  return value;
}

function positiveIntegerEnvironment(name, environment = process.env) {
  const value = Number(requiredEnvironment(name, environment));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`LOCAL_PRODUCT_CONFIGURATION_INVALID:${name}`);
  }
  return value;
}

export function resolveWorkerExecutionMode(environment = process.env) {
  const configured = environment.BACKLINKS_WORKER_EXECUTION_MODE?.trim();
  const mode = configured || "normal";
  if (mode !== "normal" && mode !== "quiesced") {
    throw new Error("BACKLINKS_WORKER_EXECUTION_MODE_UNSUPPORTED");
  }
  if (
    mode === "quiesced"
    && environment.BACKLINKS_RUNTIME_MODE !== "LOCAL_PRODUCT"
  ) {
    throw new Error(
      "BACKLINKS_WORKER_QUIESCED_MODE_REQUIRES_LOCAL_PRODUCT",
    );
  }
  return mode;
}

async function readRequiredSecretFile(reference, filePath) {
  let value;
  try {
    value = (await readFile(resolve(filePath), "utf8")).trim();
  } catch {
    throw new Error(`SECRET_FILE_UNREADABLE:${reference}`);
  }
  if (!value) {
    throw new Error(`SECRET_FILE_EMPTY:${reference}`);
  }
  return value;
}

async function loadRuntimeModule(modulePath) {
  const imported = await import(pathToFileURL(resolve(modulePath)).href);
  const runtime = imported.runtime ?? imported.default;
  if (typeof runtime !== "object" || runtime === null) {
    throw new Error("BACKLINKS_RUNTIME_MODULE_INVALID");
  }
  return runtime;
}

async function assertPostgreSqlReady(pool) {
  const result = await pool.query(`
    SELECT current_setting('server_version') AS "serverVersion",
           current_setting('server_version_num')::integer AS "serverVersionNumber",
           login.rolcanlogin AS "canLogin",
           login.rolsuper AS "isSuperuser",
           login.rolbypassrls AS "bypassRls",
           current_setting('row_security') = 'on' AS "rowSecurityEnabled",
           writer.oid IS NOT NULL AS "writerRoleExists",
           COALESCE(
             pg_has_role(current_user, writer.oid, 'member'),
             false
           ) AS "writerRoleMember",
           to_regclass('backlinks.backlink_project_context_snapshots')::text
             AS "contextTable",
           to_regclass('backlinks.backlink_provider_usage_ledger')::text
             AS "usageLedgerTable",
           to_regclass('backlinks.backlink_project_settings_versions')::text
             AS "governanceTable"
      FROM pg_roles AS login
      LEFT JOIN pg_roles AS writer
        ON writer.rolname = 'growthos_backlinks_writer'
     WHERE login.rolname = current_user
  `);
  const row = result.rows[0];
  if (
    row === undefined
    || row.canLogin !== true
    || row.isSuperuser !== false
    || row.bypassRls !== false
    || row.rowSecurityEnabled !== true
    || row.writerRoleExists !== true
    || row.writerRoleMember !== true
  ) {
    throw new Error("BACKLINKS_DATABASE_ROLE_PREREQUISITE_FAILED");
  }
  if (
    Number(row.serverVersionNumber) < 180_000
    || row.contextTable === null
    || row.usageLedgerTable === null
    || row.governanceTable === null
  ) {
    throw new Error("BACKLINKS_DATABASE_MIGRATION_PREREQUISITE_FAILED");
  }
  return row.serverVersion;
}

async function assertTemporalReady(temporal, namespace) {
  const workflowService = temporal.connection.workflowService;
  await workflowService.getSystemInfo({});
  await workflowService.describeNamespace({ namespace });
}

function waitForShutdownSignal() {
  return new Promise((complete) => {
    let stopping = false;
    const keepAlive = setInterval(() => {}, 60_000);
    const handle = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(keepAlive);
      complete();
    };
    process.once("SIGINT", handle);
    process.once("SIGTERM", handle);
    if (process.platform === "win32") {
      process.once("SIGBREAK", handle);
    }
  });
}

async function closeResources(runtime, pool, temporal, healthServer) {
  const results = await Promise.allSettled([
    healthServer?.stop(),
    runtime?.close?.(),
    pool?.end(),
    temporal?.close(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Runtime resource cleanup failed");
  }
}

export async function runQuiescedWorker(environment = process.env) {
  const [{
    backlinksDatabaseConfigSchema,
    createBacklinksDatabaseConnectionConfig,
  }, {
    createBacklinksWorkerRuntimeHealth,
    startBacklinksWorkerHealthServer,
  }, {
    backlinksTemporalConfigSchema,
    createBacklinksTemporalClient,
  }, {
    assertLocalProductRuntimeBuildIdentity,
  }] = await Promise.all([
    import("../dist/modules/backlinks/db/client/backlinks-database-config.js"),
    import("../dist/modules/backlinks/runtime/runtime-health.js"),
    import("../dist/modules/backlinks/workflows/client.js"),
    import("../dist/runtime-build-identity.js"),
  ]);
  const mode = resolveWorkerExecutionMode(environment);
  if (mode !== "quiesced") {
    throw new Error("BACKLINKS_WORKER_EXECUTION_MODE_MUST_BE_QUIESCED");
  }
  if (
    requiredEnvironment("BACKLINKS_API_ENABLED", environment) !== "false"
    || requiredEnvironment("BACKLINKS_WORKER_ENABLED", environment) !== "true"
  ) {
    throw new Error(
      "Worker process requires BACKLINKS_API_ENABLED=false and BACKLINKS_WORKER_ENABLED=true",
    );
  }

  const buildId = requiredEnvironment("TEMPORAL_BUILD_ID", environment);
  const buildIdentity = assertLocalProductRuntimeBuildIdentity(buildId);
  const databaseConfig = backlinksDatabaseConfigSchema.parse({
    DATABASE_URL_SECRET_REF: requiredEnvironment(
      "DATABASE_URL_SECRET_REF",
      environment,
    ),
    BACKLINK_DB_STATEMENT_TIMEOUT_MS: requiredEnvironment(
      "BACKLINK_DB_STATEMENT_TIMEOUT_MS",
      environment,
    ),
    BACKLINK_DB_LOCK_TIMEOUT_MS: requiredEnvironment(
      "BACKLINK_DB_LOCK_TIMEOUT_MS",
      environment,
    ),
  });
  const connectionString = await readRequiredSecretFile(
    databaseConfig.DATABASE_URL_SECRET_REF,
    requiredEnvironment("DATABASE_URL_FILE", environment),
  );
  const database = createBacklinksDatabaseConnectionConfig(
    "worker",
    databaseConfig,
    connectionString,
  );
  const pool = new Pool({
    ...database.pool,
    max: positiveIntegerEnvironment("BACKLINK_DB_POOL_MAX", environment),
    idleTimeoutMillis: positiveIntegerEnvironment(
      "BACKLINK_DB_IDLE_TIMEOUT_MS",
      environment,
    ),
    connectionTimeoutMillis: positiveIntegerEnvironment(
      "BACKLINK_DB_CONNECT_TIMEOUT_MS",
      environment,
    ),
  });
  const temporalConfig = backlinksTemporalConfigSchema.parse({
    BACKLINKS_WORKER_ENABLED: "true",
    TEMPORAL_ADDRESS: requiredEnvironment("TEMPORAL_ADDRESS", environment),
    TEMPORAL_NAMESPACE: requiredEnvironment("TEMPORAL_NAMESPACE", environment),
    TEMPORAL_BACKLINKS_TASK_QUEUE: requiredEnvironment(
      "TEMPORAL_BACKLINKS_TASK_QUEUE",
      environment,
    ),
    TEMPORAL_BUILD_ID: buildId,
  });
  const temporal = createBacklinksTemporalClient(temporalConfig);
  let runtime;
  let healthServer;

  try {
    const postgresVersion = await assertPostgreSqlReady(pool);
    await assertTemporalReady(
      temporal,
      temporalConfig.TEMPORAL_NAMESPACE,
    );
    runtime = await loadRuntimeModule(
      requiredEnvironment("BACKLINKS_RUNTIME_MODULE", environment),
    );
    if (typeof runtime.createWorkerRegistrations !== "function") {
      throw new Error("BACKLINKS_RUNTIME_WORKER_FACTORY_MISSING");
    }
    await runtime.createWorkerRegistrations({
      process: "worker",
      pool,
      temporal,
    });
    const health = createBacklinksWorkerRuntimeHealth({
      buildId: buildIdentity.buildId,
      workerExecutionMode: "quiesced",
      postgresReady: true,
      temporalReady: true,
      environment,
    });
    healthServer = await startBacklinksWorkerHealthServer(health, {
      host: requiredEnvironment("BACKLINKS_WORKER_HEALTH_HOST", environment),
      port: positiveIntegerEnvironment(
        "BACKLINKS_WORKER_HEALTH_PORT",
        environment,
      ),
    });
    console.log(JSON.stringify({
      event: "backlinks.worker.ready",
      healthAddress: healthServer.address,
      taskQueue: temporalConfig.TEMPORAL_BACKLINKS_TASK_QUEUE,
      buildId: buildIdentity.buildId,
      workerExecutionMode: "quiesced",
      businessConsumersRunning: false,
      postgresReady: true,
      postgresVersion,
      temporalReady: true,
      namespaceReady: true,
    }));
    await waitForShutdownSignal();
  } finally {
    await closeResources(runtime, pool, temporal, healthServer);
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && resolve(entrypoint) === resolve(fileURLToPath(import.meta.url))
) {
  void runQuiescedWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
