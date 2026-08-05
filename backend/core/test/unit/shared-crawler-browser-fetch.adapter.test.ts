import { describe, expect, it, vi } from "vitest";

import {
  createBrowserFetchCapability,
  type BrowserFetchRequest,
} from "../../src/modules/backlinks/ports/crawler-browser-fetch.port.js";
import {
  createSharedCrawlerBrowserFetchPort,
} from "../../src/modules/backlinks/ports/shared-crawler-browser-fetch.adapter.js";

const request: BrowserFetchRequest = {
  requestId: "browser-fetch-request-2",
  workspaceId: "workspace-2",
  websiteProjectId: "project-2",
  placementId: "placement-2",
  sourcePageUrl: "https://publisher.example.test/article",
  targetUrl: "https://owner.example.test/guide",
  fallbackReason: "static_evidence_insufficient",
  staticEvidenceSnapshotId: "evidence-snapshot-2",
  staticEvidenceSnapshotHash: "a".repeat(64),
  requestedAt: "2026-07-29T10:00:00.000Z",
};

const crawlerEvidence = {
  version: "crawler.evidence.v1",
  policyVersion: "safefetch.gold.v1",
  evidenceId: "crawler-evidence-2",
  requestId: request.requestId,
  taskType: "backlink_validation",
  runId: "crawler-run-2",
  outcome: "completed",
  collectedAt: "2026-07-29T10:00:05.000Z",
  pages: [{
    requestedUrl: request.sourcePageUrl,
    finalUrl: "https://publisher.example.test/article/",
    rendered: true,
    renderMode: "browser",
    fetchedAt: "2026-07-29T10:00:04.000Z",
  }],
  backlinkObservations: [{
    sourceUrl: request.sourcePageUrl,
    targetUrl: request.targetUrl,
    renderMode: "browser",
    observedAt: "2026-07-29T10:00:04.000Z",
  }],
};

describe("shared Crawler Browser fallback adapter", () => {
  it("defaults disabled without resolving context or calling the Crawler", async () => {
    const resolve = vi.fn();
    const collect = vi.fn();
    const capability = createBrowserFetchCapability({
      browserFetch: createSharedCrawlerBrowserFetchPort({
        contextResolver: { resolve },
        crawlerEvidence: { collect },
      }),
    });

    await expect(capability.request(request)).resolves.toEqual({
      outcome: "disabled",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it("maps one explicit fallback request onto crawler.evidence.v1", async () => {
    const resolve = vi.fn(async () => ({
      organizationId: "organization-2",
      websiteProjectKey: "project-key-2",
      actorId: "placement-worker",
      correlationId: "correlation-2",
    }));
    const collect = vi.fn(async () => crawlerEvidence);
    const capability = createBrowserFetchCapability({
      enabled: true,
      browserFetch: createSharedCrawlerBrowserFetchPort({
        enabled: true,
        contextResolver: { resolve },
        crawlerEvidence: { collect },
      }),
    });

    await expect(capability.request(request)).resolves.toMatchObject({
      outcome: "fetched",
      evidence: {
        contractVersion: "crawler-browser-fetch-evidence.v1",
        executionMode: "browser",
        requestId: request.requestId,
        finalUrl: "https://publisher.example.test/article/",
        observedAt: "2026-07-29T10:00:04.000Z",
      },
    });
    expect(collect).toHaveBeenCalledWith({
      version: "crawler.evidence.request.v1",
      requestId: request.requestId,
      taskType: "backlink_validation",
      tenant: {
        organizationId: "organization-2",
        workspaceId: request.workspaceId,
      },
      project: {
        websiteProjectId: request.websiteProjectId,
        websiteProjectKey: "project-key-2",
      },
      target: {
        urls: [request.sourcePageUrl],
        expectedLinks: [request.targetUrl],
      },
      options: {
        maxPages: 1,
        scope: "directory",
        rendering: "all",
        collectPageSpeedEvidence: false,
        collectDuplicateContentEvidence: false,
      },
      requestedBy: {
        moduleId: "backlinks",
        actorId: "placement-worker",
        correlationId: "correlation-2",
      },
      requestedAt: request.requestedAt,
    });
  });
});
