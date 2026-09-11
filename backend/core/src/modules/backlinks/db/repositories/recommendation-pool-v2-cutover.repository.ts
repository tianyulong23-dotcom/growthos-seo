import { createHash, randomUUID } from "node:crypto";

import {
  finalizeRecommendationGeneration,
  type RecommendationFinalizationCandidate,
} from "../../application/services/recommendation-pool-generation-finalizer.service.js";
import { recommendationBatchSelectionPolicyVersion } from "../../domain/recommendations/recommendation-batch-policy.js";
import type { RecommendationDiscoveryStopReason } from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../tenant-transaction.js";

export type RecommendationPoolV2CutoverMode = "PLAN" | "EXECUTE" | "VERIFY";
export type RecommendationPoolV2CutoverResult =
  | "READY"
  | "V2_ACTIVE"
  | "ALREADY_V2_ACTIVE"
  | "INPUT_REQUIRED"
  | "MIGRATION_BLOCKED";

export type RecommendationPoolV2CutoverProject = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  projectContextSnapshotId: string;
  projectContextSnapshotVersion: number;
}>;

export type RecommendationPoolV2GenerationLineage = Readonly<{
  generationContractId: string;
  poolContractVersion: "recommendation-pool.v2";
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
}>;

export type RecommendationPoolV2CutoverProjectFact =
  RecommendationPoolV2CutoverProject &
    Readonly<{
      phase: "PLAN" | "APPLY";
      result: RecommendationPoolV2CutoverResult;
      reasonCodes: readonly string[];
      lineage: RecommendationPoolV2GenerationLineage | null;
      canonicalBatchCount: number | null;
      availableBatchCount: number | null;
      canonicalItemCount: number | null;
    }>;

export type RecommendationPoolV2CutoverRun = Readonly<{
  id: string;
  commandId: string;
  mode: RecommendationPoolV2CutoverMode;
  status:
    | "RUNNING"
    | "PLANNED"
    | "INPUT_REQUIRED"
    | "MIGRATION_BLOCKED"
    | "COMPLETED";
  eligibleProjectCount: number;
  v2ActiveProjectCount: number;
  inputRequiredProjectCount: number;
  migrationBlockedProjectCount: number;
  verification: Readonly<Record<string, unknown>>;
  startedAt: Date;
  completedAt: Date | null;
}>;

export type RecommendationPoolV2CutoverVerification = Readonly<
  Record<string, unknown>
> &
  Readonly<{
    completed: boolean;
    eligibleProjectCount: number;
    v2ActiveProjectCount: number;
    validV2ActiveProjectCount: number;
    activeV1ProjectCount: number;
    migrationBlockedProjectCount: number;
    invalidV2ActiveProjectCount: number;
    activeV1GenerationCount: number;
    activeV1RefillCount: number;
    activeV1RefillJobCount: number;
    activeV1OutboxCount: number;
    activeV1ClaimCount: number;
    activeV1ProviderRequestCount: number;
    activeV1ProviderReservationCount: number;
    activeV1ProviderLeaseCount: number;
  }>;

export type RecommendationPoolV2CutoverRepository = Readonly<{
  startRun(
    input: Readonly<{
      runId: string;
      commandId: string;
      mode: RecommendationPoolV2CutoverMode;
      actor: string;
    }>,
  ): Promise<RecommendationPoolV2CutoverRun>;
  listEligibleProjects(): Promise<
    readonly RecommendationPoolV2CutoverProject[]
  >;
  listRunFacts(
    runId: string,
  ): Promise<readonly RecommendationPoolV2CutoverProjectFact[]>;
  planProject(
    project: RecommendationPoolV2CutoverProject,
  ): Promise<RecommendationPoolV2CutoverProjectFact>;
  executeProject(
    input: Readonly<{
      project: RecommendationPoolV2CutoverProject;
      actor: string;
      observedAt: Date;
    }>,
  ): Promise<RecommendationPoolV2CutoverProjectFact>;
  recordFact(
    input: Readonly<{
      id: string;
      runId: string;
      fact: RecommendationPoolV2CutoverProjectFact;
      actor: string;
      observedAt: Date;
    }>,
  ): Promise<void>;
  verifyCutover(): Promise<RecommendationPoolV2CutoverVerification>;
  finishRun(
    input: Readonly<{
      runId: string;
      status: Exclude<RecommendationPoolV2CutoverRun["status"], "RUNNING">;
      eligibleProjectCount: number;
      v2ActiveProjectCount: number;
      inputRequiredProjectCount: number;
      migrationBlockedProjectCount: number;
      verification: Readonly<Record<string, unknown>>;
      actor: string;
      completedAt: Date;
    }>,
  ): Promise<void>;
  enterMaintenanceReadOnly(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      actor: string;
      reasonCodes: readonly string[];
      observedAt: Date;
    }>,
  ): Promise<void>;
}>;

type ProjectContractRow = Readonly<{
  id: string;
  poolContractVersion: string;
  migrationState: string;
  generationContractId: string | null;
  recommendationContextVersionId: string | null;
  visiblePoolGeneration: number | null;
  inputPinId: string | null;
}>;

type GenerationRow = Readonly<{
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
  qualificationContractVersion: string;
  visibilityContractVersion: string;
  scoreModelVersion: string;
  metricScope: string;
  effectiveUniqueCandidateCount: number | null;
  canonicalBatchSize: number | null;
  canonicalBatchCount: number | null;
  canonicalOrderFingerprint: string | null;
  discoveryTerminalReason: string | null;
  discoveryCompletedAt: Date | null;
  market: string;
  location: string;
  language: string;
  trafficLocationCode: number | null;
  trafficLanguageCode: string | null;
}>;

type CanonicalCounts = Readonly<{
  batchCount: number;
  availableBatchCount: number;
  terminalBatchCount: number;
  itemCount: number;
  incompleteItemCount: number;
}>;

type ProjectionCandidateRow = Readonly<{
  id: string;
  recommendationId: string;
  prospectId: string;
  inventoryId: string;
  sourceGenerationContractId: string;
  sourceRecommendationContextVersionId: string;
  sourceVisiblePoolGeneration: number;
  sourceInputPinId: string;
  sourceQualificationContractVersion: string;
  sourceVisibilityContractVersion: string;
  sourceScoreModelVersion: string;
  sourceMetricScope: string;
  sourceMarket: string;
  sourceLocation: string;
  sourceLanguage: string;
  sourceTrafficLocationCode: number | null;
  sourceTrafficLanguageCode: string | null;
  canonicalDomain: string;
  recommendationReasonStrengthBand: number | null;
  evidenceCompleteness: number | null;
  qualificationFactId: string;
  qualificationDecision: string;
  qualificationReasonCode: string;
  visibilityQualificationFactId: string;
  visibilityFactId: string;
  visibilityDecision: string;
  visibilityReasonCode: string;
  contactDecision: string;
  contactReasonCode: string;
  contactObservedAt: Date;
  contactJobId: string | null;
  contactJobTerminalReason: string | null;
  contactJobCompletedAt: string | null;
  trafficOrganicEtv: number | null;
  authorityRank: number | null;
  spamScore: number | null;
  metricObservedAt: Date;
  contactPageUrl: string | null;
  primaryCategory: string | null;
}>;

const poolV2 = "recommendation-pool.v2" as const;
const generationTerminalReasons = new Set<RecommendationDiscoveryStopReason>([
  "CANDIDATE_LIMIT_REACHED",
  "SAFE_SUPPLY_REACHED",
  "LOW_YIELD",
  "BUDGET_EXHAUSTED",
  "PATHS_EXHAUSTED",
  "CONTEXT_SUPERSEDED",
  "UNKNOWN_CHARGE",
]);

const legacyTerminalContactReasonsByDecision = Object.freeze({
  eligible: new Set(["PUBLIC_EMAIL_FOUND"]),
  ineligible: new Set([
    "NO_PUBLIC_EMAIL",
    "SITE_UNREACHABLE",
    "UNSUPPORTED_CONTENT",
  ]),
  manual_review: new Set([
    "CONTACT_FORM_ONLY",
    "LOGIN_REQUIRED",
    "CAPTCHA_OR_BOT_CHALLENGE",
    "ROBOTS_DISALLOWED",
    "ACCESS_DENIED",
    "MANUAL_REVIEW_REQUIRED",
    "COMPLETED_PARTIAL",
  ]),
});

export type LegacyContactTerminalAssessment =
  "TERMINAL" | "CONTACT_PENDING" | "INVALID_TERMINAL_SNAPSHOT";

export function assessLegacyContactTerminalSnapshot(
  input: Readonly<{
    decision: string;
    reasonCode: string;
  }>,
): LegacyContactTerminalAssessment {
  if (
    input.decision === "pending" ||
    input.reasonCode === "CONTACT_PENDING" ||
    input.reasonCode === "CONTACT_NOT_EVALUATED"
  ) {
    return "CONTACT_PENDING";
  }
  const terminalReasons =
    legacyTerminalContactReasonsByDecision[
      input.decision as keyof typeof legacyTerminalContactReasonsByDecision
    ];
  return terminalReasons?.has(input.reasonCode) === true
    ? "TERMINAL"
    : "INVALID_TERMINAL_SNAPSHOT";
}

function legacyContactProjectionIssues(
  rows: readonly ProjectionCandidateRow[],
): readonly string[] {
  const assessments = new Set(
    rows.map((row) =>
      assessLegacyContactTerminalSnapshot({
        decision: row.contactDecision,
        reasonCode: row.contactReasonCode,
      }),
    ),
  );
  if (assessments.has("CONTACT_PENDING")) {
    return Object.freeze(["CONTACT_PENDING"]);
  }
  return Object.freeze([
    ...(assessments.has("INVALID_TERMINAL_SNAPSHOT")
      ? ["LEGACY_CONTACT_TERMINAL_FACT_INVALID"]
      : []),
    ...(rows.some(
      (row) =>
        row.contactJobId === null ||
        row.contactJobTerminalReason !== row.contactReasonCode ||
        row.contactJobCompletedAt === null,
    )
      ? ["TERMINAL_LEGACY_LINEAGE_INCOMPLETE"]
      : []),
  ]);
}

const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
};

const nullableText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const integer = (value: unknown, label: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return parsed;
};

const nullableInteger = (value: unknown): number | null =>
  value === null || value === undefined ? null : integer(value, "integer");

const nullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError("Invalid numeric value");
  }
  return parsed;
};

const date = (value: unknown, label: string): Date => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Invalid ${label}`);
  }
  return parsed;
};

const nullableDate = (value: unknown): Date | null =>
  value === null || value === undefined ? null : date(value, "date");

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const lineageFromGeneration = (
  generation: GenerationRow,
): RecommendationPoolV2GenerationLineage => ({
  generationContractId: generation.generationContractId,
  poolContractVersion: poolV2,
  recommendationContextVersionId: generation.recommendationContextVersionId,
  visiblePoolGeneration: generation.visiblePoolGeneration,
  inputPinId: generation.inputPinId,
});

function projectFact(
  project: RecommendationPoolV2CutoverProject,
  phase: "PLAN" | "APPLY",
  result: RecommendationPoolV2CutoverResult,
  reasonCodes: readonly string[],
  generation: GenerationRow | null,
  counts: CanonicalCounts | null,
): RecommendationPoolV2CutoverProjectFact {
  return Object.freeze({
    ...project,
    phase,
    result,
    reasonCodes: Object.freeze([...reasonCodes]),
    lineage: generation === null ? null : lineageFromGeneration(generation),
    canonicalBatchCount: generation?.canonicalBatchCount ?? null,
    availableBatchCount: counts?.availableBatchCount ?? null,
    canonicalItemCount: counts?.itemCount ?? null,
  });
}

async function withTransaction<T>(
  pool: BacklinkTenantPool,
  work: (client: BacklinkTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

function parseRun(
  row: Record<string, unknown>,
): RecommendationPoolV2CutoverRun {
  return Object.freeze({
    id: text(row.id, "cutover run id"),
    commandId: text(row.commandId, "cutover command id"),
    mode: text(row.mode, "cutover mode") as RecommendationPoolV2CutoverMode,
    status: text(
      row.status,
      "cutover status",
    ) as RecommendationPoolV2CutoverRun["status"],
    eligibleProjectCount: integer(
      row.eligibleProjectCount,
      "eligible project count",
    ),
    v2ActiveProjectCount: integer(
      row.v2ActiveProjectCount,
      "V2 active project count",
    ),
    inputRequiredProjectCount: integer(
      row.inputRequiredProjectCount,
      "input required project count",
    ),
    migrationBlockedProjectCount: integer(
      row.migrationBlockedProjectCount,
      "migration blocked project count",
    ),
    verification: record(row.verification),
    startedAt: date(row.startedAt, "cutover started at"),
    completedAt: nullableDate(row.completedAt),
  });
}

function parseProject(
  row: Record<string, unknown>,
): RecommendationPoolV2CutoverProject {
  return Object.freeze({
    organizationId: text(row.organizationId, "organization id"),
    workspaceId: text(row.workspaceId, "workspace id"),
    websiteProjectId: text(row.websiteProjectId, "website project id"),
    projectContextSnapshotId: text(
      row.projectContextSnapshotId,
      "project context snapshot id",
    ),
    projectContextSnapshotVersion: integer(
      row.projectContextSnapshotVersion,
      "project context snapshot version",
    ),
  });
}

function parseFact(
  row: Record<string, unknown>,
): RecommendationPoolV2CutoverProjectFact {
  const generationContractId = nullableText(row.generationContractId);
  return Object.freeze({
    ...parseProject(row),
    phase: text(row.phase, "cutover phase") as "PLAN" | "APPLY",
    result: text(
      row.result,
      "cutover result",
    ) as RecommendationPoolV2CutoverResult,
    reasonCodes: Object.freeze(stringArray(row.reasonCodes)),
    lineage:
      generationContractId === null
        ? null
        : Object.freeze({
            generationContractId,
            poolContractVersion: poolV2,
            recommendationContextVersionId: text(
              row.recommendationContextVersionId,
              "recommendation context version id",
            ),
            visiblePoolGeneration: integer(
              row.visiblePoolGeneration,
              "visible pool generation",
            ),
            inputPinId: text(row.inputPinId, "input pin id"),
          }),
    canonicalBatchCount: nullableInteger(row.canonicalBatchCount),
    availableBatchCount: nullableInteger(row.availableBatchCount),
    canonicalItemCount: nullableInteger(row.canonicalItemCount),
  });
}

function parseGeneration(row: Record<string, unknown>): GenerationRow {
  return Object.freeze({
    generationContractId: text(
      row.generationContractId,
      "generation contract id",
    ),
    recommendationContextVersionId: text(
      row.recommendationContextVersionId,
      "recommendation context version id",
    ),
    visiblePoolGeneration: integer(
      row.visiblePoolGeneration,
      "visible pool generation",
    ),
    inputPinId: text(row.inputPinId, "input pin id"),
    qualificationContractVersion: text(
      row.qualificationContractVersion,
      "qualification contract version",
    ),
    visibilityContractVersion: text(
      row.visibilityContractVersion,
      "visibility contract version",
    ),
    scoreModelVersion: text(row.scoreModelVersion, "score model version"),
    metricScope: text(row.metricScope, "metric scope"),
    effectiveUniqueCandidateCount: nullableInteger(
      row.effectiveUniqueCandidateCount,
    ),
    canonicalBatchSize: nullableInteger(row.canonicalBatchSize),
    canonicalBatchCount: nullableInteger(row.canonicalBatchCount),
    canonicalOrderFingerprint: nullableText(row.canonicalOrderFingerprint),
    discoveryTerminalReason: nullableText(row.discoveryTerminalReason),
    discoveryCompletedAt: nullableDate(row.discoveryCompletedAt),
    market: text(row.market, "generation market"),
    location: text(row.location, "generation location"),
    language: text(row.language, "generation language"),
    trafficLocationCode: nullableInteger(row.trafficLocationCode),
    trafficLanguageCode: nullableText(row.trafficLanguageCode),
  });
}

async function readProjectState(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
): Promise<
  Readonly<{
    snapshotCurrent: boolean;
    inputsReady: boolean;
    inputReasonCodes: readonly string[];
    inputPinId: string | null;
    inputPinQualificationContractVersion: string | null;
    inputPinMarket: string | null;
    contract: ProjectContractRow | null;
    generation: GenerationRow | null;
  }>
> {
  const snapshotResult = await client.query(
    `SELECT snapshot.id::text AS "projectContextSnapshotId",
            snapshot.snapshot_version AS "projectContextSnapshotVersion",
            snapshot.project_status AS "projectStatus",
            (
              jsonb_array_length(snapshot.products) +
              jsonb_array_length(snapshot.keywords) +
              jsonb_array_length(snapshot.target_urls) +
              jsonb_array_length(snapshot.target_audiences)
            ) AS "snapshotInputCount"
       FROM backlinks.backlink_project_context_snapshots AS snapshot
      WHERE snapshot.organization_id=$1
        AND snapshot.workspace_id=$2
        AND snapshot.website_project_id=$3
      ORDER BY snapshot.snapshot_version DESC,
               snapshot.created_at DESC,
               snapshot.id DESC
      LIMIT 1`,
    [project.organizationId, project.workspaceId, project.websiteProjectId],
  );
  const snapshot = snapshotResult.rows[0];
  const snapshotCurrent =
    snapshot !== undefined &&
    snapshot.projectContextSnapshotId === project.projectContextSnapshotId &&
    snapshot.projectContextSnapshotVersion ===
      project.projectContextSnapshotVersion &&
    snapshot.projectStatus === "ACTIVE";
  if (!snapshotCurrent) {
    return {
      snapshotCurrent: false,
      inputsReady: false,
      inputReasonCodes: ["PROJECT_CONTEXT_SUPERSEDED"],
      inputPinId: null,
      inputPinQualificationContractVersion: null,
      inputPinMarket: null,
      contract: null,
      generation: null,
    };
  }

  const inputResult = await client.query(
    `SELECT pin.id::text AS "inputPinId",
            pin.qualification_contract_version
              AS "inputPinQualificationContractVersion",
            pin.market AS "inputPinMarket",
            (
              jsonb_array_length(profile.keywords_and_topics) +
              jsonb_array_length(profile.products_and_services) +
              jsonb_array_length(profile.target_urls) +
              jsonb_array_length(profile.target_audiences)
            ) AS "profileInputCount"
       FROM backlinks.backlink_generation_input_pins AS pin
       JOIN backlinks.backlink_outreach_profile_versions AS profile
         ON profile.organization_id=pin.organization_id
        AND profile.workspace_id=pin.workspace_id
        AND profile.website_project_id=pin.website_project_id
        AND profile.id=pin.outreach_profile_version_id
      WHERE pin.organization_id=$1
        AND pin.workspace_id=$2
        AND pin.website_project_id=$3
        AND pin.project_context_version=$4
      ORDER BY pin.created_at DESC, pin.id DESC
      LIMIT 1`,
    [
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      project.projectContextSnapshotVersion,
    ],
  );
  const input = inputResult.rows[0];
  const snapshotInputCount = integer(
    snapshot.snapshotInputCount,
    "snapshot input count",
  );
  const profileInputCount =
    input === undefined
      ? 0
      : integer(input.profileInputCount, "profile input count");
  const inputReasonCodes: string[] = [];
  if (input === undefined) {
    inputReasonCodes.push("GENERATION_INPUT_PIN_REQUIRED");
  }
  if (snapshotInputCount + profileInputCount === 0) {
    inputReasonCodes.push("DISCOVERY_INPUTS_REQUIRED");
  }

  const contractResult = await client.query(
    `SELECT id::text AS id,
            pool_contract_version AS "poolContractVersion",
            migration_state AS "migrationState",
            generation_contract_id::text AS "generationContractId",
            recommendation_context_version_id::text
              AS "recommendationContextVersionId",
            visible_pool_generation AS "visiblePoolGeneration",
            input_pin_id::text AS "inputPinId"
       FROM backlinks.backlink_recommendation_pool_project_contracts
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3
      FOR UPDATE`,
    [project.organizationId, project.workspaceId, project.websiteProjectId],
  );
  const contractRow = contractResult.rows[0];
  const contract =
    contractRow === undefined
      ? null
      : Object.freeze({
          id: text(contractRow.id, "project contract id"),
          poolContractVersion: text(
            contractRow.poolContractVersion,
            "project pool contract version",
          ),
          migrationState: text(
            contractRow.migrationState,
            "project migration state",
          ),
          generationContractId: nullableText(contractRow.generationContractId),
          recommendationContextVersionId: nullableText(
            contractRow.recommendationContextVersionId,
          ),
          visiblePoolGeneration: nullableInteger(
            contractRow.visiblePoolGeneration,
          ),
          inputPinId: nullableText(contractRow.inputPinId),
        });

  const generationResult = await client.query(
    `SELECT generation.id::text AS "generationContractId",
            generation.recommendation_context_version_id::text
              AS "recommendationContextVersionId",
            generation.visible_pool_generation AS "visiblePoolGeneration",
            generation.input_pin_id::text AS "inputPinId",
            generation.qualification_contract_version
              AS "qualificationContractVersion",
            generation.visibility_contract_version
              AS "visibilityContractVersion",
            generation.score_model_version AS "scoreModelVersion",
            generation.metric_scope AS "metricScope",
            generation.effective_unique_candidate_count
              AS "effectiveUniqueCandidateCount",
            generation.canonical_batch_size AS "canonicalBatchSize",
            generation.canonical_batch_count AS "canonicalBatchCount",
            generation.canonical_order_fingerprint
              AS "canonicalOrderFingerprint",
            generation.discovery_terminal_reason
              AS "discoveryTerminalReason",
            generation.discovery_completed_at AS "discoveryCompletedAt",
            generation.market,
            generation.location,
            generation.language,
            generation.traffic_location_code AS "trafficLocationCode",
            generation.traffic_language_code AS "trafficLanguageCode"
       FROM backlinks.backlink_recommendation_generation_contracts
         AS generation
       JOIN backlinks.backlink_generation_input_pins AS pin
         ON pin.organization_id=generation.organization_id
        AND pin.workspace_id=generation.workspace_id
        AND pin.website_project_id=generation.website_project_id
        AND pin.id=generation.input_pin_id
      WHERE generation.organization_id=$1
        AND generation.workspace_id=$2
        AND generation.website_project_id=$3
        AND generation.pool_contract_version='recommendation-pool.v2'
        AND generation.recommendation_context_version_id=$4
        AND pin.project_context_version=$5
      ORDER BY
        (generation.id=$6::uuid) DESC,
        generation.visible_pool_generation DESC,
        generation.created_at DESC,
        generation.id DESC
      LIMIT 1`,
    [
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      project.projectContextSnapshotId,
      project.projectContextSnapshotVersion,
      contract?.generationContractId,
    ],
  );

  return Object.freeze({
    snapshotCurrent,
    inputsReady: inputReasonCodes.length === 0,
    inputReasonCodes: Object.freeze(inputReasonCodes),
    inputPinId:
      input === undefined ? null : text(input.inputPinId, "input pin id"),
    inputPinQualificationContractVersion:
      input === undefined
        ? null
        : text(
            input.inputPinQualificationContractVersion,
            "input pin qualification contract version",
          ),
    inputPinMarket:
      input === undefined
        ? null
        : text(input.inputPinMarket, "input pin market"),
    contract,
    generation:
      generationResult.rows[0] === undefined
        ? null
        : parseGeneration(generationResult.rows[0]),
  });
}

async function readCanonicalCounts(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  generation: GenerationRow,
): Promise<CanonicalCounts> {
  const result = await client.query(
    `SELECT
       count(DISTINCT batch.id)::integer AS "batchCount",
       count(DISTINCT batch.id) FILTER (
         WHERE batch.state='AVAILABLE'
       )::integer AS "availableBatchCount",
       count(DISTINCT batch.id) FILTER (
         WHERE batch.contact_terminal_count=batch.contact_total_count
       )::integer AS "terminalBatchCount",
       count(item.id)::integer AS "itemCount",
       count(item.id) FILTER (
         WHERE NOT backlinks.backlink_recommendation_release_item_has_valid_lineage(item)
            OR item.input_pin_id IS NULL
            OR item.contact_terminal_reason_at_release IS NULL
            OR item.contact_terminal_reason_at_release='CONTACT_PENDING'
            OR item.contact_completed_at_release IS NULL
       )::integer AS "incompleteItemCount"
     FROM backlinks.backlink_recommendation_release_batches AS batch
     LEFT JOIN backlinks.backlink_recommendation_release_batch_items AS item
       ON item.organization_id=batch.organization_id
      AND item.workspace_id=batch.workspace_id
      AND item.website_project_id=batch.website_project_id
      AND item.batch_id=batch.id
    WHERE batch.organization_id=$1
      AND batch.workspace_id=$2
      AND batch.website_project_id=$3
      AND batch.generation_contract_id=$4`,
    [
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      generation.generationContractId,
    ],
  );
  const row = result.rows[0] ?? {};
  return Object.freeze({
    batchCount: integer(row.batchCount ?? 0, "canonical batch count"),
    availableBatchCount: integer(
      row.availableBatchCount ?? 0,
      "available batch count",
    ),
    terminalBatchCount: integer(
      row.terminalBatchCount ?? 0,
      "terminal batch count",
    ),
    itemCount: integer(row.itemCount ?? 0, "canonical item count"),
    incompleteItemCount: integer(
      row.incompleteItemCount ?? 0,
      "incomplete item count",
    ),
  });
}

function canonicalIssueCodes(
  generation: GenerationRow,
  counts: CanonicalCounts,
): readonly string[] {
  const issues: string[] = [];
  if (
    generation.discoveryCompletedAt === null ||
    generation.effectiveUniqueCandidateCount === null ||
    generation.canonicalBatchSize === null ||
    generation.canonicalBatchCount === null ||
    generation.canonicalOrderFingerprint === null ||
    generation.discoveryTerminalReason === null
  ) {
    issues.push("V2_GENERATION_INCOMPLETE");
    return issues;
  }
  if (generation.effectiveUniqueCandidateCount === 0) {
    issues.push("EFFECTIVE_CANDIDATES_REQUIRED");
    return issues;
  }
  if (
    counts.batchCount !== 0 &&
    counts.batchCount !== generation.canonicalBatchCount
  ) {
    issues.push("CANONICAL_BATCH_COUNT_MISMATCH");
  }
  if (
    counts.itemCount !== 0 &&
    counts.itemCount !== generation.effectiveUniqueCandidateCount
  ) {
    issues.push("CANONICAL_ITEM_COUNT_MISMATCH");
  }
  if (counts.incompleteItemCount > 0) {
    issues.push("CANONICAL_ITEM_LINEAGE_OR_CONTACT_INCOMPLETE");
  }
  if (
    counts.batchCount > 0 &&
    (counts.availableBatchCount !== counts.batchCount ||
      counts.terminalBatchCount !== counts.batchCount)
  ) {
    issues.push("CANONICAL_BATCH_NOT_AVAILABLE");
  }
  return issues;
}

function hasReadyLineageConflict(
  contract: ProjectContractRow | null,
  generation: GenerationRow | null,
): boolean {
  if (contract?.migrationState !== "V2_READY") {
    return false;
  }
  if (generation === null) {
    return (
      contract.generationContractId !== null ||
      contract.recommendationContextVersionId !== null ||
      contract.visiblePoolGeneration !== null ||
      contract.inputPinId !== null
    );
  }
  return (
    contract.generationContractId !== generation.generationContractId ||
    contract.recommendationContextVersionId !==
      generation.recommendationContextVersionId ||
    contract.visiblePoolGeneration !== generation.visiblePoolGeneration ||
    contract.inputPinId !== generation.inputPinId
  );
}

async function setReadyContract(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  contract: ProjectContractRow | null,
  generation: GenerationRow | null,
  actor: string,
  observedAt: Date,
  idFactory: () => string,
): Promise<void> {
  const lineage =
    generation === null
      ? [null, null, null, null]
      : [
          generation.generationContractId,
          generation.recommendationContextVersionId,
          generation.visiblePoolGeneration,
          generation.inputPinId,
        ];
  if (contract === null) {
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
         id, organization_id, workspace_id, website_project_id,
         pool_contract_version, migration_state, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, state_reason_codes, created_at, updated_at,
         created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,'recommendation-pool.v2','V2_READY',
         $5,$6,$7,$8,'[]'::jsonb,$9,$9,$10,$10
       )`,
      [
        idFactory(),
        project.organizationId,
        project.workspaceId,
        project.websiteProjectId,
        ...lineage,
        observedAt,
        actor,
      ],
    );
    return;
  }
  if (
    contract.migrationState === "V2_READY" &&
    ((contract.generationContractId === generation?.generationContractId &&
      contract.recommendationContextVersionId ===
        generation?.recommendationContextVersionId &&
      contract.visiblePoolGeneration === generation?.visiblePoolGeneration &&
      contract.inputPinId === generation?.inputPinId) ||
      (contract.generationContractId === null &&
        contract.recommendationContextVersionId === null &&
        contract.visiblePoolGeneration === null &&
        contract.inputPinId === null))
  ) {
    return;
  }
  if (
    !["V1_ACTIVE", "V2_READY", "MIGRATION_BLOCKED"].includes(
      contract.migrationState,
    )
  ) {
    return;
  }
  await client.query(
    `UPDATE backlinks.backlink_recommendation_pool_project_contracts
        SET pool_contract_version='recommendation-pool.v2',
            migration_state='V2_READY',
            generation_contract_id=$4,
            recommendation_context_version_id=$5,
            visible_pool_generation=$6,
            input_pin_id=$7,
            state_reason_codes='[]'::jsonb,
            activated_at=NULL,
            updated_at=$8,
            updated_by=$9,
            version=version+1
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3`,
    [
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      ...lineage,
      observedAt,
      actor,
    ],
  );
}

async function setBlockedContract(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  contract: ProjectContractRow | null,
  reasonCodes: readonly string[],
  actor: string,
  observedAt: Date,
  idFactory: () => string,
): Promise<void> {
  if (
    contract?.migrationState === "V2_ACTIVE" ||
    contract?.migrationState === "V2_MAINTENANCE_READ_ONLY" ||
    contract?.migrationState === "MIGRATION_BLOCKED"
  ) {
    return;
  }
  if (contract === null) {
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
         id, organization_id, workspace_id, website_project_id,
         pool_contract_version, migration_state, generation_contract_id,
         recommendation_context_version_id, visible_pool_generation,
         input_pin_id, state_reason_codes, created_at, updated_at,
         created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,'recommendation-pool.v1','MIGRATION_BLOCKED',
         NULL,NULL,NULL,NULL,$5::jsonb,$6,$6,$7,$7
       )`,
      [
        idFactory(),
        project.organizationId,
        project.workspaceId,
        project.websiteProjectId,
        JSON.stringify(reasonCodes),
        observedAt,
        actor,
      ],
    );
    return;
  }
  await client.query(
    `UPDATE backlinks.backlink_recommendation_pool_project_contracts
        SET pool_contract_version='recommendation-pool.v1',
            migration_state='MIGRATION_BLOCKED',
            generation_contract_id=NULL,
            recommendation_context_version_id=NULL,
            visible_pool_generation=NULL,
            input_pin_id=NULL,
            state_reason_codes=$4::jsonb,
            activated_at=NULL,
            updated_at=$5,
            updated_by=$6,
            version=version+1
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3`,
    [
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      JSON.stringify(reasonCodes),
      observedAt,
      actor,
    ],
  );
}

async function readProjectionCandidates(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
): Promise<readonly ProjectionCandidateRow[]> {
  const result = await client.query(
    `SELECT DISTINCT ON (candidate.canonical_domain)
            candidate.id::text AS id,
            candidate.recommendation_id::text AS "recommendationId",
            candidate.prospect_id::text AS "prospectId",
            inventory.id::text AS "inventoryId",
            generation.id::text AS "sourceGenerationContractId",
            generation.recommendation_context_version_id::text
              AS "sourceRecommendationContextVersionId",
            generation.visible_pool_generation
              AS "sourceVisiblePoolGeneration",
            generation.input_pin_id::text AS "sourceInputPinId",
            generation.qualification_contract_version
              AS "sourceQualificationContractVersion",
            generation.visibility_contract_version
              AS "sourceVisibilityContractVersion",
            generation.score_model_version AS "sourceScoreModelVersion",
            generation.metric_scope AS "sourceMetricScope",
            generation.market AS "sourceMarket",
            generation.location AS "sourceLocation",
            generation.language AS "sourceLanguage",
            generation.traffic_location_code AS "sourceTrafficLocationCode",
            generation.traffic_language_code AS "sourceTrafficLanguageCode",
            candidate.canonical_domain AS "canonicalDomain",
            COALESCE(
              candidate.commercial_score #>>
                '{releaseOrdering,recommendationReasonStrengthBand}',
              candidate.commercial_score->>
                'recommendationReasonStrengthBand',
              LEAST(
                5,
                jsonb_array_length(
                  COALESCE(
                    candidate.commercial_score #> '{details,reasonCodes}',
                    '[]'::jsonb
                  )
                )
              )::text
            )::numeric AS "recommendationReasonStrengthBand",
            COALESCE(
              candidate.commercial_score #>>
                '{releaseOrdering,evidenceCompleteness}',
              candidate.commercial_score->>'evidenceCompleteness',
              (
                SELECT component->>'normalizedValue'
                  FROM jsonb_array_elements(
                    COALESCE(
                      candidate.commercial_score->'components',
                      '[]'::jsonb
                    )
                  ) AS component
                 WHERE component->>'id'='evidence_completeness'
                 LIMIT 1
              ),
              (
                (qualification.traffic_organic_etv IS NOT NULL)::integer +
                (qualification.authority_rank IS NOT NULL)::integer +
                (qualification.spam_score IS NOT NULL)::integer
              )::text
            )::numeric AS "evidenceCompleteness",
            qualification.id::text AS "qualificationFactId",
            qualification.decision AS "qualificationDecision",
            qualification.decision_reason_code
              AS "qualificationReasonCode",
            visibility.qualification_fact_id::text
              AS "visibilityQualificationFactId",
            visibility.id::text AS "visibilityFactId",
            visibility.decision AS "visibilityDecision",
            visibility.decision_reason_code AS "visibilityReasonCode",
            CASE contact_job.terminal_reason_code
              WHEN 'PUBLIC_EMAIL_FOUND' THEN 'eligible'
              WHEN 'NO_PUBLIC_EMAIL' THEN 'ineligible'
              WHEN 'SITE_UNREACHABLE' THEN 'ineligible'
              WHEN 'UNSUPPORTED_CONTENT' THEN 'ineligible'
              WHEN 'CONTACT_FORM_ONLY' THEN 'manual_review'
              WHEN 'LOGIN_REQUIRED' THEN 'manual_review'
              WHEN 'CAPTCHA_OR_BOT_CHALLENGE' THEN 'manual_review'
              WHEN 'ROBOTS_DISALLOWED' THEN 'manual_review'
              WHEN 'ACCESS_DENIED' THEN 'manual_review'
              WHEN 'MANUAL_REVIEW_REQUIRED' THEN 'manual_review'
              WHEN 'COMPLETED_PARTIAL' THEN 'manual_review'
              ELSE contact.decision
            END AS "contactDecision",
            COALESCE(
              contact_job.terminal_reason_code,
              contact.decision_reason_code
            ) AS "contactReasonCode",
            COALESCE(
              contact_job.completed_at,
              contact.observed_at
            ) AS "contactObservedAt",
            contact_job.id::text AS "contactJobId",
            contact_job.terminal_reason_code AS "contactJobTerminalReason",
            contact_job.completed_at::text AS "contactJobCompletedAt",
            qualification.traffic_organic_etv AS "trafficOrganicEtv",
            qualification.authority_rank AS "authorityRank",
            qualification.spam_score AS "spamScore",
            qualification.observed_at AS "metricObservedAt",
            inventory.default_contact_source_url AS "contactPageUrl",
            NULLIF(candidate.commercial_score->>'primaryCategory','')
              AS "primaryCategory"
       FROM backlinks.backlink_commercial_candidates AS candidate
       JOIN backlinks.backlink_recommendation_generation_contracts
         AS generation
         ON generation.organization_id=candidate.organization_id
        AND generation.workspace_id=candidate.workspace_id
        AND generation.website_project_id=candidate.website_project_id
        AND generation.recommendation_context_version_id=
          candidate.project_context_version_id
        AND generation.visible_pool_generation=
          candidate.visible_pool_generation
        AND generation.pool_contract_version='recommendation-pool.v1'
       JOIN backlinks.backlink_recommendation_inventory AS inventory
         ON inventory.organization_id=candidate.organization_id
        AND inventory.workspace_id=candidate.workspace_id
        AND inventory.website_project_id=candidate.website_project_id
        AND inventory.recommendation_id=candidate.recommendation_id
        AND inventory.prospect_id=candidate.prospect_id
        AND inventory.recommendation_context_version_id=
          candidate.project_context_version_id
        AND inventory.visible_pool_generation=
          candidate.visible_pool_generation
       JOIN LATERAL (
         SELECT fact.*
           FROM backlinks.backlink_recommendation_qualification_facts
             AS fact
          WHERE fact.organization_id=candidate.organization_id
            AND fact.workspace_id=candidate.workspace_id
            AND fact.website_project_id=candidate.website_project_id
            AND fact.generation_contract_id=generation.id
            AND fact.candidate_id=candidate.id
            AND fact.recommendation_context_version_id=
              candidate.project_context_version_id
            AND fact.canonical_domain=candidate.canonical_domain
            AND fact.metric_scope=generation.metric_scope
            AND fact.decision='eligible'
            AND (
              (
                fact.recommendation_id IS NULL
                AND fact.prospect_id IS NULL
              )
              OR (
                fact.recommendation_id=candidate.recommendation_id
                AND fact.prospect_id=candidate.prospect_id
              )
            )
          ORDER BY fact.attempt DESC, fact.observed_at DESC, fact.id DESC
          LIMIT 1
       ) AS qualification ON true
       JOIN LATERAL (
         SELECT fact.*
           FROM backlinks.backlink_recommendation_visibility_facts AS fact
           JOIN backlinks.backlink_recommendation_qualification_facts
             AS visibility_qualification
             ON visibility_qualification.organization_id=
                  fact.organization_id
            AND visibility_qualification.workspace_id=fact.workspace_id
            AND visibility_qualification.website_project_id=
                  fact.website_project_id
            AND visibility_qualification.id=fact.qualification_fact_id
          WHERE fact.organization_id=candidate.organization_id
            AND fact.workspace_id=candidate.workspace_id
            AND fact.website_project_id=candidate.website_project_id
            AND fact.generation_contract_id=generation.id
            AND fact.recommendation_context_version_id=
              candidate.project_context_version_id
            AND fact.recommendation_id=candidate.recommendation_id
            AND fact.prospect_id=candidate.prospect_id
            AND fact.canonical_domain=candidate.canonical_domain
            AND visibility_qualification.generation_contract_id=generation.id
            AND visibility_qualification.recommendation_context_version_id=
              candidate.project_context_version_id
            AND (
              visibility_qualification.candidate_id IS NULL
              OR visibility_qualification.candidate_id=candidate.id
            )
            AND visibility_qualification.recommendation_id=
              candidate.recommendation_id
            AND visibility_qualification.prospect_id=candidate.prospect_id
            AND visibility_qualification.canonical_domain=
              candidate.canonical_domain
            AND visibility_qualification.metric_scope=generation.metric_scope
            AND visibility_qualification.decision='eligible'
          ORDER BY fact.attempt DESC, fact.observed_at DESC, fact.id DESC
          LIMIT 1
       ) AS visibility ON true
       JOIN LATERAL (
         SELECT fact.*
           FROM backlinks.backlink_recommendation_contact_facts AS fact
          WHERE fact.organization_id=candidate.organization_id
            AND fact.workspace_id=candidate.workspace_id
            AND fact.website_project_id=candidate.website_project_id
            AND fact.generation_contract_id=generation.id
            AND fact.recommendation_id=candidate.recommendation_id
            AND fact.prospect_id=candidate.prospect_id
          ORDER BY fact.attempt DESC, fact.observed_at DESC, fact.id DESC
          LIMIT 1
       ) AS contact ON true
       LEFT JOIN LATERAL (
         SELECT job.*
           FROM backlinks.backlink_contact_enrichment_jobs AS job
          WHERE job.organization_id=candidate.organization_id
            AND job.workspace_id=candidate.workspace_id
            AND job.website_project_id=candidate.website_project_id
            AND job.recommendation_id=candidate.recommendation_id
             AND job.prospect_id=candidate.prospect_id
             AND job.recommendation_context_version_id=
               candidate.project_context_version_id
             AND job.status IN (
               'completed',
               'partially_completed',
               'no_contact_found'
             )
             AND job.terminal_reason_code IN (
               'PUBLIC_EMAIL_FOUND',
               'NO_PUBLIC_EMAIL',
               'SITE_UNREACHABLE',
               'UNSUPPORTED_CONTENT',
               'CONTACT_FORM_ONLY',
               'LOGIN_REQUIRED',
               'CAPTCHA_OR_BOT_CHALLENGE',
               'ROBOTS_DISALLOWED',
               'ACCESS_DENIED',
               'MANUAL_REVIEW_REQUIRED',
               'COMPLETED_PARTIAL'
             )
             AND job.completed_at IS NOT NULL
           ORDER BY job.completed_at DESC NULLS LAST,
                    job.created_at DESC,
                    job.id DESC
          LIMIT 1
       ) AS contact_job ON true
      WHERE candidate.organization_id=$1
        AND candidate.workspace_id=$2
        AND candidate.website_project_id=$3
        AND candidate.recommendation_id IS NOT NULL
        AND candidate.prospect_id IS NOT NULL
        AND qualification.decision='eligible'
        AND visibility.decision='visible'
      ORDER BY candidate.canonical_domain,
               generation.visible_pool_generation DESC,
               generation.created_at DESC,
               candidate.id DESC`,
    [project.organizationId, project.workspaceId, project.websiteProjectId],
  );
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        id: text(row.id, "candidate id"),
        recommendationId: text(row.recommendationId, "recommendation id"),
        prospectId: text(row.prospectId, "prospect id"),
        inventoryId: text(row.inventoryId, "inventory id"),
        sourceGenerationContractId: text(
          row.sourceGenerationContractId,
          "source generation contract id",
        ),
        sourceRecommendationContextVersionId: text(
          row.sourceRecommendationContextVersionId,
          "source recommendation context version id",
        ),
        sourceVisiblePoolGeneration: integer(
          row.sourceVisiblePoolGeneration,
          "source visible pool generation",
        ),
        sourceInputPinId: text(row.sourceInputPinId, "source input pin id"),
        sourceQualificationContractVersion: text(
          row.sourceQualificationContractVersion,
          "source qualification contract version",
        ),
        sourceVisibilityContractVersion: text(
          row.sourceVisibilityContractVersion,
          "source visibility contract version",
        ),
        sourceScoreModelVersion: text(
          row.sourceScoreModelVersion,
          "source score model version",
        ),
        sourceMetricScope: text(row.sourceMetricScope, "source metric scope"),
        sourceMarket: text(row.sourceMarket, "source market"),
        sourceLocation: text(row.sourceLocation, "source location"),
        sourceLanguage: text(row.sourceLanguage, "source language"),
        sourceTrafficLocationCode: nullableInteger(
          row.sourceTrafficLocationCode,
        ),
        sourceTrafficLanguageCode: nullableText(row.sourceTrafficLanguageCode),
        canonicalDomain: text(row.canonicalDomain, "canonical domain"),
        recommendationReasonStrengthBand: nullableNumber(
          row.recommendationReasonStrengthBand,
        ),
        evidenceCompleteness: nullableNumber(row.evidenceCompleteness),
        qualificationFactId: text(
          row.qualificationFactId,
          "qualification fact id",
        ),
        qualificationDecision: text(
          row.qualificationDecision,
          "qualification decision",
        ),
        qualificationReasonCode: text(
          row.qualificationReasonCode,
          "qualification reason code",
        ),
        visibilityQualificationFactId: text(
          row.visibilityQualificationFactId,
          "visibility qualification fact id",
        ),
        visibilityFactId: text(row.visibilityFactId, "visibility fact id"),
        visibilityDecision: text(row.visibilityDecision, "visibility decision"),
        visibilityReasonCode: text(
          row.visibilityReasonCode,
          "visibility reason code",
        ),
        contactDecision: text(row.contactDecision, "contact decision"),
        contactReasonCode: text(row.contactReasonCode, "contact reason code"),
        contactObservedAt: date(row.contactObservedAt, "contact observed at"),
        contactJobId: nullableText(row.contactJobId),
        contactJobTerminalReason: nullableText(row.contactJobTerminalReason),
        contactJobCompletedAt: nullableText(row.contactJobCompletedAt),
        trafficOrganicEtv: nullableNumber(row.trafficOrganicEtv),
        authorityRank: nullableNumber(row.authorityRank),
        spamScore: nullableNumber(row.spamScore),
        metricObservedAt: date(row.metricObservedAt, "metric observed at"),
        contactPageUrl: nullableText(row.contactPageUrl),
        primaryCategory: nullableText(row.primaryCategory),
      }),
    ),
  );
}

async function releasedDomainProjectionIssues(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  rows: readonly Readonly<{ canonicalDomain: string }>[],
): Promise<readonly string[]> {
  const canonicalDomains = [...new Set(rows.map((row) => row.canonicalDomain))];
  if (canonicalDomains.length === 0) {
    return [];
  }
  const existing = await client.query(
    `SELECT 1
       FROM backlinks.backlink_recommendation_release_batch_items
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3
        AND canonical_domain=ANY($4::text[])
      LIMIT 1`,
    [
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      canonicalDomains,
    ],
  );
  return existing.rowCount === 0 ? [] : ["LEGACY_DOMAIN_ALREADY_RELEASED"];
}

async function validateLegacyProjectionCandidates(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  rows: readonly ProjectionCandidateRow[],
  input: Readonly<{
    expectedCandidateCount: number | null;
    inputPinId: string | null;
    inputPinQualificationContractVersion: string | null;
    inputPinMarket: string | null;
  }>,
): Promise<readonly string[]> {
  const issues: string[] = [];
  if (
    rows.length === 0 ||
    (input.expectedCandidateCount !== null &&
      rows.length !== input.expectedCandidateCount)
  ) {
    issues.push("TERMINAL_LEGACY_LINEAGE_INCOMPLETE");
  }
  if (
    input.inputPinId === null ||
    input.inputPinQualificationContractVersion === null ||
    input.inputPinMarket === null
  ) {
    issues.push("GENERATION_INPUT_PIN_REQUIRED");
  }

  const first = rows[0];
  if (
    first !== undefined &&
    rows.some(
      (row) =>
        row.sourceQualificationContractVersion !==
          first.sourceQualificationContractVersion ||
        row.sourceVisibilityContractVersion !==
          first.sourceVisibilityContractVersion ||
        row.sourceScoreModelVersion !== first.sourceScoreModelVersion ||
        row.sourceMetricScope !== first.sourceMetricScope ||
        row.sourceMarket !== first.sourceMarket ||
        row.sourceLocation !== first.sourceLocation ||
        row.sourceLanguage !== first.sourceLanguage ||
        row.sourceTrafficLocationCode !== first.sourceTrafficLocationCode ||
        row.sourceTrafficLanguageCode !== first.sourceTrafficLanguageCode,
    )
  ) {
    issues.push("LEGACY_GENERATION_CONTRACT_FACTS_INCONSISTENT");
  }
  if (
    first !== undefined &&
    input.inputPinQualificationContractVersion !== null &&
    input.inputPinMarket !== null &&
    (input.inputPinQualificationContractVersion !==
      first.sourceQualificationContractVersion ||
      input.inputPinMarket !== first.sourceMarket)
  ) {
    issues.push("LEGACY_GENERATION_INPUT_CONTRACT_MISMATCH");
  }

  issues.push(...(await releasedDomainProjectionIssues(client, project, rows)));
  issues.push(...legacyContactProjectionIssues(rows));
  if (
    rows.some(
      (row) =>
        row.recommendationReasonStrengthBand === null ||
        row.evidenceCompleteness === null,
    )
  ) {
    issues.push("CANONICAL_ORDERING_FACTS_MISSING");
  }
  return Object.freeze([...new Set(issues)]);
}

async function createLegacyProjectionGeneration(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  rows: readonly ProjectionCandidateRow[],
  input: Readonly<{
    inputPinId: string;
    actor: string;
    observedAt: Date;
    idFactory: () => string;
  }>,
): Promise<GenerationRow> {
  const source = rows[0];
  if (source === undefined) {
    throw new Error("Legacy projection requires terminal source candidates.");
  }
  const visibleGenerationResult = await client.query(
    `SELECT COALESCE(MAX(visible_pool_generation),0)::integer + 1
              AS "visiblePoolGeneration"
       FROM backlinks.backlink_recommendation_generation_contracts
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3`,
    [project.organizationId, project.workspaceId, project.websiteProjectId],
  );
  const visiblePoolGeneration = integer(
    visibleGenerationResult.rows[0]?.visiblePoolGeneration,
    "legacy projection visible pool generation",
  );
  const generationContractId = input.idFactory();
  const candidates: readonly RecommendationFinalizationCandidate[] = rows.map(
    (row) =>
      Object.freeze({
        id: row.id,
        recommendationId: row.recommendationId,
        prospectId: row.prospectId,
        inventoryId: row.inventoryId,
        generationContractId,
        inputPinId: input.inputPinId,
        recommendationContextVersionId: project.projectContextSnapshotId,
        canonicalDomain: row.canonicalDomain,
        recommended:
          row.qualificationDecision === "eligible" &&
          row.visibilityDecision === "visible",
        recommendationReasonStrengthBand:
          row.recommendationReasonStrengthBand as number,
        evidenceCompleteness: row.evidenceCompleteness as number,
      }),
  );
  const finalized = finalizeRecommendationGeneration({
    candidates,
    terminalReason: "PATHS_EXHAUSTED",
    completedAt: input.observedAt,
  });
  const sourceGenerationContractIds = [
    ...new Set(rows.map((row) => row.sourceGenerationContractId)),
  ].sort();
  const result = await client.query(
    `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
       id, organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, visible_pool_generation,
       input_pin_id, qualification_contract_version,
       visibility_contract_version, score_model_version, metric_scope,
       market, location, language, traffic_location_code,
       traffic_language_code, request_fingerprints,
       creator_worker_contract_version, created_at, created_by,
       pool_contract_version, seed_contract_version,
       release_contract_version, recommendation_marker_version,
       discovery_budget_policy_version, effective_unique_candidate_count,
       canonical_batch_size, canonical_batch_count,
       canonical_order_fingerprint, discovery_terminal_reason,
       discovery_completed_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,
       $8,$18,$19,'recommendation-pool.v2','recommendation-seed.v2',
       'recommendation-release.v2','recommendation-marker.v2',
       'recommendation-discovery-budget.v1',$20,$21,$22,$23,$24,$25
     )
     RETURNING id::text AS "generationContractId",
       recommendation_context_version_id::text
         AS "recommendationContextVersionId",
       visible_pool_generation AS "visiblePoolGeneration",
       input_pin_id::text AS "inputPinId",
       qualification_contract_version AS "qualificationContractVersion",
       visibility_contract_version AS "visibilityContractVersion",
       score_model_version AS "scoreModelVersion",
       metric_scope AS "metricScope",
       effective_unique_candidate_count AS "effectiveUniqueCandidateCount",
       canonical_batch_size AS "canonicalBatchSize",
       canonical_batch_count AS "canonicalBatchCount",
       canonical_order_fingerprint AS "canonicalOrderFingerprint",
       discovery_terminal_reason AS "discoveryTerminalReason",
       discovery_completed_at AS "discoveryCompletedAt",
       market, location, language,
       traffic_location_code AS "trafficLocationCode",
       traffic_language_code AS "trafficLanguageCode"`,
    [
      generationContractId,
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      project.projectContextSnapshotId,
      visiblePoolGeneration,
      input.inputPinId,
      source.sourceQualificationContractVersion,
      source.sourceVisibilityContractVersion,
      source.sourceScoreModelVersion,
      source.sourceMetricScope,
      source.sourceMarket,
      source.sourceLocation,
      source.sourceLanguage,
      source.sourceTrafficLocationCode,
      source.sourceTrafficLanguageCode,
      JSON.stringify({
        legacyProjection: {
          contractVersion: "recommendation-pool-v2-legacy-lineage.v1",
          sourceGenerationContractIds,
          sourceLineageCount: rows.length,
        },
      }),
      input.observedAt,
      input.actor,
      finalized.effectiveUniqueCandidateCount,
      finalized.canonicalBatchSize,
      finalized.canonicalBatchCount,
      finalized.canonicalOrderFingerprint,
      finalized.discoveryTerminalReason,
      finalized.discoveryCompletedAt,
    ],
  );
  return parseGeneration(result.rows[0] ?? {});
}

function metricSnapshot(
  input: Readonly<{
    value: number | null;
    metric: string;
    generation: GenerationRow;
    qualificationFactId: string;
    observedAt: Date;
  }>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    value: input.value,
    provider: "growthos",
    endpoint: "backlinks/recommendation-qualification-facts",
    market: input.generation.market,
    location: input.generation.location,
    language: input.generation.language,
    observedAt: input.observedAt.toISOString(),
    artifactRef: `qualification-fact:${input.qualificationFactId}:${input.metric}`,
  });
}

async function projectTerminalCandidates(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  generation: GenerationRow,
  actor: string,
  observedAt: Date,
  idFactory: () => string,
): Promise<readonly string[]> {
  const rows = await readProjectionCandidates(client, project);
  if (rows.length !== generation.effectiveUniqueCandidateCount) {
    return ["TERMINAL_LEGACY_LINEAGE_INCOMPLETE"];
  }
  const releasedDomainIssues = await releasedDomainProjectionIssues(
    client,
    project,
    rows,
  );
  if (releasedDomainIssues.length > 0) {
    return releasedDomainIssues;
  }
  const contactIssues = legacyContactProjectionIssues(rows);
  if (contactIssues.length > 0) {
    return contactIssues;
  }
  if (
    rows.some(
      (row) =>
        row.recommendationReasonStrengthBand === null ||
        row.evidenceCompleteness === null,
    )
  ) {
    return ["CANONICAL_ORDERING_FACTS_MISSING"];
  }
  const terminalReason = generation.discoveryTerminalReason;
  if (
    terminalReason === null ||
    !generationTerminalReasons.has(
      terminalReason as RecommendationDiscoveryStopReason,
    ) ||
    generation.discoveryCompletedAt === null
  ) {
    return ["V2_GENERATION_TERMINAL_FACT_INVALID"];
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const candidates: readonly RecommendationFinalizationCandidate[] = rows.map(
    (row) =>
      Object.freeze({
        id: row.id,
        recommendationId: row.recommendationId,
        prospectId: row.prospectId,
        inventoryId: row.inventoryId,
        generationContractId: generation.generationContractId,
        inputPinId: generation.inputPinId,
        recommendationContextVersionId:
          generation.recommendationContextVersionId,
        canonicalDomain: row.canonicalDomain,
        recommended:
          row.qualificationDecision === "eligible" &&
          row.visibilityDecision === "visible",
        recommendationReasonStrengthBand:
          row.recommendationReasonStrengthBand as number,
        evidenceCompleteness: row.evidenceCompleteness as number,
      }),
  );
  const finalized = finalizeRecommendationGeneration({
    candidates,
    terminalReason: terminalReason as RecommendationDiscoveryStopReason,
    completedAt: generation.discoveryCompletedAt,
  });
  if (
    finalized.effectiveUniqueCandidateCount !==
      generation.effectiveUniqueCandidateCount ||
    finalized.canonicalBatchSize !== generation.canonicalBatchSize ||
    finalized.canonicalBatchCount !== generation.canonicalBatchCount ||
    finalized.canonicalOrderFingerprint !== generation.canonicalOrderFingerprint
  ) {
    return ["CANONICAL_GENERATION_FINGERPRINT_MISMATCH"];
  }

  for (const batch of finalized.batches) {
    const batchId = idFactory();
    const batchOrderFingerprint = createHash("sha256")
      .update(
        `${finalized.canonicalOrderFingerprint}:${batch.ordinal}:legacy_imported`,
      )
      .digest("hex");
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_release_batches (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         visible_pool_generation, input_pin_id, pool_contract_version,
         batch_ordinal, state, original_batch_size,
         selection_policy_version, order_fingerprint,
         contact_terminal_count, contact_total_count,
         preparation_started_at, available_at, deadline_at,
         created_at, updated_at, created_by, updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',
         $9,'PREPARING',$10,$11,$12,0,$10,$13::timestamptz,NULL,
         $13::timestamptz + interval '18 hours',
         $13::timestamptz,$13::timestamptz,$14,$14
       )`,
      [
        batchId,
        project.organizationId,
        project.workspaceId,
        project.websiteProjectId,
        generation.generationContractId,
        generation.recommendationContextVersionId,
        generation.visiblePoolGeneration,
        generation.inputPinId,
        batch.ordinal,
        batch.originalSize,
        recommendationBatchSelectionPolicyVersion,
        batchOrderFingerprint,
        observedAt,
        actor,
      ],
    );

    for (const item of batch.items) {
      const source = byId.get(item.candidate.id);
      if (source === undefined) {
        throw new Error("Cutover projection candidate disappeared.");
      }
      if (
        source.contactJobId === null ||
        source.contactJobTerminalReason === null ||
        source.contactJobCompletedAt === null
      ) {
        return ["TERMINAL_LEGACY_LINEAGE_INCOMPLETE"];
      }
      const targetItemId = idFactory();
      const traffic = metricSnapshot({
        value: source.trafficOrganicEtv,
        metric: "traffic",
        generation,
        qualificationFactId: source.qualificationFactId,
        observedAt: source.metricObservedAt,
      });
      const rank = metricSnapshot({
        value: source.authorityRank,
        metric: "rank",
        generation,
        qualificationFactId: source.qualificationFactId,
        observedAt: source.metricObservedAt,
      });
      const spam = metricSnapshot({
        value: source.spamScore,
        metric: "spam",
        generation,
        qualificationFactId: source.qualificationFactId,
        observedAt: source.metricObservedAt,
      });
      await client.query(
        `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
           id, organization_id, workspace_id, website_project_id, batch_id,
           recommendation_context_version_id, visible_pool_generation,
           candidate_id, recommendation_id, prospect_id, inventory_id,
           generation_contract_id, input_pin_id, pool_contract_version,
           canonical_domain, position, recommended,
           recommendation_reason_codes, recommendation_marker_version,
           traffic_snapshot_ref, rank_snapshot_ref, spam_snapshot_ref,
           traffic_snapshot, rank_snapshot, spam_snapshot,
           traffic_organic_etv, authority_rank, spam_score,
           primary_category, category_snapshot,
           contact_terminal_reason_at_release,
           contact_page_url_at_release, contact_completed_at_release,
           legacy_imported, created_at, created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,$8,$9,
           'recommendation-pool.v2',$10,$11,$12,$13::jsonb,
           'recommendation-marker.v2',$14,$15,$16,$17::jsonb,$18::jsonb,
           $19::jsonb,$20,$21,$22,$23,$24::jsonb,$25,$26,$27,true,$28,$29
         )`,
        [
          targetItemId,
          project.organizationId,
          project.workspaceId,
          project.websiteProjectId,
          batchId,
          generation.recommendationContextVersionId,
          generation.visiblePoolGeneration,
          generation.generationContractId,
          generation.inputPinId,
          source.canonicalDomain,
          item.position,
          item.candidate.recommended,
          JSON.stringify([
            source.qualificationReasonCode,
            source.visibilityReasonCode,
          ]),
          String(traffic.artifactRef),
          String(rank.artifactRef),
          String(spam.artifactRef),
          JSON.stringify(traffic),
          JSON.stringify(rank),
          JSON.stringify(spam),
          source.trafficOrganicEtv,
          source.authorityRank,
          source.spamScore,
          source.primaryCategory,
          source.primaryCategory === null
            ? null
            : JSON.stringify({
                value: source.primaryCategory,
                source: "commercial-candidate",
              }),
          source.contactJobTerminalReason,
          source.contactPageUrl,
          source.contactJobCompletedAt,
          observedAt,
          actor,
        ],
      );
      await client.query(
        `INSERT INTO backlinks.
           backlink_recommendation_legacy_source_lineage_facts (
             id, organization_id, workspace_id, website_project_id,
             target_generation_contract_id,
             target_recommendation_context_version_id,
             target_visible_pool_generation, target_input_pin_id,
             target_batch_id, target_item_id, target_pool_contract_version,
             source_generation_contract_id,
             source_recommendation_context_version_id,
             source_visible_pool_generation, source_input_pin_id,
             source_pool_contract_version, source_candidate_id,
             source_recommendation_id, source_prospect_id,
             source_inventory_id, source_qualification_fact_id,
             source_candidate_qualification_fact_id,
             source_visibility_qualification_fact_id,
             source_visibility_fact_id,
             source_contact_enrichment_job_id, canonical_domain,
             contact_terminal_reason, contact_completed_at,
             created_at, created_by
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'recommendation-pool.v2',
             $11,$12,$13,$14,'recommendation-pool.v1',$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25,$26,$27,$28
           )
           ON CONFLICT (
             organization_id, workspace_id, website_project_id,
             target_item_id
           ) DO NOTHING`,
        [
          idFactory(),
          project.organizationId,
          project.workspaceId,
          project.websiteProjectId,
          generation.generationContractId,
          generation.recommendationContextVersionId,
          generation.visiblePoolGeneration,
          generation.inputPinId,
          batchId,
          targetItemId,
          source.sourceGenerationContractId,
          source.sourceRecommendationContextVersionId,
          source.sourceVisiblePoolGeneration,
          source.sourceInputPinId,
          source.id,
          source.recommendationId,
          source.prospectId,
          source.inventoryId,
          source.qualificationFactId,
          source.qualificationFactId,
          source.visibilityQualificationFactId,
          source.visibilityFactId,
          source.contactJobId,
          source.canonicalDomain,
          source.contactJobTerminalReason,
          source.contactJobCompletedAt,
          observedAt,
          actor,
        ],
      );
    }
    await client.query(
      `UPDATE backlinks.backlink_recommendation_release_batches
          SET state='AVAILABLE',
              contact_terminal_count=contact_total_count,
              available_at=$5,
              updated_at=$5,
              updated_by=$6,
              version=version+1
        WHERE organization_id=$1
          AND workspace_id=$2
          AND website_project_id=$3
          AND id=$4`,
      [
        project.organizationId,
        project.workspaceId,
        project.websiteProjectId,
        batchId,
        observedAt,
        actor,
      ],
    );
  }
  return [];
}

async function activateProject(
  client: BacklinkTransactionClient,
  project: RecommendationPoolV2CutoverProject,
  generation: GenerationRow,
  actor: string,
  observedAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE backlinks.backlink_recommendation_pool_project_contracts
        SET migration_state='V2_ACTIVE',
            generation_contract_id=$6,
            recommendation_context_version_id=$7,
            visible_pool_generation=$8,
            input_pin_id=$9,
            state_reason_codes='[]'::jsonb,
            activated_at=$4,
            updated_at=$4,
            updated_by=$5,
            version=version+1
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3
        AND migration_state='V2_READY'
        AND pool_contract_version='recommendation-pool.v2'
        AND (
          (
            generation_contract_id IS NULL
            AND recommendation_context_version_id IS NULL
            AND visible_pool_generation IS NULL
            AND input_pin_id IS NULL
          )
          OR (
            generation_contract_id=$6
            AND recommendation_context_version_id=$7
            AND visible_pool_generation=$8
            AND input_pin_id=$9
          )
        )`,
    [
      project.organizationId,
      project.workspaceId,
      project.websiteProjectId,
      observedAt,
      actor,
      generation.generationContractId,
      generation.recommendationContextVersionId,
      generation.visiblePoolGeneration,
      generation.inputPinId,
    ],
  );
}

async function evaluateProject(
  client: BacklinkTransactionClient,
  input: Readonly<{
    project: RecommendationPoolV2CutoverProject;
    phase: "PLAN" | "APPLY";
    actor: string | null;
    observedAt: Date | null;
    idFactory: () => string;
  }>,
): Promise<RecommendationPoolV2CutoverProjectFact> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1||':'||$2||':'||$3||':pool-v2-cutover',0)
     )`,
    [
      input.project.organizationId,
      input.project.workspaceId,
      input.project.websiteProjectId,
    ],
  );
  const state = await readProjectState(client, input.project);
  if (!state.snapshotCurrent) {
    return projectFact(
      input.project,
      input.phase,
      "MIGRATION_BLOCKED",
      state.inputReasonCodes,
      null,
      null,
    );
  }
  if (state.contract?.migrationState === "V2_MAINTENANCE_READ_ONLY") {
    return projectFact(
      input.project,
      input.phase,
      "MIGRATION_BLOCKED",
      ["V2_MAINTENANCE_READ_ONLY"],
      state.generation,
      state.generation === null
        ? null
        : await readCanonicalCounts(client, input.project, state.generation),
    );
  }
  if (hasReadyLineageConflict(state.contract, state.generation)) {
    const reasonCodes = ["V2_READY_LINEAGE_CONFLICT"];
    if (input.phase === "APPLY") {
      await setBlockedContract(
        client,
        input.project,
        state.contract,
        reasonCodes,
        input.actor as string,
        input.observedAt as Date,
        input.idFactory,
      );
    }
    return projectFact(
      input.project,
      input.phase,
      "MIGRATION_BLOCKED",
      reasonCodes,
      state.generation,
      state.generation === null
        ? null
        : await readCanonicalCounts(client, input.project, state.generation),
    );
  }
  let generation = state.generation;
  if (generation === null) {
    if (!state.inputsReady) {
      return projectFact(
        input.project,
        input.phase,
        "INPUT_REQUIRED",
        state.inputReasonCodes,
        null,
        null,
      );
    }
    const rows = await readProjectionCandidates(client, input.project);
    const projectionIssues = await validateLegacyProjectionCandidates(
      client,
      input.project,
      rows,
      {
        expectedCandidateCount: null,
        inputPinId: state.inputPinId,
        inputPinQualificationContractVersion:
          state.inputPinQualificationContractVersion,
        inputPinMarket: state.inputPinMarket,
      },
    );
    if (projectionIssues.length > 0) {
      if (input.phase === "APPLY") {
        await setBlockedContract(
          client,
          input.project,
          state.contract,
          projectionIssues,
          input.actor as string,
          input.observedAt as Date,
          input.idFactory,
        );
      }
      return projectFact(
        input.project,
        input.phase,
        "MIGRATION_BLOCKED",
        projectionIssues,
        null,
        null,
      );
    }
    if (input.phase === "PLAN") {
      return projectFact(
        input.project,
        input.phase,
        "READY",
        ["TERMINAL_LEGACY_PROJECTION_READY"],
        null,
        null,
      );
    }
    generation = await createLegacyProjectionGeneration(
      client,
      input.project,
      rows,
      {
        inputPinId: state.inputPinId as string,
        actor: input.actor as string,
        observedAt: input.observedAt as Date,
        idFactory: input.idFactory,
      },
    );
  }

  let counts = await readCanonicalCounts(client, input.project, generation);
  const issues = canonicalIssueCodes(generation, counts);
  if (issues.includes("V2_GENERATION_INCOMPLETE")) {
    if (input.phase === "APPLY") {
      await setReadyContract(
        client,
        input.project,
        state.contract,
        generation,
        input.actor as string,
        input.observedAt as Date,
        input.idFactory,
      );
    }
    return projectFact(
      input.project,
      input.phase,
      "READY",
      issues,
      generation,
      counts,
    );
  }
  if (issues.includes("EFFECTIVE_CANDIDATES_REQUIRED")) {
    return projectFact(
      input.project,
      input.phase,
      "INPUT_REQUIRED",
      issues,
      generation,
      counts,
    );
  }
  if (issues.length > 0) {
    if (input.phase === "APPLY") {
      await setBlockedContract(
        client,
        input.project,
        state.contract,
        issues,
        input.actor as string,
        input.observedAt as Date,
        input.idFactory,
      );
    }
    return projectFact(
      input.project,
      input.phase,
      "MIGRATION_BLOCKED",
      issues,
      generation,
      counts,
    );
  }

  if (counts.batchCount === 0) {
    if (input.phase === "PLAN") {
      const rows = await readProjectionCandidates(client, input.project);
      const reasons = await validateLegacyProjectionCandidates(
        client,
        input.project,
        rows,
        {
          expectedCandidateCount: generation.effectiveUniqueCandidateCount,
          inputPinId: state.inputPinId,
          inputPinQualificationContractVersion:
            state.inputPinQualificationContractVersion,
          inputPinMarket: state.inputPinMarket,
        },
      );
      return projectFact(
        input.project,
        input.phase,
        reasons.length === 0 ? "READY" : "MIGRATION_BLOCKED",
        reasons.length === 0 ? ["TERMINAL_LEGACY_PROJECTION_READY"] : reasons,
        generation,
        counts,
      );
    }
    const projectionIssues = await projectTerminalCandidates(
      client,
      input.project,
      generation,
      input.actor as string,
      input.observedAt as Date,
      input.idFactory,
    );
    if (projectionIssues.length > 0) {
      await setBlockedContract(
        client,
        input.project,
        state.contract,
        projectionIssues,
        input.actor as string,
        input.observedAt as Date,
        input.idFactory,
      );
      return projectFact(
        input.project,
        input.phase,
        "MIGRATION_BLOCKED",
        projectionIssues,
        generation,
        counts,
      );
    }
    counts = await readCanonicalCounts(client, input.project, generation);
  }

  const finalIssues = canonicalIssueCodes(generation, counts);
  if (
    finalIssues.length > 0 ||
    counts.batchCount !== generation.canonicalBatchCount ||
    counts.itemCount !== generation.effectiveUniqueCandidateCount
  ) {
    const reasons =
      finalIssues.length > 0
        ? finalIssues
        : ["CANONICAL_PUBLICATION_INCOMPLETE"];
    if (input.phase === "APPLY") {
      await setBlockedContract(
        client,
        input.project,
        state.contract,
        reasons,
        input.actor as string,
        input.observedAt as Date,
        input.idFactory,
      );
    }
    return projectFact(
      input.project,
      input.phase,
      "MIGRATION_BLOCKED",
      reasons,
      generation,
      counts,
    );
  }

  if (
    state.contract?.migrationState === "V2_ACTIVE" &&
    state.contract.generationContractId === generation.generationContractId
  ) {
    return projectFact(
      input.project,
      input.phase,
      "ALREADY_V2_ACTIVE",
      [],
      generation,
      counts,
    );
  }
  if (input.phase === "PLAN") {
    return projectFact(
      input.project,
      input.phase,
      "READY",
      ["V2_ACTIVATION_READY"],
      generation,
      counts,
    );
  }
  await setReadyContract(
    client,
    input.project,
    state.contract,
    generation,
    input.actor as string,
    input.observedAt as Date,
    input.idFactory,
  );
  await activateProject(
    client,
    input.project,
    generation,
    input.actor as string,
    input.observedAt as Date,
  );
  return projectFact(
    input.project,
    input.phase,
    "V2_ACTIVE",
    [],
    generation,
    counts,
  );
}

function parseVerification(
  value: unknown,
): RecommendationPoolV2CutoverVerification {
  const source = record(value);
  return Object.freeze({
    ...source,
    completed: source.completed === true,
    eligibleProjectCount: integer(
      source.eligibleProjectCount ?? 0,
      "eligible project count",
    ),
    v2ActiveProjectCount: integer(
      source.v2ActiveProjectCount ?? 0,
      "V2 active project count",
    ),
    validV2ActiveProjectCount: integer(
      source.validV2ActiveProjectCount ?? 0,
      "valid V2 active project count",
    ),
    activeV1ProjectCount: integer(
      source.activeV1ProjectCount ?? 0,
      "active V1 project count",
    ),
    migrationBlockedProjectCount: integer(
      source.migrationBlockedProjectCount ?? 0,
      "migration blocked project count",
    ),
    invalidV2ActiveProjectCount: integer(
      source.invalidV2ActiveProjectCount ?? 0,
      "invalid V2 active project count",
    ),
    activeV1GenerationCount: integer(
      source.activeV1GenerationCount ?? 0,
      "active V1 generation count",
    ),
    activeV1RefillCount: integer(
      source.activeV1RefillCount ?? 0,
      "active V1 refill count",
    ),
    activeV1RefillJobCount: integer(
      source.activeV1RefillJobCount ?? 0,
      "active V1 refill job count",
    ),
    activeV1OutboxCount: integer(
      source.activeV1OutboxCount ?? 0,
      "active V1 outbox count",
    ),
    activeV1ClaimCount: integer(
      source.activeV1ClaimCount ?? 0,
      "active V1 claim count",
    ),
    activeV1ProviderRequestCount: integer(
      source.activeV1ProviderRequestCount ?? 0,
      "active V1 provider request count",
    ),
    activeV1ProviderReservationCount: integer(
      source.activeV1ProviderReservationCount ?? 0,
      "active V1 provider reservation count",
    ),
    activeV1ProviderLeaseCount: integer(
      source.activeV1ProviderLeaseCount ?? 0,
      "active V1 provider lease count",
    ),
  });
}

export function createRecommendationPoolV2CutoverRepository(
  pool: BacklinkTenantPool,
  dependencies: Readonly<{ idFactory?: () => string }> = {},
): RecommendationPoolV2CutoverRepository {
  const idFactory = dependencies.idFactory ?? randomUUID;
  return Object.freeze({
    async startRun(input) {
      return withTransaction(pool, async (client) => {
        const result = await client.query(
          `SELECT id::text AS id,
                  command_id AS "commandId",
                  mode,
                  status,
                  eligible_project_count AS "eligibleProjectCount",
                  v2_active_project_count AS "v2ActiveProjectCount",
                  input_required_project_count
                    AS "inputRequiredProjectCount",
                  migration_blocked_project_count
                    AS "migrationBlockedProjectCount",
                  verification,
                  started_at AS "startedAt",
                  completed_at AS "completedAt"
             FROM backlinks.backlink_recommendation_pool_v2_start_cutover_run(
               $1,$2,$3,$4
             )`,
          [input.runId, input.commandId, input.mode, input.actor],
        );
        return parseRun(result.rows[0] ?? {});
      });
    },
    async listEligibleProjects() {
      return withTransaction(pool, async (client) => {
        const result = await client.query(
          `SELECT organization_id::text AS "organizationId",
                  workspace_id::text AS "workspaceId",
                  website_project_id::text AS "websiteProjectId",
                  project_context_snapshot_id::text
                    AS "projectContextSnapshotId",
                  project_context_snapshot_version
                    AS "projectContextSnapshotVersion"
             FROM backlinks.
               backlink_recommendation_pool_v2_list_cutover_projects()`,
        );
        return Object.freeze(result.rows.map(parseProject));
      });
    },
    async listRunFacts(runId) {
      return withTransaction(pool, async (client) => {
        const result = await client.query(
          `SELECT organization_id::text AS "organizationId",
                  workspace_id::text AS "workspaceId",
                  website_project_id::text AS "websiteProjectId",
                  project_context_snapshot_id::text
                    AS "projectContextSnapshotId",
                  project_context_snapshot_version
                    AS "projectContextSnapshotVersion",
                  phase,
                  result,
                  reason_codes AS "reasonCodes",
                  generation_contract_id::text AS "generationContractId",
                  recommendation_context_version_id::text
                    AS "recommendationContextVersionId",
                  visible_pool_generation AS "visiblePoolGeneration",
                  input_pin_id::text AS "inputPinId",
                  canonical_batch_count AS "canonicalBatchCount",
                  available_batch_count AS "availableBatchCount",
                  canonical_item_count AS "canonicalItemCount"
             FROM backlinks.
               backlink_recommendation_pool_v2_list_cutover_facts($1)`,
          [runId],
        );
        return Object.freeze(result.rows.map(parseFact));
      });
    },
    async planProject(project) {
      return withBacklinkTenantTransaction(pool, project, (client) =>
        evaluateProject(client, {
          project,
          phase: "PLAN",
          actor: null,
          observedAt: null,
          idFactory,
        }),
      );
    },
    async executeProject(input) {
      return withBacklinkTenantTransaction(pool, input.project, (client) =>
        evaluateProject(client, {
          project: input.project,
          phase: "APPLY",
          actor: input.actor,
          observedAt: input.observedAt,
          idFactory,
        }),
      );
    },
    async recordFact(input) {
      await withTransaction(pool, async (client) => {
        const lineage = input.fact.lineage;
        await client.query(
          `SELECT backlinks.
             backlink_recommendation_pool_v2_record_cutover_fact(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,
               $11,$12,$13,$14,$15,$16,$17,$18,$19,$20
             )`,
          [
            input.id,
            input.runId,
            input.fact.organizationId,
            input.fact.workspaceId,
            input.fact.websiteProjectId,
            input.fact.projectContextSnapshotId,
            input.fact.projectContextSnapshotVersion,
            input.fact.phase,
            input.fact.result,
            JSON.stringify(input.fact.reasonCodes),
            lineage?.generationContractId ?? null,
            lineage?.poolContractVersion ?? null,
            lineage?.recommendationContextVersionId ?? null,
            lineage?.visiblePoolGeneration ?? null,
            lineage?.inputPinId ?? null,
            input.fact.canonicalBatchCount,
            input.fact.availableBatchCount,
            input.fact.canonicalItemCount,
            input.actor,
            input.observedAt,
          ],
        );
      });
    },
    async verifyCutover() {
      return withTransaction(pool, async (client) => {
        const result = await client.query(
          `SELECT backlinks.
             backlink_recommendation_pool_v2_verify_cutover()
               AS verification`,
        );
        return parseVerification(result.rows[0]?.verification);
      });
    },
    async finishRun(input) {
      await withTransaction(pool, async (client) => {
        await client.query(
          `SELECT backlinks.
             backlink_recommendation_pool_v2_finish_cutover_run(
               $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9
             )`,
          [
            input.runId,
            input.status,
            input.eligibleProjectCount,
            input.v2ActiveProjectCount,
            input.inputRequiredProjectCount,
            input.migrationBlockedProjectCount,
            JSON.stringify(input.verification),
            input.actor,
            input.completedAt,
          ],
        );
      });
    },
    async enterMaintenanceReadOnly(input) {
      await withBacklinkTenantTransaction(pool, input, async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(
             hashtextextended($1||':'||$2||':'||$3||':pool-v2-cutover',0)
           )`,
          [input.organizationId, input.workspaceId, input.websiteProjectId],
        );
        const result = await client.query(
          `UPDATE backlinks.backlink_recommendation_pool_project_contracts
              SET migration_state='V2_MAINTENANCE_READ_ONLY',
                  state_reason_codes=$4::jsonb,
                  updated_at=$5,
                  updated_by=$6,
                  version=version+1
            WHERE organization_id=$1
              AND workspace_id=$2
              AND website_project_id=$3
              AND migration_state='V2_ACTIVE'
              AND pool_contract_version='recommendation-pool.v2'`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            JSON.stringify(input.reasonCodes),
            input.observedAt,
            input.actor,
          ],
        );
        if (result.rowCount !== 1) {
          throw new Error(
            "Only an active V2 project can enter maintenance read-only.",
          );
        }
      });
    },
  });
}
