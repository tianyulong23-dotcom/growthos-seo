import { describe, expect, it } from "vitest";

import {
  assessCommercialCandidateSite,
} from "../../src/modules/backlinks/domain/recommendations/commercial-static-assessment.js";
import {
  SafeFetchError,
  safeFetchFailureCodes,
} from "../../src/modules/backlinks/ports/safe-fetch.port.js";

function response(input: Readonly<{
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  body: string;
  fetchedAt?: string;
}>) {
  return {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl ?? input.requestedUrl,
    status: input.status ?? 200,
    contentType: "text/html",
    body: Uint8Array.from(Buffer.from(input.body, "utf8")),
    redirectChain: [],
    resolvedIps: ["203.0.113.10"],
    fetchedAt: input.fetchedAt ?? "2026-08-06T08:00:00.000Z",
  };
}

describe("commercial static assessment", () => {
  it("collects homepage and bounded same-site commercial evidence", async () => {
    const requested: string[] = [];
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.co.uk",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      projectTerms: ["home cinema projector", "streaming"],
      safeFetch: {
        fetch: async ({ url }) => {
          requested.push(url);
          if (url.endsWith("/advertise")) {
            return response({
              requestedUrl: url,
              body: "<html lang='en'><head><title>Advertise</title></head>"
                + "<body><main>Partner with us through sponsored editorial."
                + "</main></body></html>",
            });
          }
          return response({
            requestedUrl: url,
            body: "<html lang='en'><head><title>Home cinema reviews</title>"
              + "<meta name='description' content='Projector and streaming guides'>"
              + "</head><body><main><article>Independent home cinema projector "
              + "reviews and streaming tutorials.</article></main>"
              + "<a href='/advertise'>Advertise</a>"
              + "<a href='https://outside.example.org/report'>Source</a>"
              + "</body></html>",
          });
        },
      },
    });

    expect(requested).toEqual([
      "https://publisher.co.uk/",
      "https://publisher.co.uk/advertise",
    ]);
    expect(assessment).toMatchObject({
      canonicalDomain: "publisher.co.uk",
      decision: "ready",
      language: "en",
      siteType: "specialist_blog",
    });
    expect(assessment.productRelevance).toBeGreaterThan(0);
    expect(assessment.cooperationPages).toContain(
      "https://publisher.co.uk/advertise",
    );
    expect(assessment.evidenceUrls).toHaveLength(2);
  });

  it("keeps a 403 in manual review instead of classifying the site", async () => {
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.com",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      projectTerms: ["projector"],
      safeFetch: {
        fetch: async ({ url }) => response({
          requestedUrl: url,
          status: 403,
          body: "<html><body>Forbidden</body></html>",
        }),
      },
      now: () => "2026-08-06T08:00:01.000Z",
    });

    expect(assessment).toMatchObject({
      decision: "manual_review",
      productRelevance: null,
      editorialQuality: null,
      technicalAccessibility: null,
    });
  });

  it("keeps a timeout as insufficient data", async () => {
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.com",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      projectTerms: ["projector"],
      safeFetch: {
        fetch: async ({ url }) => {
          throw new SafeFetchError({
            code: safeFetchFailureCodes.timeout,
            requestedUrl: url,
            message: "Timed out.",
            retryable: true,
          });
        },
      },
      now: () => "2026-08-06T08:00:01.000Z",
    });

    expect(assessment.decision).toBe("insufficient_data");
    expect(assessment.failedUrls).toEqual(["https://publisher.com/"]);
  });
});
