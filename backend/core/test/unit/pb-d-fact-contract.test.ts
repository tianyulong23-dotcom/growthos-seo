import { describe, expect, it } from "vitest";

import {
  createDraftEditingRepository,
  draftApprovalFactContractVersion,
} from "../../src/modules/backlinks/application/repositories/draft-generation.repository.js";
import {
  createReplyAssignmentFact,
  replyAssignmentFactContractVersion,
} from "../../src/modules/backlinks/application/services/reply-match.repository.js";

describe("BL-AI-161 prerequisite PB-D fact contracts", () => {
  it("keeps Draft approval, lifecycle fact, and audit in one statement", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const repository = createDraftEditingRepository({
      async query(text, values = []) {
        calls.push({ text, values });
        return {
          rows: [{
            draftId: "018f0000-0000-7000-8000-000000000501",
            versionId: "018f0000-0000-7000-8000-000000000701",
            draftVersion: 3,
            status: "approved",
          }],
        };
      },
    }, {
      newId: (() => {
        const ids = [
          "018f0000-0000-7000-8000-000000000801",
          "018f0000-0000-7000-8000-000000000802",
        ];
        return () => ids.shift() ?? "";
      })(),
    });

    await expect(repository.approve({
      organizationId: "018f0000-0000-7000-8000-000000000001",
      workspaceId: "018f0000-0000-7000-8000-000000000002",
      websiteProjectId: "018f0000-0000-7000-8000-000000000003",
      draftId: "018f0000-0000-7000-8000-000000000501",
      expectedVersion: 2,
      actorId: "user-161",
      recordedAt: new Date("2026-07-29T04:00:00.000Z"),
    })).resolves.toMatchObject({
      state: "completed",
      draftVersion: 3,
      status: "approved",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("WITH target AS");
    expect(calls[0]?.text).toContain("JOIN backlink_draft_versions v");
    expect(calls[0]?.text).toContain("v.source<>'TEMPLATE_FALLBACK'");
    expect(calls[0]?.text).toContain("INSERT INTO backlink_lifecycle_events");
    expect(calls[0]?.text).toContain("INSERT INTO backlink_audit_events");
    expect(calls[0]?.text).toContain("'draft.approval.recorded'");
    expect(calls[0]?.text).toContain("'draftId'");
    expect(calls[0]?.text).toContain("'approvedVersionId'");
    expect(calls[0]?.text).toContain("'previousAggregateVersion'");
    expect(calls[0]?.text).toContain("'nextAggregateVersion'");
    expect(calls[0]?.values).toContain(draftApprovalFactContractVersion);
  });

  it("uses one immutable Reply assignment payload for AUTO and MANUAL", () => {
    const common = {
      inboundMessageId: "018f0000-0000-7000-8000-000000000601",
      providerMessageId: "provider-message-161",
      providerThreadId: "provider-thread-161",
      matchCandidateId: "018f0000-0000-7000-8000-000000000801",
      opportunityId: "018f0000-0000-7000-8000-000000000701",
      confidence: 0.6,
      ruleVersion: "reply-matcher-v1",
      actorId: "user-161",
      occurredAt: new Date("2026-07-29T04:01:00.000Z"),
    } as const;

    expect(createReplyAssignmentFact({
      ...common,
      matchAuthority: "AUTO",
    })).toEqual({
      ...common,
      occurredAt: "2026-07-29T04:01:00.000Z",
      matchAuthority: "AUTO",
      contractVersion: replyAssignmentFactContractVersion,
    });
    expect(createReplyAssignmentFact({
      ...common,
      matchAuthority: "MANUAL",
    })).toEqual({
      ...common,
      occurredAt: "2026-07-29T04:01:00.000Z",
      matchAuthority: "MANUAL",
      contractVersion: replyAssignmentFactContractVersion,
    });
  });
});
