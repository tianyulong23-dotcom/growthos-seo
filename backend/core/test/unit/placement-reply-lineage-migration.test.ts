import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "src/modules/backlinks/db/migrations/0074_backlink_placement_reply_lineage.sql",
);

describe("P5 Placement reply lineage migration", () => {
  it("adds immutable project-scoped reply and planned Placement lineage", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain("ADD COLUMN reply_id uuid");
    expect(sql).toContain("ADD COLUMN planned_placement_id uuid");
    expect(sql).toContain("backlink_placement_candidate_reply_assignment_fk");
    expect(sql).toContain("backlink_placement_candidate_full_lineage_uq");
    expect(sql).toContain("backlink_placement_full_lineage_fk");
    expect(sql).toContain("requires_manual_confirmation");
    expect(sql).toContain("MATCH_CONFIRMED");
    expect(sql).toContain("source_type = 'manual'");
  });
});
