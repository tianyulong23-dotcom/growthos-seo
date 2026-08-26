import { describe, expect, it } from "vitest";

import {
  createBacklinksApiRuntimeHealth,
  createBacklinksWorkerRuntimeHealth,
  startBacklinksWorkerHealthServer,
} from "../../src/modules/backlinks/runtime/runtime-health.js";

describe("Backlinks runtime health", () => {
  it("separates provider configuration from external availability", () => {
    expect(createBacklinksApiRuntimeHealth({
      DATAFORSEO_ENABLED: "true",
      DATAFORSEO_EXTERNAL_AVAILABILITY: "unavailable",
      DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON: "insufficient_balance",
      BROWSER_PROVIDER_ENABLED: "false",
      AI_PROVIDER_ENABLED: "false",
      GOOGLE_OAUTH_ENABLED: "false",
      GMAIL_SEND_ENABLED: "false",
      GMAIL_SYNC_ENABLED: "false",
    }, "build-1")).toMatchObject({
      status: "ok",
      process: "api",
      buildId: "build-1",
      providers: {
        dataForSeo: {
          configured: true,
          externalAvailability: "unavailable",
          reasonCode: "insufficient_balance",
          recoveryAction: "fund_provider_account",
        },
        browser: {
          configured: false,
          externalAvailability: "disabled",
          reasonCode: "provider_disabled",
          recoveryAction: "enable_provider",
        },
      },
    });
  });

  it.each([
    ["insufficient_balance", "fund_provider_account"],
    ["invalid_credentials", "repair_provider_credentials"],
    ["rate_limited", "retry_after_rate_limit"],
    ["provider_timeout", "retry_after_timeout"],
    ["provider_outage", "retry_when_provider_recovers"],
    ["unknown_charge", "reconcile_request_fingerprint"],
    ["explicit_block", "remove_explicit_block"],
  ] as const)(
    "maps unavailable reason %s to recovery %s",
    (reasonCode, recoveryAction) => {
      expect(createBacklinksApiRuntimeHealth({
        DATAFORSEO_ENABLED: "true",
        DATAFORSEO_EXTERNAL_AVAILABILITY: "unavailable",
        DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON: reasonCode,
        BROWSER_PROVIDER_ENABLED: "true",
        BROWSER_PROVIDER_EXTERNAL_AVAILABILITY: "not_checked",
        AI_PROVIDER_ENABLED: "false",
        GOOGLE_OAUTH_ENABLED: "false",
        GMAIL_SEND_ENABLED: "false",
        GMAIL_SYNC_ENABLED: "false",
      }).providers).toMatchObject({
        dataForSeo: {
          configured: true,
          externalAvailability: "unavailable",
          reasonCode,
          recoveryAction,
        },
        browser: {
          configured: true,
          externalAvailability: "not_checked",
          reasonCode: "provider_not_checked",
          recoveryAction: "run_provider_diagnostic",
        },
      });
    },
  );

  it("requires one exact reason for an unavailable provider", () => {
    expect(() => createBacklinksApiRuntimeHealth({
      DATAFORSEO_ENABLED: "true",
      DATAFORSEO_EXTERNAL_AVAILABILITY: "unavailable",
      BROWSER_PROVIDER_ENABLED: "false",
      AI_PROVIDER_ENABLED: "false",
      GOOGLE_OAUTH_ENABLED: "false",
      GMAIL_SEND_ENABLED: "false",
      GMAIL_SYNC_ENABLED: "false",
    })).toThrow(
      "BACKLINKS_PROVIDER_UNAVAILABLE_REASON_REQUIRED:"
        + "DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON",
    );
  });

  it("distinguishes a live quiesced process from running consumers", () => {
    expect(createBacklinksWorkerRuntimeHealth({
      buildId: "build-2",
      workerExecutionMode: "quiesced",
      postgresReady: true,
      temporalReady: true,
      environment: {},
    })).toMatchObject({
      process: "worker",
      workerExecutionMode: "quiesced",
      businessConsumersRunning: false,
      postgresReady: true,
      temporalReady: true,
    });
  });

  it("reports recovery mode as maintenance without business consumers", () => {
    expect(createBacklinksWorkerRuntimeHealth({
      buildId: "build-recovery",
      workerExecutionMode: "recovery",
      postgresReady: true,
      temporalReady: true,
      environment: {},
    })).toMatchObject({
      process: "worker",
      workerExecutionMode: "recovery",
      businessConsumersRunning: false,
      postgresReady: true,
      temporalReady: true,
    });
  });

  it("serves Worker health without contacting a provider", async () => {
    const health = createBacklinksWorkerRuntimeHealth({
      buildId: "build-3",
      workerExecutionMode: "normal",
      postgresReady: true,
      temporalReady: true,
      environment: {},
    });
    const server = await startBacklinksWorkerHealthServer(health, {
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.address}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(health);
    } finally {
      await server.stop();
    }
  });

  it("adds a fresh task snapshot to each Worker health response", async () => {
    const health = createBacklinksWorkerRuntimeHealth({
      buildId: "build-4",
      workerExecutionMode: "normal",
      postgresReady: true,
      temporalReady: true,
      environment: {},
    });
    let activeJobs = 0;
    const server = await startBacklinksWorkerHealthServer(
      health,
      { host: "127.0.0.1", port: 0 },
      async () => ({ status: "ok", activeJobs: ++activeJobs }),
    );
    try {
      const first = await fetch(`${server.address}/health`);
      const second = await fetch(`${server.address}/health`);
      expect((await first.json()).tasks.activeJobs).toBe(1);
      expect((await second.json()).tasks.activeJobs).toBe(2);
    } finally {
      await server.stop();
    }
  });

  it("keeps process health truthful when task inspection fails", async () => {
    const health = createBacklinksWorkerRuntimeHealth({
      buildId: "build-5",
      workerExecutionMode: "normal",
      postgresReady: true,
      temporalReady: true,
      environment: {},
    });
    const server = await startBacklinksWorkerHealthServer(
      health,
      { host: "127.0.0.1", port: 0 },
      async () => {
        throw new Error("database unavailable");
      },
    );
    try {
      const response = await fetch(`${server.address}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "ok",
        process: "worker",
        tasks: {
          status: "unavailable",
          reasonCode: "task_health_unavailable",
          recoveryAction: "inspect_worker_task_health",
        },
      });
    } finally {
      await server.stop();
    }
  });
});
