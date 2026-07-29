import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  SafeFetchError,
  safeFetchFailureCodes,
  safeFetchFailureRetryability,
  safeFetchFailureSchema,
  safeFetchRequestSchema,
  safeFetchResultSchema,
  type SafeFetchPort,
  type SafeFetchRequest,
  type SafeFetchResult,
} from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const request = {
  url: "https://publisher.example/contact",
  purpose: "contact-enrichment",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  maxBytes: 1_000_000,
  maxRedirects: 3,
} as const;

const result = {
  requestedUrl: request.url,
  finalUrl: "https://www.publisher.example/contact",
  status: 200,
  contentType: "text/html; charset=utf-8",
  body: new Uint8Array([60, 104, 49, 62]),
  redirectChain: ["https://www.publisher.example/contact"],
  resolvedIps: ["8.8.8.8"],
  fetchedAt: "2026-07-23T04:00:00.000Z",
} as const;

describe("BL-AI-065 SafeFetchPort contract", () => {
  it("accepts the owned request and result DTOs", async () => {
    expect(safeFetchRequestSchema.parse(request)).toEqual(request);
    expect(safeFetchResultSchema.parse(result)).toEqual(result);

    const port: SafeFetchPort = {
      fetch: async (received) => {
        expect(received).toEqual(request);
        return result;
      },
    };

    await expect(port.fetch(request)).resolves.toEqual(result);
    expectTypeOf(request).toMatchTypeOf<SafeFetchRequest>();
    expectTypeOf(result).toMatchTypeOf<SafeFetchResult>();
  });

  it("rejects malformed or vendor-shaped boundary values", () => {
    expect(safeFetchRequestSchema.safeParse({
      ...request,
      workspaceId: " ",
    }).success).toBe(false);
    expect(safeFetchRequestSchema.safeParse({
      ...request,
      maxBytes: 0,
    }).success).toBe(false);
    expect(safeFetchRequestSchema.safeParse({
      ...request,
      maxRedirects: -1,
    }).success).toBe(false);
    expect(safeFetchRequestSchema.safeParse({
      ...request,
      dispatcher: "vendor-client",
    }).success).toBe(false);
    expect(safeFetchResultSchema.safeParse({
      ...result,
      status: 99,
    }).success).toBe(false);
    expect(safeFetchResultSchema.safeParse({
      ...result,
      body: "<html>",
    }).success).toBe(false);
    expect(safeFetchResultSchema.safeParse({
      ...result,
      headersTimeout: 5_000,
    }).success).toBe(false);
  });

  it("exposes stable failure classifications and retryability", () => {
    for (const [code, retryable] of Object.entries(
      safeFetchFailureRetryability,
    )) {
      const failure = {
        code,
        requestedUrl: request.url,
        message: `SafeFetch failed with ${code}.`,
        retryable,
      };

      expect(safeFetchFailureSchema.parse(failure)).toEqual(failure);
      expect(new SafeFetchError(failure)).toMatchObject({
        name: "SafeFetchError",
        code,
        requestedUrl: request.url,
        retryable,
      });
    }

    expect(Object.keys(safeFetchFailureRetryability)).toEqual(
      Object.values(safeFetchFailureCodes),
    );
    expect(safeFetchFailureSchema.safeParse({
      code: safeFetchFailureCodes.timeout,
      requestedUrl: request.url,
      message: "Timed out.",
      retryable: false,
    }).success).toBe(false);
    expect(safeFetchFailureSchema.safeParse({
      code: "UND_ERR_CONNECT_TIMEOUT",
      requestedUrl: request.url,
      message: "Vendor error leaked.",
      retryable: true,
    }).success).toBe(false);
  });

  it("does not expose Undici names or types", () => {
    const source = readFileSync(new URL(
      "../../src/modules/backlinks/ports/safe-fetch.port.ts",
      import.meta.url,
    ), "utf8");

    expect(source).not.toMatch(/\bundici\b/i);
    expect(source).not.toMatch(/\bDispatcher\b|\bHeadersTimeoutError\b/);
  });
});
