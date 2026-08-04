import { describe, expect, it, vi } from "vitest";

import {
  backlinksTemporalConfigSchema,
  createBacklinksTemporalClient,
} from "../../../src/modules/backlinks/workflows/client.js";
import {
  startBacklinksWorker,
  type BacklinksWorkerFactory,
} from "../../../src/modules/backlinks/workflows/worker.js";
const requiredConfig = {
  TEMPORAL_ADDRESS: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "growthos-test",
  TEMPORAL_BACKLINKS_TASK_QUEUE: "growthos.backlinks.v1",
  TEMPORAL_BUILD_ID: "backlinks-2026.07.22.1",
};
const registrations = {
  workflowsPath: "workflows.js",
  activities: {},
};
describe("backlinks Temporal client and worker", () => {
  it("parses the dedicated configuration with the worker disabled by default", () => {
    expect(backlinksTemporalConfigSchema.parse(requiredConfig)).toEqual({
      BACKLINKS_WORKER_ENABLED: false,
      ...requiredConfig,
    });
  });

  it.each([
    ["blank address", { ...requiredConfig, TEMPORAL_ADDRESS: "" }],
    ["blank namespace", { ...requiredConfig, TEMPORAL_NAMESPACE: "" }],
    ["blank queue", { ...requiredConfig, TEMPORAL_BACKLINKS_TASK_QUEUE: "" }],
    ["shared queue", { ...requiredConfig,
      TEMPORAL_BACKLINKS_TASK_QUEUE: "growthos.shared.v1" }],
    ["latest build", { ...requiredConfig, TEMPORAL_BUILD_ID: "latest" }],
    ["latest build with case", { ...requiredConfig, TEMPORAL_BUILD_ID: "LATEST" }],
    ["unknown key", { ...requiredConfig, TEMPORAL_DEFAULT_QUEUE: "shared" }],
  ])("rejects %s", (_name, value) => {
    expect(backlinksTemporalConfigSchema.safeParse(value).success).toBe(false);
  });

  it("creates a lazy SDK client and closes it without a server connection", async () => {
    const config = backlinksTemporalConfigSchema.parse(requiredConfig);
    const temporal = createBacklinksTemporalClient(config);
    expect(temporal.connection.options.address).toBe(requiredConfig.TEMPORAL_ADDRESS);
    expect(temporal.workflow.options.namespace).toBe(requiredConfig.TEMPORAL_NAMESPACE);
    await temporal.close();
  });

  it("does not create a worker while the default-off switch is disabled", async () => {
    const factory = vi.fn<BacklinksWorkerFactory>();
    const config = backlinksTemporalConfigSchema.parse(requiredConfig);
    await expect(startBacklinksWorker(config, registrations, factory)).rejects.toThrow(
      "BACKLINKS_WORKER_ENABLED",
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("starts and stops the configured worker exactly once", async () => {
    let finishRun: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
    );
    const shutdown = vi.fn(() => finishRun?.());
    const close = vi.fn(async () => undefined);
    const factory = vi.fn<BacklinksWorkerFactory>(
      async () => ({ run, shutdown, close }),
    );
    const config = backlinksTemporalConfigSchema.parse({
      ...requiredConfig,
      BACKLINKS_WORKER_ENABLED: "true",
    });
    const running = await startBacklinksWorker(config, registrations, factory);
    expect(factory).toHaveBeenCalledWith({
      address: requiredConfig.TEMPORAL_ADDRESS,
      namespace: requiredConfig.TEMPORAL_NAMESPACE,
      taskQueue: requiredConfig.TEMPORAL_BACKLINKS_TASK_QUEUE,
      buildId: requiredConfig.TEMPORAL_BUILD_ID,
      useVersioning: false,
      ...registrations,
    });
    expect(run).toHaveBeenCalledOnce();
    await running.stop();
    await running.stop();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(running.completion).resolves.toBeUndefined();
  });
});
