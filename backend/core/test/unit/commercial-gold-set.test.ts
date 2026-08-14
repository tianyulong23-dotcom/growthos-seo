import { describe, expect, it } from "vitest";

import {
  calculateCommercialGoldMetrics,
} from "../../src/modules/backlinks/domain/recommendations/commercial-gold-set.js";

describe("LOCAL-PRODUCT-015 commercial Gold Set metrics", () => {
  it("reports precision, duplicate, gate false-positive, stability and cost", () => {
    const metrics = calculateCommercialGoldMetrics({
      labels: [
        { canonicalDomain: "a.example.com", marketCode: "us", label: "suitable" },
        { canonicalDomain: "b.example.com", marketCode: "us", label: "unsuitable" },
        { canonicalDomain: "c.example.com", marketCode: "us", label: "suitable" },
      ],
      predictions: [
        {
          canonicalDomain: "a.example.com",
          score: 90,
          decision: "ready",
          hitGates: [],
        },
        {
          canonicalDomain: "b.example.com",
          score: 80,
          decision: "ready",
          hitGates: [],
        },
        {
          canonicalDomain: "c.example.com",
          score: null,
          decision: "excluded",
          hitGates: ["strict_market_mismatch"],
        },
        {
          canonicalDomain: "a.example.com",
          score: 70,
          decision: "ready",
          hitGates: [],
        },
      ],
      previousPredictions: [
        {
          canonicalDomain: "a.example.com",
          score: 90,
          decision: "ready",
          hitGates: [],
        },
        {
          canonicalDomain: "d.example.com",
          score: 80,
          decision: "ready",
          hitGates: [],
        },
      ],
      totalCostMicros: 1_000,
    });

    expect(metrics.precisionAt20).toBe(0.5);
    expect(metrics.duplicateRate).toBe(0.25);
    expect(metrics.gateFalsePositiveRate).toBe(0.5);
    expect(metrics.topKStability).toBeCloseTo(1 / 3, 4);
    expect(metrics.costPerReadyMicros).toBe(500);
    expect(metrics.calibrationReady).toBe(false);
    expect(metrics.productionPrecisionClaimAllowed).toBe(false);
  });

  it("requires 500 unique labels and 100 of each label in every market", () => {
    const labelValues = [
      "suitable",
      "unsuitable",
      "uncertain",
    ] as const;
    const labels = Array.from({ length: 600 }, (_, index) => ({
      canonicalDomain: `site-${index}.example.com`,
      marketCode: index < 300 ? "US" : "ZA",
      label: labelValues[index % labelValues.length] ?? "uncertain",
    }));
    const metrics = calculateCommercialGoldMetrics({
      labels,
      predictions: [],
      totalCostMicros: 0,
    });

    expect(metrics.calibrationReady).toBe(true);
    expect(metrics.productionPrecisionClaimAllowed).toBe(true);
  });
});
