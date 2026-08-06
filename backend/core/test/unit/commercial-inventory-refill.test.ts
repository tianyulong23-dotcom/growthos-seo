import { describe, expect, it, vi } from "vitest";

import {
  ensureCommercialRecommendationRefill,
} from "../../src/modules/backlinks/application/services/commercial-inventory-refill.service.js";

const input = {
  organizationId: "018f0000-0000-7000-8000-000000000101",
  workspaceId: "018f0000-0000-7000-8000-000000000102",
  websiteProjectId: "018f0000-0000-7000-8000-000000000103",
  projectContextVersionId: "018f0000-0000-7000-8000-000000000104",
  actorId: "user-commercial-inventory",
  estimatedCostMicros: 1_000,
  candidateLimit: 100,
  now: new Date("2026-08-06T09:00:00.000Z"),
} as const;

const inventoryState = {
  canonicalDomain: "elephtv.com",
  locale: "en-US",
  countryCode: "US",
  profileVersionId: "profile-1",
  promotionTargetVersionId: "promotion-1",
  candidateLowWatermark: 20,
  candidateHighWatermark: 40,
  publishedLowWatermark: 5,
  publishedHighWatermark: 10,
  minimumEmailHitRate: 0.1,
  maximumEmailHitRate: 0.8,
  candidateReadyCount: 25,
  historicalCandidateCount: 20,
  publishedContactReadyCount: 2,
  historicalVerifiedEmailCount: 1,
  workflowReadyCount: 25,
  inflight: false,
  cooldownActive: false,
  budgetAvailable: true,
} as const;

describe("commercial inventory automatic refill", () => {
  it("queues one inventory-low refill through the existing durable workflow", async () => {
    let commandValues: readonly unknown[] | undefined;
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return { rows: [inventoryState] };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      requestedCandidateCount: 80,
      effectiveEmailHitRate: 0.1,
    });
    expect(commandValues?.[15]).toBe(26);
    expect(commandValues?.[16]).toBe(105);
    expect(commandValues?.[19]).toBe("inventory_low");
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("backlinks.recommendation-refill.requested.v1")
    )).toBe(true);
  });

  it("records a budget pause without creating a refill job", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            candidateReadyCount: 0,
            publishedContactReadyCount: 0,
            budgetAvailable: false,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toEqual({
      status: "paused",
      pauseReason: "budget",
      requestedCandidateCount: 100,
      effectiveEmailHitRate: 0.1,
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
  });
});
