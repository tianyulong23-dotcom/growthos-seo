import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const scriptUrl = new URL(
  "../../../scripts/run-recommendation-pool-v2-cutover.ts",
  import.meta.url,
);

describe("recommendation pool V2 cutover operator entrypoint", () => {
  it("registers the production command and composes only the cutover repository and service", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const source = await readFile(scriptUrl, "utf8");

    expect(
      packageJson.scripts?.["local-product:recommendation-pool-v2:cutover"],
    ).toBe("tsx scripts/run-recommendation-pool-v2-cutover.ts");
    expect(source).toContain(
      "createRecommendationPoolV2CutoverRepository(pool)",
    );
    expect(source).toContain(
      "createRecommendationPoolV2CutoverService(repository)",
    );
    expect(source).toContain("await service.run(command)");
    expect(source).not.toMatch(
      /dataforseo|provider|temporal|workflow|contact-enrichment/i,
    );
  });

  it("accepts only explicit PLAN, EXECUTE, or VERIFY commands from standard input", async () => {
    const source = await readFile(scriptUrl, "utf8");

    expect(source).toContain('mode: z.enum(["PLAN", "EXECUTE", "VERIFY"])');
    expect(source).toContain("commandId: nonBlank");
    expect(source).toContain("actor: nonBlank");
    expect(source).toMatch(/\}\)\s*\.strict\(\);/);
    expect(source).toContain("DATABASE_URL_REQUIRED");
  });
});
