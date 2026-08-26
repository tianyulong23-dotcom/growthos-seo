import { describe, expect, it, vi } from "vitest";

import {
  reconcilePublishedOpportunityContacts,
  synchronizeRecommendationContactState,
} from "../../src/modules/backlinks/application/services/recommendation-contact-synchronization.service.js";

const input = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  prospectId: "018f0000-0000-7000-8000-000000000004",
  recommendationContextVersionId:
    "018f0000-0000-7000-8000-000000000005",
  actorId: "contact-worker",
};

describe("recommendation contact synchronization", () => {
  it("publishes first and then reconciles downstream Opportunities", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ emailCount: 1 }] })
      .mockResolvedValueOnce({ rows: [{ reconciledCount: 1 }] });

    const result = await synchronizeRecommendationContactState(
      { query },
      input,
    );

    expect(result).toEqual({
      emailCount: 1,
      reconciledOpportunityCount: 1,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).not.toContain(
      "backlink_opportunities",
    );
    expect(String(query.mock.calls[1]?.[0])).toContain(
      "UPDATE backlink_opportunities",
    );
  });

  it("only binds verified public contacts to unresolved email Opportunities", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ reconciledCount: 2 }],
    });

    const count = await reconcilePublishedOpportunityContacts(
      { query },
      {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        actorId: input.actorId,
      },
    );

    expect(count).toBe(2);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("contact_reason_code='PUBLIC_EMAIL_FOUND'");
    expect(sql).toContain("candidate.guessed=false");
    expect(sql).toContain("evidence.expires_at>now()");
    expect(sql).toContain(
      "'mailto','visible_text','obfuscated_text','json_ld'",
    );
    expect(sql).toContain("opportunity.engagement_channel='EMAIL'");
    expect(sql).toContain(
      "opportunity.source_contact_candidate_id IS NULL",
    );
    expect(sql).toContain("opportunity.contact_review_required=true");
    expect(sql).toContain("INSERT INTO backlink_contacts");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("'opportunity.contact_auto_bound'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.actorId,
      null,
      null,
    ]);
  });
});
