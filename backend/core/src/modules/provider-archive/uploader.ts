import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { eventDigest, parseEvent } from "./contract.js";
import { durableWrite, syncDirectory } from "./spool.js";

export type UploadConfig = Readonly<{
  directory: string;
  deploymentId: string;
  centerUrl: string;
  token: string;
  timeoutMs: number;
  batchSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
}>;

export async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await durableWrite(temporary, value);
  await rename(temporary, path);
}

async function remove(path: string): Promise<void> {
  try { await unlink(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function spoolStatus(directory: string) {
  const files = await readdir(directory);
  const events = files.filter((name) => name.endsWith(".event.json"));
  const pending = files.filter((name) => name.endsWith(".pending"));
  const timestamps = await Promise.all([...events, ...pending].map(async (name) => {
    try { return (await stat(join(directory, name))).mtimeMs; } catch { return Date.now(); }
  }));
  return {
    queued: events.length, pendingCapture: pending.length,
    incompleteWrites: files.filter((name) => name.endsWith(".writing")).length,
    oldestAgeMs: timestamps.length ? Math.max(0, Date.now() - Math.min(...timestamps)) : 0,
  };
}

export async function uploadOnce(config: UploadConfig, fetchImplementation = globalThis.fetch) {
  const url = new URL(config.centerUrl);
  if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) {
    throw new Error("ARCHIVE_HTTPS_REQUIRED");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("ARCHIVE_INVALID_URL");
  const names = (await readdir(config.directory)).filter((name) =>
    /^[a-f0-9-]{36}\.event\.json$/u.test(name)).sort();
  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  for (const name of names) {
    if (attempted >= config.batchSize) break;
    const path = join(config.directory, name);
    const retryPath = `${path}.retry.json`;
    let attempts = 0;
    try {
      const retry = JSON.parse(await readFile(retryPath, "utf8")) as { attempts: number; nextAt: number };
      attempts = Number.isSafeInteger(retry.attempts) ? Math.max(0, retry.attempts) : 0;
      if (Number.isFinite(retry.nextAt) && retry.nextAt > Date.now()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Corrupt retry metadata is not a reason to discard a captured event.
        attempts = 0;
      }
    }
    attempted += 1;
    let code = "ARCHIVE_UPLOAD_FAILED";
    try {
      const event = parseEvent(JSON.parse(await readFile(path, "utf8")));
      if (`${event.eventId}.event.json` !== name || event.deploymentId !== config.deploymentId) {
        code = "ARCHIVE_SPOOL_IDENTITY_MISMATCH";
        throw new Error(code);
      }
      const response = await fetchImplementation(`${url.href.replace(/\/$/u, "")}/v1/events`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs),
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      code = `ARCHIVE_HTTP_${response.status}`;
      if (response.status !== 200 && response.status !== 201) throw new Error(code);
      const receipt = await response.json() as Record<string, unknown>;
      if (receipt.eventId !== event.eventId || receipt.deploymentId !== event.deploymentId ||
          receipt.eventDigest !== eventDigest(event) ||
          !["stored", "existing"].includes(String(receipt.status))) {
        code = "ARCHIVE_RECEIPT_MISMATCH";
        throw new Error(code);
      }
      await remove(path);
      await remove(retryPath);
      await remove(join(config.directory, `${event.eventId}.pending`));
      await syncDirectory(config.directory);
      delivered += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failed += 1;
      const delay = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(attempts, 20));
      await replaceJson(retryPath, { attempts: attempts + 1, nextAt: Date.now() + delay, code });
    }
  }
  return { attempted, delivered, failed, ...await spoolStatus(config.directory) };
}
