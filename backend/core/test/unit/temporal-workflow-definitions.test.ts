import { describe, expect, it } from "vitest";

describe("Temporal workflow definitions", () => {
  it("load in an ESM runtime without a CommonJS require global", async () => {
    const definitions = await import(
      "../../src/modules/backlinks/workflows/definitions/index.js"
    );

    expect(
      definitions.backlinksPlacementMonitoringInitializationV1Workflow,
    ).toBeTypeOf("function");
  });
});
