import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const scriptUrl = new URL(
  "../../../scripts/run-recommendation-pool-v2-phase9.ts",
  import.meta.url,
);

describe("recommendation pool V2 Phase 9 operator entrypoint", () => {
  it("registers the production command and invokes only the guarded Phase 9 database function", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const source = await readFile(scriptUrl, "utf8");

    expect(
      packageJson.scripts?.["local-product:recommendation-pool-v2:phase9"],
    ).toBe("tsx scripts/run-recommendation-pool-v2-phase9.ts");
    expect(source).toContain(
      "backlinks.backlink_recommendation_pool_v2_phase9_run(",
    );
    expect(source).not.toMatch(
      /dataforseo|gmail|oauth|provider request|temporal|workflow/i,
    );
  });

  it("requires a stable run ID and an explicit PLAN, EXECUTE, or VERIFY command", async () => {
    const source = await readFile(scriptUrl, "utf8");

    expect(source).toContain("runId: z.string().uuid()");
    expect(source).toContain('mode: z.enum(["PLAN", "EXECUTE", "VERIFY"])');
    expect(source).toContain("commandId: nonBlank");
    expect(source).toContain("actor: nonBlank");
    expect(source).toMatch(/\}\)\s*\.strict\(\);/);
    expect(source).toContain("DATABASE_URL_REQUIRED");
  });
});
