import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createArchiveCenter, parseCredentials, type ArchiveDatabase } from "../../../src/modules/provider-archive/center.js";
import { archiveDataForSeoFetch } from "../../../src/modules/provider-archive/capture-fetch.js";
import { sha256 } from "../../../src/modules/provider-archive/contract.js";
import { uploadOnce } from "../../../src/modules/provider-archive/uploader.js";
import { startBacklinksPostgresHarness, type BacklinksPostgresHarness } from "./harness/postgresql-container.js";

let harness: BacklinksPostgresHarness;
let db: ArchiveDatabase & { end(): Promise<void> };
let app: ReturnType<typeof createArchiveCenter>;
const directories: string[] = [];
let centerUrl: string;
function center() {
  return createArchiveCenter({ db, credentials: parseCredentials(JSON.stringify([
    { role: "upload", deploymentId: "a", tokenSha256: sha256("token-a") },
    { role: "upload", deploymentId: "b", tokenSha256: sha256("token-b") },
    { role: "admin", tokenSha256: sha256("admin") },
  ])) });
}
beforeAll(async () => {
  harness = await startBacklinksPostgresHarness();
  const { Pool } = createRequire(import.meta.url)("pg");
  db = new Pool({ connectionString: harness.connectionString });
  await db.query(await readFile(new URL(
    "../../../src/modules/provider-archive/schema.sql", import.meta.url), "utf8"));
  app = center();
  centerUrl = await app.listen({ host: "127.0.0.1", port: 0 });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await harness?.stop();
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

it("merges two deployments, retains repeated site history, survives lost receipts and rejects mutation", async () => {
  let firstEvent: Record<string, unknown> | undefined;
  for (const deploymentId of ["a", "b"]) {
    const directory = await mkdtemp(join(tmpdir(), "archive-integration-"));
    directories.push(directory);
    const capture = archiveDataForSeoFetch(async () => new Response(
      JSON.stringify({ tasks: [{ result: [{ domain: "same.test", rank: deploymentId === "a" ? 10 : 20 }] }] }),
    ), "fixture", {
      PROVIDER_ARCHIVE_ENABLED: "true", PROVIDER_ARCHIVE_SPOOL_DIR: directory,
      PROVIDER_ARCHIVE_DEPLOYMENT_ID: deploymentId,
    });
    await capture("https://api.dataforseo.com/v3/backlinks/summary/live", {
      method: "POST", body: '[{"target":"same.test"}]',
    });
    await capture("https://api.dataforseo.com/v3/backlinks/summary/live", {
      method: "POST", body: '[{"target":"same.test"}]',
    });
    const eventName = (await readdir(directory)).find((name) => name.endsWith(".event.json"));
    if (!eventName) throw new Error("fixture event missing");
    firstEvent ??= JSON.parse(await readFile(join(directory, eventName), "utf8"));
    const config = { directory, deploymentId, centerUrl, token: `token-${deploymentId}`,
      timeoutMs: 5000, batchSize: 20, retryBaseMs: 1, retryMaxMs: 5 };
    const lostReceipt = await uploadOnce(config, async (...args) => {
      await fetch(...args);
      throw new Error("receipt lost");
    });
    expect(lostReceipt.failed).toBe(2);
    await app.close();
    app = center();
    centerUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await uploadOnce({ ...config, centerUrl })).delivered).toBe(2);
  }
  const result = await app.inject({
    method: "GET", url: "/v1/events?limit=2", headers: { authorization: "Bearer admin" },
  });
  expect(result.statusCode).toBe(200);
  const page = result.json();
  expect(page.events).toHaveLength(2);
  expect(page.events[0].event.responseBodyBase64).toBeUndefined();
  const next = await app.inject({
    method: "GET", url: `/v1/events?after=${page.nextCursor}&limit=2`,
    headers: { authorization: "Bearer admin" },
  });
  expect(next.json().events).toHaveLength(2);
  expect((await db.query("SELECT count(*)::int AS count FROM provider_archive_events")).rows[0]?.count).toBe(4);
  const conflict = await app.inject({
    method: "POST", url: "/v1/events", headers: { authorization: "Bearer token-a" },
    payload: { ...firstEvent, component: "altered" },
  });
  expect(conflict.statusCode).toBe(409);
  if (!firstEvent) throw new Error("fixture event missing");
  const detail = await app.inject({
    method: "GET", url: `/v1/events/a/${firstEvent.eventId}`,
    headers: { authorization: "Bearer admin" },
  });
  expect(detail.json().event.responseBodyBase64).toBe(firstEvent.responseBodyBase64);
  await expect(db.query("UPDATE provider_archive_events SET endpoint='/v3/changed'")).rejects.toThrow("IMMUTABLE");
  await expect(db.query("DELETE FROM provider_archive_events")).rejects.toThrow("IMMUTABLE");
  await expect(db.query("TRUNCATE provider_archive_events")).rejects.toThrow("IMMUTABLE");
}, 30_000);

it.runIf(process.env.ARCHIVE_TEST_PYTHON)("accepts Python spool records through the Node uploader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "archive-python-integration-"));
  directories.push(directory);
  const python = process.env.ARCHIVE_TEST_PYTHON;
  if (!python) throw new Error("fixture Python path missing");
  execFileSync(python, ["-c", [
    "from growthos_provider_archive import begin_capture",
    "c = begin_capture('python-fixture', 'https://api.dataforseo.com/v3/test', 'GET')",
    "c.finish(b'{\"domain\":\"python.test\"}', 200)",
  ].join("\n")], {
    env: {
      ...process.env,
      PYTHONPATH: fileURLToPath(new URL("../../../../provider_archive", import.meta.url)),
      PROVIDER_ARCHIVE_ENABLED: "true", PROVIDER_ARCHIVE_DEPLOYMENT_ID: "b",
      PROVIDER_ARCHIVE_SPOOL_DIR: directory,
    },
  });
  expect((await uploadOnce({
    directory, deploymentId: "b", centerUrl, token: "token-b",
    timeoutMs: 5000, batchSize: 20, retryBaseMs: 1, retryMaxMs: 5,
  })).delivered).toBe(1);
  const rows = (await db.query(`
    SELECT event_payload FROM provider_archive_events
    WHERE event_payload->>'component'='python-fixture'
  `)).rows;
  expect(rows).toHaveLength(1);
});

it.runIf(process.env.ARCHIVE_TEST_COMPILED_CLI)("runs the compiled migration entry without changing history", async () => {
  const before = (await db.query("SELECT count(*)::int AS count FROM provider_archive_events")).rows[0]?.count;
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL("../../../dist/modules/provider-archive/cli.js", import.meta.url)),
    "migrate",
  ], {
    env: { ...process.env, PROVIDER_ARCHIVE_DATABASE_URL: harness.connectionString },
    encoding: "utf8",
  });
  expect(output).toContain("ARCHIVE_SCHEMA_READY");
  expect((await db.query("SELECT count(*)::int AS count FROM provider_archive_events")).rows[0]?.count).toBe(before);
});
