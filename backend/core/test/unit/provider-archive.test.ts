import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveDataForSeoFetch } from "../../src/modules/provider-archive/capture-fetch.js";
import { beginCapture, captureConfig } from "../../src/modules/provider-archive/spool.js";
import { eventDigest, parseEvent, sha256 } from "../../src/modules/provider-archive/contract.js";
import { createArchiveCenter, parseCredentials } from "../../src/modules/provider-archive/center.js";
import { spoolStatus, uploadOnce } from "../../src/modules/provider-archive/uploader.js";
import { createCommercialOfficialDataForSeoRuntime } from "../../src/modules/backlinks/adapters/dataforseo/commercial-official-runtime.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "growthos-archive-"));
  directories.push(directory);
  const env = {
    PROVIDER_ARCHIVE_ENABLED: "true", PROVIDER_ARCHIVE_DEPLOYMENT_ID: "deployment-a",
    PROVIDER_ARCHIVE_SPOOL_DIR: directory,
  };
  const config = captureConfig(env);
  if (!config) throw new Error("fixture capture disabled");
  const upload = {
    ...config, centerUrl: "http://127.0.0.1:7400", token: "fixture-only",
    timeoutMs: 1000, batchSize: 20, retryBaseMs: 1, retryMaxMs: 10,
  };
  return { directory, env, config, upload };
}
async function events(directory: string) {
  return Promise.all((await readdir(directory)).filter((name) => name.endsWith(".event.json"))
    .map(async (name) => parseEvent(JSON.parse(await readFile(join(directory, name), "utf8")))));
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("provider archive capture and delivery", () => {
  it("captures through the official runtime without changing the provider result", async () => {
    const f = await fixture();
    for (const [key, value] of Object.entries(f.env)) vi.stubEnv(key, value);
    const payload = {
      status_code: 20000, status_message: "Ok.", cost: 0.001,
      tasks: [{ id: "fixture-task", status_code: 20000, cost: 0.001,
        result: [{ items: [{ domain: "publisher.test", rank: 10 }] }] }],
    };
    const send = vi.fn(async () => new Response(JSON.stringify(payload)));
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials: { login: "fixture-login", password: "fixture-password" },
      endpointAllowlist: ["https://api.dataforseo.com/v3/backlinks/referring_domains/live"],
      timeoutMs: 5000, fetchImplementation: send,
    });
    await expect(runtime.execute({
      endpoint: "/v3/backlinks/referring_domains/live", intent: "DISCOVERY",
      sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
      request: { target: "publisher.test", limit: 10 },
      responseSchemaVersion: "fixture.v1", estimatedCostMicros: 1000,
    })).resolves.toMatchObject({ tasks: [{ id: "fixture-task" }] });
    const captured = await events(f.directory);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.component).toBe("backlinks-discovery");
    expect(JSON.stringify(captured)).not.toContain("fixture-password");
    expect(send).toHaveBeenCalledOnce();
  });

  it("is disabled without config; rejects incomplete enabled config before dispatch", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    await archiveDataForSeoFetch(fetch, "fixture", {})("https://api.dataforseo.com/v3/test");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(archiveDataForSeoFetch(fetch, "fixture", {
      PROVIDER_ARCHIVE_ENABLED: "true",
    })("https://api.dataforseo.com/v3/test")).rejects.toThrow("SPOOL");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("captures every HTTP response before parsing, preserving errors and repeated sites", async () => {
    const f = await fixture();
    const fetch = vi.fn(async () => new Response(' {"domain":"same.test", "rank":0} ', { status: 200 }));
    const wrapped = archiveDataForSeoFetch(fetch, "fixture", f.env);
    for (let index = 0; index < 2; index += 1) {
      const response = await wrapped("https://api.dataforseo.com/v3/backlinks/summary/live", {
        method: "POST", body: '[{"target":"same.test"}]', headers: { authorization: "SECRET_SENTINEL" },
      });
      expect(await response.text()).toBe(' {"domain":"same.test", "rank":0} ');
    }
    await archiveDataForSeoFetch(async () => new Response("invalid JSON", { status: 503 }), "fixture", f.env)(
      "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready");
    const captured = await events(f.directory);
    expect(captured).toHaveLength(3);
    expect(new Set(captured.map((event) => event.eventId)).size).toBe(3);
    expect(JSON.stringify(captured)).not.toContain("SECRET_SENTINEL");
    expect(captured.some((event) => event.httpStatus === 503 &&
      Buffer.from(event.responseBodyBase64, "base64").toString() === "invalid JSON")).toBe(true);
    expect((await spoolStatus(f.directory)).pendingCapture).toBe(0);
  });

  it("records transport failures without inventing a provider response", async () => {
    const f = await fixture();
    const error = new Error("connection lost");
    const wrapped = archiveDataForSeoFetch(async () => { throw error; }, "fixture", f.env);
    await expect(wrapped("https://api.dataforseo.com/v3/test")).rejects.toBe(error);
    expect((await events(f.directory))[0]).toMatchObject({
      outcome: "transport_error", httpStatus: null, responseBodyBase64: "",
    });
  });

  it("does not collect account-management responses", async () => {
    const f = await fixture();
    await archiveDataForSeoFetch(async () => new Response('{"balance":123}'), "fixture", f.env)(
      "https://api.dataforseo.com/v3/appendix/user_data");
    expect(await events(f.directory)).toEqual([]);
  });

  it("leaves visible gaps for oversize captures without retrying successful paid calls", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => new Response("too large"));
    const response = await archiveDataForSeoFetch(fetch, "fixture", {
      ...f.env, PROVIDER_ARCHIVE_MAX_RESPONSE_BYTES: "1",
    })("https://api.dataforseo.com/v3/test");
    expect(await response.text()).toBe("too large");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await spoolStatus(f.directory)).pendingCapture).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ARCHIVE_CAPTURE_GAP"));
  });

  it("persists outage retries across uploader restarts and deletes only after a matching receipt", async () => {
    const f = await fixture();
    const capture = await beginCapture(f.config, {
      component: "fixture", endpoint: "/v3/test", method: "GET", requestBody: null,
    });
    await capture.finish(Buffer.from('{"site":"same.test"}'), 200);
    const [event] = await events(f.directory);
    if (!event) throw new Error("fixture event missing");
    expect((await uploadOnce(f.upload, async () => { throw new Error("offline"); })).failed).toBe(1);
    expect(await events(f.directory)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect((await uploadOnce(f.upload, async () => new Response(JSON.stringify({
      eventId: event.eventId, deploymentId: event.deploymentId,
      eventDigest: "wrong", status: "stored",
    })))).failed).toBe(1);
    expect(await events(f.directory)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = await uploadOnce(f.upload, async () => new Response(JSON.stringify({
      eventId: event.eventId, deploymentId: event.deploymentId,
      eventDigest: eventDigest(event), status: "existing",
    })));
    expect(result.delivered).toBe(1);
    expect(await events(f.directory)).toHaveLength(0);
  });

  it("rejects identity changes and plaintext remote centers without uploading", async () => {
    const f = await fixture();
    const capture = await beginCapture(f.config, {
      component: "fixture", endpoint: "/v3/test", method: "GET", requestBody: null,
    });
    await capture.finish(Buffer.from("{}"), 200);
    const send = vi.fn();
    await expect(uploadOnce({ ...f.upload, centerUrl: "http://remote.test" }, send)).rejects.toThrow("HTTPS");
    expect((await uploadOnce({ ...f.upload, deploymentId: "wrong" }, send)).failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("checks integrity, credentials and pagination before any database write", async () => {
    const f = await fixture();
    const capture = await beginCapture(f.config, {
      component: "fixture", endpoint: "/v3/test", method: "GET", requestBody: null,
    });
    await capture.finish(Buffer.from("{}"), 200);
    const [event] = await events(f.directory);
    expect(() => parseEvent({ ...event, responseBodyBase64: "bm8=" })).toThrow();
    expect(() => parseCredentials('[{"role":"upload","tokenSha256":"' + sha256("test") + '"}]')).toThrow();
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const app = createArchiveCenter({ db, credentials: parseCredentials(JSON.stringify([
      { role: "upload", deploymentId: "deployment-a", tokenSha256: sha256("uploader") },
      { role: "admin", tokenSha256: sha256("admin") },
    ])) });
    try {
      expect((await app.inject({ method: "POST", url: "/v1/events", payload: event })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/v1/events",
        headers: { authorization: "Bearer uploader" },
        payload: { ...event, deploymentId: "deployment-b" },
      })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/v1/events",
        headers: { authorization: "Bearer uploader" },
      })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/v1/events?limit=100000",
        headers: { authorization: "Bearer admin" },
      })).statusCode).toBe(400);
      expect(db.query).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("blocks new captures at the configured backlog threshold and retains corrupt files", async () => {
    const f = await fixture();
    await beginCapture(f.config, { component: "fixture", endpoint: "/v3/test", method: "GET", requestBody: null });
    await expect(beginCapture({ ...f.config, maxPending: 1 }, {
      component: "fixture", endpoint: "/v3/test", method: "GET", requestBody: null,
    })).rejects.toThrow("CAPACITY");
    const name = "11111111-1111-4111-8111-111111111111.event.json";
    await writeFile(join(f.directory, name), "{");
    expect((await uploadOnce(f.upload, vi.fn())).failed).toBe(1);
    expect(await readFile(join(f.directory, name), "utf8")).toBe("{");
  });
});
