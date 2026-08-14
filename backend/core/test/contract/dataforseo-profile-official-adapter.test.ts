import { describe, expect, it, vi } from "vitest";

import {
  createOfficialDataForSeoProfileRuntime,
} from "../../src/modules/backlinks/adapters/dataforseo/profile-official-runtime.js";

const credentials = {
  login: "fixture-login",
  password: "fixture-password",
};

describe("official DataForSEO backlink profile adapter", () => {
  it("uses only summary/live and backlinks/live with an explicit monitoring tag", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as unknown });
      const result = url.endsWith("/summary/live")
        ? {
            version: "0.1.20260720",
            status_code: 20000,
            tasks: [{
              id: "summary-task-1",
              status_code: 20000,
              cost: 0.02,
              result: [{
                target: "elephtv.com",
                backlinks: 250,
                referring_domains: 80,
                referring_links_types: { anchor: 240 },
                referring_links_attributes: {
                  dofollow: 170,
                  nofollow: 60,
                  sponsored: 10,
                  ugc: 10,
                },
                referring_links_countries: { US: 90, GB: 30 },
                referring_links_tld: { com: 120, org: 20 },
              }],
            }],
          }
        : {
            version: "0.1.20260720",
            status_code: 20000,
            tasks: [{
              id: "inventory-task-1",
              status_code: 20000,
              cost: 0.0276,
              result: [{
                target: "elephtv.com",
                total_count: 250,
                items_count: 1,
                search_after_token: "next-page-token",
                items: [{
                  type: "backlink",
                  domain_from: "publisher.example",
                  url_from: "https://publisher.example/article",
                  url_to: "https://elephtv.com/product",
                  anchor: "ElephTV",
                  dofollow: true,
                  is_new: true,
                  is_lost: false,
                  first_seen: "2026-08-01 00:00:00 +00:00",
                  last_seen: "2026-08-06 00:00:00 +00:00",
                  domain_from_rank: 71,
                  backlink_spam_score: 4,
                  domain_from_country: "US",
                  tld_from: "com",
                  page_from_language: "en",
                  page_from_status_code: 200,
                  url_to_status_code: 200,
                  item_type: "anchor",
                  attributes: ["dofollow"],
                }],
              }],
            }],
          };
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const runtime = createOfficialDataForSeoProfileRuntime({
      credentials,
      endpointAllowlist: [
        "/v3/backlinks/summary/live",
        "/v3/backlinks/backlinks/live",
      ],
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    const summary = await runtime.fetchSummary({
      canonicalDomain: "elephtv.com",
      requestTag: "monitoring:project-1:job-1:summary",
    });
    const inventory = await runtime.fetchInventoryPage({
      canonicalDomain: "elephtv.com",
      requestTag: "monitoring:project-1:job-1:inventory:1",
      limit: 100,
      searchAfterToken: null,
    });

    expect(summary).toMatchObject({
      providerTaskId: "summary-task-1",
      costMicros: 20_000,
      totalBacklinks: 250,
      referringDomains: 80,
      distributions: {
        countries: { US: 90, GB: 30 },
        tlds: { com: 120, org: 20 },
      },
    });
    expect(inventory).toMatchObject({
      providerTaskId: "inventory-task-1",
      totalCount: 250,
      pulledCount: 1,
      nextCursor: "next-page-token",
      items: [{
        sourceUrl: "https://publisher.example/article",
        targetUrl: "https://elephtv.com/product",
        rel: ["dofollow"],
        isNew: true,
        isLost: false,
      }],
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.dataforseo.com/v3/backlinks/summary/live",
      "https://api.dataforseo.com/v3/backlinks/backlinks/live",
    ]);
    expect(requests[0]?.body).toEqual([expect.objectContaining({
      target: "elephtv.com",
      backlinks_status_type: "all",
      tag: "monitoring:project-1:job-1:summary",
    })]);
    expect(requests[1]?.body).toEqual([expect.objectContaining({
      target: "elephtv.com",
      mode: "as_is",
      limit: 100,
      tag: "monitoring:project-1:job-1:inventory:1",
    })]);
    expect(JSON.stringify(requests)).not.toContain("fixture-password");
  });

  it("rejects a profile endpoint outside the allowlist before dispatch", async () => {
    const fetchMock = vi.fn();
    const runtime = createOfficialDataForSeoProfileRuntime({
      credentials,
      endpointAllowlist: ["/v3/backlinks/summary/live"],
      timeoutMs: 5_000,
      fetchImplementation: fetchMock,
    });

    await expect(runtime.fetchInventoryPage({
      canonicalDomain: "elephtv.com",
      requestTag: "monitoring:project-1:job-1:inventory:1",
      limit: 100,
      searchAfterToken: null,
    })).rejects.toThrow("DATAFORSEO_ENDPOINT_NOT_ALLOWLISTED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
