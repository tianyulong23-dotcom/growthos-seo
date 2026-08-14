import {
  Connection,
  WorkflowClient,
  WorkflowNotFoundError,
  type WorkflowExecutionStatusName,
} from "@temporalio/client";
import { Pool } from "pg";
import { z } from "zod";

import {
  reconcileRecommendationRefillOrphans,
  type RecommendationRefillWorkflowState,
} from "../src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.js";

const nonBlank = z.string().trim().min(1);
const commandSchema = z.object({
  action: z.enum(["dry-run", "apply"]),
  scope: z.object({
    organizationId: z.uuid(),
    workspaceId: z.uuid(),
    websiteProjectId: z.uuid(),
  }).strict(),
  actorId: nonBlank,
}).strict();

async function readStandardInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 100_000) {
      throw new Error("RECOMMENDATION_REFILL_RECONCILE_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.length === 0) {
    throw new Error("RECOMMENDATION_REFILL_RECONCILE_STDIN_REQUIRED");
  }
  return JSON.parse(value) as unknown;
}

function workflowState(
  status: WorkflowExecutionStatusName,
): RecommendationRefillWorkflowState {
  if (status === "RUNNING" || status === "PAUSED") return "running";
  if (
    status === "COMPLETED"
    || status === "FAILED"
    || status === "CANCELLED"
    || status === "TERMINATED"
    || status === "CONTINUED_AS_NEW"
    || status === "TIMED_OUT"
  ) {
    return "closed";
  }
  return "unknown";
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const temporalAddress = process.env.TEMPORAL_ADDRESS?.trim();
  const temporalNamespace = process.env.TEMPORAL_NAMESPACE?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  if (temporalAddress === undefined || temporalAddress.length === 0) {
    throw new Error("TEMPORAL_ADDRESS_REQUIRED");
  }
  if (temporalNamespace === undefined || temporalNamespace.length === 0) {
    throw new Error("TEMPORAL_NAMESPACE_REQUIRED");
  }

  const command = commandSchema.parse(await readStandardInput());
  const pool = new Pool({ connectionString: databaseUrl });
  const connection = Connection.lazy({ address: temporalAddress });
  const workflow = new WorkflowClient({
    connection,
    namespace: temporalNamespace,
  });
  try {
    const reconciliation = await reconcileRecommendationRefillOrphans({
      pool,
      scope: command.scope,
      actorId: command.actorId,
      mode: command.action,
      workflowProbe: {
        async inspect(workflowId) {
          try {
            const description = await workflow.getHandle(workflowId).describe();
            return workflowState(description.status.name);
          } catch (error) {
            return error instanceof WorkflowNotFoundError
              ? "missing"
              : "unknown";
          }
        },
      },
    });
    console.log(JSON.stringify(reconciliation));
  } finally {
    await connection.close();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "RECOMMENDATION_REFILL_RECONCILE_FAILED",
  );
  process.exitCode = 1;
});
