import { describe, expect, it } from "vitest";

import {
  createOpportunityRepository,
} from "../../src/modules/backlinks/db/repositories/opportunity.repository.js";

describe("Opportunity selection contract", () => {
  it("binds creation to the latest visible project generation atomically", async () => {
    const calls: Readonly<{ text: string; values?: readonly unknown[] }>[] = [];
    const repository = createOpportunityRepository({
      query: async (text, values) => {
        (calls as { text: string; values?: readonly unknown[] }[])
          .push({ text, values });
        return {
          rows: [{
            state: "completed",
            requestHash: "request-hash",
            responseBody: {
              opportunityId: "018f0000-0000-7000-8000-000000000001",
            },
          }],
        };
      },
    });

    await repository.createFromRecommendation({
      organizationId: "018f0000-0000-7000-8000-000000000010",
      workspaceId: "018f0000-0000-7000-8000-000000000011",
      websiteProjectId: "018f0000-0000-7000-8000-000000000012",
      actorId: "user-1",
      recommendationId: "018f0000-0000-7000-8000-000000000013",
      contactCandidateId: null,
      expectedVersion: 1,
      idempotencyKey: "opportunity-selection-contract",
      requestHash: "request-hash",
      requestId: "request-1",
      idempotencyRecordId: "018f0000-0000-7000-8000-000000000014",
      opportunityId: "018f0000-0000-7000-8000-000000000015",
      cycleId: "018f0000-0000-7000-8000-000000000016",
      lifecycleEventId: "018f0000-0000-7000-8000-000000000017",
      auditEventId: "018f0000-0000-7000-8000-000000000018",
      contactId: "018f0000-0000-7000-8000-000000000019",
    });

    const sql = calls[0]?.text ?? "";
    expect(sql).toContain("policy.visible_pool_generation");
    expect(sql).toContain("i.visible_pool_generation");
    expect(sql).toContain("policy.visible_pool_state IN ('building','active')");
    expect(sql).toContain("ORDER BY current_policy.updated_at DESC");
    expect(sql).toContain("backlink_recommendation_generation_contracts");
    expect(sql).toContain("'visiblePoolGeneration',s.visible_pool_generation");
    expect(sql).toContain("'immutableFingerprint',s.selection_immutable_fingerprint");
    expect(sql).toContain("'selectedTargetUrl',s.selection_target_url");
  });
});
