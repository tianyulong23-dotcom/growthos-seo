import { createRequire } from "node:module";
import { z } from "zod";
import { backlinksRuntimeContract } from "./namespaces.js";
type TemporalConnection = Readonly<{
  options: Readonly<{ address: string }>;
  workflowService: unknown;
  close(): Promise<void>;
}>;
type TemporalWorkflowClient = Readonly<{
  options: Readonly<{ namespace: string }>;
  workflowService: unknown;
  start(type: string, options: Readonly<{
    workflowId: string;
    taskQueue: string;
    args: readonly unknown[];
  }>): Promise<unknown>;
  getHandle(workflowId: string): Readonly<{
    signal(signalName: string): Promise<void>;
    query<T>(queryName: string): Promise<T>;
  }>;
}>;
const require = createRequire(import.meta.url);
const temporalClientSdk = require("@temporalio/client") as Readonly<{
  Connection: Readonly<{ lazy(
    options: Readonly<{ address: string }>,
  ): TemporalConnection }>;
  WorkflowClient: new (options: Readonly<{
    connection: TemporalConnection;
    namespace: string;
  }>) => TemporalWorkflowClient;
}>;
const disabledByDefaultSchema = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

const requiredTextSchema = z.string().trim().min(1);
const buildIdSchema = requiredTextSchema.refine(
  (value) => value.toLowerCase() !== "latest",
  { message: "TEMPORAL_BUILD_ID must be an immutable release identifier" },
);

export const backlinksTemporalConfigSchema = z
  .object({
    BACKLINKS_WORKER_ENABLED: disabledByDefaultSchema,
    TEMPORAL_ADDRESS: requiredTextSchema,
    TEMPORAL_NAMESPACE: requiredTextSchema,
    TEMPORAL_BACKLINKS_TASK_QUEUE: z.literal(
      backlinksRuntimeContract.taskQueue,
    ),
    TEMPORAL_BUILD_ID: buildIdSchema,
  })
  .strict();
export type BacklinksTemporalConfig =
  z.output<typeof backlinksTemporalConfigSchema>;
export type BacklinksTemporalClient = Readonly<{
  connection: TemporalConnection;
  workflow: TemporalWorkflowClient;
  close(): Promise<void>;
}>;
export function createBacklinksTemporalClient(
  config: BacklinksTemporalConfig,
): BacklinksTemporalClient {
  const connection = temporalClientSdk.Connection.lazy(
    { address: config.TEMPORAL_ADDRESS },
  );
  const workflow = new temporalClientSdk.WorkflowClient({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
  });

  return Object.freeze({
    connection,
    workflow,
    close: () => connection.close(),
  });
}
