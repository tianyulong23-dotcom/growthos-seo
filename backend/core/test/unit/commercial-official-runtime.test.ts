import { describe, expect, it, vi } from "vitest";

import {
  createCommercialOfficialDataForSeoRuntime,
} from "../../src/modules/backlinks/adapters/dataforseo/commercial-official-runtime.js";

const baseUrl = "https://api.dataforseo.com";
const credentials = {
  login: "fixture-login",
  password: "fixture-password",
} as const;
const endpointAllowlist = [
  `${baseUrl}/v3/serp/google/organic/task_post`,
  `${baseUrl}/v3/serp/id_list`,
  `${baseUrl}/v3/serp/google/organic/tasks_ready`,
  `${baseUrl}/v3/serp/google/organic/task_get/advanced`,
  `${baseUrl}/v3/dataforseo_labs/google/competitors_domain/live`,
  `${baseUrl}/v3/backlinks/competitors/live`,
  `${baseUrl}/v3/backlinks/referring_domains/live`,
] as const;

function response(tasks: readonly Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({
    version: "0.1.20260806",
    status_code: 20000,
    status_message: "Ok.",
    time: "0.01 sec.",
    cost: 0,
    tasks_count: tasks.length,
    tasks_error: 0,
    tasks,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function expectAuthentication(init?: RequestInit): void {
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Basic ${Buffer.from(
      "fixture-login:fixture-password",
      "utf8",
    ).toString("base64")}`,
  );
}

const semanticRecoveryCall = {
  endpoint: "/v3/serp/google/organic/task_post",
  intent: "DISCOVERY",
  sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
  request: {
    keyword: "regional streaming industry publications",
    location_code: 2710,
    language_code: "en",
    depth: 10,
    device: "desktop",
    os: "windows",
  },
  responseSchemaVersion: "fixture.serp.v1",
  estimatedCostMicros: 25_000,
  plannerLineage: {
    blueprintId: "88888888-8888-4888-8888-888888888888",
    queryId:
      "6ab6496c85b0ed689bef3ec5de29e27ecb2b28fc25a39018dfc56f6578e0326d",
  },
} as const;

describe("commercial official DataForSEO runtime", () => {
  it("uses the allowlisted official backlinks endpoint with Basic auth", async () => {
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(request)).toBe(
        `${baseUrl}/v3/backlinks/referring_domains/live`,
      );
      expectAuthentication(init);
      expect(JSON.parse(String(init?.body))).toEqual([{
        target: "publisher.example",
        include_subdomains: true,
        exclude_internal_backlinks: true,
        limit: 100,
      }]);
      return response([{
        id: "backlinks-task-1",
        status_code: 20000,
        status_message: "Ok.",
        cost: 0.001,
        result: [{
          items: [{
            domain: "news.example",
            rank: 71,
            backlinks: 12,
          }],
        }],
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.execute({
      endpoint: "/v3/backlinks/referring_domains/live",
      intent: "DISCOVERY",
      sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
      request: {
        target: "publisher.example",
        include_subdomains: true,
        exclude_internal_backlinks: true,
        limit: 100,
      },
      responseSchemaVersion: "fixture.backlinks.v1",
      estimatedCostMicros: 1_000,
    })).resolves.toMatchObject({
      tasks: [{ id: "backlinks-task-1" }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("posts and polls the official SERP standard queue before task_get", async () => {
    const seenUrls: string[] = [];
    const onProviderTaskAccepted = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(request);
      seenUrls.push(url);
      expectAuthentication(init);
      if (url.endsWith("/task_post")) {
        const posted = JSON.parse(String(init?.body)) as readonly Readonly<{
          tag?: string;
        }>[];
        expect(posted[0]?.tag).toMatch(/^growthos:[0-9a-f]{64}$/u);
        return response([{
          id: "serp-task-1",
          status_code: 20100,
          status_message: "Task Created.",
          cost: 0.001,
          result: null,
        }]);
      }
      if (url.endsWith("/tasks_ready")) {
        return response([{
          id: "ready-list-1",
          status_code: 20000,
          status_message: "Ok.",
          cost: 0,
          result: [{ id: "serp-task-1" }],
        }]);
      }
      expect(url).toBe(
        `${baseUrl}/v3/serp/google/organic/task_get/advanced/serp-task-1`,
      );
      return response([{
        id: "serp-task-1",
        status_code: 20000,
        status_message: "Ok.",
        cost: 0,
        result: [{
          items: [{
            type: "organic",
            domain: "editorial.example",
            rank_absolute: 1,
          }],
        }],
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
      sleep: async () => undefined,
      pollAttempts: 2,
      pollIntervalMs: 0,
    });

    await expect(runtime.execute(
      {
        endpoint: "/v3/serp/google/organic/task_post",
        intent: "DISCOVERY",
        sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
        request: {
          keyword: "streaming editorial resources",
          location_code: 2840,
          language_code: "en",
          depth: 10,
          device: "desktop",
          os: "windows",
        },
        responseSchemaVersion: "fixture.serp.v1",
        estimatedCostMicros: 1_000,
      },
      { onProviderTaskAccepted },
    )).resolves.toMatchObject({
      tasks: [{ id: "serp-task-1" }],
    });
    expect(onProviderTaskAccepted).toHaveBeenCalledWith("serp-task-1");
    expect(seenUrls).toEqual([
      `${baseUrl}/v3/serp/google/organic/task_post`,
      `${baseUrl}/v3/serp/google/organic/tasks_ready`,
      `${baseUrl}/v3/serp/google/organic/task_get/advanced/serp-task-1`,
    ]);
  });

  it("keeps polling beyond the previous 300-attempt limit", async () => {
    let readyPolls = 0;
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(request);
      expectAuthentication(init);
      if (url.endsWith("/task_post")) {
        return response([{
          id: "serp-task-long-running",
          status_code: 20100,
          status_message: "Task Created.",
          cost: 0.001,
          result: null,
        }]);
      }
      if (url.endsWith("/tasks_ready")) {
        readyPolls += 1;
        return response([{
          id: "ready-list-long-running",
          status_code: 20000,
          status_message: "Ok.",
          cost: 0,
          result: readyPolls >= 320
            ? [{ id: "serp-task-long-running" }]
            : [],
        }]);
      }
      expect(url).toBe(
        `${baseUrl}/v3/serp/google/organic/task_get/advanced/serp-task-long-running`,
      );
      return response([{
        id: "serp-task-long-running",
        status_code: 20000,
        status_message: "Ok.",
        cost: 0,
        result: [{ items: [] }],
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
      sleep: async () => undefined,
    });

    await expect(runtime.execute({
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: "home cinema",
        location_code: 2840,
        language_code: "en",
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "fixture.serp.v1",
      estimatedCostMicros: 1_000,
    })).resolves.toMatchObject({
      tasks: [{ id: "serp-task-long-running" }],
    });
    expect(readyPolls).toBe(320);
  });

  it("recovers the same accepted task after explicit not-ready responses", async () => {
    const seenUrls: string[] = [];
    const delays: number[] = [];
    let poll = 0;
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(request);
      seenUrls.push(url);
      expectAuthentication(init);
      poll += 1;
      if (poll < 3) {
        return response([{
          id: "accepted-task-pending",
          status_code: poll === 1 ? 40602 : 40601,
          status_message: poll === 1 ? "Task In Queue." : "Task Handed.",
          cost: 0,
          result: null,
        }]);
      }
      return response([{
        id: "accepted-task-pending",
        status_code: 20000,
        status_message: "Ok.",
        cost: 0.025,
        result: [{ items: [{ domain: "regional-publisher.example" }] }],
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      pollAttempts: 4,
      pollIntervalMs: 100,
      maximumPollIntervalMs: 1_000,
    });
    if (runtime.recoverAcceptedTask === undefined) {
      throw new Error("Accepted task recovery is unavailable");
    }

    await expect(runtime.recoverAcceptedTask(
      semanticRecoveryCall,
      "accepted-task-pending",
    )).resolves.toMatchObject({
      tasks: [{
        id: "accepted-task-pending",
        status_code: 20000,
      }],
    });
    expect(delays).toEqual([100, 200]);
    expect(seenUrls).toEqual(Array(3).fill(
      `${baseUrl}/v3/serp/google/organic/task_get/advanced/accepted-task-pending`,
    ));
    expect(seenUrls.some((url) => url.endsWith("/task_post"))).toBe(false);
    expect(semanticRecoveryCall.plannerLineage).toEqual({
      blueprintId: "88888888-8888-4888-8888-888888888888",
      queryId:
        "6ab6496c85b0ed689bef3ec5de29e27ecb2b28fc25a39018dfc56f6578e0326d",
    });
  });

  it("times out a persistently not-ready accepted task without reposting", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenUrls.push(String(request));
      expectAuthentication(init);
      return response([{
        id: "accepted-task-timeout",
        status_code: 40602,
        status_message: "Task In Queue.",
        cost: 0,
        result: null,
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
      sleep: async () => undefined,
      pollAttempts: 3,
      pollIntervalMs: 0,
    });
    if (runtime.recoverAcceptedTask === undefined) {
      throw new Error("Accepted task recovery is unavailable");
    }

    await expect(runtime.recoverAcceptedTask(
      semanticRecoveryCall,
      "accepted-task-timeout",
    )).rejects.toMatchObject({
      code: "DATAFORSEO_RESULT_UNKNOWN",
      providerRequestStatus: "unknown_charge",
      reconciliationRequired: true,
      cause: { kind: "timeout" },
    });
    expect(seenUrls).toHaveLength(3);
    expect(seenUrls.every((url) =>
      url.endsWith("/task_get/advanced/accepted-task-timeout")
    )).toBe(true);
    expect(seenUrls.some((url) => url.endsWith("/task_post"))).toBe(false);
  });

  it("retries a transient accepted-task transport failure without reposting", async () => {
    const delays: number[] = [];
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", {
        cause: new Error("TLS connection reset"),
      }))
      .mockResolvedValueOnce(response([{
        id: "accepted-task-transient-network",
        status_code: 20000,
        status_message: "Ok.",
        cost: 0.0006,
        result: [{ items: [{ domain: "regional-publisher.example" }] }],
      }]));
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      pollAttempts: 3,
      pollIntervalMs: 100,
      maximumPollIntervalMs: 1_000,
    });
    if (runtime.recoverAcceptedTask === undefined) {
      throw new Error("Accepted task recovery is unavailable");
    }

    await expect(runtime.recoverAcceptedTask(
      semanticRecoveryCall,
      "accepted-task-transient-network",
    )).resolves.toMatchObject({
      tasks: [{
        id: "accepted-task-transient-network",
        status_code: 20000,
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100]);
    expect(fetchMock.mock.calls.every(([request]) =>
      String(request).endsWith(
        "/task_get/advanced/accepted-task-transient-network",
      )
    )).toBe(true);
  });

  it("fails closed after bounded accepted-task transport retries", async () => {
    const delays: number[] = [];
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("TLS connection reset"),
      });
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      pollAttempts: 3,
      pollIntervalMs: 100,
      maximumPollIntervalMs: 1_000,
    });
    if (runtime.recoverAcceptedTask === undefined) {
      throw new Error("Accepted task recovery is unavailable");
    }

    await expect(runtime.recoverAcceptedTask(
      semanticRecoveryCall,
      "accepted-task-persistent-network",
    )).rejects.toMatchObject({
      code: "DATAFORSEO_RESULT_UNKNOWN",
      providerRequestStatus: "unknown_charge",
      reconciliationRequired: true,
      cause: { kind: "network", statusCode: undefined },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
  });

  it("fails closed on a truly malformed accepted-task response", async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      seenUrls.push(String(request));
      expectAuthentication(init);
      return response([]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
      sleep: async () => undefined,
      pollAttempts: 3,
      pollIntervalMs: 0,
    });
    if (runtime.recoverAcceptedTask === undefined) {
      throw new Error("Accepted task recovery is unavailable");
    }

    await expect(runtime.recoverAcceptedTask(
      semanticRecoveryCall,
      "accepted-task-malformed",
    )).rejects.toMatchObject({
      code: "DATAFORSEO_RESULT_UNKNOWN",
      providerRequestStatus: "unknown_charge",
      reconciliationRequired: true,
      cause: { kind: "malformed_response" },
    });
    expect(seenUrls).toEqual([
      `${baseUrl}/v3/serp/google/organic/task_get/advanced/accepted-task-malformed`,
    ]);
    expect(seenUrls.some((url) => url.endsWith("/task_post"))).toBe(false);
  });

  it("classifies a pre-response fetch TypeError as a network failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("TLS connection reset"),
      });
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.execute(semanticRecoveryCall)).rejects.toMatchObject({
      code: "DATAFORSEO_RESULT_UNKNOWN",
      providerRequestStatus: "unknown_charge",
      reconciliationRequired: true,
      cause: { kind: "network", statusCode: undefined },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reconciles one matching SERP task from the official task list", async () => {
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(request)).toBe(`${baseUrl}/v3/serp/id_list`);
      expectAuthentication(init);
      const body = JSON.parse(String(init?.body)) as readonly Readonly<{
        include_metadata?: boolean;
      }>[];
      expect(body[0]?.include_metadata).toBe(true);
      return response([{
        id: "task-list-request",
        status_code: 20000,
        status_message: "Ok.",
        cost: 0,
        result: [{
          id: "serp-task-reconciled",
          url: `${baseUrl}/v3/serp/google/organic/task_post`,
          metadata: semanticRecoveryCall.request,
        }],
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.reconcileDispatchedTask?.(
      semanticRecoveryCall,
      {
        dispatchedAt: new Date("2026-08-25T09:00:00.000Z"),
        reconciledAt: new Date("2026-08-25T09:05:00.000Z"),
      },
    )).resolves.toEqual({
      status: "accepted",
      providerTaskId: "serp-task-reconciled",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("confirms an old unmatched SERP dispatch was not created", async () => {
    const fetchMock = vi.fn(async () => response([{
      id: "task-list-request",
      status_code: 20000,
      status_message: "Ok.",
      cost: 0,
      result: [],
    }]));
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.reconcileDispatchedTask?.(
      semanticRecoveryCall,
      {
        dispatchedAt: new Date("2026-08-25T09:00:00.000Z"),
        reconciledAt: new Date("2026-08-25T09:05:00.000Z"),
      },
    )).resolves.toEqual({ status: "not_found" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails a rejected SERP task without marking the charge unknown", async () => {
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(request)).toBe(
        `${baseUrl}/v3/serp/google/organic/task_post`,
      );
      expectAuthentication(init);
      return response([{
        id: "serp-task-rejected",
        status_code: 40501,
        status_message: "Invalid Field.",
        cost: 0,
        result: null,
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.execute({
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: "streaming editorial resources",
        location_code: 2840,
        language_code: "en",
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "fixture.serp.v1",
      estimatedCostMicros: 1_000,
    })).rejects.toMatchObject({
      code: "DATAFORSEO_INVALID_REQUEST",
      providerRequestStatus: "failed",
      reconciliationRequired: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the official Labs competitor endpoint only when allowlisted", async () => {
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(request)).toBe(
        `${baseUrl}/v3/dataforseo_labs/google/competitors_domain/live`,
      );
      expectAuthentication(init);
      return response([{
        id: "labs-task-1",
        status_code: 20000,
        status_message: "Ok.",
        cost: 0.001,
        result: [{
          items: [{ domain: "observed-competitor.example" }],
        }],
      }]);
    });
    const runtime = createCommercialOfficialDataForSeoRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.execute({
      endpoint: "/v3/dataforseo_labs/google/competitors_domain/live",
      intent: "DISCOVERY",
      sourceType: "VERIFIED_COMPETITOR_BACKLINK_GAP",
      request: {
        target: "elephtv.com",
        location_code: 2840,
        language_code: "en",
      },
      responseSchemaVersion: "fixture.labs.v1",
      estimatedCostMicros: 1_000,
    })).resolves.toMatchObject({
      tasks: [{ id: "labs-task-1" }],
    });
  });
});
