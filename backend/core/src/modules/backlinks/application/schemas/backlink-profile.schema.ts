import { z } from "zod";

const nonBlank = z.string().trim().min(1);
const timestamp = z.string().datetime();
const nullableCount = z.number().int().nonnegative().nullable();
const meta = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: timestamp,
}).strict();

export const backlinkProfileParamsSchema = z.object({
  websiteProjectKey: nonBlank,
}).strict();
export const backlinkProfileSyncJobParamsSchema =
  backlinkProfileParamsSchema.extend({ jobId: z.uuid() }).strict();
export const backlinkInventoryItemParamsSchema =
  backlinkProfileParamsSchema.extend({ inventoryItemId: z.uuid() }).strict();
export const backlinkProfileSyncHeadersSchema = z.object({
  "idempotency-key": nonBlank.max(200),
});
export const backlinkInventoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["live", "lost", "unknown"]).optional(),
  source: z.enum(["DATAFORSEO", "USER_IMPORTED"]).optional(),
  query: nonBlank.max(300).optional(),
  sort: z.enum(["last_seen_desc", "rank_desc", "spam_desc"])
    .default("last_seen_desc"),
}).strict();
export const backlinkInventoryImportBodySchema = z.object({
  sourceUrl: z.string().url(),
  targetUrl: z.string().url(),
  anchorText: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2_000).optional(),
  managed: z.boolean().default(false),
}).strict();
export const backlinkInventoryPolicyBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  important: z.boolean(),
  monitoringStatus: z.enum(["enabled", "paused"]),
}).strict();
export const backlinkInventoryObservationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const syncStatus = z.object({
  providerEnabled: z.boolean(),
  status: nonBlank,
  lastSyncAt: timestamp.nullable(),
  nextSyncAt: timestamp.nullable(),
  estimatedCostMicros: z.number().int().nonnegative(),
  actualCostMicros: z.number().int().nonnegative(),
  stale: z.boolean(),
  partial: z.boolean(),
  providerInputRequired: z.boolean(),
}).strict();
const snapshot = z.object({
  snapshotId: z.uuid(),
  provider: nonBlank,
  observedAt: timestamp,
  freshUntil: timestamp,
  freshness: z.enum(["fresh", "stale", "unavailable"]),
  completeness: z.enum(["full", "partial", "summary_only", "unavailable"]),
  totalBacklinks: nullableCount,
  referringDomains: nullableCount,
  dofollow: nullableCount,
  nofollow: nullableCount,
  sponsored: nullableCount,
  ugc: nullableCount,
  newBacklinks: nullableCount,
  lostBacklinks: nullableCount,
  inventoryPulledCount: z.number().int().nonnegative(),
  inventoryCoverage: z.number().min(0).max(1).nullable(),
  distributions: z.record(z.string(), z.unknown()),
  unavailableMetrics: z.array(nonBlank),
  costMicros: z.number().int().nonnegative(),
  nextSyncAt: timestamp.nullable(),
}).strict();
const health = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  grade: z.enum(["A", "B", "C", "D", "E", "INSUFFICIENT_DATA"]),
  components: z.array(z.record(z.string(), z.unknown())),
  risks: z.array(nonBlank),
  positives: z.array(nonBlank),
  evidenceObservedAt: timestamp,
  modelVersion: z.literal("backlink-profile-health.v1"),
}).strict();

export const backlinkProfileResponseSchema = z.object({
  canonicalDomain: nonBlank,
  snapshot: snapshot.nullable(),
  health: health.nullable(),
  sync: syncStatus,
  meta,
}).strict();
export const backlinkInventoryResponseSchema = z.object({
  items: z.array(z.object({
    inventoryItemId: z.uuid(),
    sourceType: z.enum(["DATAFORSEO", "USER_IMPORTED"]),
    provider: nonBlank,
    sourceDomain: nonBlank.nullable(),
    sourceUrl: z.string().url(),
    targetUrl: z.string().url(),
    anchorText: z.string(),
    relAttributes: z.array(nonBlank),
    providerStatus: z.enum(["live", "lost", "unknown"]),
    firstSeenAt: timestamp.nullable(),
    lastSeenAt: timestamp.nullable(),
    rank: z.number().int().min(0).max(100).nullable(),
    spamScore: z.number().int().min(0).max(100).nullable(),
    countryCode: nonBlank.nullable(),
    tld: nonBlank.nullable(),
    languageCode: nonBlank.nullable(),
    sourceHttpStatus: z.number().int().min(100).max(599).nullable(),
    targetHttpStatus: z.number().int().min(100).max(599).nullable(),
    redirectUrl: z.string().url().nullable(),
    placementId: z.uuid().nullable(),
    opportunityId: z.uuid().nullable(),
    pinned: z.boolean(),
    managed: z.boolean(),
    directHealthStatus: z.enum([
      "pending_verification",
      "active",
      "suspected_changed",
      "changed",
      "suspected_lost",
      "lost",
    ]),
    directValidationStatus: z.enum([
      "UNVERIFIED",
      "VALID",
      "SUSPECTED_CHANGED",
      "CHANGED",
      "SUSPECTED_LOST",
      "LOST",
      "RECOVERED",
      "INACCESSIBLE",
    ]),
    lastDirectCheckedAt: timestamp.nullable(),
    restrictionReason: nonBlank.nullable(),
    userNotes: nonBlank.nullable(),
    latestDirectEvidenceId: z.uuid().nullable(),
    tier: z.enum(["A", "B", "C"]),
    importance: z.enum(["normal", "important"]),
    monitoringStatus: z.enum(["enabled", "paused", "provider_only"]),
    policyVersion: z.literal("inventory-monitoring-v1"),
    policyRevision: z.number().int().positive(),
    nextCheckAt: timestamp.nullable(),
    providerOnlyReason: nonBlank.nullable(),
  }).strict()),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalCount: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  meta,
}).strict();
export const backlinkInventoryImportResponseSchema = z.object({
  inventoryItemId: z.uuid(),
  sourceUrl: z.string().url(),
  targetUrl: z.string().url(),
  tier: z.enum(["A", "B", "C"]),
  monitoringStatus: z.enum(["enabled", "paused", "provider_only"]),
  nextCheckAt: timestamp.nullable(),
  replayed: z.boolean(),
  meta,
}).strict();
export const backlinkInventoryPolicyResponseSchema = z.object({
  inventoryItemId: z.uuid(),
  tier: z.enum(["A", "B", "C"]),
  importance: z.enum(["normal", "important"]),
  monitoringStatus: z.enum(["enabled", "paused", "provider_only"]),
  policyVersion: z.literal("inventory-monitoring-v1"),
  policyRevision: z.number().int().positive(),
  nextCheckAt: timestamp.nullable(),
  providerOnlyReason: nonBlank.nullable(),
  meta,
}).strict();
export const backlinkInventoryCheckResponseSchema = z.object({
  inventoryItemId: z.uuid(),
  runId: z.uuid(),
  observationId: z.uuid(),
  workflowId: nonBlank,
  scheduledFor: timestamp,
  replayed: z.boolean(),
  meta,
}).strict();
export const backlinkInventoryDirectObservationResponseSchema = z.object({
  items: z.array(z.object({
    observationId: z.uuid(),
    runId: z.uuid(),
    result: z.enum(["present", "changed", "absent", "inaccessible"]),
    directValidationStatus: z.enum([
      "VALID",
      "SUSPECTED_CHANGED",
      "CHANGED",
      "SUSPECTED_LOST",
      "LOST",
      "RECOVERED",
      "INACCESSIBLE",
    ]),
    failureCode: nonBlank.nullable(),
    restrictionReason: nonBlank.nullable(),
    evidenceSnapshot: z.record(z.string(), z.unknown()),
    observedAt: timestamp,
  }).strict()),
  meta,
}).strict();
export const backlinkProfileSyncResponseSchema = z.object({
  jobId: z.uuid(),
  workflowId: nonBlank,
  status: z.enum([
    "queued",
    "running",
    "completed",
    "partial",
    "waiting_provider",
    "failed",
  ]),
  canonicalDomain: nonBlank,
  estimatedCostMicros: z.number().int().nonnegative(),
  providerInputRequired: z.boolean(),
  replayed: z.boolean(),
  meta,
}).strict();
export const backlinkProfileSyncJobResponseSchema = z.object({
  job: z.object({
    jobId: z.uuid(),
    status: nonBlank,
    canonicalDomain: nonBlank,
    totalCount: nullableCount,
    pulledCount: z.number().int().nonnegative(),
    inventoryCoverage: z.number().min(0).max(1).nullable(),
    estimatedCostMicros: z.number().int().nonnegative(),
    actualCostMicros: z.number().int().nonnegative(),
    nextSyncAt: timestamp.nullable(),
    errorCode: nonBlank.nullable(),
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).strict(),
  meta,
}).strict();
