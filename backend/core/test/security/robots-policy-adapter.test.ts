import { describe, expect, it, vi } from "vitest";
import { RobotsPolicyAdapter } from "../../src/modules/backlinks/adapters/html/robots-policy.adapter.js";
import type {
  SafeFetchPort, SafeFetchResult,
} from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const targetUrl = "https://example.com/private/report";
function response(body: string | Uint8Array, status = 200): SafeFetchResult {
  return {
    requestedUrl: "https://example.com/robots.txt",
    finalUrl: "https://example.com/robots.txt",
    status,
    contentType: "text/plain",
    body: typeof body === "string" ? new TextEncoder().encode(body) : body,
    redirectChain: [],
    resolvedIps: ["8.8.8.8"],
    fetchedAt: "2026-07-23T06:00:00.000Z",
  };
}
function setup(result: SafeFetchResult | Error) {
  const fetch = result instanceof Error
    ? vi.fn<SafeFetchPort["fetch"]>().mockRejectedValue(result)
    : vi.fn<SafeFetchPort["fetch"]>().mockResolvedValue(result);
  return { adapter: new RobotsPolicyAdapter({ fetch }), fetch };
}
const request = {
  targetUrl,
  userAgent: "GrowthOS-SafeFetch",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
} as const;

describe("BL-AI-069 robots policy adapter", () => {
  it("enforces Disallow and returns crawl-delay evidence", async () => {
    const { adapter, fetch } = setup(response([
      "User-agent: GrowthOS-SafeFetch",
      "invalid rule",
      "Disallow: /private",
      "Crawl-delay: 7",
    ].join("\n")));
    await expect(adapter.evaluate(request)).resolves.toMatchObject({
      decision: "disallow",
      reason: "robots_disallowed",
      crawlDelaySeconds: 7,
    });
    expect(fetch).toHaveBeenCalledWith({
      url: "https://example.com/robots.txt",
      purpose: "contact-enrichment",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      maxBytes: 512_000,
      maxRedirects: 3,
    });
  });

  it.each([
    ["", "allow"],
    ["User-agent: *\nDisallow: /\nAllow: /public", "allow"],
  ] as const)("evaluates successful rules without widening them", async (rules, decision) => {
    const url = rules === "" ? targetUrl : "https://example.com/public/about";
    const { adapter } = setup(response(rules));
    await expect(adapter.evaluate({ ...request, targetUrl: url }))
      .resolves.toMatchObject({ decision });
  });

  it("reuses one robots document for pages in the same project and origin", async () => {
    const { adapter, fetch } = setup(response(
      "User-agent: *\nDisallow: /private\nAllow: /public",
    ));
    await expect(adapter.evaluate(request)).resolves.toMatchObject({
      decision: "disallow",
    });
    await expect(adapter.evaluate({
      ...request,
      targetUrl: "https://example.com/public/about",
    })).resolves.toMatchObject({ decision: "allow" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new Error("offline"), "robots_unavailable"],
    [response("User-agent: *", 503), "robots_unavailable"],
    [response(Uint8Array.from([0xff])), "robots_parse_failed"],
  ] as const)("returns unknown when robots cannot be trusted", async (result, reason) => {
    const { adapter } = setup(result);
    await expect(adapter.evaluate(request)).resolves.toMatchObject({
      decision: "unknown",
      reason,
    });
  });
});
