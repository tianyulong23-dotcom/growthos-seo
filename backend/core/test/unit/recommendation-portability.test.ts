import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { observedContactPageSql } from "../../src/modules/backlinks/db/repositories/observed-contact-page.sql.js";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("portable recommendation evidence", () => {
  it("ships contact page migration with the deployment chain, checksum and startup detection", () => {
    const manifest = JSON.parse(read("backend/database/deployment-manifest.v1.json"));
    const migration = manifest.steps.find((step: { migrationId: string }) =>
      step.migrationId === "backlinks-0103");
    expect(Number(manifest.heads.backlinks)).toBeGreaterThanOrEqual(103);
    expect(migration.prerequisites).toEqual(["backlinks-0102"]);
    expect(createHash("sha256").update(read(migration.path).replace(/\r\n/gu, "\n")).digest("hex"))
      .toBe(migration.sha256);
    const startup = read("scripts/dev-up.ps1");
    expect(startup).toContain("column_name IN ('observed_page_url','contact_page_kind')");
    expect(startup).toContain("THEN '0103'");
    expect(startup).toContain("THEN '0102'");
    expect(startup).toContain("deploymentManifest.heads.backlinks");
  });

  it("wires governed metrics into the production worker and ships the bulk allowlist", () => {
    const runtime = read("backend/core/src/modules/backlinks/runtime/production-runtime.ts");
    expect(runtime).toContain("enrichMetrics: createRecommendationPoolV2MetricRuntime");
    const activity = read("backend/core/src/modules/backlinks/activities/recommendation-pool-v2.activity.ts");
    expect(activity).toContain("dependencies.enrichMetrics");
    const env = read("deploy/compose/.env.example");
    for (const endpoint of [
      "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
      "/v3/backlinks/bulk_spam_score/live", "/v3/backlinks/bulk_ranks/live",
    ]) expect(env).toContain(endpoint);
    for (const path of [
      "backend/core/src/modules/backlinks/runtime/recommendation-pool-v2-metric-runtime.ts",
      "backend/core/src/modules/backlinks/runtime/production-runtime.ts",
    ]) {
      expect(read(path)).not.toMatch(/\.codex-checkpoints|C:[\\/]Users[\\/]/);
    }
  });

  it("only reads observed evidence from the same recommendation and matching terminal outcome", () => {
    const sql = observedContactPageSql("item", "item.contact_terminal_reason_at_release");
    for (const field of [
      "organization_id", "workspace_id", "website_project_id",
      "recommendation_context_version_id", "prospect_id", "recommendation_id",
    ]) expect(sql).toContain(`item.${field}`);
    expect(sql).toContain("page_job.completed_at IS NOT NULL");
    expect(sql).toContain("page.contact_page_kind=page_job.terminal_reason_code");
    expect(sql).toContain("page_job.terminal_reason_code=item.contact_terminal_reason_at_release");
  });
});
