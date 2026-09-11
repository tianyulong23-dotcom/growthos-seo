import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const scriptUrl = new URL(
  "../../../scripts/apply-recommendation-pool-v2-phase9-migration.ts",
  import.meta.url,
);

describe("recommendation pool V2 Phase 9 migration runner", () => {
  it("registers a manifest-bound 0084 to 0085 runner", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const source = await readFile(scriptUrl, "utf8");

    expect(
      packageJson.scripts?.[
        "local-product:recommendation-pool-v2:phase9-migrate"
      ],
    ).toBe("tsx scripts/apply-recommendation-pool-v2-phase9-migration.ts");
    expect(source).toContain('const expectedMigrationId = "backlinks-0085"');
    expect(source).toContain('const expectedPrerequisite = "backlinks-0084"');
    expect(source).toContain("BACKLINKS_PHASE9_MIGRATION_HASH_MISMATCH");
    expect(source).toContain("BACKLINKS_PHASE9_MIGRATION_REQUIRES_0084");
    expect(source).not.toMatch(/gmail|oauth|dataforseo|temporal|workflow/i);
  });

  it("applies the reviewed migration file and verifies its schema marker", async () => {
    const source = await readFile(scriptUrl, "utf8");

    expect(source).toContain("await pool.query(sql)");
    expect(source).toContain("if (!before.has0085)");
    expect(source).toContain("if (!after.has0085)");
    expect(source).toContain("source_candidate_qualification_fact_id");
    expect(source).toContain("source_visibility_qualification_fact_id");
    expect(source).toContain(
      "backlinks.backlink_recommendation_pool_v2_phase9_verify()",
    );
  });
});
