import { describe, expect, it } from "vitest";

import { backlinksConfigSchema } from "../../../src/modules/backlinks/config/index.js";

const requiredConfig = {
  BACKLINK_API_BODY_LIMIT: "1048576",
  BACKLINK_API_REQUEST_TIMEOUT_MS: "30000",
};

describe("backlinksConfigSchema", () => {
  it("parses required API limits and keeps the API disabled by default", () => {
    expect(backlinksConfigSchema.parse(requiredConfig)).toEqual({
      BACKLINKS_API_ENABLED: false,
      BACKLINK_API_BODY_LIMIT: 1_048_576,
      BACKLINK_API_REQUEST_TIMEOUT_MS: 30_000,
    });
  });

  it("accepts an explicit true API switch", () => {
    expect(
      backlinksConfigSchema.parse({
        ...requiredConfig,
        BACKLINKS_API_ENABLED: "true",
      }).BACKLINKS_API_ENABLED,
    ).toBe(true);
  });

  it("rejects missing required API limits", () => {
    expect(
      backlinksConfigSchema.safeParse({
        BACKLINK_API_BODY_LIMIT: requiredConfig.BACKLINK_API_BODY_LIMIT,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["invalid boolean", { ...requiredConfig, BACKLINKS_API_ENABLED: "1" }],
    ["zero body limit", { ...requiredConfig, BACKLINK_API_BODY_LIMIT: "0" }],
    [
      "decimal timeout",
      { ...requiredConfig, BACKLINK_API_REQUEST_TIMEOUT_MS: "10.5" },
    ],
  ])("rejects %s", (_name, config) => {
    expect(backlinksConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects unknown configuration keys", () => {
    expect(
      backlinksConfigSchema.safeParse({
        ...requiredConfig,
        BACKLINKS_WORKER_ENABLED: "true",
      }).success,
    ).toBe(false);
  });
});
