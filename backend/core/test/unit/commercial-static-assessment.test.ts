import { describe, expect, it } from "vitest";

import {
  commercialPageParser,
} from "../../src/modules/backlinks/adapters/html/commercial-page-parser.adapter.js";
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

const project = Object.freeze({
  products: ["home cinema projector"],
  topics: ["streaming"],
  keywords: ["projector reviews"],
  targetPages: ["https://example.com/projectors"],
  targetAudiences: ["home cinema buyers"],
  partnershipGoals: ["editorial review"],
});

describe("commercial static assessment", () => {
  it("collects homepage and bounded same-site commercial evidence", async () => {
    const requested: string[] = [];
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.co.uk",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      project,
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
      pageParser: commercialPageParser,
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
      project,
      safeFetch: {
        fetch: async ({ url }) => response({
          requestedUrl: url,
          status: 403,
          body: "<html><body>Forbidden</body></html>",
        }),
      },
      pageParser: commercialPageParser,
      now: () => "2026-08-06T08:00:01.000Z",
    });

    expect(assessment).toMatchObject({
      decision: "manual_review",
      productRelevance: null,
      editorialQuality: null,
      technicalAccessibility: null,
    });
  });

  it("uses same-domain discovery pages as bounded semantic evidence", async () => {
    const requested: string[] = [];
    const discoveryUrl =
      "https://publisher.com/reviews/home-cinema-projectors#top";
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.com",
      discoveryUrls: [
        discoveryUrl,
        "https://unrelated.example.org/projector-reviews",
      ],
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      project,
      safeFetch: {
        fetch: async ({ url }) => {
          requested.push(url);
          return response({
            requestedUrl: url,
            body: url.includes("/reviews/")
              ? "<html lang='en'><head><title>Home cinema projector reviews</title>"
                + "<meta name='description' content='Projector reviews'></head>"
                + "<body><main><article>Independent home cinema projector reviews "
                + "for home cinema buyers and editorial review partners."
                + "</article></main></body></html>"
              : "<html lang='en'><head><title>Publisher</title></head>"
                + "<body><main>Independent magazine.</main></body></html>",
          });
        },
      },
      pageParser: commercialPageParser,
    });

    expect(requested).toEqual([
      "https://publisher.com/",
      "https://publisher.com/reviews/home-cinema-projectors",
    ]);
    expect(assessment.matchedProducts).toContain("home cinema projector");
    expect(assessment.matchedKeywords).toContain("projector reviews");
    expect(assessment.matchedAudiences).toContain("home cinema buyers");
    expect(assessment.matchedPartnershipGoals).toContain("editorial review");
  });

  it("uses a public discovery page when the homepage is forbidden", async () => {
    const discoveryUrl = "https://publisher.com/reviews/projector-guide";
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.com",
      discoveryUrls: [discoveryUrl],
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      project,
      safeFetch: {
        fetch: async ({ url }) =>
          url === "https://publisher.com/"
            ? response({
                requestedUrl: url,
                status: 403,
                body: "<html><body>Forbidden</body></html>",
              })
            : response({
                requestedUrl: url,
                body: "<html lang='en'><head><title>Projector reviews</title>"
                  + "<meta name='description' content='Home cinema projectors'>"
                  + "</head><body><main><article>Home cinema projector reviews "
                  + "for home cinema buyers.</article></main></body></html>",
              }),
      },
      pageParser: commercialPageParser,
    });

    expect(assessment.decision).toBe("ready");
    expect(assessment.failedUrls).toEqual(["https://publisher.com/"]);
    expect(assessment.evidenceUrls).toEqual([discoveryUrl]);
    expect(assessment.technicalAccessibility).toBe(0.5);
  });

  it("keeps a timeout as insufficient data", async () => {
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.com",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      project,
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
      pageParser: commercialPageParser,
      now: () => "2026-08-06T08:00:01.000Z",
    });

    expect(assessment.decision).toBe("insufficient_data");
    expect(assessment.failedUrls).toEqual(["https://publisher.com/"]);
  });

  it("uses target-page path semantics while preserving the original URL", async () => {
    const targetPage = "https://example.com/projector-calibration";
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "publisher.com",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      project: {
        products: [],
        topics: [],
        keywords: [],
        targetPages: [targetPage],
        targetAudiences: [],
        partnershipGoals: [],
      },
      safeFetch: {
        fetch: async ({ url }) => response({
          requestedUrl: url,
          body: "<html lang='en'><head><title>Projector calibration</title>"
            + "</head><body><main><article>Projector calibration checklist."
            + "</article></main></body></html>",
        }),
      },
      pageParser: commercialPageParser,
    });

    expect(assessment.matchedTargetPages).toEqual([targetPage]);
    expect(assessment.productRelevance).toBe(1);
  });

  it("does not treat the generic word pool as Aiper product relevance", async () => {
    const assessment = await assessCommercialCandidateSite({
      canonicalDomain: "celebritypoolnews.com",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      project: {
        products: ["Aiper robotic pool cleaner"],
        topics: ["pool maintenance"],
        keywords: ["robotic pool cleaning"],
        targetPages: ["https://aiper.com/products/scuba-s1"],
        targetAudiences: ["pool owners"],
        partnershipGoals: ["editorial review"],
      },
      safeFetch: {
        fetch: async ({ url }) => response({
          requestedUrl: url,
          body: "<html lang='en'><head><title>Celebrity pool party news</title>"
            + "<meta name='description' content='Entertainment and movie news'>"
            + "</head><body><main><article>Photos from a celebrity pool party."
            + "</article><a href='/advertise'>Advertise</a></main></body></html>",
        }),
      },
      pageParser: commercialPageParser,
    });

    expect(assessment.productRelevance).toBe(0);
    expect(assessment.unrelatedIndustry).toBe(true);
    expect(assessment.matchedProducts).toEqual([]);
    expect(assessment.matchedTopics).toEqual([]);
    expect(assessment.matchedKeywords).toEqual([]);
  });
});
