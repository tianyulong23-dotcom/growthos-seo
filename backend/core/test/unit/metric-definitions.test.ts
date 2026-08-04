import { describe, expect, it } from "vitest";

import {
  backlinkMetricDefinitionContractVersion,
  backlinkMetricDefinitions,
  backlinkMetricKeys,
  type BacklinkMetricDefinition,
} from "../../src/modules/backlinks/domain/metrics/definitions.js";

const definitionsByKey = new Map(
  backlinkMetricDefinitions.map((definition) => [
    definition.metricKey,
    definition,
  ]),
);

function metric(metricKey: (typeof backlinkMetricKeys)[number]) {
  const definition = definitionsByKey.get(metricKey);
  expect(definition).toBeDefined();
  return definition as BacklinkMetricDefinition;
}

describe("BL-AI-161 metric definitions", () => {
  it("freezes the V1 metric registry and every required semantic field", () => {
    expect(backlinkMetricDefinitionContractVersion).toBe(
      "backlink-metric-definition.v1",
    );
    expect(backlinkMetricDefinitions.map(({ metricKey }) => metricKey)).toEqual(
      backlinkMetricKeys,
    );

    for (const definition of backlinkMetricDefinitions) {
      expect(definition.definitionVersion).toBe(
        `${definition.metricKey}.v1`,
      );
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.sources.length).toBeGreaterThan(0);
      expect(definition.businessTime.length).toBeGreaterThan(0);
      expect(definition.numerator.rule.length).toBeGreaterThan(0);
      expect(definition.dedupeKey.length).toBeGreaterThan(0);
      expect(definition.allowedDimensions).toEqual([
        "website_project_id",
        "keyword",
        "market",
        "collaboration_mode",
        "owner_id",
      ]);
      expect(definition.window).toMatchObject({
        startBoundary: "INCLUSIVE",
        endBoundary: "EXCLUSIVE",
        asOfBoundary: "INCLUSIVE",
      });
      expect(definition.timezone).toEqual({
        sourceTimestampZone: "UTC",
        reportingTimezoneSource: "WORKSPACE_IANA_TIMEZONE",
        browserTimezoneAllowed: false,
      });
      expect(definition.lateData).toEqual({
        preserveBusinessOccurredAt: true,
        openWindowAction: "RECOMPUTE",
        finalizedWindowAction: "APPEND_CORRECTION_REVISION",
        inPlaceResultMutationAllowed: false,
      });
    }
  });

  it("uses immutable facts and lifecycle events instead of frontend or mutable projections", () => {
    const forbiddenSources = new Set([
      "backlink_email_drafts",
      "backlink_inbound_messages",
      "backlink_opportunities",
      "backlink_placement_candidates",
      "backlink_placements",
      "frontend_state",
    ]);

    for (const definition of backlinkMetricDefinitions) {
      for (const source of definition.sources) {
        expect(source.immutable).toBe(true);
        expect(["IMMUTABLE_FACT", "LIFECYCLE_EVENT"]).toContain(source.kind);
        expect(forbiddenSources.has(source.name)).toBe(false);
      }
    }
  });

  it("defines rate denominators, cohort boundaries, and zero-denominator behavior", () => {
    for (const definition of backlinkMetricDefinitions) {
      if (definition.valueType !== "RATE") continue;

      expect(definition.denominator?.rule.length).toBeGreaterThan(0);
      expect(definition.denominator?.zeroResult).toBeNull();
      expect(definition.window.kind).toBe("COHORT");
    }

    expect(metric("reply_rate").denominator?.rule).toBe(
      "Unique provider thread whose first provider-accepted outbound SendIntent occurred inside the local cohort interval.",
    );
    expect(metric("reply_rate").dedupeKey).toEqual(["provider_thread_id"]);
    expect(metric("negotiation_conversion_rate").denominator?.rule).toBe(
      "Unique Opportunity whose first valid human reply occurred inside the local cohort interval.",
    );
    expect(metric("link_acquisition_rate").denominator?.rule).toBe(
      "Unique Opportunity whose first provider-accepted INITIAL_OUTREACH SendIntent occurred inside the local cohort interval.",
    );
    expect(metric("link_acquisition_rate").dedupeKey).toEqual([
      "opportunity_id",
    ]);
  });

  it("counts only promoted confirmed Placements as successful acquisition", () => {
    for (
      const metricKey of [
        "link_acquisition_rate",
        "gained_placement_count",
        "active_placement_count",
        "suspected_lost_placement_count",
        "lost_placement_count",
        "recovered_placement_count",
      ] as const
    ) {
      expect(metric(metricKey).placementSuccessPolicy).toEqual({
        requiredLifecycleEvent: "placement.confirmed",
        candidateCountsTowardSuccess: false,
      });
    }

    expect(metric("link_acquisition_rate").numerator.rule).toBe(
      "Cohort Opportunity with at least one promoted Placement carrying placement.confirmed by as-of.",
    );
  });

  it("rebuilds day-end Placement state and recovery from frozen monitoring decisions", () => {
    for (
      const metricKey of [
        "active_placement_count",
        "suspected_lost_placement_count",
        "lost_placement_count",
      ] as const
    ) {
      expect(metric(metricKey).window.kind).toBe("LOCAL_DAY_END");
      expect(metric(metricKey).sources.map(({ eventType }) => eventType)).toEqual(
        ["placement.confirmed", "placement.monitoring.status_decided"],
      );
    }

    expect(metric("recovered_placement_count").numerator.rule).toBe(
      "Monitoring decision inside the local interval with previousHealthStatus in [lost, suspected_lost] and nextHealthStatus = active.",
    );
  });
});
