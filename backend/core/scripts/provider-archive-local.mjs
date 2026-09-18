import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import assert from "node:assert/strict";
import { archiveDataForSeoFetch } from "../dist/modules/provider-archive/capture-fetch.js";
import { eventDigest, sha256 } from "../dist/modules/provider-archive/contract.js";
import { uploadOnce } from "../dist/modules/provider-archive/uploader.js";

const { Pool } = createRequire(import.meta.url)("pg");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = resolve(process.env.PROVIDER_ARCHIVE_LOCAL_DIR ?? join(root, "storage/provider-archive"));
const configPath = join(directory, "local-config.json");
const token = () => randomBytes(32).toString("hex");
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function exclusive(path, value) {
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), {
    flag: "wx", mode: 0o600,
  });
}
function databaseUrl(base, database, user, password) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  url.username = user;
  url.password = password;
  return url.href;
}
async function setup() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const existing = await json(configPath);
    const db = new Pool({ connectionString: existing.PROVIDER_ARCHIVE_DATABASE_URL });
    try { await db.query("SELECT count(*) FROM provider_archive_events"); }
    finally { await db.end(); }
    console.log(JSON.stringify({ status: "EXISTING_DATABASE_READY", configPath }));
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const envPath = process.env.PROVIDER_ARCHIVE_PROJECT_ENV ?? join(root, "deploy/compose/.env");
  const project = parseEnv(await readFile(envPath, "utf8"));
  assert(process.env.PROVIDER_ARCHIVE_LOCAL_ADMIN_URL || project.POSTGRES_PASSWORD,
    "LOCAL_DATABASE_PASSWORD_REQUIRED");
  const port = Number(process.env.PROVIDER_ARCHIVE_PORT ?? 7400);
  assert(Number.isInteger(port) && port > 0 && port <= 65535, "INVALID_PORT");
  const adminUrl = process.env.PROVIDER_ARCHIVE_LOCAL_ADMIN_URL ??
    databaseUrl(`postgresql://127.0.0.1:${project.POSTGRES_PORT ?? 5432}/postgres`,
      "postgres", project.POSTGRES_USER ?? "postgres", project.POSTGRES_PASSWORD);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(adminUrl).hostname),
    "LOCAL_BOOTSTRAP_REQUIRES_LOOPBACK_DATABASE");
  const database = process.env.PROVIDER_ARCHIVE_LOCAL_DATABASE ?? "growthos_provider_archive";
  assert(/^[a-z][a-z0-9_]{0,50}$/.test(database), "INVALID_DATABASE_NAME");
  const role = `${database}_app`;
  const admin = new Pool({ connectionString: adminUrl });
  try {
    const occupied = await admin.query(
      "SELECT datname FROM pg_database WHERE datname=$1 UNION ALL SELECT rolname FROM pg_roles WHERE rolname=$2",
      [database, role]);
    assert.equal(occupied.rows.length, 0, "REFUSE_ADOPT_EXISTING_DATABASE_OR_ROLE_WITHOUT_CONFIG");
    const password = token();
    // Identifiers are strictly validated; generated passwords contain hex only.
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${database}`;
    const owner = new Pool({ connectionString: ownerUrl.href });
    try {
      await owner.query(await readFile(new URL("../src/modules/provider-archive/schema.sql", import.meta.url), "utf8"));
      await owner.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await owner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await owner.query(`GRANT SELECT, INSERT ON provider_archive_events TO "${role}"`);
      await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    } finally { await owner.end(); }
    const deploymentId = `local-${randomUUID()}`;
    const fixtureId = `fixture-${randomUUID()}`;
    const uploadToken = token();
    const readToken = token();
    const fixtureToken = token();
    const credentials = join(directory, "credentials.json");
    const uploadFile = join(directory, "upload-token.secret");
    const adminFile = join(directory, "admin-token.secret");
    const fixtureFile = join(directory, "fixture-token.secret");
    await exclusive(credentials, [
      { role: "upload", deploymentId, tokenSha256: sha256(uploadToken) },
      { role: "upload", deploymentId: fixtureId, tokenSha256: sha256(fixtureToken) },
      { role: "admin", tokenSha256: sha256(readToken) },
    ]);
    await exclusive(uploadFile, uploadToken);
    await exclusive(adminFile, readToken);
    await exclusive(fixtureFile, fixtureToken);
    const spool = join(directory, "spool");
    await mkdir(spool, { recursive: true, mode: 0o700 });
    await exclusive(configPath, {
      PROVIDER_ARCHIVE_ENABLED: "true",
      PROVIDER_ARCHIVE_DEPLOYMENT_ID: deploymentId,
      PROVIDER_ARCHIVE_SPOOL_DIR: spool,
      PROVIDER_ARCHIVE_CENTER_URL: `http://127.0.0.1:${port}`,
      PROVIDER_ARCHIVE_UPLOAD_TOKEN_FILE: uploadFile,
      PROVIDER_ARCHIVE_DATABASE_URL: databaseUrl(adminUrl, database, role, password),
      PROVIDER_ARCHIVE_CREDENTIALS_FILE: credentials,
      PROVIDER_ARCHIVE_HOST: "127.0.0.1",
      PROVIDER_ARCHIVE_PORT: String(port),
    });
    await exclusive(join(directory, "fixture-config.json"), {
      deploymentId: fixtureId, tokenFile: fixtureFile, adminFile,
    });
    console.log(JSON.stringify({ status: "DATABASE_CREATED", database, role, configPath }));
  } finally { await admin.end(); }
}

async function verify() {
  const config = await json(configPath);
  const fixture = await json(join(directory, "fixture-config.json"));
  const runId = randomUUID();
  const spool = join(directory, "verification", runId);
  await mkdir(spool, { recursive: true, mode: 0o700 });
  const env = { ...config, PROVIDER_ARCHIVE_DEPLOYMENT_ID: fixture.deploymentId,
    PROVIDER_ARCHIVE_SPOOL_DIR: spool };
  let calls = 0;
  const captured = archiveDataForSeoFetch(async () => new Response(JSON.stringify({
    fixture: true, runId, domain: "archive-verification.test", rank: ++calls * 10,
  })), "local-acceptance-fixture", env);
  for (let i = 0; i < 2; i++) {
    await captured("https://api.dataforseo.com/v3/backlinks/summary/live", {
      method: "POST", body: JSON.stringify([{ target: "archive-verification.test" }]),
    });
  }
  const upload = {
    directory: spool, deploymentId: fixture.deploymentId,
    centerUrl: config.PROVIDER_ARCHIVE_CENTER_URL,
    token: (await readFile(fixture.tokenFile, "utf8")).trim(),
    timeoutMs: 5000, batchSize: 20, retryBaseMs: 1, retryMaxMs: 1,
  };
  const outage = await uploadOnce(upload, async () => { throw new Error("fixture offline"); });
  assert.equal(outage.queued, 2);
  await new Promise((r) => setTimeout(r, 10));
  const lost = await uploadOnce(upload, async (...args) => {
    const response = await fetch(...args);
    assert(response.ok);
    throw new Error("fixture acknowledgement lost after commit");
  });
  assert.equal(lost.queued, 2);
  await new Promise((r) => setTimeout(r, 10));
  const recovered = await uploadOnce(upload);
  assert.equal(recovered.delivered, 2);
  assert.equal(recovered.queued, 0);
  const db = new Pool({ connectionString: config.PROVIDER_ARCHIVE_DATABASE_URL });
  let records;
  try {
    const result = await db.query(`SELECT event_payload FROM provider_archive_events
      WHERE deployment_id=$1 AND event_payload->>'component'='local-acceptance-fixture'`,
    [fixture.deploymentId]);
    records = result.rows.map((row) => row.event_payload).filter((event) =>
      JSON.parse(Buffer.from(event.responseBodyBase64, "base64").toString()).runId === runId);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((e) => JSON.parse(Buffer.from(e.responseBodyBase64, "base64").toString()).rank).sort((a,b) => a-b), [10,20]);
    await assert.rejects(db.query("DELETE FROM provider_archive_events WHERE false"), /permission denied/);
    await assert.rejects(db.query("CREATE TABLE public.archive_permission_probe(id int)"), /permission denied/);
  } finally { await db.end(); }
  const headers = { authorization: `Bearer ${(await readFile(fixture.adminFile, "utf8")).trim()}` };
  for (const event of records) {
    const response = await fetch(`${upload.centerUrl}/v1/events/${fixture.deploymentId}/${event.eventId}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(eventDigest((await response.json()).event), eventDigest(event));
  }
  const denied = await fetch(`${upload.centerUrl}/v1/events`, {
    headers: { authorization: `Bearer ${upload.token}` },
  });
  assert.equal(denied.status, 401);
  // This event uses the configured deployment spool and must be delivered by
  // the independently running uploader, not by this verification process.
  const daemonCapture = archiveDataForSeoFetch(async () => new Response(JSON.stringify({
    fixture: true, runId, domain: "archive-daemon-verification.test",
  })), "local-acceptance-fixture", config);
  await daemonCapture("https://api.dataforseo.com/v3/backlinks/summary/live", {
    method: "POST", body: JSON.stringify([{ target: "archive-daemon-verification.test" }]),
  });
  const daemonDb = new Pool({ connectionString: config.PROVIDER_ARCHIVE_DATABASE_URL });
  let daemonEvent;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await daemonDb.query(`SELECT event_payload FROM provider_archive_events
        WHERE deployment_id=$1 AND event_payload->>'component'='local-acceptance-fixture'`,
      [config.PROVIDER_ARCHIVE_DEPLOYMENT_ID]);
      daemonEvent = rows.rows.map((row) => row.event_payload).find((event) =>
        JSON.parse(Buffer.from(event.responseBodyBase64, "base64").toString()).runId === runId);
      if (daemonEvent) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(daemonEvent, "BACKGROUND_UPLOADER_DID_NOT_DELIVER");
  } finally { await daemonDb.end(); }
  const evidence = { status: "PASS", runId, stored: 3, realProviderCalls: 0,
    centerUrl: upload.centerUrl, verifiedAt: new Date().toISOString(),
    checks: ["persistent-history", "repeated-site-distinct-events", "outage-retention",
      "lost-receipt-idempotency", "raw-body-roundtrip", "restricted-db-role", "admin-read-boundary",
      "background-uploader-delivery"],
    eventIds: [...records.map((e) => e.eventId), daemonEvent.eventId] };
  await exclusive(join(spool, "result.json"), evidence);
  await writeFile(join(directory, "latest-verification.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}

async function inspectStored() {
  const config = await json(configPath);
  const db = new Pool({ connectionString: config.PROVIDER_ARCHIVE_DATABASE_URL });
  try {
    const counts = await db.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE event_payload->>'component'='local-acceptance-fixture')::int AS fixtures
      FROM provider_archive_events`);
    let retained = null;
    try {
      const previous = await json(join(directory, "latest-verification.json"));
      const stored = await db.query(
        "SELECT count(*)::int AS count FROM provider_archive_events WHERE event_id=ANY($1::uuid[])",
        [previous.eventIds]);
      assert.equal(stored.rows[0].count, previous.eventIds.length, "PREVIOUS_VERIFICATION_HISTORY_MISSING");
      retained = stored.rows[0].count;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    console.log(JSON.stringify({ database: new URL(config.PROVIDER_ARCHIVE_DATABASE_URL).pathname.slice(1),
      ...counts.rows[0], previousVerificationRetained: retained }));
  } finally { await db.end(); }
}

const mode = process.argv[2];
try {
  if (mode === "setup") await setup();
  else if (mode === "verify") await verify();
  else if (["serve", "upload", "status"].includes(mode)) {
    if (mode === "status") await inspectStored();
    Object.assign(process.env, await json(configPath));
    process.argv[2] = mode;
    await import("../dist/modules/provider-archive/cli.js");
  } else throw new Error("UNKNOWN_LOCAL_ARCHIVE_COMMAND");
} catch (error) {
  // Do not print database connection strings, credentials or response payloads.
  console.error(JSON.stringify({ status: "FAILED", code: error.code ?? error.name }));
  process.exitCode = 1;
}
