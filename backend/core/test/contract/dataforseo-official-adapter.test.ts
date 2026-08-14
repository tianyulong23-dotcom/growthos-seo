import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  DataForSeoAdapter,
} from "../../src/modules/backlinks/adapters/dataforseo/adapter.js";
import {
  DataForSeoClient,
} from "../../src/modules/backlinks/adapters/dataforseo/client.js";
import {
  dataForSeoClientConfigSchema,
} from "../../src/modules/backlinks/adapters/dataforseo/config.js";
import {
  createOfficialDataForSeoRuntimeFactory,
} from "../../src/modules/backlinks/adapters/dataforseo/official-runtime.js";

const fixtureUrl = new URL(
  "fixtures/dataforseo-referring-domains-success.json",
  import.meta.url,
);
const request = {
  target: "example.com",
  targetType: "domain" as const,
  limit: 2,
};
const context = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  requestId: "request-1",
  idempotencyKey: "recommendation-refill:project-1:context-1",
  budgetReservationId: "reservation-1",
};

describe("official DataForSEO adapter", () => {
  it("uses the pinned official client through the exact allowlisted endpoint", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void input;
      void init;
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new DataForSeoClient(
      dataForSeoClientConfigSchema.parse({
        DATAFORSEO_ENABLED: "true",
        DATAFORSEO_CREDENTIAL_SECRET_REF:
          "secret://growthos/backlinks/dataforseo",
        DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
      }),
      vi.fn().mockResolvedValue({
        login: "fixture-login",
        password: "fixture-password",
      }),
      createOfficialDataForSeoRuntimeFactory(fetchMock),
    );
    const timestamps = [
      new Date("2026-08-04T02:00:00.000Z"),
      new Date("2026-08-04T02:00:01.000Z"),
    ];
    const adapter = new DataForSeoAdapter(
      client,
      () => timestamps.shift() ?? new Date("2026-08-04T02:00:01.000Z"),
    );

    await expect(
      adapter.fetchBacklinkSnapshot(context, request),
    ).resolves.toMatchObject({
      provider: "dataforseo",
      schemaVersion: "dataforseo.backlinks-referring-domains.v1",
      requestedAt: "2026-08-04T02:00:00.000Z",
      completedAt: "2026-08-04T02:00:01.000Z",
      costMicros: 20_100,
      referringDomains: [
        {
          domain: "publisher.example",
          backlinkCount: 3,
          rank: 72,
          spamScore: 4,
          countryCode: "US",
        },
        {
          domain: "news.example",
          backlinkCount: 1,
          rank: 41,
          spamScore: null,
          countryCode: null,
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from(
        "fixture-login:fixture-password",
        "utf8",
      ).toString("base64")}`,
    );
    expect(JSON.parse(String(init?.body))).toEqual([{
      target: "example.com",
      limit: 2,
      backlinks_status_type: "live",
      order_by: ["rank,desc"],
      include_subdomains: true,
      include_indirect_links: false,
      exclude_internal_backlinks: true,
      rank_scale: "one_hundred",
    }]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      "fixture-password",
    );
  });
});
