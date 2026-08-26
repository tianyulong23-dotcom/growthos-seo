import { describe, expect, it, vi } from "vitest";

import {
  synchronizeRecommendationPublication,
} from "../../src/modules/backlinks/application/services/recommendation-publication.service.js";

describe("recommendation publication gate", () => {
  it("publishes from current valid evidence without rewriting job history", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ emailCount: 1 }],
    });
    const count = await synchronizeRecommendationPublication({ query }, {
      organizationId: "org",
      workspaceId: "workspace",
      websiteProjectId: "project",
      prospectId: "prospect",
      recommendationContextVersionId: "context",
      actorId: "worker",
    });

    expect(count).toBe(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("publication_status=CASE");
    expect(sql).toContain(
      "WHEN fit_candidate.fit_decision='eligible' THEN 'PUBLISHED'",
    );
    expect(sql).toContain("'recommendation-commercial-fit.v4'");
    expect(sql).not.toContain("'recommendation-commercial-fit.v3'");
    expect(sql).not.toContain(
      "AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'",
    );
    expect(sql).not.toContain(
      "AND inventory.verified_public_email_count>=1",
    );
    expect(sql).not.toContain(
      "latest_job.terminal_reason_code='PUBLIC_EMAIL_FOUND'",
    );
    expect(sql).toContain(
      "'mailto','visible_text','obfuscated_text','json_ld'",
    );
    expect(sql).not.toContain("'manual-public-evidence.v1'");
    expect(sql).toContain("candidate.inferred_purpose IN");
    expect(sql).toContain("INSERT INTO backlink_contact_evidence_snapshots");
    expect(sql).toContain("contact_evidence_snapshot_id=COALESCE");
    expect(sql).toContain("evidence.expires_at>now()");
    expect(sql).toContain("candidate.email_domain_ascii NOT LIKE '%.invalid'");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("EXISTS (SELECT 1 FROM generation_contract)");
    expect(sql).toContain("corrected_visibility_capacity.visible_count");
    expect(sql).toContain(
      "pool_policy.visible_pool_state IN ('building','active')",
    );
    expect(sql).toContain("LIMIT 1");
    const activation = sql.slice(
      sql.indexOf("activated AS"),
      sql.indexOf("RETURNING policy.visible_pool_generation"),
    );
    expect(activation).toContain("current_pool.published_count>0");
    expect(activation).not.toMatch(
      /AND current_pool\.published_count>=\s*pool_policy\.visible_pool_target_count/,
    );
    expect(activation).toContain(
      "current_pool.published_count>=pool_policy.visible_pool_target_count",
    );
    expect(sql).toContain(
      "last_publishable_count=current_pool.published_count",
    );
    expect(sql).toContain("pause_reason=CASE");
    expect(sql).not.toContain("backlink_opportunities");
    expect(sql).not.toContain("backlink_mail");
    expect(sql).not.toContain("backlink_placements");
  });
});
