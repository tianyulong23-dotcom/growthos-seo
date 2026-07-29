import type {
  EvidenceUnavailableReason,
  EvidenceValue,
} from "../evidence/evidence.js";

const unavailableReasons = new Set<EvidenceUnavailableReason>([
  "not_observed",
  "not_supported",
  "partial_scan",
  "resource_limit",
  "source_unavailable",
]);

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function copyRecommendationEvidenceValue<T>(
  name: string,
  evidence: EvidenceValue<T>,
  isValue: (value: unknown) => value is T,
): EvidenceValue<T> {
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    !nonBlank(evidence.sourceType) ||
    !nonBlank(evidence.sourceReleaseId) ||
    !Number.isFinite(evidence.confidence) ||
    evidence.confidence < 0 ||
    evidence.confidence > 1 ||
    !nonBlank(evidence.observedAt) ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    typeof evidence.stale !== "boolean" ||
    !Array.isArray(evidence.evidenceRefs) ||
    evidence.evidenceRefs.some((reference) => !nonBlank(reference))
  ) {
    throw new TypeError(`${name} has invalid evidence metadata`);
  }

  const metadata = {
    sourceType: evidence.sourceType.trim(),
    sourceReleaseId: evidence.sourceReleaseId.trim(),
    confidence: evidence.confidence,
    observedAt: evidence.observedAt,
    stale: evidence.stale,
    evidenceRefs: Object.freeze(
      evidence.evidenceRefs.map((reference) => reference.trim()),
    ),
  } as const;

  if (evidence.availability === "unavailable") {
    if (
      evidence.confidence !== 0 ||
      !unavailableReasons.has(evidence.reason) ||
      "value" in evidence
    ) {
      throw new TypeError(`${name} has invalid unavailable evidence`);
    }
    return Object.freeze({
      ...metadata,
      availability: "unavailable",
      confidence: 0,
      reason: evidence.reason,
    });
  }

  if (
    (evidence.availability !== "observed" &&
      evidence.availability !== "derived") ||
    evidence.evidenceRefs.length === 0 ||
    !isValue(evidence.value)
  ) {
    throw new TypeError(`${name} has invalid available evidence`);
  }

  if (evidence.availability === "derived") {
    if (!nonBlank(evidence.derivationRuleVersion)) {
      throw new TypeError(`${name} requires a derivation rule version`);
    }
    return Object.freeze({
      ...metadata,
      availability: "derived",
      value: evidence.value,
      derivationRuleVersion: evidence.derivationRuleVersion.trim(),
    });
  }

  return Object.freeze({
    ...metadata,
    availability: "observed",
    value: evidence.value,
  });
}

export function recommendationEvidenceIsUsable<T>(
  evidence: EvidenceValue<T>,
): evidence is Extract<
  EvidenceValue<T>,
  { availability: "observed" | "derived" }
> {
  return evidence.availability !== "unavailable" && !evidence.stale;
}
