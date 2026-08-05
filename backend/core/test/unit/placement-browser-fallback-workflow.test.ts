import { describe, expect, it } from "vitest";

import {
  createBrowserFetchCapability,
  type BrowserFetchRequest,
} from "../../src/modules/backlinks/ports/crawler-browser-fetch.port.js";
import { FakeBrowserFetchAdapter } from "../../src/modules/backlinks/ports/crawler-browser-fetch.fake.js";
import {
  runPlacementBrowserFallbackWorkflow,
  type BrowserFallbackBudgetGate,
} from "../../src/modules/backlinks/application/workflows/placement-browser-fallback.workflow.js";

const browserRequest: BrowserFetchRequest = {
  requestId: "browser-fallback-request-001",
  workspaceId: "workspace-001",
  websiteProjectId: "website-project-001",
  placementId: "placement-001",
  sourcePageUrl: "https://publisher.example/articles/placement",
  targetUrl: "https://target.example/landing",
  fallbackReason: "static_evidence_insufficient",
  staticEvidenceSnapshotId: "static-snapshot-001",
  staticEvidenceSnapshotHash: "a".repeat(64),
  requestedAt: "2026-07-28T10:00:00.000Z",
};

function createBudgetGate(
  outcome: "granted" | "exhausted",
): { gate: BrowserFallbackBudgetGate; calls: unknown[] } {
  const calls: unknown[] = [];

  return {
    gate: {
      reserve: async (request) => {
        calls.push(request);
        return Object.freeze({ outcome });
      },
    },
    calls,
  };
}

describe("placement browser fallback workflow", () => {
  it("does not reserve budget or call Browser when static evidence is sufficient", async () => {
    const browserFetch = new FakeBrowserFetchAdapter();
    const budget = createBudgetGate("granted");

    const result = await runPlacementBrowserFallbackWorkflow(
      {
        request: browserRequest,
        staticEvidenceSufficient: true,
        authorized: true,
      },
      {
        browserFetchCapability: createBrowserFetchCapability({
          enabled: true,
          browserFetch,
        }),
        budgetGate: budget.gate,
      },
    );

    expect(result).toMatchObject({
      outcome: "not_requested",
      reason: "static_evidence_sufficient",
      evidenceMarker: {
        sharedCrawlerEvidenceContract: "crawler.evidence.v1",
        disposition: "static_evidence_sufficient",
      },
    });
    expect(budget.calls).toHaveLength(0);
    expect(browserFetch.calls).toHaveLength(0);
  });

  it("does not reserve budget or call Browser without authorization", async () => {
    const browserFetch = new FakeBrowserFetchAdapter();
    const budget = createBudgetGate("granted");

    const result = await runPlacementBrowserFallbackWorkflow(
      {
        request: browserRequest,
        staticEvidenceSufficient: false,
        authorized: false,
      },
      {
        browserFetchCapability: createBrowserFetchCapability({
          enabled: true,
          browserFetch,
        }),
        budgetGate: budget.gate,
      },
    );

    expect(result).toMatchObject({
      outcome: "not_requested",
      reason: "not_authorized",
      evidenceMarker: {
        disposition: "not_authorized",
      },
    });
    expect(budget.calls).toHaveLength(0);
    expect(browserFetch.calls).toHaveLength(0);
  });

  it("does not call Browser when the fallback budget is exhausted", async () => {
    const browserFetch = new FakeBrowserFetchAdapter();
    const budget = createBudgetGate("exhausted");

    const result = await runPlacementBrowserFallbackWorkflow(
      {
        request: browserRequest,
        staticEvidenceSufficient: false,
        authorized: true,
      },
      {
        browserFetchCapability: createBrowserFetchCapability({
          enabled: true,
          browserFetch,
        }),
        budgetGate: budget.gate,
      },
    );

    expect(result).toMatchObject({
      outcome: "not_requested",
      reason: "budget_exhausted",
      evidenceMarker: {
        disposition: "budget_exhausted",
      },
    });
    expect(budget.calls).toHaveLength(1);
    expect(browserFetch.calls).toHaveLength(0);
  });

  it("marks Browser evidence only after authorization and budget reservation", async () => {
    const browserFetch = new FakeBrowserFetchAdapter();
    const budget = createBudgetGate("granted");

    const result = await runPlacementBrowserFallbackWorkflow(
      {
        request: browserRequest,
        staticEvidenceSufficient: false,
        authorized: true,
      },
      {
        browserFetchCapability: createBrowserFetchCapability({
          enabled: true,
          browserFetch,
        }),
        budgetGate: budget.gate,
      },
    );

    expect(result).toMatchObject({
      outcome: "browser_evidence_fetched",
      evidenceMarker: {
        disposition: "browser_evidence_fetched",
        sharedCrawlerEvidenceContract: "crawler.evidence.v1",
        browserEvidence: {
          contractVersion: "crawler-browser-fetch-evidence.v1",
          evidenceSnapshotHash: expect.any(String),
        },
      },
    });
    expect(budget.calls).toHaveLength(1);
    expect(browserFetch.calls).toHaveLength(1);
  });

  it("marks a disabled Browser capability without calling the Browser port", async () => {
    const browserFetch = new FakeBrowserFetchAdapter();
    const budget = createBudgetGate("granted");

    const result = await runPlacementBrowserFallbackWorkflow(
      {
        request: browserRequest,
        staticEvidenceSufficient: false,
        authorized: true,
      },
      {
        browserFetchCapability: createBrowserFetchCapability({
          enabled: false,
          browserFetch,
        }),
        budgetGate: budget.gate,
      },
    );

    expect(result).toMatchObject({
      outcome: "not_requested",
      reason: "capability_disabled",
      evidenceMarker: {
        disposition: "capability_disabled",
      },
    });
    expect(budget.calls).toHaveLength(0);
    expect(browserFetch.calls).toHaveLength(0);
  });
});
