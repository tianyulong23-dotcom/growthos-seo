import { Pool } from "pg";
import { z } from "zod";

import {
  importCommercialGoldSet,
  reportCommercialGoldSetMetrics,
} from "../src/modules/backlinks/application/services/commercial-gold-set.service.js";
import {
  withBacklinkTenantTransaction,
} from "../src/modules/backlinks/db/tenant-transaction.js";

const nonBlank = z.string().trim().min(1);
const scopeSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  websiteProjectId: z.uuid(),
}).strict();
const commandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("import"),
    scope: scopeSchema,
    actorId: nonBlank,
    payload: z.unknown(),
  }).strict(),
  z.object({
    action: z.literal("report"),
    scope: scopeSchema,
    datasetVersion: nonBlank,
    discoveryBatchId: z.uuid(),
    previousDiscoveryBatchId: z.uuid().optional(),
  }).strict(),
]);

async function readStandardInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 5_000_000) {
      throw new Error("COMMERCIAL_GOLD_SET_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.length === 0) {
    throw new Error("COMMERCIAL_GOLD_SET_STDIN_REQUIRED");
  }
  return JSON.parse(value) as unknown;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  const command = commandSchema.parse(await readStandardInput());
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await withBacklinkTenantTransaction(
      pool,
      command.scope,
      (client) => command.action === "import"
        ? importCommercialGoldSet({
            client,
            scope: command.scope,
            actorId: command.actorId,
            importedAt: new Date(),
            payload: command.payload,
          })
        : reportCommercialGoldSetMetrics({
            client,
            scope: command.scope,
            datasetVersion: command.datasetVersion,
            discoveryBatchId: command.discoveryBatchId,
            ...(command.previousDiscoveryBatchId === undefined
              ? {}
              : {
                  previousDiscoveryBatchId:
                    command.previousDiscoveryBatchId,
                }),
          }),
    );
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "COMMERCIAL_GOLD_SET_FAILED",
  );
  process.exitCode = 1;
});
