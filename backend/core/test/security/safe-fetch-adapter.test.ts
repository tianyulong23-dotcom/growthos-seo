import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const httpsRequest = vi.hoisted(() => vi.fn());
vi.mock("node:https", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:https")>(),
  request: httpsRequest,
}));

import {
  nodeHttpTransport, SafeFetchAdapter, type SafeHttpResponse, type SafeHttpTransport,
} from "../../src/modules/backlinks/adapters/http/safe-fetch.adapter.js";
import type { HostnameResolver } from "../../src/modules/backlinks/adapters/http/network-policy.js";
import { enforceUrlPolicy } from "../../src/modules/backlinks/adapters/http/url-policy.js";
import { safeFetchFailureCodes } from "../../src/modules/backlinks/ports/safe-fetch.port.js";
const request = {
  url: "https://example.com/start", purpose: "contact-enrichment",
  workspaceId: "workspace-1", websiteProjectId: "project-1",
  maxBytes: 5, maxRedirects: 2,
} as const;
const resolver: HostnameResolver = async () => [{ address: "8.8.8.8", family: 4 }];
function reply(values: Partial<SafeHttpResponse> & {
  chunks?: readonly number[][];
} = {}): SafeHttpResponse {
  const chunks = values.chunks ?? [[60, 104, 49, 62]];
  return {
    status: values.status ?? 200,
    contentType: "contentType" in values ? values.contentType : "text/html",
    contentLength: values.contentLength, location: values.location,
    body: (async function* () {
      for (const chunk of chunks) yield Uint8Array.from(chunk);
    })(),
    close: vi.fn(),
  };
}
const adapter = (transport: SafeHttpTransport, timeoutMs = 50) =>
  new SafeFetchAdapter({
    timeoutMs, transport, resolver, clock: () => "2026-07-23T06:00:00.000Z",
  });
describe("BL-AI-068 SafeFetch adapter", () => {
  it("keeps pinned-IP requests off Node's environment proxy agent", async () => {
    httpsRequest.mockImplementationOnce((options, receive) => {
      const response = Readable.from([]);
      Object.assign(response, {
        statusCode: 200,
        headers: { "content-type": "text/html" },
        destroy: vi.fn(),
      });
      queueMicrotask(() => receive(response));
      return Object.assign(new EventEmitter(), { end: vi.fn() });
    });

    await nodeHttpTransport({
      url: enforceUrlPolicy("https://example.com/start"),
      address: { address: "8.8.8.8", family: 4 },
      signal: new AbortController().signal,
    });

    expect(httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: false,
        hostname: "8.8.8.8",
        servername: "example.com",
      }),
      expect.any(Function),
    );
  });

  it("pins an approved IP and revalidates a redirect", async () => {
    const transport = vi.fn<SafeHttpTransport>()
      .mockResolvedValueOnce(reply({ status: 302, location: "/final" }))
      .mockResolvedValueOnce(reply({ chunks: [[60, 104], [49, 62]] }));
    const result = await adapter(transport).fetch(request);
    expect(result).toMatchObject({
      finalUrl: "https://example.com/final",
      redirectChain: ["https://example.com/final"],
      resolvedIps: ["8.8.8.8", "8.8.8.8"],
    });
    expect([...result.body]).toEqual([60, 104, 49, 62]);
    expect(transport.mock.calls[1]?.[0]).toMatchObject({
      address: { address: "8.8.8.8" },
      url: { normalizedUrl: "https://example.com/final" },
    });
  });
  it("tries each approved address after a transport failure", async () => {
    const multiAddressResolver: HostnameResolver = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ];
    const transport = vi.fn<SafeHttpTransport>()
      .mockRejectedValueOnce(new Error("first address unavailable"))
      .mockResolvedValueOnce(reply());
    const result = await new SafeFetchAdapter({
      timeoutMs: 50,
      transport,
      resolver: multiAddressResolver,
      clock: () => "2026-07-23T06:00:00.000Z",
    }).fetch(request);

    expect(result.resolvedIps).toEqual(["8.8.8.8", "1.1.1.1"]);
    expect(transport.mock.calls.map(([call]) => call.address.address))
      .toEqual(["8.8.8.8", "1.1.1.1"]);
  });
  it("blocks a private redirect before a second request", async () => {
    const transport = vi.fn<SafeHttpTransport>().mockResolvedValue(
      reply({ status: 302, location: "http://127.0.0.1/admin" }),
    );
    await expect(adapter(transport).fetch(request)).rejects.toMatchObject({
      code: safeFetchFailureCodes.networkBlocked, retryable: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not let one stalled address consume the timeout for every approved address", async () => {
    let firstSignal: AbortSignal | undefined;
    const transport = vi.fn<SafeHttpTransport>().mockImplementation(async ({ address, signal }) => {
      if (address.address === "8.8.8.8") {
        firstSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener(
          "abort", () => reject(new Error("aborted stalled address")), { once: true },
        ));
      }
      return reply();
    });
    const result = await new SafeFetchAdapter({
      timeoutMs: 200, transport,
      resolver: async () => [
        { address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 },
      ],
    }).fetch(request);
    expect(result.status).toBe(200);
    expect(firstSignal?.aborted).toBe(true);
    expect(result.resolvedIps).toEqual(["8.8.8.8", "1.1.1.1"]);
  });
  it("enforces maxRedirects and total timeout", async () => {
    const redirect = vi.fn<SafeHttpTransport>().mockResolvedValue(
      reply({ status: 302, location: "/again" }),
    );
    await expect(adapter(redirect).fetch({ ...request, maxRedirects: 0 }))
      .rejects.toMatchObject({ code: safeFetchFailureCodes.redirectLimitExceeded });
    const stalled: SafeHttpTransport = async () => new Promise(() => {});
    await expect(adapter(stalled, 5).fetch(request)).rejects.toMatchObject({
      code: safeFetchFailureCodes.timeout, retryable: true,
    });
  });
  it.each([
    reply({ contentLength: 6 }),
    reply({ chunks: [[1, 2, 3], [4, 5, 6]] }),
  ])("rejects an oversized response", async (response) => {
    const transport = vi.fn<SafeHttpTransport>().mockResolvedValue(response);
    await expect(adapter(transport).fetch(request)).rejects.toMatchObject({
      code: safeFetchFailureCodes.responseTooLarge,
    });
    expect(response.close).toHaveBeenCalled();
  });
  it.each([undefined, "image/png"])("rejects Content-Type %s", async (contentType) => {
    const response = reply({ contentType });
    const transport = vi.fn<SafeHttpTransport>().mockResolvedValue(response);
    await expect(adapter(transport).fetch(request)).rejects.toMatchObject({
      code: safeFetchFailureCodes.unsupportedContentType,
    });
    expect(response.close).toHaveBeenCalled();
  });
});
