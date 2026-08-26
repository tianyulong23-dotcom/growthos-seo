import { describe, expect, it, vi } from "vitest";

import {
  createCommercialQualificationOfficialRuntime,
} from "../../src/modules/backlinks/adapters/dataforseo/commercial-qualification-official-runtime.js";
import {
  commercialQualificationBulkEndpoints,
  type CommercialQualificationBulkCall,
} from "../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";

const baseUrl = "https://api.dataforseo.com";
const credentials = {
  login: "fixture-login",
  password: "fixture-password",
} as const;
const endpointAllowlist = Object.values(
  commercialQualificationBulkEndpoints,
).map((endpoint) => `${baseUrl}${endpoint}`);

function call(
  kind: CommercialQualificationBulkCall["kind"],
): CommercialQualificationBulkCall {
  const endpoint = commercialQualificationBulkEndpoints[kind];
  return {
    kind,
    endpoint,
    targets: ["example.com"],
    body: [{
      targets: ["example.com"],
      ...(kind === "traffic" ? { item_types: ["organic"] } : {}),
      ...(kind === "rank" ? { rank_scale: "one_hundred" } : {}),
    }],
    requestFingerprint: `${kind}-fingerprint`,
  };
}

function response(kind: CommercialQualificationBulkCall["kind"]): Response {
  const item = kind === "traffic"
    ? { target: "example.com", metrics: { organic: { etv: 30_000 } } }
    : kind === "spam"
      ? { target: "example.com", spam_score: 10 }
      : { target: "example.com", rank: 70 };
  return new Response(JSON.stringify({
    version: "0.1.20260816",
    status_code: 20000,
    status_message: "Ok.",
    cost: 0.001,
    tasks: [{
      id: `${kind}-task`,
      status_code: 20000,
      status_message: "Ok.",
      cost: 0.001,
      result: [{ items: [item] }],
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("commercial qualification official DataForSEO runtime", () => {
  it.each([
    ["traffic", commercialQualificationBulkEndpoints.traffic],
    ["spam", commercialQualificationBulkEndpoints.spam],
    ["rank", commercialQualificationBulkEndpoints.rank],
  ] as const)("uses the official %s endpoint once", async (kind, endpoint) => {
    const fetchMock = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(request)).toBe(`${baseUrl}${endpoint}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from(
          "fixture-login:fixture-password",
          "utf8",
        ).toString("base64")}`,
      );
      return response(kind);
    });
    const runtime = createCommercialQualificationOfficialRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.execute(call(kind))).resolves.toMatchObject({
      status: "completed",
      providerRequestId: `${kind}-task`,
      costMicros: 1_000,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns unknown_charge without resending an ambiguous live request", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connection ended after dispatch");
    });
    const runtime = createCommercialQualificationOfficialRuntime({
      credentials,
      endpointAllowlist,
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.execute(call("traffic"))).resolves.toMatchObject({
      status: "unknown_charge",
      providerRequestId: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a non-allowlisted endpoint before dispatch", async () => {
    const fetchMock = vi.fn();
    const runtime = createCommercialQualificationOfficialRuntime({
      credentials,
      endpointAllowlist: [
        commercialQualificationBulkEndpoints.traffic,
      ],
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.execute(call("spam"))).rejects.toMatchObject({
      kind: "invalid_request",
      requestDispatched: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
