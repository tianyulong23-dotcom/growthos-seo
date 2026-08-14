import { createRequire } from "node:module";
import type { BacklinksTemporalConfig } from "./client.js";

type TemporalNativeConnection = Readonly<{
  close(): Promise<void>;
}>;
type TemporalWorker = Readonly<{
  run(): Promise<void>;
  shutdown(): void;
}>;

const require = createRequire(import.meta.url);
const temporalWorkerSdk = require("@temporalio/worker") as Readonly<{
  NativeConnection: Readonly<{ connect(
    options: Readonly<{ address: string }>,
  ): Promise<TemporalNativeConnection> }>;
  Worker: Readonly<{
    create(options: Readonly<{
      connection: TemporalNativeConnection;
      namespace: string;
      taskQueue: string;
      buildId: string;
      useVersioning: false;
      workflowsPath: string;
      activities: object;
    }>): Promise<TemporalWorker>;
  }>;
}>;

export type BacklinksWorkerFactoryOptions = Readonly<{
  address: string;
  namespace: string;
  taskQueue: string;
  buildId: string;
  useVersioning: false;
  workflowsPath: string;
  activities: object;
}>;
export type BacklinksWorkerRegistrations = Readonly<{
  workflowsPath: string;
  activities: object;
  backgroundServices?: readonly Readonly<{
    start(): Promise<void>;
    stop(): Promise<void>;
  }>[];
}>;

export type BacklinksWorkerRuntime = Readonly<{
  run(): Promise<void>;
  shutdown(): void;
  close(): Promise<void>;
}>;

export type BacklinksWorkerFactory = (
  options: BacklinksWorkerFactoryOptions,
) => Promise<BacklinksWorkerRuntime>;
export type RunningBacklinksWorker = Readonly<{
  completion: Promise<void>;
  stop(): Promise<void>;
}>;

const createSdkWorker: BacklinksWorkerFactory = async ({
  address,
  ...workerOptions
}) => {
  const connection =
    await temporalWorkerSdk.NativeConnection.connect({ address });
  try {
    const worker = await temporalWorkerSdk.Worker.create({
      connection,
      ...workerOptions,
    });
    return {
      run: () => worker.run(),
      shutdown: () => worker.shutdown(),
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close();
    throw error;
  }
};

export async function startBacklinksWorker(
  config: BacklinksTemporalConfig,
  registrations: BacklinksWorkerRegistrations,
  factory: BacklinksWorkerFactory = createSdkWorker,
): Promise<RunningBacklinksWorker> {
  if (!config.BACKLINKS_WORKER_ENABLED) {
    throw new Error("BACKLINKS_WORKER_ENABLED must be true to start the worker");
  }

  const {
    backgroundServices = [],
    ...workerRegistrations
  } = registrations;
  const worker = await factory({
    address: config.TEMPORAL_ADDRESS,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_BACKLINKS_TASK_QUEUE,
    buildId: config.TEMPORAL_BUILD_ID,
    useVersioning: false,
    ...workerRegistrations,
  });
  const startedServices: typeof backgroundServices[number][] = [];
  let servicesStopping = false;
  const stopServices = async () => {
    if (servicesStopping) return;
    servicesStopping = true;
    const results = await Promise.allSettled(
      [...startedServices].reverse().map((service) => service.stop()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Backlinks worker background service cleanup failed",
      );
    }
  };
  const completion = worker.run().finally(async () => {
    try {
      await stopServices();
    } finally {
      await worker.close();
    }
  });
  try {
    for (const service of backgroundServices) {
      await service.start();
      startedServices.push(service);
    }
  } catch (error) {
    worker.shutdown();
    await completion.catch(() => undefined);
    throw error;
  }
  let stopping = false;

  return Object.freeze({
    completion,
    async stop() {
      if (!stopping) {
        stopping = true;
        try {
          await stopServices();
        } finally {
          worker.shutdown();
        }
      }
      await completion;
    },
  });
}
