import { describe, expect, it, vi } from "vitest";

import {
  synchronizeRecommendationPublication,
} from "../../src/modules/backlinks/application/services/recommendation-publication.service.js";

describe("recommendation publication gate", () => {
  it("publishes only from a current valid public email evidence count", async () => {
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
  });
});
