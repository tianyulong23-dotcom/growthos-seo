import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createArchiveCenter, parseCredentials, type ArchiveDatabase } from "./center.js";
import { positiveInteger } from "./contract.js";
import { captureConfig } from "./spool.js";
import { replaceJson, spoolStatus, uploadOnce } from "./uploader.js";

const env = process.env;
function required(key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`ARCHIVE_CONFIG_REQUIRED:${key}`);
  return value;
}
async function secretFile(key: string) {
  const path = required(key);
  if (!isAbsolute(path)) throw new Error("ARCHIVE_ABSOLUTE_SECRET_PATH_REQUIRED");
  return (await readFile(path, "utf8")).trim();
}

async function main() {
  const mode = process.argv[2];
  if (mode === "upload" || mode === "status") {
    const config = captureConfig();
    if (!config) throw new Error("ARCHIVE_CAPTURE_NOT_ENABLED");
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    if (mode === "status") {
      console.log(JSON.stringify(await spoolStatus(config.directory)));
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      while (!controller.signal.aborted) {
        const health = await uploadOnce({
          ...config, centerUrl: required("PROVIDER_ARCHIVE_CENTER_URL"),
          token: await secretFile("PROVIDER_ARCHIVE_UPLOAD_TOKEN_FILE"),
          timeoutMs: positiveInteger(env.PROVIDER_ARCHIVE_UPLOAD_TIMEOUT_MS, 30_000),
          batchSize: positiveInteger(env.PROVIDER_ARCHIVE_UPLOAD_BATCH_SIZE, 20),
          retryBaseMs: positiveInteger(env.PROVIDER_ARCHIVE_RETRY_BASE_MS, 5_000),
          retryMaxMs: positiveInteger(env.PROVIDER_ARCHIVE_RETRY_MAX_MS, 300_000),
        });
        await replaceJson(join(config.directory, "uploader-health.json"), {
          observedAt: new Date().toISOString(), ...health,
        });
        console.log(JSON.stringify({ component: "provider-archive-uploader", ...health }));
        try {
          await setTimeout(positiveInteger(env.PROVIDER_ARCHIVE_UPLOAD_INTERVAL_MS, 5_000), undefined,
            { signal: controller.signal });
        } catch {
          if (!controller.signal.aborted) throw new Error("ARCHIVE_SLEEP_FAILED");
        }
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    return;
  }
  if (mode !== "migrate" && mode !== "serve") throw new Error("ARCHIVE_MODE_REQUIRED");
  const { Pool } = createRequire(import.meta.url)("pg") as {
    Pool: new (config: object) => ArchiveDatabase & { end(): Promise<void> };
  };
  const pool = new Pool({
    connectionString: required("PROVIDER_ARCHIVE_DATABASE_URL"),
    max: positiveInteger(env.PROVIDER_ARCHIVE_DATABASE_POOL_SIZE, 5),
    connectionTimeoutMillis: 10_000,
  });
  if (mode === "migrate") {
    try {
      await pool.query(await readFile(
        new URL("../../../src/modules/provider-archive/schema.sql", import.meta.url), "utf8"));
      console.log(JSON.stringify({ status: "ARCHIVE_SCHEMA_READY" }));
    } finally { await pool.end(); }
    return;
  }
  try {
    const app = createArchiveCenter({
      db: pool, credentials: parseCredentials(await secretFile("PROVIDER_ARCHIVE_CREDENTIALS_FILE")),
      bodyLimit: positiveInteger(env.PROVIDER_ARCHIVE_HTTP_BODY_LIMIT, 48 * 1024 * 1024),
    });
    app.addHook("onClose", () => pool.end());
    const stop = () => { void app.close(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await app.listen({
      host: env.PROVIDER_ARCHIVE_HOST ?? "127.0.0.1",
      port: positiveInteger(env.PROVIDER_ARCHIVE_PORT, 7400),
    });
    console.log(JSON.stringify({ status: "ARCHIVE_CENTER_READY" }));
  } catch (error) {
    await pool.end();
    throw error;
  }
}

void main().catch(() => {
  // Connection strings, raw response bodies and credentials must not enter logs.
  console.error(JSON.stringify({ code: "ARCHIVE_PROCESS_FAILED" }));
  process.exitCode = 1;
});
