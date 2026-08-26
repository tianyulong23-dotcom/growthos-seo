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
const monitoringState = z.enum([
  "pending_verification",
  "active",
  "suspected_changed",
  "changed",
  "suspected_lost",
  "lost",
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
  opportunityId: z.uuid().nullable(),
  replyId: z.uuid().nullable(),
  lineageStatus: z.enum(["OUTREACH_DERIVED", "UNATTRIBUTED"]),
  sourcePageUrl: z.string().url().nullable(),
  targetUrl: z.string().url(),
  candidateStatus: nonBlank,
  matchStatus: nonBlank,
  validationStatus: nonBlank,
  evidenceSource: z.literal("DIRECT_VALIDATION"),
  version: z.number().int().positive(),
  createdAt: timestamp,
  countsTowardKpi: z.literal(false),
}).strict();
const placementLinkSchema = z.object({
  recordType: z.literal("placement"),
  displayState: placementDisplayState,
  placementId: z.uuid(),
  candidateId: z.uuid(),
  opportunityId: z.uuid().nullable(),
  replyId: z.uuid().nullable(),
  lineageStatus: z.enum(["OUTREACH_DERIVED", "UNATTRIBUTED"]),
  sourcePageUrl: z.string().url(),
  targetUrl: z.string().url(),
  initialValidationStatus: nonBlank,
  healthStatus: nonBlank,
  monitoringState,
  monitoringStatus: nonBlank,
  latestObservedAt: timestamp.nullable(),
  lastSuccessfulObservationAt: timestamp.nullable(),
  nextCheckAt: timestamp.nullable(),
  freshness,
  latestFailure: failure,
  evidenceSource: z.literal("DIRECT_MONITOR"),
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
  summary: z.object({
    placements: z.object({
      total: z.number().int().nonnegative(),
      pendingVerification: z.number().int().nonnegative(),
      active: z.number().int().nonnegative(),
      suspectedChanged: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
      suspectedLost: z.number().int().nonnegative(),
      lost: z.number().int().nonnegative(),
      recovered: z.number().int().nonnegative(),
    }).strict(),
    candidates: z.object({
      total: z.number().int().nonnegative(),
      countsTowardKpi: z.literal(false),
    }).strict(),
    evidence: z.object({
      source: z.literal("DIRECT_MONITOR"),
      dataCutoff: timestamp.nullable(),
      freshness,
      lastSuccessfulObservationAt: timestamp.nullable(),
      latestAttemptAt: timestamp.nullable(),
      latestAttemptStatus: monitorRunStatus,
      latestFailure: failure,
    }).strict(),
  }).strict(),
  meta: metaSchema,
}).strict();
export const placementLinkCandidateResponseSchema = z.object({
  link: candidateLinkSchema.extend({
    opportunityId: z.uuid().nullable(),
    replyId: z.uuid().nullable(),
    placementId: z.uuid().nullable(),
    lineageStatus: z.enum(["OUTREACH_DERIVED", "UNATTRIBUTED"]),
    normalizedSourceUrl: z.string().url().nullable(),
    normalizedTargetUrl: z.string().url(),
    urlNormalizationVersion: nonBlank,
    latestValidation: z.object({
      validationRunId: z.uuid(),
      status: nonBlank,
      observedAt: timestamp,
      evidenceSource: z.literal("DIRECT_VALIDATION"),
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
    replyId: z.uuid().nullable(),
    lineageStatus: z.enum(["OUTREACH_DERIVED", "UNATTRIBUTED"]),
    normalizedSourceUrl: z.string().url(),
    normalizedTargetUrl: z.string().url(),
    urlNormalizationVersion: nonBlank,
    updatedAt: timestamp,
    initialValidation: z.object({
      validationRunId: z.uuid(),
      status: nonBlank,
      evidenceSource: z.literal("DIRECT_VALIDATION"),
      evidenceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceContractVersion: nonBlank,
      evidenceSchemaVersion: z.number().int().positive(),
    }).strict(),
    nextCheckAt: timestamp.nullable(),
    consecutiveAnomalies: z.number().int().nonnegative(),
    browserFallbackEnabled: z.boolean().nullable(),
    latestObservation: z.object({
      observationId: z.uuid(),
      result: observationResult,
      observedAt: timestamp,
      executionMode,
      evidenceSource: z.literal("DIRECT_MONITOR"),
      evidence: z.object({
        evidenceId: z.uuid(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        contractVersion: nonBlank,
        schemaVersion: z.number().int().positive(),
        freshness,
      }).strict(),
      failure,
    }).strict().nullable(),
    lastSuccessfulObservation: z.object({
      observationId: z.uuid(),
      result: observationResult,
      observedAt: timestamp,
      executionMode,
      evidenceSource: z.literal("DIRECT_MONITOR"),
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
    evidenceSource: z.literal("DIRECT_MONITOR"),
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
