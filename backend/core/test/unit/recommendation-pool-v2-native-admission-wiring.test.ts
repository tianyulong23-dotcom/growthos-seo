import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

describe("recommendation pool V2 native admission wiring", () => {
  it("keeps the V2 executor independent from V1 refill, store, and score admission", () => {
    const executor = source(
      "../../src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.ts",
    );

    expect(executor).not.toContain("prepareReadyRecommendationRefill");
    expect(executor).not.toContain("runtime.store");
    expect(executor).not.toContain("recommendation-commercial-fit.v4");
    expect(executor).not.toContain("appliedThreshold");
  });

  it("returns the native V2 discovery result before V1 progressive admission", () => {
    const discovery = source(
      "../../src/modules/backlinks/application/services/commercial-recommendation-discovery.service.ts",
    );
    const progressiveAdmission = discovery.indexOf(
      "applyProgressiveCommercialCandidateAdmission(",
    );
    const collectionFinished = discovery.lastIndexOf(
      "await ensureBatchOpen();",
      progressiveAdmission,
    );
    const nativeBranch = discovery.indexOf(
      "if (input.nativeV2 !== undefined) {",
      collectionFinished,
    );
    const nativeReturn = discovery.indexOf("return Object.freeze({", nativeBranch);

    expect(collectionFinished).toBeGreaterThan(-1);
    expect(nativeBranch).toBeGreaterThan(collectionFinished);
    expect(nativeReturn).toBeGreaterThan(nativeBranch);
    expect(nativeReturn).toBeLessThan(progressiveAdmission);
  });

  it("removes V1 static and contact work from the native V2 runtime", () => {
    const runtime = source(
      "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts",
    );
    const discoveryResult = runtime.indexOf(
      "const commercial = await (async () =>",
    );
    const nativeReturn = runtime.indexOf("return Object.freeze({", discoveryResult);
    expect(discoveryResult).toBeGreaterThan(-1);
    expect(nativeReturn).toBeGreaterThan(discoveryResult);
    expect(runtime).not.toContain("recoverCurrentCommercialStaticAssessments");
    expect(runtime).not.toContain("prepareCurrentCommercialCandidateEnrichment");
    expect(runtime).not.toContain("ensureReadyContactEnrichmentJobs");
  });
});
