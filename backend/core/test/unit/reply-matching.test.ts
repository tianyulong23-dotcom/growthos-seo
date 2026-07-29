import { describe, expect, it } from "vitest";

import {
  matchInboundReply,
  replyMatchDecisions,
  replyMatchEvidenceKinds,
  type OutboundReplyReference,
} from "../../src/modules/backlinks/domain/replies/matching.js";

const scope = {
  organizationId: "organization-134",
  workspaceId: "workspace-134",
  websiteProjectId: "project-134",
  gmailConnectionId: "gmail-134",
};

const inbound = {
  ...scope,
  providerThreadId: "gmail-thread-134",
  inReplyToMessageId: "<outbound-134@example.test>",
  referenceMessageIds: [],
  fromAddress: "editor@example.test",
  participantAddresses: [
    "owner@example.test",
    "editor@example.test",
  ],
  subject: "Re: GrowthOS collaboration",
  receivedAt: new Date("2026-07-28T09:00:00.000Z"),
};

const outbound = {
  ...scope,
  opportunityId: "opportunity-134",
  mailThreadId: "mail-thread-134",
  providerThreadId: "gmail-thread-134",
  rfcMessageId: "<outbound-134@example.test>",
  contactAddress: "editor@example.test",
  participantAddresses: [
    "owner@example.test",
    "editor@example.test",
  ],
  subject: "GrowthOS collaboration",
  sentAt: new Date("2026-07-27T09:00:00.000Z"),
} satisfies OutboundReplyReference;

describe("BL-AI-134 Reply candidate matching", () => {
  it("auto-matches unique strong evidence only inside the exact scope", () => {
    const result = matchInboundReply(inbound, [
      outbound,
      {
        ...outbound,
        websiteProjectId: "project-other",
        opportunityId: "opportunity-cross-project",
      },
      {
        ...outbound,
        workspaceId: "workspace-other",
        opportunityId: "opportunity-cross-workspace",
      },
      {
        ...outbound,
        gmailConnectionId: "gmail-other",
        opportunityId: "opportunity-cross-connection",
      },
    ]);

    expect(result.decision).toBe(replyMatchDecisions.autoMatched);
    expect(result.matchedOpportunityId).toBe("opportunity-134");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.evidence.map((item) => item.kind)).toEqual([
      replyMatchEvidenceKinds.providerThreadExact,
      replyMatchEvidenceKinds.inReplyToExact,
      replyMatchEvidenceKinds.knownContact,
      replyMatchEvidenceKinds.normalizedSubject,
      replyMatchEvidenceKinds.participantOverlap,
      replyMatchEvidenceKinds.timeWindow,
    ]);
  });

  it("uses References as strong evidence and de-duplicates one Opportunity", () => {
    const result = matchInboundReply({
      ...inbound,
      providerThreadId: null,
      inReplyToMessageId: null,
      referenceMessageIds: [
        "<older@example.test>",
        "<outbound-134@example.test>",
      ],
    }, [
      outbound,
      {
        ...outbound,
        mailThreadId: "mail-thread-134-follow-up",
        providerThreadId: "gmail-thread-134-follow-up",
        rfcMessageId: "<outbound-follow-up@example.test>",
      },
    ]);

    expect(result).toMatchObject({
      decision: replyMatchDecisions.autoMatched,
      matchedOpportunityId: "opportunity-134",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.evidence).toContainEqual({
      kind: replyMatchEvidenceKinds.referencesExact,
      outboundMessageId: "<outbound-134@example.test>",
    });
  });

  it("never resolves conflicting strong evidence by score", () => {
    const result = matchInboundReply(inbound, [
      {
        ...outbound,
        rfcMessageId: "<different@example.test>",
      },
      {
        ...outbound,
        opportunityId: "opportunity-conflict",
        mailThreadId: "mail-thread-conflict",
        providerThreadId: "gmail-thread-conflict",
      },
    ]);

    expect(result.decision).toBe(replyMatchDecisions.conflicted);
    expect(result.matchedOpportunityId).toBeNull();
    expect(result.candidates.map((candidate) => candidate.opportunityId))
      .toEqual([
        "opportunity-134",
        "opportunity-conflict",
      ]);
  });

  it("keeps an exact normalized subject as a low-confidence manual candidate", () => {
    const result = matchInboundReply({
      ...inbound,
      providerThreadId: null,
      inReplyToMessageId: null,
      fromAddress: null,
      participantAddresses: [],
      receivedAt: new Date("2026-07-20T09:00:00.000Z"),
    }, [{
      ...outbound,
      providerThreadId: null,
      rfcMessageId: null,
      contactAddress: null,
      participantAddresses: [],
      sentAt: new Date("2026-07-27T09:00:00.000Z"),
    }]);

    expect(result).toMatchObject({
      decision: replyMatchDecisions.reviewRequired,
      matchedOpportunityId: null,
      confidence: "LOW",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      opportunityId: "opportunity-134",
      requiresManualConfirmation: true,
      confidence: "LOW",
      evidence: [{
        kind: replyMatchEvidenceKinds.normalizedSubject,
        value: "growthos collaboration",
      }],
    });
  });

  it("keeps combined contact, subject, participant, and time evidence manual", () => {
    const result = matchInboundReply({
      ...inbound,
      providerThreadId: null,
      inReplyToMessageId: null,
    }, [{
      ...outbound,
      providerThreadId: null,
      rfcMessageId: null,
    }]);

    expect(result.decision).toBe(replyMatchDecisions.reviewRequired);
    expect(result.matchedOpportunityId).toBeNull();
    expect(result.confidence).toBe("MEDIUM");
    expect(result.candidates[0]?.requiresManualConfirmation).toBe(true);
  });

  it("returns UNMATCHED without leaking unrelated candidates", () => {
    const result = matchInboundReply({
      ...inbound,
      providerThreadId: null,
      inReplyToMessageId: null,
      referenceMessageIds: [],
      fromAddress: "unknown@example.test",
      participantAddresses: ["unknown@example.test"],
      subject: "Unrelated topic",
    }, [outbound]);

    expect(result).toEqual({
      decision: replyMatchDecisions.unmatched,
      confidence: "NONE",
      matchedOpportunityId: null,
      matchedMailThreadId: null,
      candidates: [],
      ruleVersion: "reply-matcher-v1",
    });
  });
});
