import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const scriptUrl = new URL(
  "../../../scripts/apply-recommendation-pool-v2-native-generation-migration.ts",
  import.meta.url,
);
const compatibilityScriptUrl = new URL(
  "../../../scripts/apply-recommendation-pool-v2-generation-compatibility-migration.ts",
  import.meta.url,
);
const evidenceReplayScriptUrl = new URL(
  "../../../scripts/apply-recommendation-pool-v2-evidence-replay-migration.ts",
  import.meta.url,
);

describe("recommendation pool V2 native generation migration runner", () => {
  it("registers a manifest-bound 0085 to 0086 runner", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const source = await readFile(scriptUrl, "utf8");

    expect(
      packageJson.scripts?.[
        "local-product:recommendation-pool-v2:native-generation-migrate"
      ],
    ).toBe(
      "tsx scripts/apply-recommendation-pool-v2-native-generation-migration.ts",
    );
    expect(source).toContain('const expectedMigrationId = "backlinks-0086"');
    expect(source).toContain('const expectedPrerequisite = "backlinks-0085"');
    expect(source).toContain(
      "BACKLINKS_V2_NATIVE_GENERATION_HASH_MISMATCH",
    );
    expect(source).toContain(
      "BACKLINKS_V2_NATIVE_GENERATION_REQUIRES_0085",
    );
    expect(source).not.toMatch(/gmail|oauth|dataforseo|temporal|workflow/i);
  });

  it("applies the reviewed migration and verifies V1 remains frozen", async () => {
    const source = await readFile(scriptUrl, "utf8");

    expect(source).toContain("await pool.query(sql)");
    expect(source).toContain(
      "backlinks.backlink_recommendation_pool_v2_native_generation_verify()",
    );
    expect(source).toContain("v2_generation_job_allowed");
    expect(source).toContain("v1_writes_frozen");
  });

  it("registers the 0086 to 0087 compatibility correction", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const source = await readFile(compatibilityScriptUrl, "utf8");

    expect(
      packageJson.scripts?.[
        "local-product:recommendation-pool-v2:generation-compatibility-migrate"
      ],
    ).toBe(
      "tsx scripts/apply-recommendation-pool-v2-generation-compatibility-migration.ts",
    );
    expect(source).toContain('const expectedMigrationId = "backlinks-0087"');
    expect(source).toContain('const expectedPrerequisite = "backlinks-0086"');
    expect(source).toContain(
      "BACKLINKS_V2_GENERATION_COMPATIBILITY_HASH_MISMATCH",
    );
    expect(source).toContain(
      "v2_generation_precedes_legacy_classification",
    );
    expect(source).toContain("v1_writes_frozen");
    expect(source).not.toMatch(/gmail|oauth|dataforseo|temporal|workflow/i);
  });

  it("registers the 0087 to 0088 zero-cost evidence replay migration", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const source = await readFile(evidenceReplayScriptUrl, "utf8");

    expect(
      packageJson.scripts?.[
        "local-product:recommendation-pool-v2:evidence-replay-migrate"
      ],
    ).toBe(
      "tsx scripts/apply-recommendation-pool-v2-evidence-replay-migration.ts",
    );
    expect(source).toContain('const expectedMigrationId = "backlinks-0088"');
    expect(source).toContain('const expectedPrerequisite = "backlinks-0087"');
    expect(source).toContain("BACKLINKS_V2_EVIDENCE_REPLAY_HASH_MISMATCH");
    expect(source).toContain("evidence_replay_columns_present");
    expect(source).toContain("outcome_trigger_supports_evidence_replay");
    expect(source).toContain("v1_writes_frozen");
    expect(source).not.toMatch(/gmail|oauth|dataforseo|temporal|workflow/i);
  });
});
