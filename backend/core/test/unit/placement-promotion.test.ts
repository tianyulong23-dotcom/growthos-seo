import { describe, expect, it } from "vitest";

import type { EvidenceValue } from "../../src/modules/backlinks/domain/evidence/evidence.js";
import {
  evaluatePlacementPromotion,
  type PlacementCandidate,
} from "../../src/modules/backlinks/domain/placements/placement-promotion.js";

const releaseId = "dataforseo-2026-07-25";

function observed<T>(
  value: T,
  sourceType = "shared_crawler_page_check",
): EvidenceValue<T> {
  return {
    availability: "observed",
    value,
    sourceType,
    sourceReleaseId: releaseId,
    confidence: 0.99,
    observedAt: "2026-07-25T00:00:00.000Z",
    stale: false,
    evidenceRefs: ["page-check:1"],
  };
}

function unavailable<T>(): EvidenceValue<T> {
  return {
    availability: "unavailable",
    reason: "not_observed",
    sourceType: "dataforseo",
    sourceReleaseId: releaseId,
    confidence: 0,
    observedAt: "2026-07-25T00:00:00.000Z",
    stale: false,
    evidenceRefs: ["graph-edge:1"],
  };
}

function candidate(
  overrides: Partial<PlacementCandidate> = {},
): PlacementCandidate {
  return {
    candidateId: "candidate-1",
    opportunityId: "opportunity-1",
    sourceType: "crawler_discovery",
    sourcePageUrl: observed("https://publisher.example/article"),
    targetUrl: observed("https://owner.example/guide"),
    anchorText: observed("streaming guide"),
    rel: observed(["noopener"]),
    verification: {
      method: "direct_page_check",
      result: observed(true),
      verifiedBy: "crawler-worker-1",
      verifiedAt: "2026-07-25T02:00:00.000Z",
      auditEventId: "audit-1",
      initialEvidenceRef: "page-check:1",
    },
    ...overrides,
  };
}

describe("placement promotion gate", () => {
  it("never promotes incomplete domain-level evidence directly", () => {
    const result = evaluatePlacementPromotion(
      candidate({
        sourceType: "dataforseo",
        sourcePageUrl: unavailable(),
        anchorText: unavailable(),
        rel: unavailable(),
        verification: null,
      }),
      "opportunity-1",
    );

    expect(result).toEqual({
      decision: "requires_page_evidence",
      reasons: [
        "SOURCE_PAGE_UNAVAILABLE",
        "ANCHOR_UNAVAILABLE",
        "REL_UNAVAILABLE",
        "VERIFICATION_REQUIRED",
      ],
    });
  });

  it("allows a page-level candidate only after direct verification", () => {
    expect(evaluatePlacementPromotion(candidate(), "opportunity-1")).toEqual({
      decision: "eligible",
      reasons: [],
    });
    expect(evaluatePlacementPromotion(candidate({
      verification: {
        method: "direct_page_check",
        result: observed(false),
        verifiedBy: "crawler-worker-1",
        verifiedAt: "2026-07-25T02:00:00.000Z",
        auditEventId: "audit-1",
        initialEvidenceRef: "page-check:1",
      },
    }), "opportunity-1")).toEqual({
      decision: "requires_page_evidence",
      reasons: ["DIRECT_VERIFICATION_FAILED"],
    });
    expect(evaluatePlacementPromotion(
      candidate(),
      "another-opportunity",
    )).toEqual({
      decision: "requires_page_evidence",
      reasons: ["OPPORTUNITY_MISMATCH"],
    });
  });

  it("requires an attributable audit chain for direct verification", () => {
    expect(evaluatePlacementPromotion(candidate({
      verification: {
        method: "direct_page_check",
        result: observed(true),
        verifiedBy: "",
        verifiedAt: "not-a-date",
        auditEventId: "",
        initialEvidenceRef: "",
      },
    }), "opportunity-1")).toEqual({
      decision: "requires_page_evidence",
      reasons: [
        "VERIFICATION_IDENTITY_REQUIRED",
        "AUDIT_EVENT_REQUIRED",
        "INITIAL_EVIDENCE_REQUIRED",
      ],
    });
  });

  it("requires explicit authorization and audit identity for manual confirmation", () => {
    expect(evaluatePlacementPromotion(candidate({
      sourceType: "manual",
      verification: {
        method: "manual_confirmation",
        allowed: true,
        confirmed: true,
        confirmedBy: "operator-1",
        confirmedAt: "2026-07-25T02:00:00.000Z",
        auditEventId: "audit-1",
        initialEvidenceRef: "manual-confirmation:1",
      },
    }), "opportunity-1")).toEqual({
      decision: "eligible",
      reasons: [],
    });
    expect(evaluatePlacementPromotion(candidate({
      sourceType: "manual",
      verification: {
        method: "manual_confirmation",
        allowed: false,
        confirmed: true,
        confirmedBy: "operator-1",
        confirmedAt: "2026-07-25T02:00:00.000Z",
        auditEventId: "audit-1",
        initialEvidenceRef: "manual-confirmation:1",
      },
    }), "opportunity-1")).toEqual({
      decision: "requires_page_evidence",
      reasons: ["MANUAL_CONFIRMATION_NOT_ALLOWED"],
    });
  });
});
