import { Pool } from "pg";
import { z } from "zod";

import { createRecommendationPoolV2CutoverService } from "../src/modules/backlinks/application/services/recommendation-pool-v2-cutover.service.js";
import { createRecommendationPoolV2CutoverRepository } from "../src/modules/backlinks/db/repositories/recommendation-pool-v2-cutover.repository.js";

const nonBlank = z.string().trim().min(1);
const commandSchema = z
  .object({
    commandId: nonBlank,
    mode: z.enum(["PLAN", "EXECUTE", "VERIFY"]),
    actor: nonBlank,
  })
  .strict();

async function readStandardInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 100_000) {
      throw new Error("RECOMMENDATION_POOL_V2_CUTOVER_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.length === 0) {
    throw new Error("RECOMMENDATION_POOL_V2_CUTOVER_STDIN_REQUIRED");
  }
  return JSON.parse(value) as unknown;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }

  const command = commandSchema.parse(await readStandardInput());
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const repository = createRecommendationPoolV2CutoverRepository(pool);
    const service = createRecommendationPoolV2CutoverService(repository);
    console.log(JSON.stringify(await service.run(command)));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "RECOMMENDATION_POOL_V2_CUTOVER_FAILED",
  );
  process.exitCode = 1;
});
