import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { archiveEventSchema, positiveInteger, sha256, type ArchiveEvent } from "./contract.js";

export type CaptureConfig = Readonly<{
  directory: string;
  deploymentId: string;
  maxResponseBytes: number;
  maxPending: number;
}>;

export function captureConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig | null {
  if (env.PROVIDER_ARCHIVE_ENABLED === undefined || env.PROVIDER_ARCHIVE_ENABLED === "false") return null;
  if (env.PROVIDER_ARCHIVE_ENABLED !== "true") throw new Error("ARCHIVE_INVALID_ENABLED");
  const directory = env.PROVIDER_ARCHIVE_SPOOL_DIR ?? "";
  if (!isAbsolute(directory)) throw new Error("ARCHIVE_ABSOLUTE_SPOOL_REQUIRED");
  const deploymentId = archiveEventSchema.shape.deploymentId.parse(env.PROVIDER_ARCHIVE_DEPLOYMENT_ID);
  return {
    directory, deploymentId,
    maxResponseBytes: positiveInteger(env.PROVIDER_ARCHIVE_MAX_RESPONSE_BYTES, 32 * 1024 * 1024),
    maxPending: positiveInteger(env.PROVIDER_ARCHIVE_MAX_PENDING, 100_000),
  };
}

export async function durableWrite(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node. Persist the volume.
  if (process.platform === "win32") return;
  const file = await open(directory, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export async function beginCapture(
  config: CaptureConfig,
  input: Pick<ArchiveEvent, "component" | "endpoint" | "method" | "requestBody">,
) {
  await mkdir(config.directory, { recursive: true, mode: 0o700 });
  const pending = (await readdir(config.directory)).filter((name) =>
    name.endsWith(".pending") || name.endsWith(".event.json"));
  if (pending.length >= config.maxPending) throw new Error("ARCHIVE_SPOOL_CAPACITY");
  const eventId = randomUUID();
  const base = {
    schemaVersion: 1 as const, eventId, deploymentId: config.deploymentId,
    ...input, startedAt: new Date().toISOString(),
  };
  const marker = join(config.directory, `${eventId}.pending`);
  await durableWrite(marker, base);
  await syncDirectory(config.directory);
  return {
    eventId,
    async finish(body: Buffer, httpStatus: number | null): Promise<void> {
      if (body.length > config.maxResponseBytes) throw new Error("ARCHIVE_RESPONSE_TOO_LARGE");
      const event: ArchiveEvent = {
        ...base, receivedAt: new Date().toISOString(), httpStatus,
        responseBodyBase64: body.toString("base64"), responseSha256: sha256(body),
        outcome: httpStatus === null ? "transport_error" : "response",
      };
      const temporary = join(config.directory, `${eventId}.writing`);
      await durableWrite(temporary, event);
      await rename(temporary, join(config.directory, `${eventId}.event.json`));
      await syncDirectory(config.directory);
      try { await unlink(marker); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
