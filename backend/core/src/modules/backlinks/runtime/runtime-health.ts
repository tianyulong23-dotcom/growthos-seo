import {
  createServer,
  type Server,
} from "node:http";

import { z } from "zod";

export const providerExternalAvailabilitySchema = z.enum([
  "disabled",
  "not_checked",
  "available",
  "unavailable",
]);

export type ProviderExternalAvailability = z.infer<
  typeof providerExternalAvailabilitySchema
>;

export const providerReasonCodeSchema = z.enum([
  "provider_disabled",
  "provider_not_checked",
  "insufficient_balance",
  "invalid_credentials",
  "rate_limited",
  "provider_timeout",
  "provider_outage",
  "unknown_charge",
  "explicit_block",
]);

export type ProviderReasonCode = z.infer<
  typeof providerReasonCodeSchema
>;

export const providerRecoveryActionSchema = z.enum([
  "enable_provider",
  "run_provider_diagnostic",
  "fund_provider_account",
  "repair_provider_credentials",
  "retry_after_rate_limit",
  "retry_after_timeout",
  "retry_when_provider_recovers",
  "reconcile_request_fingerprint",
  "remove_explicit_block",
]);

export type ProviderRecoveryAction = z.infer<
  typeof providerRecoveryActionSchema
>;

export type BacklinksProviderHealth = Readonly<{
  configured: boolean;
  externalAvailability: ProviderExternalAvailability;
  reasonCode: ProviderReasonCode | null;
  recoveryAction: ProviderRecoveryAction | null;
}>;

export type BacklinksProvidersHealth = Readonly<{
  dataForSeo: BacklinksProviderHealth;
  browser: BacklinksProviderHealth;
  ai: BacklinksProviderHealth;
  gmail: BacklinksProviderHealth;
}>;

export type BacklinksApiRuntimeHealth = Readonly<{
  status: "ok";
  process: "api";
  buildId: string | null;
  providers: BacklinksProvidersHealth;
}>;

export type BacklinksWorkerExecutionMode = "normal" | "quiesced" | "recovery";

export type BacklinksWorkerRuntimeHealth = Readonly<{
  status: "ok";
  process: "worker";
  buildId: string;
  workerExecutionMode: BacklinksWorkerExecutionMode;
  businessConsumersRunning: boolean;
  postgresReady: boolean;
  temporalReady: boolean;
  providers: BacklinksProvidersHealth;
}>;

type WorkerHealthServer = Readonly<{
  address: string;
  stop(): Promise<void>;
}>;

const externalAvailabilityEnvironment = Object.freeze({
  dataForSeo: "DATAFORSEO_EXTERNAL_AVAILABILITY",
  browser: "BROWSER_PROVIDER_EXTERNAL_AVAILABILITY",
  ai: "AI_PROVIDER_EXTERNAL_AVAILABILITY",
  gmail: "GMAIL_EXTERNAL_AVAILABILITY",
});
const externalUnavailableReasonEnvironment = Object.freeze({
  dataForSeo: "DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON",
  browser: "BROWSER_PROVIDER_EXTERNAL_UNAVAILABLE_REASON",
  ai: "AI_PROVIDER_EXTERNAL_UNAVAILABLE_REASON",
  gmail: "GMAIL_EXTERNAL_UNAVAILABLE_REASON",
});
const recoveryActionByUnavailableReason = Object.freeze({
  insufficient_balance: "fund_provider_account",
  invalid_credentials: "repair_provider_credentials",
  rate_limited: "retry_after_rate_limit",
  provider_timeout: "retry_after_timeout",
  provider_outage: "retry_when_provider_recovers",
  unknown_charge: "reconcile_request_fingerprint",
  explicit_block: "remove_explicit_block",
} satisfies Readonly<Record<
  Exclude<
    ProviderReasonCode,
    "provider_disabled" | "provider_not_checked"
  >,
  ProviderRecoveryAction
>>);

function enabled(
  environment: NodeJS.ProcessEnv,
  name: string,
): boolean {
  return environment[name]?.trim() === "true";
}

function providerHealth(
  environment: NodeJS.ProcessEnv,
  configured: boolean,
  availabilityName: string,
  unavailableReasonName: string,
): BacklinksProviderHealth {
  if (!configured) {
    return Object.freeze({
      configured: false,
      externalAvailability: "disabled",
      reasonCode: "provider_disabled",
      recoveryAction: "enable_provider",
    });
  }
  const configuredAvailability = environment[availabilityName]?.trim();
  if (configuredAvailability === undefined || configuredAvailability === "") {
    return Object.freeze({
      configured: true,
      externalAvailability: "not_checked",
      reasonCode: "provider_not_checked",
      recoveryAction: "run_provider_diagnostic",
    });
  }
  const availability = providerExternalAvailabilitySchema.parse(
    configuredAvailability,
  );
  if (availability === "disabled") {
    throw new Error(
      `BACKLINKS_PROVIDER_AVAILABILITY_CONFLICT:${availabilityName}`,
    );
  }
  if (availability === "available") {
    return Object.freeze({
      configured: true,
      externalAvailability: availability,
      reasonCode: null,
      recoveryAction: null,
    });
  }
  if (availability === "not_checked") {
    return Object.freeze({
      configured: true,
      externalAvailability: availability,
      reasonCode: "provider_not_checked",
      recoveryAction: "run_provider_diagnostic",
    });
  }
  const configuredReason = environment[unavailableReasonName]?.trim();
  if (configuredReason === undefined || configuredReason === "") {
    throw new Error(
      `BACKLINKS_PROVIDER_UNAVAILABLE_REASON_REQUIRED:${unavailableReasonName}`,
    );
  }
  const reason = providerReasonCodeSchema.safeParse(configuredReason);
  if (
    !reason.success
    || reason.data === "provider_disabled"
    || reason.data === "provider_not_checked"
  ) {
    throw new Error(
      `BACKLINKS_PROVIDER_UNAVAILABLE_REASON_INVALID:${unavailableReasonName}`,
    );
  }
  return Object.freeze({
    configured: true,
    externalAvailability: availability,
    reasonCode: reason.data,
    recoveryAction: recoveryActionByUnavailableReason[reason.data],
  });
}

export function createDataForSeoProviderHealth(
  environment: NodeJS.ProcessEnv = process.env,
): BacklinksProviderHealth {
  return providerHealth(
    environment,
    enabled(environment, "DATAFORSEO_ENABLED"),
    externalAvailabilityEnvironment.dataForSeo,
    externalUnavailableReasonEnvironment.dataForSeo,
  );
}

export function createBacklinksProvidersHealth(
  environment: NodeJS.ProcessEnv = process.env,
): BacklinksProvidersHealth {
  return Object.freeze({
    dataForSeo: createDataForSeoProviderHealth(environment),
    browser: providerHealth(
      environment,
      enabled(environment, "BROWSER_PROVIDER_ENABLED"),
      externalAvailabilityEnvironment.browser,
      externalUnavailableReasonEnvironment.browser,
    ),
    ai: providerHealth(
      environment,
      enabled(environment, "AI_PROVIDER_ENABLED"),
      externalAvailabilityEnvironment.ai,
      externalUnavailableReasonEnvironment.ai,
    ),
    gmail: providerHealth(
      environment,
      enabled(environment, "GOOGLE_OAUTH_ENABLED")
        || enabled(environment, "GMAIL_SEND_ENABLED")
        || enabled(environment, "GMAIL_SYNC_ENABLED"),
      externalAvailabilityEnvironment.gmail,
      externalUnavailableReasonEnvironment.gmail,
    ),
  });
}

export function createBacklinksApiRuntimeHealth(
  environment: NodeJS.ProcessEnv = process.env,
  buildId: string | null = null,
): BacklinksApiRuntimeHealth {
  return Object.freeze({
    status: "ok",
    process: "api",
    buildId,
    providers: createBacklinksProvidersHealth(environment),
  });
}

export function createBacklinksWorkerRuntimeHealth(input: Readonly<{
  buildId: string;
  workerExecutionMode: BacklinksWorkerExecutionMode;
  postgresReady: boolean;
  temporalReady: boolean;
  environment?: NodeJS.ProcessEnv;
}>): BacklinksWorkerRuntimeHealth {
  return Object.freeze({
    status: "ok",
    process: "worker",
    buildId: input.buildId,
    workerExecutionMode: input.workerExecutionMode,
    businessConsumersRunning: input.workerExecutionMode === "normal",
    postgresReady: input.postgresReady,
    temporalReady: input.temporalReady,
    providers: createBacklinksProvidersHealth(
      input.environment ?? process.env,
    ),
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function startBacklinksWorkerHealthServer(
  health: BacklinksWorkerRuntimeHealth,
  options: Readonly<{ host: string; port: number }>,
  healthSnapshot?: () => Promise<Record<string, unknown>>,
): Promise<WorkerHealthServer> {
  if (!["127.0.0.1", "::1", "localhost"].includes(options.host)) {
    throw new Error("BACKLINKS_WORKER_HEALTH_MUST_BIND_TO_LOOPBACK");
  }
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    let body: string;
    try {
      const tasks = await healthSnapshot?.();
      body = `${JSON.stringify({
        ...health,
        ...(tasks === undefined ? {} : { tasks }),
      })}\n`;
    } catch {
      body = `${JSON.stringify({
        ...health,
        tasks: {
          status: "unavailable",
          reasonCode: "task_health_unavailable",
          recoveryAction: "inspect_worker_task_health",
        },
      })}\n`;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json; charset=utf-8",
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("BACKLINKS_WORKER_HEALTH_ADDRESS_INVALID");
  }
  let stopped = false;
  return Object.freeze({
    address: `http://${options.host}:${address.port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await closeServer(server);
    },
  });
}
