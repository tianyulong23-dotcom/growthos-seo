import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import {
  createBacklinksPrivateApi,
  startBacklinksPrivateApi,
  type BacklinksPrivateApiDependencies,
} from "./modules/backlinks/api/private-server.js";
import {
  backlinksConfigSchema,
} from "./modules/backlinks/config/index.js";
import {
  backlinksDatabaseConfigSchema,
  createBacklinksDatabaseConnectionConfig,
} from "./modules/backlinks/db/client/backlinks-database-config.js";
import {
  backlinksTemporalConfigSchema,
  createBacklinksTemporalClient,
  type BacklinksTemporalClient,
} from "./modules/backlinks/workflows/client.js";
import {
  createBacklinksApiRuntimeHealth,
  createBacklinksWorkerRuntimeHealth,
  startBacklinksWorkerHealthServer,
  type BacklinksWorkerExecutionMode,
} from "./modules/backlinks/runtime/runtime-health.js";
import {
  startBacklinksWorker,
  type BacklinksWorkerRegistrations,
} from "./modules/backlinks/workflows/worker.js";
import {
  assertLocalProductRuntimeBuildIdentity,
  type LocalProductRuntimeBuildIdentity,
} from "./runtime-build-identity.js";
import { assertBacklinksOutboundProxyReady } from "./runtime-outbound-proxy.js";
import {
  installDatabaseErrorHandlers,
  type DatabasePoolEvents,
} from "./runtime-database-errors.js";

export * from "./modules/backlinks/api/index.js";

type RuntimeProcess = "api" | "worker";
type QueryResult = Readonly<{
  rows: readonly Record<string, unknown>[];
  rowCount: number | null;
}>;
type RuntimePoolClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult>;
  release(): void;
}>;
type RuntimePool = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult>;
  connect(): Promise<RuntimePoolClient>;
  end(): Promise<void>;
}>;

export type BacklinksRuntimeFactoryContext = Readonly<{
  process: RuntimeProcess;
  pool: RuntimePool;
  temporal: BacklinksTemporalClient;
  buildIdentity: LocalProductRuntimeBuildIdentity;
}>;

export type BacklinksProductionRuntimeModule = Readonly<{
  createApiDependencies?(
    context: BacklinksRuntimeFactoryContext,
  ): Promise<BacklinksPrivateApiDependencies>;
  createWorkerRegistrations?(
    context: BacklinksRuntimeFactoryContext,
  ): Promise<BacklinksWorkerRegistrations>;
  close?(): Promise<void>;
}>;

const require = createRequire(import.meta.url);
const postgres = require("pg") as Readonly<{
  Pool: new (config: Readonly<{
    connectionString: string;
    application_name: string;
    options: string;
    statement_timeout: number;
    lock_timeout: number;
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
  }>) => RuntimePool & DatabasePoolEvents;
}>;

const positiveIntegerStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "Expected a positive integer string")
  .transform(Number)
  .pipe(z.number().int().positive().safe());
const portSchema = positiveIntegerStringSchema.pipe(z.number().max(65_535));
const requiredTextSchema = z.string().trim().min(1);
const capabilitySchema = z.enum(["true", "false"]).optional().default("false");

const runtimeEnvironmentSchema = z
  .object({
    BACKLINKS_RUNTIME_MODULE: requiredTextSchema,
    DATABASE_URL_SECRET_REF: requiredTextSchema,
    DATABASE_URL_FILE: requiredTextSchema,
    BACKLINK_DB_STATEMENT_TIMEOUT_MS: requiredTextSchema,
    BACKLINK_DB_LOCK_TIMEOUT_MS: requiredTextSchema,
    BACKLINK_DB_POOL_MAX: positiveIntegerStringSchema,
    BACKLINK_DB_IDLE_TIMEOUT_MS: positiveIntegerStringSchema,
    BACKLINK_DB_CONNECT_TIMEOUT_MS: positiveIntegerStringSchema,
    TEMPORAL_ADDRESS: requiredTextSchema,
    TEMPORAL_NAMESPACE: requiredTextSchema,
    TEMPORAL_BACKLINKS_TASK_QUEUE: requiredTextSchema,
    TEMPORAL_BUILD_ID: requiredTextSchema,
    BACKLINKS_API_ENABLED: z.enum(["true", "false"]),
    BACKLINKS_WORKER_ENABLED: z.enum(["true", "false"]),
    BACKLINK_API_BODY_LIMIT: requiredTextSchema,
    BACKLINK_API_REQUEST_TIMEOUT_MS: requiredTextSchema,
    BACKLINKS_HOST: requiredTextSchema,
    BACKLINKS_PORT: portSchema,
    BACKLINKS_WORKER_EXECUTION_MODE: z
      .enum(["normal", "quiesced", "recovery"])
      .optional()
      .default("normal"),
    BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID: z.string().uuid().optional(),
    BACKLINKS_RECOVERY_REFILL_JOB_ID: z.string().uuid().optional(),
    BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID: z.string().uuid().optional(),
    BACKLINKS_WORKER_HEALTH_HOST: requiredTextSchema
      .optional()
      .default("127.0.0.1"),
    BACKLINKS_WORKER_HEALTH_PORT: portSchema
      .optional()
      .default(7302),
    PLATFORM_CONTEXT_SIGNING_KEY_SECRET_REF: requiredTextSchema,
    PLATFORM_CONTEXT_SIGNING_KEY_FILE: requiredTextSchema,
    BACKLINKS_RUNTIME_MODE: z.enum([
      "DISABLED",
      "LOCAL_PRODUCT_ACCEPTANCE",
      "LOCAL_PRODUCT",
    ]).optional().default("DISABLED"),
    BACKLINKS_LIVE_CANARY_STAGE: z.enum([
      "LIVE-003",
      "LIVE-004",
    ]).optional(),
    GOOGLE_OAUTH_ENABLED: capabilitySchema,
    PLATFORM_SECRET_STORE_ENABLED: capabilitySchema,
    PLATFORM_SECRET_STORE_PROVIDER: requiredTextSchema.optional(),
    PLATFORM_SECRET_STORE_ROOT: requiredTextSchema.optional(),
    GOOGLE_OAUTH_CLIENT_ID: requiredTextSchema.optional(),
    GOOGLE_OAUTH_CLIENT_SECRET_REF: requiredTextSchema.optional(),
    GOOGLE_OAUTH_REDIRECT_URI: requiredTextSchema.optional(),
    LOCAL_PRODUCT_WEBSITE_PROJECT_KEY: requiredTextSchema.optional(),
    GMAIL_CANARY_RECIPIENT_SECRET_REF: requiredTextSchema.optional(),
    GMAIL_SEND_ENABLED: capabilitySchema,
    GMAIL_SYNC_ENABLED: capabilitySchema,
    GMAIL_POLLING_INTERVAL_SECONDS: z.string().optional(),
    DATAFORSEO_ENABLED: capabilitySchema,
    AI_PROVIDER_ENABLED: capabilitySchema,
    BROWSER_PROVIDER_ENABLED: capabilitySchema,
    BROWSER_WORKER_ENDPOINT: requiredTextSchema.optional(),
    BROWSER_WORKER_TIMEOUT_MS: positiveIntegerStringSchema.optional(),
    CONTACT_ENRICHMENT_FETCH_TIMEOUT_MS:
      positiveIntegerStringSchema.optional(),
    CONTACT_ENRICHMENT_MAX_PAGES: positiveIntegerStringSchema.optional(),
    CONTACT_ENRICHMENT_MAX_DEPTH: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(5))
      .optional(),
    CONTACT_ENRICHMENT_MAX_ATTEMPTS:
      positiveIntegerStringSchema.optional(),
    LOCAL_PRODUCT_ORGANIZATION_ID: requiredTextSchema.optional(),
    LOCAL_PRODUCT_WORKSPACE_ID: requiredTextSchema.optional(),
    LOCAL_PRODUCT_USER_ID: requiredTextSchema.optional(),
  })
  .strict();

const runtimeEnvironmentKeys = Object.keys(
  runtimeEnvironmentSchema.shape,
) as readonly (keyof z.input<typeof runtimeEnvironmentSchema>)[];

function readRuntimeEnvironment(): z.output<typeof runtimeEnvironmentSchema> {
  const selected = Object.fromEntries(
    runtimeEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  return runtimeEnvironmentSchema.parse(selected);
}

async function readRequiredSecretFile(
  secretReference: string,
  filePath: string,
): Promise<string> {
  let value: string;
  try {
    value = (await readFile(resolve(filePath), "utf8")).trim();
  } catch {
    throw new Error(`SECRET_FILE_UNREADABLE:${secretReference}`);
  }
  if (value.length === 0) {
    throw new Error(`SECRET_FILE_EMPTY:${secretReference}`);
  }
  return value;
}

function assertProcessConfiguration(
  runtimeProcess: RuntimeProcess,
  environment: z.output<typeof runtimeEnvironmentSchema>,
): void {
  if (
    runtimeProcess === "api"
    && (
      environment.BACKLINKS_API_ENABLED !== "true"
      || environment.BACKLINKS_WORKER_ENABLED !== "false"
    )
  ) {
    throw new Error(
      "API process requires BACKLINKS_API_ENABLED=true and BACKLINKS_WORKER_ENABLED=false",
    );
  }
  if (
    runtimeProcess === "worker"
    && (
      environment.BACKLINKS_API_ENABLED !== "false"
      || environment.BACKLINKS_WORKER_ENABLED !== "true"
    )
  ) {
    throw new Error(
      "Worker process requires BACKLINKS_API_ENABLED=false and BACKLINKS_WORKER_ENABLED=true",
    );
  }
  if (
    runtimeProcess === "worker"
    && environment.BACKLINKS_WORKER_EXECUTION_MODE === "recovery"
    && (
      environment.BACKLINKS_RECOVERY_WEBSITE_PROJECT_ID === undefined
      || environment.BACKLINKS_RECOVERY_REFILL_JOB_ID === undefined
      || environment.BACKLINKS_RECOVERY_REFILL_OUTBOX_EVENT_ID === undefined
    )
  ) {
    throw new Error("BACKLINKS_RECOVERY_IDENTITY_REQUIRED");
  }
}

async function loadRuntimeModule(
  modulePath: string,
): Promise<BacklinksProductionRuntimeModule> {
  const imported = await import(pathToFileURL(resolve(modulePath)).href) as Readonly<{
    default?: unknown;
    runtime?: unknown;
  }>;
  const runtime = imported.runtime ?? imported.default;
  if (typeof runtime !== "object" || runtime === null) {
    throw new Error("BACKLINKS_RUNTIME_MODULE_INVALID");
  }
  return runtime as BacklinksProductionRuntimeModule;
}

async function assertPostgreSqlReady(pool: RuntimePool): Promise<void> {
  const result = await pool.query(`
    SELECT current_setting('server_version_num')::integer AS "serverVersion",
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
     Number(row.serverVersion) < 180_000
     || row.contextTable === null
     || row.usageLedgerTable === null
     || row.governanceTable === null
   ) {
    throw new Error("BACKLINKS_DATABASE_MIGRATION_PREREQUISITE_FAILED");
  }
}

async function assertTemporalReady(
  temporal: BacklinksTemporalClient,
): Promise<void> {
  const workflowService = temporal.connection.workflowService as Readonly<{
    getSystemInfo(request: object): Promise<unknown>;
  }>;
  await workflowService.getSystemInfo({});
}

function installSignalHandlers(stop: () => Promise<void>): void {
  let stopping = false;
  const handle = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void stop().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handle);
  process.once("SIGTERM", handle);
  if (process.platform === "win32") {
    process.once("SIGBREAK", handle);
  }
}

async function closeResources(
  operations: readonly (() => Promise<void>)[],
): Promise<void> {
  const results = await Promise.allSettled(operations.map((operation) =>
    operation()
  ));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Runtime resource cleanup failed");
  }
}

async function createRuntimeResources(
  runtimeProcess: RuntimeProcess,
  environment: z.output<typeof runtimeEnvironmentSchema>,
) {
  const databaseConfig = backlinksDatabaseConfigSchema.parse({
    DATABASE_URL_SECRET_REF: environment.DATABASE_URL_SECRET_REF,
    BACKLINK_DB_STATEMENT_TIMEOUT_MS:
      environment.BACKLINK_DB_STATEMENT_TIMEOUT_MS,
    BACKLINK_DB_LOCK_TIMEOUT_MS: environment.BACKLINK_DB_LOCK_TIMEOUT_MS,
  });
  const connectionString = await readRequiredSecretFile(
    environment.DATABASE_URL_SECRET_REF,
    environment.DATABASE_URL_FILE,
  );
  const database = createBacklinksDatabaseConnectionConfig(
    runtimeProcess,
    databaseConfig,
    connectionString,
  );
  const pool = new postgres.Pool({
    ...database.pool,
    max: environment.BACKLINK_DB_POOL_MAX,
    idleTimeoutMillis: environment.BACKLINK_DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: environment.BACKLINK_DB_CONNECT_TIMEOUT_MS,
  });
  installDatabaseErrorHandlers(pool, runtimeProcess);
  const temporalConfig = backlinksTemporalConfigSchema.parse({
    BACKLINKS_WORKER_ENABLED: environment.BACKLINKS_WORKER_ENABLED,
    TEMPORAL_ADDRESS: environment.TEMPORAL_ADDRESS,
    TEMPORAL_NAMESPACE: environment.TEMPORAL_NAMESPACE,
    TEMPORAL_BACKLINKS_TASK_QUEUE:
      environment.TEMPORAL_BACKLINKS_TASK_QUEUE,
    TEMPORAL_BUILD_ID: environment.TEMPORAL_BUILD_ID,
  });
  const temporal = createBacklinksTemporalClient(temporalConfig);

  try {
    await assertPostgreSqlReady(pool);
    await assertTemporalReady(temporal);
  } catch (error) {
    await Promise.allSettled([pool.end(), temporal.close()]);
    throw error;
  }
  return { pool, temporal, temporalConfig };
}

async function startApiProcess(
  environment: z.output<typeof runtimeEnvironmentSchema>,
  buildIdentity: LocalProductRuntimeBuildIdentity,
): Promise<void> {
  const resources = await createRuntimeResources("api", environment);
  let runtime: BacklinksProductionRuntimeModule | undefined;
  try {
    runtime = await loadRuntimeModule(environment.BACKLINKS_RUNTIME_MODULE);
    if (runtime.createApiDependencies === undefined) {
      throw new Error("BACKLINKS_RUNTIME_API_FACTORY_MISSING");
    }
    const signingKey = await readRequiredSecretFile(
      environment.PLATFORM_CONTEXT_SIGNING_KEY_SECRET_REF,
      environment.PLATFORM_CONTEXT_SIGNING_KEY_FILE,
    );
    const config = backlinksConfigSchema.parse({
      BACKLINKS_API_ENABLED: environment.BACKLINKS_API_ENABLED,
      BACKLINK_API_BODY_LIMIT: environment.BACKLINK_API_BODY_LIMIT,
      BACKLINK_API_REQUEST_TIMEOUT_MS:
        environment.BACKLINK_API_REQUEST_TIMEOUT_MS,
    });
    const dependencies = await runtime.createApiDependencies({
      process: "api",
      pool: resources.pool,
      temporal: resources.temporal,
      buildIdentity,
    });
    const app = await createBacklinksPrivateApi({
      config,
      dependencies,
      platformContextSigningKey: signingKey,
      readiness: async () => {
        await assertPostgreSqlReady(resources.pool);
        await assertTemporalReady(resources.temporal);
      },
      buildIdentity,
      runtimeHealth: createBacklinksApiRuntimeHealth(
        process.env,
        buildIdentity.buildId,
      ),
    });
    const server = await startBacklinksPrivateApi(app, {
      host: environment.BACKLINKS_HOST,
      port: environment.BACKLINKS_PORT,
    });
    installSignalHandlers(async () => {
      try {
        await server.stop();
      } finally {
        await closeResources([
          async () => runtime?.close?.(),
          () => resources.pool.end(),
          () => resources.temporal.close(),
        ]);
      }
    });
    console.log(JSON.stringify({
      event: "backlinks.api.ready",
      address: server.address,
      taskQueue: environment.TEMPORAL_BACKLINKS_TASK_QUEUE,
      buildId: buildIdentity.buildId,
    }));
  } catch (error) {
    await closeResources([
      async () => runtime?.close?.(),
      () => resources.pool.end(),
      () => resources.temporal.close(),
    ]).catch((cleanupError: unknown) => {
      console.error(cleanupError);
    });
    throw error;
  }
}

async function startWorkerProcess(
  environment: z.output<typeof runtimeEnvironmentSchema>,
  buildIdentity: LocalProductRuntimeBuildIdentity,
): Promise<void> {
  const resources = await createRuntimeResources("worker", environment);
  let runtime: BacklinksProductionRuntimeModule | undefined;
  let worker: Awaited<ReturnType<typeof startBacklinksWorker>> | undefined;
  let healthServer:
    Awaited<ReturnType<typeof startBacklinksWorkerHealthServer>> | undefined;
  try {
    runtime = await loadRuntimeModule(environment.BACKLINKS_RUNTIME_MODULE);
    if (runtime.createWorkerRegistrations === undefined) {
      throw new Error("BACKLINKS_RUNTIME_WORKER_FACTORY_MISSING");
    }
    const registrations = await runtime.createWorkerRegistrations({
      process: "worker",
      pool: resources.pool,
      temporal: resources.temporal,
      buildIdentity,
    });
    worker = await startBacklinksWorker(
      resources.temporalConfig,
      registrations,
    );
    const workerExecutionMode: BacklinksWorkerExecutionMode =
      environment.BACKLINKS_WORKER_EXECUTION_MODE;
    if (workerExecutionMode === "quiesced") {
      throw new Error(
        "QUIESCED_WORKER_REQUIRES_LOCAL_PRODUCT_QUIESCED_ENTRYPOINT",
      );
    }
    const health = createBacklinksWorkerRuntimeHealth({
      buildId: buildIdentity.buildId,
      workerExecutionMode,
      postgresReady: true,
      temporalReady: true,
    });
    healthServer = await startBacklinksWorkerHealthServer(
      health,
      {
        host: environment.BACKLINKS_WORKER_HEALTH_HOST,
        port: environment.BACKLINKS_WORKER_HEALTH_PORT,
      },
      registrations.healthSnapshot,
    );
    installSignalHandlers(async () => {
      try {
        await worker?.stop();
      } finally {
        await closeResources([
          async () => healthServer?.stop(),
          async () => runtime?.close?.(),
          () => resources.pool.end(),
          () => resources.temporal.close(),
        ]);
      }
    });
    console.log(JSON.stringify({
      event: "backlinks.worker.ready",
      taskQueue:
        registrations.taskQueue
        ?? environment.TEMPORAL_BACKLINKS_TASK_QUEUE,
      buildId: buildIdentity.buildId,
      healthAddress: healthServer.address,
      workerExecutionMode,
      businessConsumersRunning: health.businessConsumersRunning,
    }));
    await worker.completion;
  } catch (error) {
    await closeResources([
      async () => worker?.stop(),
      async () => healthServer?.stop(),
      async () => runtime?.close?.(),
      () => resources.pool.end(),
      () => resources.temporal.close(),
    ]).catch((cleanupError: unknown) => {
      console.error(cleanupError);
    });
    throw error;
  }
}

export async function runBacklinksProcess(
  runtimeProcess: RuntimeProcess,
): Promise<void> {
  const environment = readRuntimeEnvironment();
  assertProcessConfiguration(runtimeProcess, environment);
  await assertBacklinksOutboundProxyReady(process.env);
  const buildIdentity = assertLocalProductRuntimeBuildIdentity(
    environment.TEMPORAL_BUILD_ID,
  );
  if (runtimeProcess === "api") {
    await startApiProcess(environment, buildIdentity);
    return;
  }
  await startWorkerProcess(environment, buildIdentity);
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined
  && resolve(entrypoint) === resolve(fileURLToPath(import.meta.url))
) {
  const requestedProcess = process.argv[2];
  if (requestedProcess !== "api" && requestedProcess !== "worker") {
    console.error("Usage: node dist/index.js <api|worker>");
    process.exitCode = 2;
  } else {
    void runBacklinksProcess(requestedProcess).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
