import { describe, expect, it } from "vitest";

import {
  createBrowserFetchCapability,
  type BrowserFetchRequest,
} from "../../src/modules/backlinks/ports/crawler-browser-fetch.port.js";
import {
  FakeBrowserFetchAdapter,
} from "../../src/modules/backlinks/ports/crawler-browser-fetch.fake.js";

const request: BrowserFetchRequest = {
  requestId: "browser-fetch-request-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  placementId: "placement-1",
  sourcePageUrl: "https://publisher.example.test/article",
  targetUrl: "https://owner.example.test/guide",
  fallbackReason: "static_evidence_insufficient",
  staticEvidenceSnapshotId: "evidence-snapshot-1",
  staticEvidenceSnapshotHash: "a".repeat(64),
  requestedAt: "2026-07-28T10:00:00.000Z",
};

describe("BL-AI-155 Browser Fetch capability", () => {
  it("is disabled by default and does not call the Browser Fetch port", async () => {
    const browserFetch = new FakeBrowserFetchAdapter();
    const capability = createBrowserFetchCapability({ browserFetch });

    await expect(capability.request(request)).resolves.toEqual({
      outcome: "disabled",
    });
    expect(browserFetch.calls).toEqual([]);
  });

  it("uses the Fake Adapter only for explicit static-evidence insufficiency", async () => {
    const browserFetch = new FakeBrowserFetchAdapter({
      observedAt: "2026-07-28T10:00:05.000Z",
    });
    const capability = createBrowserFetchCapability({
      enabled: true,
      browserFetch,
    });

    await expect(capability.request(request)).resolves.toMatchObject({
      outcome: "fetched",
      evidence: {
        contractVersion: "crawler-browser-fetch-evidence.v1",
        executionMode: "browser",
        requestId: request.requestId,
        sourcePageUrl: request.sourcePageUrl,
        targetUrl: request.targetUrl,
        observedAt: "2026-07-28T10:00:05.000Z",
      },
    });
    expect(browserFetch.calls).toEqual([request]);

    await expect(
      capability.request({
        ...request,
        fallbackReason: "static_evidence_sufficient" as never,
      }),
    ).rejects.toThrow("static_evidence_insufficient");
    expect(browserFetch.calls).toEqual([request]);
  });
});
