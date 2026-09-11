import { Pool } from "pg";
import { z } from "zod";

const nonBlank = z.string().trim().min(1);
const commandSchema = z
  .object({
    runId: z.string().uuid(),
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
      throw new Error("RECOMMENDATION_POOL_V2_PHASE9_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.length === 0) {
    throw new Error("RECOMMENDATION_POOL_V2_PHASE9_STDIN_REQUIRED");
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
    const result = await pool.query<{ result: unknown }>(
      `SELECT backlinks.backlink_recommendation_pool_v2_phase9_run(
         $1::uuid,
         $2::text,
         $3::text,
         $4::text,
         $5::timestamptz
       ) AS result`,
      [
        command.runId,
        command.commandId,
        command.mode,
        command.actor,
        new Date(),
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("RECOMMENDATION_POOL_V2_PHASE9_RESULT_MISSING");
    }
    console.log(JSON.stringify(result.rows[0]?.result));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "RECOMMENDATION_POOL_V2_PHASE9_FAILED",
  );
  process.exitCode = 1;
});
