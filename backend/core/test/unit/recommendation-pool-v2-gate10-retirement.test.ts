import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Gate 10 V2-only production composition", () => {
  it("does not schedule retired analysis from Website Project projection", () => {
    const projection = source(
      "src/modules/backlinks/application/commands/project-context-projection.command.ts",
    );
    for (const retired of [
      "BACKLINK_PROJECT_ANALYSIS_REQUESTED",
      "createJobRepository",
      "createOutboxRepository",
      'workflow: "project-analysis"',
    ]) {
      expect(projection, retired).not.toContain(retired);
    }
  });

  it("does not register legacy recommendation write routes", () => {
    expect(source("src/modules/backlinks/api/private-server.ts")).not.toContain(
      "registerBacklinksRecommendationCommandsRoutes",
    );
    expect(source("scripts/check-backlinks-openapi.ts")).not.toContain(
      "registerBacklinksRecommendationCommandsRoutes",
    );
  });

  it("does not bundle the retired refill workflow", () => {
    expect(
      source("src/modules/backlinks/workflows/definitions/index.ts"),
    ).not.toContain("backlink-recommendation-refill.workflow");
  });

  it("does not construct retired recommendation execution paths", () => {
    const runtime = source("src/modules/backlinks/runtime/production-runtime.ts");
    for (const retired of [
      "createRecommendationCommands",
      "createRecommendationRefillOutboxRelay",
      "createTemporalRecommendationRefillConsumer",
      "ensureCommercialRecommendationRefill",
      "ensureCurrentCommercialStaticAssessmentRecovery",
      "reserveRecommendationRefillJob",
      "backlinksExecuteRecommendationRefillV1",
      "backlinksReserveRecommendationRefillV1",
      "backlinksPlanRecommendationRefillSupplyV1",
      "backlinksCompleteRecommendationRefillSupplyV1",
      "backlinksRecordRecommendationRefillFailureV1",
      "../workflows/definitions/recovery.js",
    ]) {
      expect(runtime, retired).not.toContain(retired);
    }
  });
});
