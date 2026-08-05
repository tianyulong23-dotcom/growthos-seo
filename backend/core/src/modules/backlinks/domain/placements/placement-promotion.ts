import type { EvidenceValue } from "../evidence/evidence.js";

export const placementCandidateSourceTypes = [
  "manual",
  "dataforseo",
  "crawler_discovery",
  "search_discovery",
  "import",
] as const;
export type PlacementCandidateSourceType =
  (typeof placementCandidateSourceTypes)[number];

export type PlacementVerification =
  | Readonly<{
    method: "direct_page_check";
    result: EvidenceValue<boolean>;
    verifiedBy: string;
    verifiedAt: string;
    auditEventId: string;
    initialEvidenceRef: string;
  }>
  | Readonly<{
    method: "manual_confirmation";
    allowed: boolean;
    confirmed: boolean;
    confirmedBy: string;
    confirmedAt: string;
    auditEventId: string;
    initialEvidenceRef: string;
  }>;

export type PlacementCandidate = Readonly<{
  candidateId: string;
  opportunityId: string;
  sourceType: PlacementCandidateSourceType;
  sourcePageUrl: EvidenceValue<string>;
  targetUrl: EvidenceValue<string>;
  anchorText: EvidenceValue<string>;
  rel: EvidenceValue<readonly string[]>;
  verification: PlacementVerification | null;
}>;

export const placementPromotionReasons = [
  "OPPORTUNITY_REQUIRED",
  "OPPORTUNITY_MISMATCH",
  "SOURCE_PAGE_UNAVAILABLE",
  "TARGET_URL_UNAVAILABLE",
  "ANCHOR_UNAVAILABLE",
  "REL_UNAVAILABLE",
  "VERIFICATION_REQUIRED",
  "DIRECT_VERIFICATION_FAILED",
  "MANUAL_CONFIRMATION_NOT_ALLOWED",
  "MANUAL_CONFIRMATION_REQUIRED",
  "VERIFICATION_IDENTITY_REQUIRED",
  "AUDIT_EVENT_REQUIRED",
  "INITIAL_EVIDENCE_REQUIRED",
] as const;
export type PlacementPromotionReason =
  (typeof placementPromotionReasons)[number];

export type PlacementPromotionDecision = Readonly<{
  decision: "eligible" | "requires_page_evidence";
  reasons: readonly PlacementPromotionReason[];
}>;

function usable<T>(
  evidence: EvidenceValue<T>,
  isValue: (value: T) => boolean,
): boolean {
  return evidence.availability !== "unavailable" &&
    !evidence.stale &&
    isValue(evidence.value);
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

export function evaluatePlacementPromotion(
  candidate: PlacementCandidate,
  expectedOpportunityId: string,
): PlacementPromotionDecision {
  const reasons: PlacementPromotionReason[] = [];

  if (!nonBlank(candidate.opportunityId) || !nonBlank(expectedOpportunityId)) {
    reasons.push("OPPORTUNITY_REQUIRED");
  } else if (candidate.opportunityId !== expectedOpportunityId) {
    reasons.push("OPPORTUNITY_MISMATCH");
  }
  if (!usable(candidate.sourcePageUrl, nonBlank)) {
    reasons.push("SOURCE_PAGE_UNAVAILABLE");
  }
  if (!usable(candidate.targetUrl, nonBlank)) {
    reasons.push("TARGET_URL_UNAVAILABLE");
  }
  if (!usable(candidate.anchorText, nonBlank)) {
    reasons.push("ANCHOR_UNAVAILABLE");
  }
  if (!usable(candidate.rel, (value) => Array.isArray(value))) {
    reasons.push("REL_UNAVAILABLE");
  }

  if (candidate.verification === null) {
    reasons.push("VERIFICATION_REQUIRED");
  } else if (candidate.verification.method === "direct_page_check") {
    if (!usable(candidate.verification.result, (value) => value === true)) {
      reasons.push("DIRECT_VERIFICATION_FAILED");
    } else {
      if (
        !nonBlank(candidate.verification.verifiedBy) ||
        !Number.isFinite(Date.parse(candidate.verification.verifiedAt))
      ) {
        reasons.push("VERIFICATION_IDENTITY_REQUIRED");
      }
      if (!nonBlank(candidate.verification.auditEventId)) {
        reasons.push("AUDIT_EVENT_REQUIRED");
      }
      if (!nonBlank(candidate.verification.initialEvidenceRef)) {
        reasons.push("INITIAL_EVIDENCE_REQUIRED");
      }
    }
  } else {
    if (!candidate.verification.allowed) {
      reasons.push("MANUAL_CONFIRMATION_NOT_ALLOWED");
    } else if (!candidate.verification.confirmed) {
      reasons.push("MANUAL_CONFIRMATION_REQUIRED");
    } else if (
      !nonBlank(candidate.verification.confirmedBy) ||
      !Number.isFinite(Date.parse(candidate.verification.confirmedAt))
    ) {
      reasons.push("VERIFICATION_IDENTITY_REQUIRED");
    }
    if (
      candidate.verification.allowed &&
      candidate.verification.confirmed &&
      !nonBlank(candidate.verification.auditEventId)
    ) {
      reasons.push("AUDIT_EVENT_REQUIRED");
    }
    if (
      candidate.verification.allowed &&
      candidate.verification.confirmed &&
      !nonBlank(candidate.verification.initialEvidenceRef)
    ) {
      reasons.push("INITIAL_EVIDENCE_REQUIRED");
    }
  }

  return Object.freeze({
    decision: reasons.length === 0 ? "eligible" : "requires_page_evidence",
    reasons: Object.freeze(reasons),
  });
}
