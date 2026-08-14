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
