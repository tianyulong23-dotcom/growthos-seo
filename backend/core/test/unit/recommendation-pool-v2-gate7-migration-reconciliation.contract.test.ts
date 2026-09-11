import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type DeploymentManifest = Readonly<{
  heads: Readonly<{ backlinks: string }>;
  steps: readonly Readonly<{
    migrationId: string;
    path: string;
    sha256: string;
    prerequisites: readonly string[];
  }>[];
}>;

describe("recommendation pool V2 Gate 7 migration reconciliation", () => {
  it("repairs the cross-tenant 0091 reconciliation behind a locked RLS boundary", () => {
    const migration = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/migrations/0093_backlink_recommendation_pool_v2_candidate_fact_reconciliation.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const lockIndex = migration.indexOf(
      "LOCK TABLE\n  backlink_recommendation_pool_project_contracts,\n  backlink_recommendation_generation_contracts,\n  backlink_generation_input_pins\n  IN ACCESS EXCLUSIVE MODE;",
    );
    const noForceIndex = migration.indexOf(
      "ALTER TABLE backlink_recommendation_pool_project_contracts\n  NO FORCE ROW LEVEL SECURITY;",
    );
    const updateIndex = migration.indexOf(
      "UPDATE backlink_recommendation_pool_project_contracts AS contract",
    );
    const forceIndex = migration.indexOf(
      "ALTER TABLE backlink_recommendation_pool_project_contracts\n  FORCE ROW LEVEL SECURITY;",
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(noForceIndex).toBeGreaterThan(lockIndex);
    expect(migration).toContain(
      "ALTER TABLE backlink_recommendation_generation_contracts\n  NO FORCE ROW LEVEL SECURITY;",
    );
    expect(migration).toContain(
      "ALTER TABLE backlink_generation_input_pins\n  NO FORCE ROW LEVEL SECURITY;",
    );
    expect(updateIndex).toBeGreaterThan(noForceIndex);
    expect(forceIndex).toBeGreaterThan(updateIndex);
    expect(migration).toContain(
      "ALTER TABLE backlink_recommendation_generation_contracts\n  FORCE ROW LEVEL SECURITY;",
    );
    expect(migration).toContain(
      "ALTER TABLE backlink_generation_input_pins\n  FORCE ROW LEVEL SECURITY;",
    );
    expect(migration).toContain("migration_state = 'MIGRATION_BLOCKED'");
    expect(migration).toContain("V2_CANDIDATE_LINEAGE_INCOMPLETE");
    expect(migration).toContain("updated_by = 'backlinks-0093'");
    expect(migration).toContain(
      "backlink_pool_v2_candidate_fact_reconciliation_verify()",
    );
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE)\b/u);
  });

  it("publishes 0093 as a forward-only manifest step after 0092", () => {
    const migration = readFileSync(
      new URL(
        "../../src/modules/backlinks/db/migrations/0093_backlink_recommendation_pool_v2_candidate_fact_reconciliation.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../database/deployment-manifest.v1.json", import.meta.url),
        "utf8",
      ),
    ) as DeploymentManifest;
    const step = manifest.steps.find(
      ({ migrationId }) => migrationId === "backlinks-0093",
    );
    const sha256 = createHash("sha256")
      .update(migration.replace(/\r\n/gu, "\n"))
      .digest("hex");

    expect(Number.parseInt(manifest.heads.backlinks, 10)).toBeGreaterThanOrEqual(93);
    expect(step).toMatchObject({
      path: "backend/core/src/modules/backlinks/db/migrations/0093_backlink_recommendation_pool_v2_candidate_fact_reconciliation.sql",
      prerequisites: ["backlinks-0092"],
      sha256,
    });
  });
});
