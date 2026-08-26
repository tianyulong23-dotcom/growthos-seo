import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL(
    "../../../src/modules/backlinks/db/migrations/0061_backlink_project_input_persistence.sql",
    import.meta.url,
  ),
);

describe("0061 Backlinks project input persistence migration", () => {
  it("defines immutable tenant-scoped inputs and retained dependency guards", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of [
      "backlink_outreach_profile_versions",
      "backlink_shared_seo_evidence_references",
      "backlink_generation_input_pins",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("backlink_reject_immutable_project_input");
    expect(sql).toContain("backlink_outreach_profile_scope_version_uq");
    expect(sql).toContain("backlink_list_project_retained_dependencies");
    expect(sql).toContain("ON DELETE RESTRICT");
    expect(sql).not.toMatch(/api\.dataforseo\.com|gmail\.googleapis\.com/i);
  });
});
