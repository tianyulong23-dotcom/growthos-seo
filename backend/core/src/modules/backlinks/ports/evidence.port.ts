import { z } from "zod";
import type { EvidenceSnapshot } from "../domain/evidence/evidence.js";
const id = z.string().trim().min(1).max(255);
const target = z.string().trim().min(1).max(2_048);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const refs = z.array(id).max(100);
const metadata = {
  sourceType: key,
  sourceReleaseId: id,
  confidence: z.number().finite().min(0).max(1),
  observedAt: z.string().datetime({ offset: true }),
  stale: z.boolean(),
};
export const createEvidenceValueSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("availability", [
    z.object({
      ...metadata, availability: z.literal("observed"), value, evidenceRefs: refs.min(1),
    }).strict(),
    z.object({
      ...metadata, availability: z.literal("derived"), value,
      evidenceRefs: refs.min(1), derivationRuleVersion: id,
    }).strict(),
    z.object({
      ...metadata, availability: z.literal("unavailable"),
      confidence: z.literal(0), evidenceRefs: refs,
      reason: z.enum([
        "not_observed", "not_supported", "partial_scan",
        "resource_limit", "source_unavailable",
      ]),
    }).strict(),
  ]);
const value = z.union([
  z.string().max(2_048), z.number().finite(), z.boolean(),
  z.array(z.string().max(2_048)).max(1_000),
]);
export const evidenceFieldSchema = z.object({
  key,
  result: createEvidenceValueSchema(value),
}).strict();
export const evidenceSnapshotSchema = z.object({
  subject: target,
  subjectType: z.enum(["domain", "page", "query", "site"]),
  fields: z.array(evidenceFieldSchema).min(1).max(1_000),
}).strict();
export const evidenceRequestContextSchema = z.object({
  organizationId: id,
  workspaceId: id,
  websiteProjectId: id,
  requestId: id,
  dedupeKey: id,
  schemaVersion: id,
  limits: z.object({
    timeoutMs: z.number().int().min(1).max(120_000),
    maxItems: z.number().int().min(1).max(1_000),
  }).strict(),
}).strict();
const request = { context: evidenceRequestContextSchema, target };
export const evidenceRequestSchema = z.object({
  ...request, targetType: z.enum(["domain", "page"]),
  featureKeys: z.array(key).min(1).max(1_000),
}).strict();
export const graphRequestSchema = z.object({
  ...request, direction: z.enum(["inbound", "outbound", "both"]),
}).strict();
export const discoveryRequestSchema = z.object({
  ...request,
  locale: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
}).strict();
export const siteAuditRequestSchema = z.object(request).strict();
export interface EvidencePort { collect(request: Readonly<z.output<typeof evidenceRequestSchema>>): Promise<EvidenceSnapshot>; }
export interface GraphPort { query(request: Readonly<z.output<typeof graphRequestSchema>>): Promise<EvidenceSnapshot>; }
export interface DiscoveryPort { discover(request: Readonly<z.output<typeof discoveryRequestSchema>>): Promise<EvidenceSnapshot>; }
export interface SiteAuditPort { audit(request: Readonly<z.output<typeof siteAuditRequestSchema>>): Promise<EvidenceSnapshot>; }
export const evidencePortFailureCodes = {
  invalidRequest: "EVIDENCE_INVALID_REQUEST",
  malformedResponse: "EVIDENCE_MALFORMED_RESPONSE",
  resourceLimitExceeded: "EVIDENCE_RESOURCE_LIMIT_EXCEEDED",
  sourceUnavailable: "EVIDENCE_SOURCE_UNAVAILABLE",
  timeout: "EVIDENCE_TIMEOUT",
} as const;
const retryable = new Set<string>([
  evidencePortFailureCodes.sourceUnavailable,
  evidencePortFailureCodes.timeout,
]);
export const evidencePortFailureSchema = z.object({
  code: z.enum(Object.values(evidencePortFailureCodes)),
  requestId: id,
  message: z.string().trim().min(1).max(1_024),
  retryable: z.boolean(),
}).strict().superRefine((failure, context) => {
  if (failure.retryable !== retryable.has(failure.code)) {
    context.addIssue({ code: "custom", path: ["retryable"],
      message: `Retryability does not match ${failure.code}.` });
  }
});
