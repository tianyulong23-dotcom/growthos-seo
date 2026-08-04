export type EvidenceAvailability = "observed" | "derived" | "unavailable";
export type EvidenceUnavailableReason =
  | "not_observed"
  | "not_supported"
  | "partial_scan"
  | "resource_limit"
  | "source_unavailable";
type EvidenceMetadata = Readonly<{
  sourceType: string;
  sourceReleaseId: string;
  confidence: number;
  observedAt: string;
  stale: boolean;
  evidenceRefs: readonly string[];
}>;
export type EvidenceValue<T> =
  | Readonly<EvidenceMetadata & { availability: "observed"; value: T }>
  | Readonly<EvidenceMetadata & {
    availability: "derived";
    value: T;
    derivationRuleVersion: string;
  }>
  | Readonly<EvidenceMetadata & {
    availability: "unavailable";
    confidence: 0;
    reason: EvidenceUnavailableReason;
  }>;
export type NormalizedEvidenceValue =
  | string
  | number
  | boolean
  | readonly string[];
export type EvidenceField = Readonly<{
  key: string;
  result: EvidenceValue<NormalizedEvidenceValue>;
}>;
export type EvidenceSnapshot = Readonly<{
  subject: string;
  subjectType: "domain" | "page" | "query" | "site";
  fields: readonly EvidenceField[];
}>;
