import { describe, expect, it } from "vitest";

import {
  findBreakingOpenApiChanges,
  findSensitiveOpenApiFields,
  generateBacklinksOpenApi,
  type JsonValue,
} from "../../scripts/check-backlinks-openapi.js";

const baseline: JsonValue = {
  paths: {
    "/summary": {
      schema: {
        type: "object",
        required: ["summary", "meta"],
        properties: {
          summary: { type: "object" },
          meta: { type: "object" },
        },
      },
    },
  },
};

describe("findBreakingOpenApiChanges", () => {
  it("allows additive fields", () => {
    const additive: JsonValue = {
      paths: {
        "/summary": {
          schema: {
            type: "object",
            required: ["summary", "meta"],
            properties: {
              summary: { type: "object" },
              meta: { type: "object" },
              future: { type: "string" },
            },
          },
        },
      },
    };
    expect(findBreakingOpenApiChanges(baseline, additive)).toEqual([]);
  });

  it("rejects a deleted response field fixture", () => {
    const deletedFieldFixture: JsonValue = {
      paths: {
        "/summary": {
          schema: {
            type: "object",
            required: ["summary", "meta"],
            properties: {
              summary: { type: "object" },
            },
          },
        },
      },
    };
    expect(findBreakingOpenApiChanges(baseline, deletedFieldFixture)).toContain(
      "$.paths./summary.schema.properties.meta is missing",
    );
  });

  it("rejects a sensitive internal field fixture", () => {
    const sensitiveFieldFixture: JsonValue = {
      schema: {
        type: "object",
        properties: {
          providerPayload: { type: "object" },
        },
      },
    };
    expect(findSensitiveOpenApiFields(sensitiveFieldFixture)).toContain(
      "$.schema.properties.providerPayload",
    );
  });

  it("publishes the corrected Links contract without internal evidence fields", async () => {
    const contract = await generateBacklinksOpenApi();
    const serialized = JSON.stringify(contract);

    expect(serialized).toContain("backlinksListPlacementLifecycleEventsV1");
    expect(serialized).toContain("backlinksGetPlacementEvidenceV1");
    expect(serialized).toContain("backlinksReverifyPlacementV1");
    expect(serialized).toContain('"latestObservation"');
    expect(serialized).toContain('"latestMonitorRun"');
    expect(serialized).toContain('"freshness"');
    expect(serialized).toContain('"recovered"');
    expect(findSensitiveOpenApiFields(contract)).toEqual([]);
    for (const forbidden of [
      "providerPayload",
      "objectKey",
      "storagePath",
      "resolvedIps",
      "accessToken",
      "refreshToken",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
