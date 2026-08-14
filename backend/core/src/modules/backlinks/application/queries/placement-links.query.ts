import {
  hashPlacementEvidence,
  type PlacementMonitorObservationResult,
} from "../activities/placement-static-monitor.activity.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export const placementLinkViews = [
  "all",
  "candidate",
  "confirmed",
  "changed",
  "lost",
  "recovered",
] as const;
export type PlacementLinkView = (typeof placementLinkViews)[number];
export type PlacementLinkDisplayState = Exclude<PlacementLinkView, "all">;
export type PlacementEvidenceFreshness = "fresh" | "stale" | "unknown";
export type PlacementMonitorPublicStatus =
  | "idle"
  | "scheduled"
  | "running"
  | "retry_wait"
  | "failed"
  | "completed";
export const placementLifecycleEventTypes = [
  "placement.confirmed",
  "placement.changed",
  "placement.lost",
  "placement.recovered",
  "placement.restored",
] as const;
export type PlacementLifecycleEventType =
  (typeof placementLifecycleEventTypes)[number];

type CandidateLink = Readonly<{
  recordType: "candidate";
  displayState: "candidate";
  candidateId: string;
  sourcePageUrl: string | null;
  targetUrl: string;
  candidateStatus: string;
  matchStatus: string;
  validationStatus: string;
  version: number;
  createdAt: string;
  countsTowardKpi: false;
}>;
type PlacementLink = Readonly<{
  recordType: "placement";
  displayState: Exclude<PlacementLinkDisplayState, "candidate">;
  placementId: string;
  candidateId: string;
  sourcePageUrl: string;
  targetUrl: string;
  initialValidationStatus: string;
  healthStatus: string;
  monitoringStatus: string;
  version: number;
  createdAt: string;
  countsTowardKpi: true;
}>;
export type PlacementLinkListItem = CandidateLink | PlacementLink;

export type PlacementCandidateLinkDetail = CandidateLink & Readonly<{
  opportunityId: string | null;
  normalizedSourceUrl: string | null;
  normalizedTargetUrl: string;
  urlNormalizationVersion: string;
  latestValidation: Readonly<{
    validationRunId: string;
    status: string;
    observedAt: string;
    evidenceSnapshotHash: string;
    evidenceContractVersion: string;
    evidenceSchemaVersion: number;
  }> | null;
}>;
export type PlacementLatestObservation = Readonly<{
  observationId: string;
  result: PlacementMonitorObservationResult;
  observedAt: string;
  executionMode: "static" | "browser";
  evidence: Readonly<{
    evidenceId: string;
    hash: string;
    contractVersion: string;
    schemaVersion: number;
    freshness: PlacementEvidenceFreshness;
  }>;
  failure: Readonly<{
    status: "none" | "failed";
    code: string | null;
  }>;
}>;
export type PlacementLatestMonitorRun = Readonly<{
  monitorRunId: string | null;
  status: PlacementMonitorPublicStatus;
  scheduledFor: string | null;
  updatedAt: string | null;
}>;
export type PlacementLinkDetail = PlacementLink & Readonly<{
  opportunityId: string | null;
  normalizedSourceUrl: string;
  normalizedTargetUrl: string;
  urlNormalizationVersion: string;
  updatedAt: string;
  initialValidation: Readonly<{
    validationRunId: string;
    status: string;
    evidenceSnapshotHash: string;
    evidenceContractVersion: string;
    evidenceSchemaVersion: number;
  }>;
  nextCheckAt: string;
  consecutiveAnomalies: number;
  browserFallbackEnabled: boolean;
  latestObservation: PlacementLatestObservation | null;
  latestMonitorRun: PlacementLatestMonitorRun;
}>;
export type PlacementLinksListInput = Readonly<{
  view: PlacementLinkView;
  limit: number;
  cursor?: string | undefined;
}>;
export type PlacementLinksPage = Readonly<{
  items: PlacementLinkListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}>;
export type PlacementLifecycleEvent = Readonly<{
  eventId: string;
  eventType: PlacementLifecycleEventType;
  occurredAt: string;
  placementVersion: number;
  previousHealthStatus: string | null;
  nextHealthStatus: string | null;
  observationId: string | null;
  reason: string | null;
}>;
export type PlacementLifecyclePage = Readonly<{
  items: PlacementLifecycleEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}>;
export type PlacementEvidence = Readonly<{
  evidenceId: string;
  placementId: string;
  kind: "placement_observation";
  immutable: true;
  hashVerified: true;
  hash: string;
  contractVersion: string;
  schemaVersion: number;
  observedAt: string;
  executionMode: "static" | "browser";
  result: PlacementMonitorObservationResult;
  reasonCode: string | null;
  failure: Readonly<{
    status: "none" | "failed";
    code: string | null;
  }>;
  freshness: PlacementEvidenceFreshness;
  source: Readonly<{
    sourcePageUrl: string;
    targetUrl: string;
    fetchMode: "static" | "browser";
    httpStatus: number | null;
    finalUrl: string | null;
    contentType: string | null;
    fetchedAt: string | null;
    redirectChain: string[];
    xRobotsTag: string | null;
  }>;
  link: Readonly<{
    canonicalUrl: string | null;
    noindex: boolean | null;
    occurrenceCount: number | null;
    robotsDirectives: string[];
    occurrences: Readonly<{
      resolvedHref: string;
      anchorText: string;
      rel: string[];
      nofollow: boolean;
      sponsored: boolean;
      ugc: boolean;
    }>[];
  }>;
}>;
export type PlacementLinksQuery = Readonly<{
  listLinks(
    context: ResolvedProjectContext,
    input: PlacementLinksListInput,
  ): Promise<PlacementLinksPage>;
  getCandidateLink(
    context: ResolvedProjectContext,
    candidateId: string,
  ): Promise<PlacementCandidateLinkDetail | null>;
  getPlacementLink(
    context: ResolvedProjectContext,
    placementId: string,
  ): Promise<PlacementLinkDetail | null>;
  listPlacementEvents(
    context: ResolvedProjectContext,
    placementId: string,
    input: Readonly<{ limit: number; cursor?: string | undefined }>,
  ): Promise<PlacementLifecyclePage | null>;
  getPlacementEvidence(
    context: ResolvedProjectContext,
    evidenceId: string,
  ): Promise<PlacementEvidence | null>;
}>;
export type PlacementLinksQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
type ListCursor = readonly [string, "candidate" | "placement", string];
type EventCursor = readonly [string, string];

const invalidCursor = () => new BacklinkError({
  code: backlinkErrorCodes.invalidRequest,
  message: "Link cursor is invalid.",
  fieldErrors: [{ field: "cursor", message: "Use a cursor returned by this API." }],
});

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

function asPositiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return number;
}

function asNonnegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return number;
}

function asIsoTimestamp(value: unknown, field: string): string {
  const timestamp = value instanceof Date ? value.toISOString() : asString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return timestamp;
}

function asRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function decodeListCursor(value: string | undefined): ListCursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3
      || typeof parsed[0] !== "string" || Number.isNaN(Date.parse(parsed[0]))
      || (parsed[1] !== "candidate" && parsed[1] !== "placement")
      || typeof parsed[2] !== "string" || parsed[2].trim().length === 0) {
      throw invalidCursor();
    }
    return parsed as unknown as ListCursor;
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}

function decodeEventCursor(value: string | undefined): EventCursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== "string" || Number.isNaN(Date.parse(parsed[0]))
      || typeof parsed[1] !== "string" || parsed[1].trim().length === 0) {
      throw invalidCursor();
    }
    return parsed as unknown as EventCursor;
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}

function displayStateForHealth(healthStatus: string): PlacementLink["displayState"] {
  if (healthStatus === "changed") return "changed";
  if (healthStatus === "lost") return "lost";
  return "confirmed";
}

function mapListItem(
  row: Readonly<Record<string, unknown>>,
  view: PlacementLinkView,
): PlacementLinkListItem {
  const recordType = asString(row.recordType, "recordType");
  if (recordType === "candidate") {
    return {
      recordType: "candidate",
      displayState: "candidate",
      candidateId: asString(row.candidateId, "candidateId"),
      sourcePageUrl: asNullableString(row.sourcePageUrl, "sourcePageUrl"),
      targetUrl: asString(row.targetUrl, "targetUrl"),
      candidateStatus: asString(row.candidateStatus, "candidateStatus"),
      matchStatus: asString(row.matchStatus, "matchStatus"),
      validationStatus: asString(row.validationStatus, "validationStatus"),
      version: asPositiveInteger(row.version, "version"),
      createdAt: asIsoTimestamp(row.createdAt, "createdAt"),
      countsTowardKpi: false,
    };
  }
  if (recordType === "placement") {
    const healthStatus = asString(row.healthStatus, "healthStatus");
    return {
      recordType: "placement",
      displayState: view === "recovered"
        ? "recovered"
        : displayStateForHealth(healthStatus),
      placementId: asString(row.placementId, "placementId"),
      candidateId: asString(row.candidateId, "candidateId"),
      sourcePageUrl: asString(row.sourcePageUrl, "sourcePageUrl"),
      targetUrl: asString(row.targetUrl, "targetUrl"),
      initialValidationStatus: asString(row.validationStatus, "validationStatus"),
      healthStatus,
      monitoringStatus: asString(row.monitoringStatus, "monitoringStatus"),
      version: asPositiveInteger(row.version, "version"),
      createdAt: asIsoTimestamp(row.createdAt, "createdAt"),
      countsTowardKpi: true,
    };
  }
  throw new TypeError("Placement link query returned an invalid recordType.");
}

const encodeListCursor = (item: PlacementLinkListItem): string =>
  Buffer.from(JSON.stringify([
    item.createdAt,
    item.recordType,
    item.recordType === "candidate" ? item.candidateId : item.placementId,
  ])).toString("base64url");

function freshness(nextCheckAt: unknown, now: Date): PlacementEvidenceFreshness {
  if (nextCheckAt === null || nextCheckAt === undefined) return "unknown";
  const next = new Date(asIsoTimestamp(nextCheckAt, "nextCheckAt"));
  return now <= next ? "fresh" : "stale";
}

function monitorStatus(value: unknown): PlacementMonitorPublicStatus {
  if (value === null || value === undefined) return "idle";
  if (value === "SCHEDULED") return "scheduled";
  if (value === "RUNNING") return "running";
  if (value === "RETRY_WAIT") return "retry_wait";
  if (value === "FAILED") return "failed";
  if (value === "SUCCEEDED" || value === "CANCELLED") return "completed";
  throw new TypeError("Placement link query returned an invalid monitor status.");
}

function observationResult(value: unknown): PlacementMonitorObservationResult {
  if (
    value === "present"
    || value === "changed"
    || value === "absent"
    || value === "inaccessible"
  ) return value;
  throw new TypeError("Placement link query returned an invalid observation result.");
}

function executionMode(value: unknown): "static" | "browser" {
  if (value === "static" || value === "browser") return value;
  throw new TypeError("Placement link query returned an invalid execution mode.");
}

function safeFailureCode(value: unknown): string | null {
  const code = asNullableString(value, "failureCode");
  if (code === null) return null;
  return /^[A-Z0-9_]{1,100}$/u.test(code) ? code : "MONITORING_FAILED";
}

function failure(value: unknown) {
  const code = safeFailureCode(value);
  return { status: code === null ? "none" as const : "failed" as const, code };
}

function lifecycleType(value: unknown): PlacementLifecycleEventType {
  if (
    typeof value === "string"
    && placementLifecycleEventTypes.includes(value as PlacementLifecycleEventType)
  ) return value as PlacementLifecycleEventType;
  throw new TypeError("Placement link query returned an invalid lifecycle event type.");
}

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599
    ? parsed
    : null;
}

function safeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return [...value];
}

function asText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Placement link query returned an invalid ${field}.`);
  }
  return value;
}

function evidenceOccurrences(
  value: unknown,
): PlacementEvidence["link"]["occurrences"] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(
      "Placement link query returned invalid evidence occurrences.",
    );
  }
  return value.map((item, index) => {
    const occurrence = asRecord(item, `occurrences[${index}]`);
    return {
      resolvedHref: asString(
        occurrence.resolvedHref,
        `occurrences[${index}].resolvedHref`,
      ),
      anchorText: asText(
        occurrence.anchorText,
        `occurrences[${index}].anchorText`,
      ),
      rel: asStringArray(occurrence.rel, `occurrences[${index}].rel`),
      nofollow: asBoolean(
        occurrence.nofollow,
        `occurrences[${index}].nofollow`,
      ),
      sponsored: asBoolean(
        occurrence.sponsored,
        `occurrences[${index}].sponsored`,
      ),
      ugc: asBoolean(occurrence.ugc, `occurrences[${index}].ugc`),
    };
  });
}

export function createPlacementLinksQuery(
  client: PlacementLinksQueryClient,
  options: Readonly<{ now?: () => Date }> = {},
): PlacementLinksQuery {
  const now = options.now ?? (() => new Date());
  const scopeValues = (context: ResolvedProjectContext) => [
    context.tenant.organizationId,
    context.tenant.workspaceId,
    context.project.websiteProjectId,
  ] as const;

  return Object.freeze({
    async listLinks(context, input) {
      const after = decodeListCursor(input.cursor);
      const result = await client.query(`
        WITH entries AS (
          SELECT 'candidate'::text "recordType", 'candidate'::text "displayState",
                 c.id, c.id "candidateId", NULL::uuid "placementId",
                 c.source_page_url "sourcePageUrl", c.target_url "targetUrl",
                 c.status "candidateStatus", c.match_status "matchStatus",
                 c.initial_validation_status "validationStatus",
                 NULL::text "healthStatus", NULL::text "monitoringStatus",
                 false "wasRecovered", c.version, c.created_at "createdAt"
            FROM backlink_placement_candidates c
           WHERE (c.organization_id,c.workspace_id,c.website_project_id)=($1,$2,$3)
             AND c.status NOT IN ('PROMOTED','REJECTED')
          UNION ALL
          SELECT 'placement'::text "recordType",
                 CASE WHEN p.health_status='changed' THEN 'changed'
                      WHEN p.health_status='lost' THEN 'lost'
                      ELSE 'confirmed' END "displayState",
                 p.id, p.candidate_id "candidateId", p.id "placementId",
                 p.source_page_url "sourcePageUrl", p.target_url "targetUrl",
                 NULL::text "candidateStatus", NULL::text "matchStatus",
                 p.initial_validation_status "validationStatus",
                 p.health_status "healthStatus",
                 p.monitoring_status "monitoringStatus",
                 EXISTS (
                   SELECT 1 FROM backlink_lifecycle_events lifecycle
                    WHERE (
                      lifecycle.organization_id,lifecycle.workspace_id,
                      lifecycle.website_project_id,lifecycle.aggregate_type,
                      lifecycle.aggregate_id,lifecycle.event_type
                    )=(
                      p.organization_id,p.workspace_id,p.website_project_id,
                      'placement',p.id,'placement.recovered'
                    )
                 ) "wasRecovered",
                 p.version, p.created_at "createdAt"
            FROM backlink_placements p
           WHERE (p.organization_id,p.workspace_id,p.website_project_id)=($1,$2,$3)
        )
        SELECT "recordType","displayState",id,"candidateId","placementId",
               "sourcePageUrl","targetUrl","candidateStatus","matchStatus",
               "validationStatus","healthStatus","monitoringStatus",
               "wasRecovered",version,"createdAt"
          FROM entries
         WHERE (
           $4::text='all'
           OR ($4='recovered' AND "recordType"='placement' AND "wasRecovered")
           OR ($4<>'recovered' AND "displayState"=$4)
         )
           AND ($5::timestamptz IS NULL OR "createdAt" < $5
             OR ("createdAt"=$5 AND "recordType" > $6)
             OR ("createdAt"=$5 AND "recordType"=$6 AND id>$7::uuid))
         ORDER BY "createdAt" DESC,"recordType",id
         LIMIT $8
      `, [
        ...scopeValues(context),
        input.view,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        input.limit + 1,
      ]);
      const items = result.rows.slice(0, input.limit)
        .map((row) => mapListItem(row, input.view));
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? encodeListCursor(last)
          : null,
      };
    },

    async getCandidateLink(context, candidateId) {
      const result = await client.query(`
        SELECT c.id AS "candidateId", c.opportunity_id "opportunityId",
               c.source_page_url "sourcePageUrl",
               c.normalized_source_url "normalizedSourceUrl",
               c.target_url "targetUrl", c.normalized_target_url "normalizedTargetUrl",
               c.url_normalization_version "urlNormalizationVersion", c.status "candidateStatus",
               c.match_status "matchStatus", c.initial_validation_status "validationStatus",
               c.version, c.created_at "createdAt",
               v.id "latestValidationRunId", v.status "latestValidationStatus",
               v.evidence_observed_at "latestValidationObservedAt",
               v.evidence_snapshot_hash "latestEvidenceSnapshotHash",
               v.evidence_contract_version "latestEvidenceContractVersion",
               v.evidence_schema_version "latestEvidenceSchemaVersion"
          FROM backlink_placement_candidates c
          LEFT JOIN LATERAL (
            SELECT id,status,evidence_observed_at,evidence_snapshot_hash,
                   evidence_contract_version,evidence_schema_version
              FROM backlink_placement_validation_runs v
             WHERE (v.organization_id,v.workspace_id,v.website_project_id,v.candidate_id)=(
               c.organization_id,c.workspace_id,c.website_project_id,c.id)
             ORDER BY v.run_number DESC,v.id DESC
             LIMIT 1
          ) v ON true
         WHERE (c.organization_id,c.workspace_id,c.website_project_id,c.id)=($1,$2,$3,$4::uuid)
      `, [...scopeValues(context), candidateId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const latestValidationRunId = asNullableString(
        row.latestValidationRunId,
        "latestValidationRunId",
      );
      return {
        recordType: "candidate",
        displayState: "candidate",
        candidateId: asString(row.candidateId, "candidateId"),
        opportunityId: asNullableString(row.opportunityId, "opportunityId"),
        sourcePageUrl: asNullableString(row.sourcePageUrl, "sourcePageUrl"),
        normalizedSourceUrl: asNullableString(row.normalizedSourceUrl, "normalizedSourceUrl"),
        targetUrl: asString(row.targetUrl, "targetUrl"),
        normalizedTargetUrl: asString(row.normalizedTargetUrl, "normalizedTargetUrl"),
        urlNormalizationVersion: asString(row.urlNormalizationVersion, "urlNormalizationVersion"),
        candidateStatus: asString(row.candidateStatus, "candidateStatus"),
        matchStatus: asString(row.matchStatus, "matchStatus"),
        validationStatus: asString(row.validationStatus, "validationStatus"),
        version: asPositiveInteger(row.version, "version"),
        createdAt: asIsoTimestamp(row.createdAt, "createdAt"),
        countsTowardKpi: false,
        latestValidation: latestValidationRunId === null ? null : {
          validationRunId: latestValidationRunId,
          status: asString(row.latestValidationStatus, "latestValidationStatus"),
          observedAt: asIsoTimestamp(
            row.latestValidationObservedAt,
            "latestValidationObservedAt",
          ),
          evidenceSnapshotHash: asString(
            row.latestEvidenceSnapshotHash,
            "latestEvidenceSnapshotHash",
          ),
          evidenceContractVersion: asString(
            row.latestEvidenceContractVersion,
            "latestEvidenceContractVersion",
          ),
          evidenceSchemaVersion: asPositiveInteger(
            row.latestEvidenceSchemaVersion,
            "latestEvidenceSchemaVersion",
          ),
        },
      };
    },

    async getPlacementLink(context, placementId) {
      const result = await client.query(`
        SELECT p.id AS "placementId", p.candidate_id "candidateId",
               p.opportunity_id "opportunityId", p.source_page_url "sourcePageUrl",
               p.normalized_source_url "normalizedSourceUrl",
               p.target_url "targetUrl", p.normalized_target_url "normalizedTargetUrl",
               p.url_normalization_version "urlNormalizationVersion",
               p.initial_validation_id "initialValidationId",
               p.initial_validation_status "validationStatus",
               p.initial_evidence_snapshot_hash "initialEvidenceSnapshotHash",
               p.evidence_contract_version "evidenceContractVersion",
               p.initial_evidence_schema_version "initialEvidenceSchemaVersion",
               p.health_status "healthStatus", p.monitoring_status "monitoringStatus",
               p.version, p.created_at "createdAt", p.updated_at "updatedAt",
               observation.id "latestObservationId",
               observation.result "latestObservationResult",
               observation.observed_at "latestObservedAt",
               observation.execution_mode "latestExecutionMode",
               observation.evidence_snapshot_hash "latestEvidenceHash",
               observation.evidence_contract_version "latestEvidenceContractVersion",
               observation.evidence_schema_version "latestEvidenceSchemaVersion",
               observation.failure_code "latestFailureCode",
               policy.next_check_at "nextCheckAt",
               policy.browser_fallback_enabled "browserFallbackEnabled",
               anomalies."consecutiveAnomalies",
               run.id "latestMonitorRunId", run.status "latestMonitorRunStatus",
               run.scheduled_for "latestMonitorRunScheduledFor",
               run.updated_at "latestMonitorRunUpdatedAt"
          FROM backlink_placements p
          LEFT JOIN LATERAL (
            SELECT observation.*
              FROM backlink_monitor_observations observation
             WHERE (
               observation.organization_id,observation.workspace_id,
               observation.website_project_id,observation.placement_id
             )=(p.organization_id,p.workspace_id,p.website_project_id,p.id)
             ORDER BY observation.observed_at DESC,observation.id DESC
             LIMIT 1
          ) observation ON true
          LEFT JOIN LATERAL (
            SELECT policy.next_check_at,policy.browser_fallback_enabled
              FROM backlink_monitor_policies policy
             WHERE (
               policy.organization_id,policy.workspace_id,
               policy.website_project_id,policy.placement_id
             )=(p.organization_id,p.workspace_id,p.website_project_id,p.id)
             ORDER BY policy.created_at DESC,policy.id DESC
             LIMIT 1
          ) policy ON true
          LEFT JOIN LATERAL (
            SELECT count(*)::integer "consecutiveAnomalies"
              FROM backlink_monitor_observations anomaly
             WHERE (
               anomaly.organization_id,anomaly.workspace_id,
               anomaly.website_project_id,anomaly.placement_id
             )=(p.organization_id,p.workspace_id,p.website_project_id,p.id)
               AND anomaly.result<>'present'
               AND anomaly.observed_at>COALESCE((
                 SELECT max(reset.observed_at)
                   FROM backlink_monitor_observations reset
                  WHERE (
                    reset.organization_id,reset.workspace_id,
                    reset.website_project_id,reset.placement_id
                  )=(
                    p.organization_id,p.workspace_id,
                    p.website_project_id,p.id
                  )
                    AND reset.result='present'
               ),'-infinity'::timestamptz)
          ) anomalies ON true
          LEFT JOIN LATERAL (
            SELECT run.id,run.status,run.scheduled_for,run.updated_at
              FROM backlink_monitor_runs run
             WHERE (
               run.organization_id,run.workspace_id,
               run.website_project_id,run.placement_id
             )=(p.organization_id,p.workspace_id,p.website_project_id,p.id)
             ORDER BY run.created_at DESC,run.id DESC
             LIMIT 1
          ) run ON true
         WHERE (p.organization_id,p.workspace_id,p.website_project_id,p.id)=($1,$2,$3,$4::uuid)
      `, [...scopeValues(context), placementId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const healthStatus = asString(row.healthStatus, "healthStatus");
      const latestObservationId = asNullableString(
        row.latestObservationId,
        "latestObservationId",
      );
      const latestMonitorRunId = asNullableString(
        row.latestMonitorRunId,
        "latestMonitorRunId",
      );
      return {
        recordType: "placement",
        displayState: displayStateForHealth(healthStatus),
        placementId: asString(row.placementId, "placementId"),
        candidateId: asString(row.candidateId, "candidateId"),
        opportunityId: asNullableString(row.opportunityId, "opportunityId"),
        sourcePageUrl: asString(row.sourcePageUrl, "sourcePageUrl"),
        normalizedSourceUrl: asString(row.normalizedSourceUrl, "normalizedSourceUrl"),
        targetUrl: asString(row.targetUrl, "targetUrl"),
        normalizedTargetUrl: asString(row.normalizedTargetUrl, "normalizedTargetUrl"),
        urlNormalizationVersion: asString(row.urlNormalizationVersion, "urlNormalizationVersion"),
        initialValidationStatus: asString(row.validationStatus, "validationStatus"),
        healthStatus,
        monitoringStatus: asString(row.monitoringStatus, "monitoringStatus"),
        version: asPositiveInteger(row.version, "version"),
        createdAt: asIsoTimestamp(row.createdAt, "createdAt"),
        updatedAt: asIsoTimestamp(row.updatedAt, "updatedAt"),
        countsTowardKpi: true,
        initialValidation: {
          validationRunId: asString(row.initialValidationId, "initialValidationId"),
          status: asString(row.validationStatus, "validationStatus"),
          evidenceSnapshotHash: asString(
            row.initialEvidenceSnapshotHash,
            "initialEvidenceSnapshotHash",
          ),
          evidenceContractVersion: asString(
            row.evidenceContractVersion,
            "evidenceContractVersion",
          ),
          evidenceSchemaVersion: asPositiveInteger(
            row.initialEvidenceSchemaVersion,
            "initialEvidenceSchemaVersion",
          ),
        },
        nextCheckAt: asIsoTimestamp(row.nextCheckAt, "nextCheckAt"),
        consecutiveAnomalies: asNonnegativeInteger(
          row.consecutiveAnomalies,
          "consecutiveAnomalies",
        ),
        browserFallbackEnabled: asBoolean(
          row.browserFallbackEnabled,
          "browserFallbackEnabled",
        ),
        latestObservation: latestObservationId === null ? null : {
          observationId: latestObservationId,
          result: observationResult(row.latestObservationResult),
          observedAt: asIsoTimestamp(row.latestObservedAt, "latestObservedAt"),
          executionMode: executionMode(row.latestExecutionMode),
          evidence: {
            evidenceId: latestObservationId,
            hash: asString(row.latestEvidenceHash, "latestEvidenceHash"),
            contractVersion: asString(
              row.latestEvidenceContractVersion,
              "latestEvidenceContractVersion",
            ),
            schemaVersion: asPositiveInteger(
              row.latestEvidenceSchemaVersion,
              "latestEvidenceSchemaVersion",
            ),
            freshness: freshness(row.nextCheckAt, now()),
          },
          failure: failure(row.latestFailureCode),
        },
        latestMonitorRun: {
          monitorRunId: latestMonitorRunId,
          status: monitorStatus(row.latestMonitorRunStatus),
          scheduledFor: latestMonitorRunId === null
            ? null
            : asIsoTimestamp(
                row.latestMonitorRunScheduledFor,
                "latestMonitorRunScheduledFor",
              ),
          updatedAt: latestMonitorRunId === null
            ? null
            : asIsoTimestamp(
                row.latestMonitorRunUpdatedAt,
                "latestMonitorRunUpdatedAt",
              ),
        },
      };
    },

    async listPlacementEvents(context, placementId, input) {
      const exists = await client.query(`
        SELECT 1
          FROM backlink_placements placement
         WHERE (
           placement.organization_id,placement.workspace_id,
           placement.website_project_id,placement.id
         )=($1,$2,$3,$4::uuid)
      `, [...scopeValues(context), placementId]);
      if (exists.rows[0] === undefined) return null;
      const after = decodeEventCursor(input.cursor);
      const result = await client.query(`
        SELECT lifecycle.id "eventId",lifecycle.event_type "eventType",
               lifecycle.created_at "occurredAt",
               lifecycle.aggregate_version "placementVersion",
               lifecycle.before_state->>'healthStatus' "previousHealthStatus",
               lifecycle.after_state->>'healthStatus' "nextHealthStatus",
               lifecycle.after_state->>'observationId' "observationId",
               lifecycle.reason
          FROM backlink_lifecycle_events lifecycle
         WHERE (
           lifecycle.organization_id,lifecycle.workspace_id,
           lifecycle.website_project_id,lifecycle.aggregate_type,
           lifecycle.aggregate_id
         )=($1,$2,$3,'placement',$4::uuid)
           AND lifecycle.event_type=ANY($5::text[])
           AND ($6::timestamptz IS NULL OR lifecycle.created_at<$6
             OR (lifecycle.created_at=$6 AND lifecycle.id>$7::uuid))
         ORDER BY lifecycle.created_at DESC,lifecycle.id
         LIMIT $8
      `, [
        ...scopeValues(context),
        placementId,
        placementLifecycleEventTypes,
        after?.[0] ?? null,
        after?.[1] ?? null,
        input.limit + 1,
      ]);
      const items = result.rows.slice(0, input.limit).map((row) => ({
        eventId: asString(row.eventId, "eventId"),
        eventType: lifecycleType(row.eventType),
        occurredAt: asIsoTimestamp(row.occurredAt, "occurredAt"),
        placementVersion: asPositiveInteger(
          row.placementVersion,
          "placementVersion",
        ),
        previousHealthStatus: asNullableString(
          row.previousHealthStatus,
          "previousHealthStatus",
        ),
        nextHealthStatus: asNullableString(
          row.nextHealthStatus,
          "nextHealthStatus",
        ),
        observationId: asNullableString(row.observationId, "observationId"),
        reason: asNullableString(row.reason, "reason"),
      }));
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? Buffer.from(JSON.stringify([last.occurredAt, last.eventId]))
              .toString("base64url")
          : null,
      };
    },

    async getPlacementEvidence(context, evidenceId) {
      const result = await client.query(`
        SELECT observation.id "evidenceId",
               observation.placement_id "placementId",
               observation.result,observation.failure_code "failureCode",
               observation.evidence_snapshot "evidenceSnapshot",
               observation.evidence_snapshot_hash "evidenceHash",
               observation.evidence_contract_version "evidenceContractVersion",
               observation.evidence_schema_version "evidenceSchemaVersion",
               observation.observed_at "observedAt",
               observation.execution_mode "executionMode",
               placement.source_page_url "sourcePageUrl",
               placement.target_url "targetUrl",
               policy.next_check_at "nextCheckAt"
          FROM backlink_monitor_observations observation
          JOIN backlink_placements placement ON (
            placement.organization_id,placement.workspace_id,
            placement.website_project_id,placement.id
          )=(
            observation.organization_id,observation.workspace_id,
            observation.website_project_id,observation.placement_id
          )
          LEFT JOIN LATERAL (
            SELECT current_policy.next_check_at
              FROM backlink_monitor_policies current_policy
             WHERE (
               current_policy.organization_id,current_policy.workspace_id,
               current_policy.website_project_id,current_policy.placement_id
             )=(
               observation.organization_id,observation.workspace_id,
               observation.website_project_id,observation.placement_id
             )
             ORDER BY current_policy.created_at DESC,current_policy.id DESC
             LIMIT 1
          ) policy ON true
         WHERE (
           observation.organization_id,observation.workspace_id,
           observation.website_project_id,observation.id
         )=($1,$2,$3,$4::uuid)
      `, [...scopeValues(context), evidenceId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const snapshot = asRecord(row.evidenceSnapshot, "evidenceSnapshot");
      const expectedHash = asString(row.evidenceHash, "evidenceHash");
      if (hashPlacementEvidence(snapshot) !== expectedHash) {
        throw new BacklinkError({
          code: backlinkErrorCodes.internal,
          message: "Placement evidence integrity verification failed.",
        });
      }
      const fetch = snapshot.fetch === null || snapshot.fetch === undefined
        ? null
        : asRecord(snapshot.fetch, "evidenceSnapshot.fetch");
      const page = snapshot.page === null || snapshot.page === undefined
        ? null
        : asRecord(snapshot.page, "evidenceSnapshot.page");
      const snapshotResult = snapshot.result === null
        || snapshot.result === undefined
        ? null
        : asRecord(snapshot.result, "evidenceSnapshot.result");
      const mode = executionMode(row.executionMode);
      return {
        evidenceId: asString(row.evidenceId, "evidenceId"),
        placementId: asString(row.placementId, "placementId"),
        kind: "placement_observation",
        immutable: true,
        hashVerified: true,
        hash: expectedHash,
        contractVersion: asString(
          row.evidenceContractVersion,
          "evidenceContractVersion",
        ),
        schemaVersion: asPositiveInteger(
          row.evidenceSchemaVersion,
          "evidenceSchemaVersion",
        ),
        observedAt: asIsoTimestamp(row.observedAt, "observedAt"),
        executionMode: mode,
        result: observationResult(row.result),
        reasonCode: asNullableString(snapshotResult?.reasonCode, "reasonCode"),
        failure: failure(row.failureCode),
        freshness: freshness(row.nextCheckAt, now()),
        source: {
          sourcePageUrl: asString(row.sourcePageUrl, "sourcePageUrl"),
          targetUrl: asString(row.targetUrl, "targetUrl"),
          fetchMode: mode,
          httpStatus: safeNumber(fetch?.status),
          finalUrl: asNullableString(fetch?.finalUrl, "finalUrl"),
          contentType: asNullableString(fetch?.contentType, "contentType"),
          fetchedAt: fetch?.fetchedAt === null || fetch?.fetchedAt === undefined
            ? null
            : asIsoTimestamp(fetch.fetchedAt, "fetchedAt"),
          redirectChain: fetch === null
            ? []
            : asStringArray(fetch.redirectChain, "redirectChain"),
          xRobotsTag: asNullableString(fetch?.xRobotsTag, "xRobotsTag"),
        },
        link: {
          canonicalUrl: asNullableString(page?.canonicalUrl, "canonicalUrl"),
          noindex: safeBoolean(page?.noindex),
          occurrenceCount: Array.isArray(page?.occurrences)
            ? page.occurrences.length
            : null,
          robotsDirectives: page === null
            ? []
            : asStringArray(page.robotsDirectives, "robotsDirectives"),
          occurrences: evidenceOccurrences(page?.occurrences),
        },
      };
    },
  });
}
