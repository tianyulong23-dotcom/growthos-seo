import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  backlinksDatabaseConfigSchema,
  createBacklinksDatabaseConnectionConfig,
} from "../dist/modules/backlinks/db/client/backlinks-database-config.js";
import { createScopedOutboxRelayRepository } from "../dist/modules/backlinks/db/repositories/outbox.repository.js";
import { withBacklinkTenantTransaction } from "../dist/modules/backlinks/db/tenant-transaction.js";
import { createRecommendationCommands } from "../dist/modules/backlinks/application/commands/recommendations.command.js";
import {
  backlinksTemporalConfigSchema,
  createBacklinksTemporalClient,
} from "../dist/modules/backlinks/workflows/client.js";
import { startBacklinksWorker } from "../dist/modules/backlinks/workflows/worker.js";
import { createRecommendationRefillOutboxRelay } from "../dist/modules/backlinks/workflows/outbox-relay.js";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

const runtimeRoot =
  process.argv[2] ?? "C:\\Users\\DELL\\AppData\\Local\\GrowthOS\\live001";
const resumeOnly = process.argv.includes("--resume-only");
const environmentFile = resolve(runtimeRoot, "backlinks-worker.env");
const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "cec65d3f-92e5-4b13-aa26-7b39e74e213a";
const websiteProjectId = "3778023d-05a4-442d-babf-5424ae30f094";
const recommendationContextVersionId =
  "3432a635-5729-4dc8-aca0-fdcd62852958";
const promotionTargetVersionId = "42035a50-5995-4c93-b3d3-2a6f644c309d";
const operationId = "1f9a2510-0ba2-4dda-908c-cc56dee02849";
const jobId = "59df61d1-015d-4b17-8f32-fb320dc41aee";
const workflowId =
  "backlinks:11111111-1111-4111-8111-111111111111:" +
  "cec65d3f-92e5-4b13-aa26-7b39e74e213a:" +
  "3778023d-05a4-442d-babf-5424ae30f094:" +
  "recommendation-refill:v1:59df61d1-015d-4b17-8f32-fb320dc41aee";
const actorId = "local-product-operator";
const scope = { organizationId, workspaceId, websiteProjectId };

function emit(event, fields = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`LOCAL_PRODUCT_CONFIGURATION_MISSING:${name}`);
  return value;
}

function positiveIntegerEnvironment(name) {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`LOCAL_PRODUCT_CONFIGURATION_INVALID:${name}`);
  }
  return value;
}

async function loadEnvironment() {
  const content = await readFile(environmentFile, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    process.env[name] = value;
  }
}

async function loadRuntimeModule(modulePath) {
  const imported = await import(pathToFileURL(resolve(modulePath)).href);
  const runtime = imported.runtime ?? imported.default;
  if (typeof runtime !== "object" || runtime === null) {
    throw new Error("BACKLINKS_RUNTIME_MODULE_INVALID");
  }
  return runtime;
}

async function snapshot(pool) {
  return withBacklinkTenantTransaction(pool, scope, async (client) => {
    const job = (
      await client.query(
        `SELECT status,step,progress,retry_count "retryCount",
                version,error
           FROM backlink_jobs
          WHERE id=$1`,
        [jobId],
      )
    ).rows[0];
    const policy = (
      await client.query(
        `SELECT visible_pool_generation "visiblePoolGeneration",
                visible_pool_state "visiblePoolState",
                refill_state "refillState",
                current_refill_tier "currentRefillTier",
                current_refill_round "currentRefillRound",
                last_publishable_count "lastPublishableCount",
                termination_reason "terminationReason",
                pause_reason "pauseReason",
                version
           FROM backlink_commercial_inventory_policies
          WHERE project_context_version_id=$1`,
        [recommendationContextVersionId],
      )
    ).rows[0];
    const inventory = (
      await client.query(
        `SELECT count(*)::integer count
           FROM backlink_recommendation_inventory
          WHERE recommendation_context_version_id=$1
            AND visible_pool_generation=1
            AND status IN ('ready','shown','accepted')`,
        [recommendationContextVersionId],
      )
    ).rows[0];
    return { job, policy, inventory };
  });
}

await loadEnvironment();
const buildIdentity = JSON.parse(
  await readFile(resolve("dist", "local-product-build-identity.json"), "utf8"),
);
process.env.TEMPORAL_BUILD_ID = String(buildIdentity.buildId);

const databaseConfig = backlinksDatabaseConfigSchema.parse({
  DATABASE_URL_SECRET_REF: requiredEnvironment("DATABASE_URL_SECRET_REF"),
  BACKLINK_DB_STATEMENT_TIMEOUT_MS: requiredEnvironment(
    "BACKLINK_DB_STATEMENT_TIMEOUT_MS",
  ),
  BACKLINK_DB_LOCK_TIMEOUT_MS: requiredEnvironment(
    "BACKLINK_DB_LOCK_TIMEOUT_MS",
  ),
});
const connectionString = (
  await readFile(requiredEnvironment("DATABASE_URL_FILE"), "utf8")
).trim();
const database = createBacklinksDatabaseConnectionConfig(
  "worker",
  databaseConfig,
  connectionString,
);
const pool = new Pool({
  ...database.pool,
  max: positiveIntegerEnvironment("BACKLINK_DB_POOL_MAX"),
  idleTimeoutMillis: positiveIntegerEnvironment(
    "BACKLINK_DB_IDLE_TIMEOUT_MS",
  ),
  connectionTimeoutMillis: positiveIntegerEnvironment(
    "BACKLINK_DB_CONNECT_TIMEOUT_MS",
  ),
});
const temporalConfig = backlinksTemporalConfigSchema.parse({
  BACKLINKS_WORKER_ENABLED: "true",
  TEMPORAL_ADDRESS: requiredEnvironment("TEMPORAL_ADDRESS"),
  TEMPORAL_NAMESPACE: requiredEnvironment("TEMPORAL_NAMESPACE"),
  TEMPORAL_BACKLINKS_TASK_QUEUE: requiredEnvironment(
    "TEMPORAL_BACKLINKS_TASK_QUEUE",
  ),
  TEMPORAL_BUILD_ID: requiredEnvironment("TEMPORAL_BUILD_ID"),
});
const temporal = createBacklinksTemporalClient(temporalConfig);
const isolatedTaskQueue =
  `growthos.backlinks.local-product-038.${jobId}`;
let runtime;
let runningWorker;

try {
  runtime = await loadRuntimeModule(
    requiredEnvironment("BACKLINKS_RUNTIME_MODULE"),
  );
  const context = Object.freeze({
    actor: Object.freeze({
      userId: actorId,
      sessionId: `local-product-038:${jobId}`,
      roles: Object.freeze(["member"]),
    }),
    tenant: Object.freeze({ organizationId, workspaceId }),
    project: Object.freeze({
      websiteProjectId,
      canonicalDomain: "manitosilk.com",
      locale: "en",
      countryCode: "US",
      profileVersionId: recommendationContextVersionId,
      promotionTargetVersionId,
    }),
  });
  const before = await snapshot(pool);
  emit("local-product-038.before", before);

  if (!resumeOnly) {
    const recovery = await withBacklinkTenantTransaction(
      pool,
      scope,
      (client) =>
        createRecommendationCommands(client).requestRefill({
          context,
          requestId: `local-product-038-recovery-${Date.now()}`,
          expectedVersion: 0,
          recommendationContextVersionId,
          visiblePoolGeneration: 1,
          lowWatermark: 20,
          highWatermark: 106,
          operationId,
        }),
    );
    emit("local-product-038.rearmed", recovery);
  }

  const registrations = await runtime.createWorkerRegistrations({
    process: "worker",
    pool,
    temporal,
  });
  runningWorker = await startBacklinksWorker(
    {
      ...temporalConfig,
      TEMPORAL_BACKLINKS_TASK_QUEUE: isolatedTaskQueue,
    },
    {
      workflowsPath: registrations.workflowsPath,
      activities: registrations.activities,
    },
  );
  emit("local-product-038.worker.started", {
    taskQueue: isolatedTaskQueue,
    buildId: temporalConfig.TEMPORAL_BUILD_ID,
  });

  if (resumeOnly) {
    const description = await temporal.workflow.getHandle(workflowId).describe();
    emit("local-product-038.workflow.resumed", {
      workflowId,
      status: description.status.name,
    });
  } else {
    const relay = createRecommendationRefillOutboxRelay({
      repository: createScopedOutboxRelayRepository(pool, scope),
      consumer: {
        async consume(input) {
          if (input.jobId !== jobId || input.workflowId !== workflowId) {
            throw new Error("LOCAL_PRODUCT_038_OUTBOX_SCOPE_MISMATCH");
          }
          await temporal.workflow.start(
            "backlinksRecommendationRefillV1Workflow",
            {
              workflowId,
              taskQueue: isolatedTaskQueue,
              args: [input],
              workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
            },
          );
          return { workflowId };
        },
      },
    });
    const relayOutcome = await relay.runOnce({
      workerId: `local-product-038:${process.pid}`,
      limit: 1,
      staleClaimBefore: new Date(Date.now() - 60_000),
    });
    if (
      relayOutcome.claimed !== 1 ||
      relayOutcome.published !== 1 ||
      relayOutcome.failed !== 0
    ) {
      throw new Error(
        `LOCAL_PRODUCT_038_RELAY_FAILED:${JSON.stringify(relayOutcome)}`,
      );
    }
    emit("local-product-038.workflow.started", {
      workflowId,
      relay: relayOutcome,
    });
  }

  const handle = temporal.workflow.getHandle(workflowId);
  const result = await Promise.race([
    handle.result(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("LOCAL_PRODUCT_038_WORKFLOW_TIMEOUT")),
        45 * 60 * 1000,
      ),
    ),
  ]);
  emit("local-product-038.workflow.completed", { result });
  emit("local-product-038.after", await snapshot(pool));
} catch (error) {
  emit("local-product-038.failed", {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  try {
    emit("local-product-038.failure-snapshot", await snapshot(pool));
  } catch {
    // The primary error remains authoritative.
  }
  process.exitCode = 1;
} finally {
  if (runningWorker !== undefined) {
    await runningWorker.stop().catch(() => undefined);
  }
  await Promise.allSettled([
    runtime?.close?.(),
    pool.end(),
    temporal.close(),
  ]);
}
