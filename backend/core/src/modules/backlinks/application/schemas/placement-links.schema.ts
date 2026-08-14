import { z } from "zod";

import {
  placementLifecycleEventTypes,
  placementLinkViews,
} from "../queries/placement-links.query.js";

const nonBlank = z.string().trim().min(1);
const timestamp = z.string().datetime();
const placementDisplayState = z.enum([
  "confirmed",
  "changed",
  "lost",
  "recovered",
]);
const freshness = z.enum(["fresh", "stale", "unknown"]);
const observationResult = z.enum([
  "present",
  "changed",
  "absent",
  "inaccessible",
]);
const executionMode = z.enum(["static", "browser"]);
const monitorRunStatus = z.enum([
  "idle",
  "scheduled",
  "running",
  "retry_wait",
  "failed",
  "completed",
]);
const failure = z.object({
  status: z.enum(["none", "failed"]),
  code: nonBlank.max(100).nullable(),
}).strict();

export const placementLinksParamsSchema = z.object({
  websiteProjectKey: nonBlank,
}).strict();
export const placementLinksListQuerySchema = z.object({
  view: z.enum(placementLinkViews).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: nonBlank.max(2048).optional(),
}).strict();
export const placementLinkCandidateParamsSchema = placementLinksParamsSchema.extend({
  candidateId: z.uuid(),
}).strict();
export const placementLinkPlacementParamsSchema = placementLinksParamsSchema.extend({
  placementId: z.uuid(),
}).strict();
export const placementLinkEvidenceParamsSchema = placementLinksParamsSchema.extend({
  evidenceId: z.uuid(),
}).strict();
export const placementLinkEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: nonBlank.max(2048).optional(),
}).strict();
export const placementLinkReverifyHeadersSchema = z.object({
  "idempotency-key": nonBlank.max(200),
});
export const placementLinkReverifyBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

const candidateLinkSchema = z.object({
  recordType: z.literal("candidate"),
  displayState: z.literal("candidate"),
  candidateId: z.uuid(),
  sourcePageUrl: z.string().url().nullable(),
  targetUrl: z.string().url(),
  candidateStatus: nonBlank,
  matchStatus: nonBlank,
  validationStatus: nonBlank,
  version: z.number().int().positive(),
  createdAt: timestamp,
  countsTowardKpi: z.literal(false),
}).strict();
const placementLinkSchema = z.object({
  recordType: z.literal("placement"),
  displayState: placementDisplayState,
  placementId: z.uuid(),
  candidateId: z.uuid(),
  sourcePageUrl: z.string().url(),
  targetUrl: z.string().url(),
  initialValidationStatus: nonBlank,
  healthStatus: nonBlank,
  monitoringStatus: nonBlank,
  version: z.number().int().positive(),
  createdAt: timestamp,
  countsTowardKpi: z.literal(true),
}).strict();
const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: timestamp,
}).strict();

export const placementLinksListResponseSchema = z.object({
  items: z.array(z.discriminatedUnion("recordType", [
    candidateLinkSchema,
    placementLinkSchema,
  ])),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  meta: metaSchema,
}).strict();
export const placementLinkCandidateResponseSchema = z.object({
  link: candidateLinkSchema.extend({
    opportunityId: z.uuid().nullable(),
    normalizedSourceUrl: z.string().url().nullable(),
    normalizedTargetUrl: z.string().url(),
    urlNormalizationVersion: nonBlank,
    latestValidation: z.object({
      validationRunId: z.uuid(),
      status: nonBlank,
      observedAt: timestamp,
      evidenceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceContractVersion: nonBlank,
      evidenceSchemaVersion: z.number().int().positive(),
    }).strict().nullable(),
  }).strict(),
  meta: metaSchema,
}).strict();
export const placementLinkPlacementResponseSchema = z.object({
  link: placementLinkSchema.extend({
    opportunityId: z.uuid().nullable(),
    normalizedSourceUrl: z.string().url(),
    normalizedTargetUrl: z.string().url(),
    urlNormalizationVersion: nonBlank,
    updatedAt: timestamp,
    initialValidation: z.object({
      validationRunId: z.uuid(),
      status: nonBlank,
      evidenceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceContractVersion: nonBlank,
      evidenceSchemaVersion: z.number().int().positive(),
    }).strict(),
    nextCheckAt: timestamp,
    consecutiveAnomalies: z.number().int().nonnegative(),
    browserFallbackEnabled: z.boolean(),
    latestObservation: z.object({
      observationId: z.uuid(),
      result: observationResult,
      observedAt: timestamp,
      executionMode,
      evidence: z.object({
        evidenceId: z.uuid(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        contractVersion: nonBlank,
        schemaVersion: z.number().int().positive(),
        freshness,
      }).strict(),
      failure,
    }).strict().nullable(),
    latestMonitorRun: z.object({
      monitorRunId: z.uuid().nullable(),
      status: monitorRunStatus,
      scheduledFor: timestamp.nullable(),
      updatedAt: timestamp.nullable(),
    }).strict(),
  }).strict(),
  meta: metaSchema,
}).strict();
export const placementLinkEventsResponseSchema = z.object({
  items: z.array(z.object({
    eventId: z.uuid(),
    eventType: z.enum(placementLifecycleEventTypes),
    occurredAt: timestamp,
    placementVersion: z.number().int().positive(),
    previousHealthStatus: nonBlank.nullable(),
    nextHealthStatus: nonBlank.nullable(),
    observationId: z.uuid().nullable(),
    reason: nonBlank.nullable(),
  }).strict()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  meta: metaSchema,
}).strict();
export const placementLinkEvidenceResponseSchema = z.object({
  evidence: z.object({
    evidenceId: z.uuid(),
    placementId: z.uuid(),
    kind: z.literal("placement_observation"),
    immutable: z.literal(true),
    hashVerified: z.literal(true),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    contractVersion: nonBlank,
    schemaVersion: z.number().int().positive(),
    observedAt: timestamp,
    executionMode,
    result: observationResult,
    reasonCode: nonBlank.nullable(),
    failure,
    freshness,
    source: z.object({
      sourcePageUrl: z.string().url(),
      targetUrl: z.string().url(),
      fetchMode: executionMode,
      httpStatus: z.number().int().min(100).max(599).nullable(),
      finalUrl: z.string().url().nullable(),
      contentType: nonBlank.nullable(),
      fetchedAt: timestamp.nullable(),
      redirectChain: z.array(z.string().url()),
      xRobotsTag: nonBlank.nullable(),
    }).strict(),
    link: z.object({
      canonicalUrl: z.string().url().nullable(),
      noindex: z.boolean().nullable(),
      occurrenceCount: z.number().int().nonnegative().nullable(),
      robotsDirectives: z.array(nonBlank),
      occurrences: z.array(z.object({
        resolvedHref: z.string().url(),
        anchorText: z.string(),
        rel: z.array(nonBlank),
        nofollow: z.boolean(),
        sponsored: z.boolean(),
        ugc: z.boolean(),
      }).strict()),
    }).strict(),
  }).strict(),
  meta: metaSchema,
}).strict();
export const placementLinkReverifyResponseSchema = z.object({
  placementId: z.uuid(),
  placementVersion: z.number().int().positive(),
  accepted: z.boolean(),
  replayed: z.boolean(),
  browserFallbackAllowed: z.boolean(),
  monitorRun: z.object({
    monitorRunId: z.uuid(),
    status: monitorRunStatus.exclude(["idle"]),
    scheduledFor: timestamp,
  }).strict(),
  meta: metaSchema,
}).strict();
