import { z } from "zod";

import { publicAssessmentOutcomes } from "../domain/assessments/public-assessment.js";
import {
  placementCandidateSourceTypes,
} from "../domain/placements/placement-promotion.js";
import {
  recommendationScoreComponentIds,
} from "../domain/recommendations/scoring.js";

const nonBlank = z.string().trim().min(1);
const unavailableReason = z.enum([
  "not_observed",
  "not_supported",
  "partial_scan",
  "resource_limit",
  "source_unavailable",
]);
const evidenceMetadata = {
  sourceType: nonBlank,
  sourceReleaseId: nonBlank,
  confidence: z.number().min(0).max(1),
  observedAt: z.string().datetime(),
  stale: z.boolean(),
  evidenceRefs: z.array(nonBlank).readonly(),
} as const;

function evidenceValueSchema<T extends z.ZodType>(
  value: T,
) {
  return z.discriminatedUnion("availability", [
    z.object({
      ...evidenceMetadata,
      availability: z.literal("observed"),
      value,
    }).strict(),
    z.object({
      ...evidenceMetadata,
      availability: z.literal("derived"),
      value,
      derivationRuleVersion: nonBlank,
    }).strict(),
    z.object({
      ...evidenceMetadata,
      availability: z.literal("unavailable"),
      confidence: z.literal(0),
      reason: unavailableReason,
    }).strict(),
  ]);
}

export const publicAssessmentSchema = z.object({
  outcome: z.enum(publicAssessmentOutcomes),
  score: z.number().min(0).max(100).nullable(),
  availability: z.enum(["available", "partial", "unavailable"]),
  freshness: z.enum(["fresh", "stale"]),
  scoreModelVersion: nonBlank,
  ruleVersion: nonBlank,
  generatedAt: z.string().datetime(),
  readOnly: z.boolean(),
  sourceReleaseIds: z.array(nonBlank).min(1).readonly(),
  unavailableFields: z.array(z.enum(recommendationScoreComponentIds)).readonly(),
  staleFields: z.array(z.enum(recommendationScoreComponentIds)).readonly(),
  components: z.array(z.object({
    id: z.enum(recommendationScoreComponentIds),
    normalizedValue: z.number().min(0).max(1).nullable(),
    weight: z.number().min(0).max(100),
    points: z.number().min(0).max(100).nullable(),
    availability: z.enum(["observed", "derived", "unavailable"]),
    sourceType: nonBlank,
    sourceReleaseId: nonBlank,
    confidence: z.number().min(0).max(1),
    observedAt: z.string().datetime(),
    stale: z.boolean(),
    evidenceRefs: z.array(nonBlank).readonly(),
    unavailableReason: unavailableReason.nullable(),
    derivationRuleVersion: z.string().nullable(),
  }).strict()).length(recommendationScoreComponentIds.length).readonly(),
}).strict();

const directVerificationSchema = z.object({
  method: z.literal("direct_page_check"),
  result: evidenceValueSchema(z.boolean()),
  verifiedBy: nonBlank,
  verifiedAt: z.string().datetime(),
  auditEventId: nonBlank,
  initialEvidenceRef: nonBlank,
}).strict();
const manualVerificationSchema = z.object({
  method: z.literal("manual_confirmation"),
  allowed: z.boolean(),
  confirmed: z.boolean(),
  confirmedBy: z.string(),
  confirmedAt: z.string().datetime(),
  auditEventId: z.string(),
  initialEvidenceRef: z.string(),
}).strict();

export const placementCandidateSchema = z.object({
  candidateId: nonBlank,
  opportunityId: nonBlank,
  sourceType: z.enum(placementCandidateSourceTypes),
  sourcePageUrl: evidenceValueSchema(nonBlank),
  targetUrl: evidenceValueSchema(nonBlank),
  anchorText: evidenceValueSchema(z.string()),
  rel: evidenceValueSchema(z.array(nonBlank).readonly()),
  verification: z.discriminatedUnion("method", [
    directVerificationSchema,
    manualVerificationSchema,
  ]).nullable(),
}).strict();
