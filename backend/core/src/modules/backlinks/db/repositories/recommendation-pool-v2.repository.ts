import { randomUUID } from "node:crypto";
import { observedContactPageSql } from "./observed-contact-page.sql.js";

import {
  finalizeRecommendationGeneration,
  type RecommendationFinalizationCandidate,
} from "../../application/services/recommendation-pool-generation-finalizer.service.js";
import type { PrepareRecommendationPoolV2CanonicalBatchesInput } from "../../application/services/recommendation-pool-v2-contact-preparation.service.js";
import {
  buildRecommendationPoolV2ReleaseMetricPersistence,
  type RecommendationPoolV2ReleaseMetricEvidence,
} from "../../application/services/recommendation-pool-v2-release-snapshot.service.js";
import type {
  RecommendationPoolV2GenerationFinalization,
  RecommendationPoolV2GenerationStart,
  RecommendationPoolV2PreparationInspection,
  RecommendationPoolV2PublicationOutcome,
  RecommendationPoolV2Supersession,
  RecommendationPoolV2WorkflowActivities,
} from "../../application/services/recommendation-pool-v2-workflow.service.js";
import { recommendationHybridBatchSelectionPolicyVersion } from "../../domain/recommendations/recommendation-batch-policy.js";
import { recommendationDiscoverySupplyThreshold } from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import { isRecommendationPoolV2ProjectGeneratable } from "../../domain/recommendations/recommendation-pool-v2-project-generation-eligibility.js";
import type { BacklinkTransactionClient } from "../tenant-transaction.js";

type WorkflowInput = Parameters<
  RecommendationPoolV2WorkflowActivities["loadGeneration"]
>[0];
type FinalizeInput = Parameters<
  RecommendationPoolV2WorkflowActivities["finalizeGeneration"]
>[0];
type CompleteWithoutPublicationInput = Parameters<
  RecommendationPoolV2WorkflowActivities["completeGenerationWithoutPublication"]
>[0];
type ActivateGenerationInput = Parameters<
  RecommendationPoolV2WorkflowActivities["activateGeneration"]
>[0];
type FailGenerationInput = Parameters<
  RecommendationPoolV2WorkflowActivities["failGeneration"]
>[0];
export type RecommendationPoolV2CanonicalBatchPreparationInput =
  PersistenceScopeInput &
    Readonly<{
      actorId: string;
      batchIds: readonly string[];
      preparationDeadlineAt: string;
      jobId?: string;
      workflowId?: string;
      publicationOutcome?: RecommendationPoolV2PublicationOutcome;
    }>;
export type RecommendationPoolV2CanonicalBatchRecoveryResult =
  | Readonly<{ status: "contract_not_applicable" }>
  | Readonly<{ status: "idle" }>
  | Readonly<{
      status: "preparing";
      input: RecommendationPoolV2CanonicalBatchPreparationInput;
      preparingBatchIds: readonly string[];
    }>;
type PersistenceScopeInput = Pick<
  WorkflowInput,
  | "organizationId"
  | "workspaceId"
  | "websiteProjectId"
  | "generationContractId"
  | "recommendationContextVersionId"
  | "visiblePoolGeneration"
  | "inputPinId"
>;
export type RecommendationPoolV2GenerationSupersessionInput =
  PersistenceScopeInput &
    Readonly<{
      actorId: string;
      supersession: RecommendationPoolV2Supersession | null;
    }>;

type JsonObject = Record<string, unknown>;
const boundedExhaustionReasons = new Set([
  "LOW_YIELD",
  "BUDGET_EXHAUSTED",
  "PATHS_EXHAUSTED",
  "REQUEST_SCOPE_CHANGED",
]);
const recommendationPoolV2GeneratableContractSql = `(
  contract.migration_state IN ('V2_READY','V2_ACTIVE')
  OR (
    contract.migration_state='MIGRATION_BLOCKED'
    AND contract.state_reason_codes=
      '["V2_CANDIDATE_LINEAGE_INCOMPLETE"]'::jsonb
    AND COALESCE((
      backlinks.backlink_recommendation_pool_v2_native_generation_verify()
        ->>'v1WritesFrozen'
    )::boolean,false)
  )
)`;

type CandidatePersistence = Readonly<{
  generationCandidateId: string;
  candidate: RecommendationFinalizationCandidate;
  recommendationReasonCodes: readonly string[];
  recommendationMarkerVersion: string;
  metrics: ReturnType<typeof buildRecommendationPoolV2ReleaseMetricPersistence>;
  primaryCategory: string | null;
  categorySnapshot: JsonObject | null;
  resourceLibrarySnapshot: JsonObject | null;
}>;

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function releaseMetricJoin(
  metricType: "TRAFFIC_ORGANIC_ETV" | "AUTHORITY_RANK" | "SPAM_SCORE",
  alias: "traffic" | "rank" | "spam",
): string {
  // Keep the original observation provenance when reusing a fresh domain metric.
  const usable = `metric.value_state='AVAILABLE'
    AND metric.observed_at BETWEEN statement_timestamp()-interval '7 days'
                               AND statement_timestamp()
    AND metric.market=generation.market
    AND metric.location=generation.location
    AND metric.language=generation.language`;
  return `LEFT JOIN LATERAL (
    SELECT CASE WHEN ${usable} THEN metric.metric_value ELSE 'null'::jsonb END
             AS metric_value,
           metric.provider,metric.endpoint,metric.market,metric.location,
           metric.language,metric.request_ref,metric.artifact_ref,metric.observed_at
      FROM backlinks.backlink_recommendation_candidate_metric_snapshots metric
      JOIN backlinks.backlink_recommendation_generation_candidates origin
        ON origin.id=metric.generation_candidate_id
       AND origin.organization_id=metric.organization_id
       AND origin.workspace_id=metric.workspace_id
       AND origin.website_project_id=metric.website_project_id
     WHERE metric.organization_id=authority.organization_id
       AND metric.workspace_id=authority.workspace_id
       AND metric.website_project_id=authority.website_project_id
       AND origin.canonical_domain=authority.canonical_domain
       AND metric.metric_type='${metricType}'
       AND (metric.generation_candidate_id=authority.id OR (${usable}))
     ORDER BY (${usable}) DESC,metric.observed_at DESC,metric.id DESC
     LIMIT 1
  ) AS ${alias} ON true`;
}

function requiredString(value: unknown, label: string): string {
  const parsed = String(value ?? "").trim();
  if (parsed.length === 0) {
    throw new Error(`RECOMMENDATION_POOL_V2_${label}_MISSING`);
  }
  return parsed;
}

function requiredStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`RECOMMENDATION_POOL_V2_${label}_MISSING`);
  }
  const parsed = value.map((item) => requiredString(item, label));
  if (parsed.length === 0) {
    throw new Error(`RECOMMENDATION_POOL_V2_${label}_MISSING`);
  }
  return Object.freeze(parsed);
}

function metricEvidence(
  row: Record<string, unknown>,
  prefix: "traffic" | "rank" | "spam",
): RecommendationPoolV2ReleaseMetricEvidence {
  if (row.resourceLibrary !== null && typeof row.resourceLibrary === "object"
    && row[`${prefix}ArtifactRef`] == null && row[`${prefix}RequestRef`] == null) {
    // The library does not supply ETV/rank/spam. Retain its provenance with a
    // null value, never relabel library DR/traffic as DataForSEO observations.
    const library = row.resourceLibrary as JsonObject;
    return {
      value: null, provider: "resource_library", endpoint: "CURATED_RESOURCE_LIBRARY",
      market: "GLOBAL", location: "GLOBAL",
      language: requiredString(library.language, "LIBRARY_LANGUAGE"),
      observedAt: new Date(String(row.libraryObservedAt)).toISOString(),
      artifactRef: requiredString(row.librarySourceRef, "LIBRARY_SOURCE_REF"),
    };
  }
  const observedAt = row[`${prefix}ObservedAt`];
  const requestRef =
    typeof row[`${prefix}RequestRef`] === "string"
      ? String(row[`${prefix}RequestRef`])
      : null;
  const artifactRef =
    typeof row[`${prefix}ArtifactRef`] === "string"
      ? String(row[`${prefix}ArtifactRef`])
      : null;
  if (requestRef === null && artifactRef === null) {
    throw new Error("RECOMMENDATION_POOL_V2_METRIC_ARTIFACT_REFERENCE_MISSING");
  }
  return Object.freeze({
    value: nullableNumber(row[`${prefix}MetricValue`]),
    provider: requiredString(row[`${prefix}Provider`], "METRIC_PROVIDER"),
    endpoint: requiredString(row[`${prefix}Endpoint`], "METRIC_ENDPOINT"),
    market: requiredString(row[`${prefix}Market`], "METRIC_MARKET"),
    location: requiredString(row[`${prefix}Location`], "METRIC_LOCATION"),
    language: requiredString(row[`${prefix}Language`], "METRIC_LANGUAGE"),
    observedAt: new Date(
      observedAt instanceof Date ? observedAt.getTime() : String(observedAt),
    ).toISOString(),
    ...(requestRef === null ? {} : { requestRef }),
    ...(artifactRef === null ? {} : { artifactRef }),
  });
}

function mapCandidate(row: Record<string, unknown>): CandidatePersistence {
  const library = row.resourceLibrary !== null && typeof row.resourceLibrary === "object"
    ? row.resourceLibrary as JsonObject : null;
  const metricValues = [
    row.trafficMetricValue,
    row.rankMetricValue,
    row.spamMetricValue,
  ].filter((value) => nullableNumber(value) !== null).length;
  const metrics = buildRecommendationPoolV2ReleaseMetricPersistence({
    traffic: metricEvidence(row, "traffic"),
    rank: metricEvidence(row, "rank"),
    spam: metricEvidence(row, "spam"),
  });
  const recommended = row.recommended === true;
  return Object.freeze({
    generationCandidateId: requiredString(
      row.generationCandidateId,
      "GENERATION_CANDIDATE_ID",
    ),
    candidate: Object.freeze({
      id: requiredString(row.candidateId, "CANDIDATE_ID"),
      recommendationId: requiredString(
        row.recommendationId,
        "RECOMMENDATION_ID",
      ),
      prospectId: requiredString(row.prospectId, "PROSPECT_ID"),
      inventoryId: requiredString(row.inventoryId, "INVENTORY_ID"),
      generationContractId: requiredString(
        row.generationContractId,
        "GENERATION_ID",
      ),
      inputPinId: requiredString(row.inputPinId, "INPUT_PIN_ID"),
      recommendationContextVersionId: requiredString(
        row.recommendationContextVersionId,
        "CONTEXT_ID",
      ),
      canonicalDomain: requiredString(row.canonicalDomain, "CANONICAL_DOMAIN"),
      recommended,
      recommendationReasonStrengthBand: recommended ? 1 : 0,
      evidenceCompleteness: metricValues,
      sourceType: row.hasDiscoverySource === false ? "CURATED_RESOURCE_LIBRARY" : "DATAFORSEO",
      ...(library?.releaseBatchOrdinal === undefined ? {} : {
        resourceBatchOrdinal: Number(library.releaseBatchOrdinal),
      }),
    }),
    recommendationReasonCodes: requiredStringArray(
      row.recommendationReasonCodes,
      "RECOMMENDATION_REASON_CODES",
    ),
    recommendationMarkerVersion: requiredString(
      row.recommendationMarkerVersion,
      "MARKER_VERSION",
    ),
    metrics,
    primaryCategory: Array.isArray(library?.categories) ? String(library.categories[0] ?? "") || null : null,
    categorySnapshot: library === null ? null : {
      categories: library.categories, categoryMatch: library.categoryMatch,
    },
    resourceLibrarySnapshot: library === null ? null : {
      ...library, sourceRef: row.librarySourceRef, observedAt: row.libraryObservedAt,
    },
  });
}

function scopeValues(input: PersistenceScopeInput): readonly unknown[] {
  return [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.visiblePoolGeneration,
    input.inputPinId,
  ];
}

async function readFinalization(
  client: BacklinkTransactionClient,
  input: PersistenceScopeInput,
  row: Record<string, unknown>,
): Promise<RecommendationPoolV2GenerationFinalization> {
  const batches = await client.query(
    `SELECT id "batchId",batch_ordinal "ordinal",
            original_batch_size "originalBatchSize",
            preparation_started_at "preparationStartedAt",
            deadline_at "deadlineAt"
       FROM backlinks.backlink_recommendation_release_batches
      WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
        AND generation_contract_id=$4
        AND recommendation_context_version_id=$5
        AND visible_pool_generation=$6 AND input_pin_id=$7
      ORDER BY batch_ordinal`,
    scopeValues(input),
  );
  const discoveryCompletedAt = new Date(
    String(row.discoveryCompletedAt),
  ).toISOString();
  const firstBatch = batches.rows[0];
  const preparationStartedAt =
    firstBatch === undefined
      ? discoveryCompletedAt
      : new Date(String(firstBatch.preparationStartedAt)).toISOString();
  const preparationDeadlineAt =
    firstBatch === undefined
      ? new Date(Date.parse(preparationStartedAt) + 86_400_000).toISOString()
      : new Date(String(firstBatch.deadlineAt)).toISOString();
  const cost = await client.query(
    `SELECT COALESCE(sum(batch.paid_cost_micros),0)::bigint "costMicros"
       FROM backlinks.backlink_commercial_discovery_batches AS batch
      WHERE batch.organization_id=$1 AND batch.workspace_id=$2
        AND batch.website_project_id=$3
        AND batch.project_context_version_id=$5
        AND batch.visible_pool_generation=$6
        AND EXISTS (
          SELECT 1
            FROM backlinks.backlink_commercial_blueprint_seeds AS seed
           WHERE seed.organization_id=batch.organization_id
             AND seed.workspace_id=batch.workspace_id
              AND seed.website_project_id=batch.website_project_id
              AND seed.blueprint_id=batch.blueprint_id
              AND seed.generation_contract_id=$4
         )
        AND EXISTS (
          SELECT 1
            FROM backlinks.backlink_recommendation_generation_contracts
              AS generation
           WHERE generation.organization_id=batch.organization_id
             AND generation.workspace_id=batch.workspace_id
             AND generation.website_project_id=batch.website_project_id
             AND generation.id=$4
             AND generation.recommendation_context_version_id=$5
             AND generation.visible_pool_generation=$6
             AND generation.input_pin_id=$7
         )`,
    scopeValues(input),
  );
  return Object.freeze({
    effectiveUniqueCandidateCount: Number(row.effectiveUniqueCandidateCount),
    discoveryTerminalReason: String(
      row.discoveryTerminalReason,
    ) as RecommendationPoolV2GenerationFinalization["discoveryTerminalReason"],
    totalSettledCostMicros: Number(cost.rows[0]?.costMicros ?? 0),
    discoveryCompletedAt,
    preparationStartedAt,
    preparationDeadlineAt,
    batches: Object.freeze(
      batches.rows.map((batch) =>
        Object.freeze({
          batchId: String(batch.batchId),
          ordinal: Number(batch.ordinal),
          originalBatchSize: Number(batch.originalBatchSize),
        }),
      ),
    ),
  });
}

export function createRecommendationPoolV2Repository(
  client: BacklinkTransactionClient,
) {
  const loadGeneration = async (
    input: WorkflowInput,
  ): Promise<RecommendationPoolV2GenerationStart> => {
    const loaded = await client.query(
      `SELECT generation.pool_contract_version "poolContractVersion",
              generation.effective_unique_candidate_count
                "effectiveUniqueCandidateCount",
              generation.discovery_terminal_reason "discoveryTerminalReason",
              generation.discovery_completed_at "discoveryCompletedAt",
              project.pool_contract_version "projectPoolContractVersion",
              project.migration_state "migrationState",
              project.state_reason_codes "stateReasonCodes",
              CASE
                WHEN project.migration_state='MIGRATION_BLOCKED'
                  THEN COALESCE((
                    backlinks
                      .backlink_recommendation_pool_v2_native_generation_verify()
                      ->>'v1WritesFrozen'
                  )::boolean,false)
                ELSE false
              END "v1WritesFrozen",
              (
                SELECT snapshot.id
                  FROM backlinks.backlink_project_context_snapshots AS snapshot
                 WHERE snapshot.organization_id=$1
                   AND snapshot.workspace_id=$2
                   AND snapshot.website_project_id=$3
                 ORDER BY snapshot.snapshot_version DESC
                 LIMIT 1
              ) "authoritativeContextId"
         FROM backlinks.backlink_recommendation_generation_contracts
           AS generation
         LEFT JOIN backlinks.backlink_recommendation_pool_project_contracts
           AS project
           ON project.organization_id=generation.organization_id
          AND project.workspace_id=generation.workspace_id
          AND project.website_project_id=generation.website_project_id
        WHERE generation.organization_id=$1
          AND generation.workspace_id=$2
          AND generation.website_project_id=$3
          AND generation.id=$4
          AND generation.recommendation_context_version_id=$5
          AND generation.visible_pool_generation=$6
          AND generation.input_pin_id=$7`,
      scopeValues(input),
    );
    const row = loaded.rows[0];
    if (
      row === undefined ||
      row.poolContractVersion !== "recommendation-pool.v2"
    ) {
      return Object.freeze({
        status: "input_required",
        reason: "RECOMMENDATION_POOL_V2_GENERATION_CONTRACT_MISSING",
      });
    }
    if (
      String(row.authoritativeContextId ?? "") !==
      input.recommendationContextVersionId
    ) {
      return Object.freeze({ status: "superseded" });
    }
    if (
      !isRecommendationPoolV2ProjectGeneratable({
        poolContractVersion: row.projectPoolContractVersion,
        migrationState: row.migrationState,
        stateReasonCodes: row.stateReasonCodes,
        v1WritesFrozen: row.v1WritesFrozen,
      })
    ) {
      return Object.freeze({
        status: "input_required",
        reason: "RECOMMENDATION_POOL_V2_PROJECT_NOT_GENERATABLE",
      });
    }
    if (row.effectiveUniqueCandidateCount !== null) {
      return Object.freeze({
        status: "already_completed",
        finalization: await readFinalization(client, input, row),
      });
    }
    const prepared = await client.query(
      `SELECT EXISTS (
         SELECT 1
           FROM backlinks.backlink_commercial_blueprint_seeds
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND generation_contract_id=$4
            AND recommendation_context_version_id=$5
            AND visible_pool_generation=$6
       ) "prepared"`,
      scopeValues(input).slice(0, 6),
    );
    if (prepared.rows[0]?.prepared !== true) {
      return Object.freeze({
        status: "input_required",
        reason: "RECOMMENDATION_POOL_V2_DISCOVERY_INPUT_NOT_PREPARED",
      });
    }
    await client.query(
      `UPDATE backlinks.backlink_jobs
          SET status='running',step='discovery',progress=10,
              started_at=COALESCE(started_at,statement_timestamp()),
              updated_at=statement_timestamp(),updated_by=$8,
              version=version+1
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$9
          AND job_type='recommendation_pool_v2_generation'
          AND source_object_type='project-context-snapshot'
          AND source_object_id=$5
          AND result_summary->>'generationContractId'=$4::uuid::text
          AND result_summary->>'visiblePoolGeneration'=$6::integer::text
          AND result_summary->>'inputPinId'=$7::uuid::text
          AND status IN ('queued','running','waiting_provider')`,
      [...scopeValues(input), input.actorId, input.jobId],
    );
    return Object.freeze({ status: "ready" });
  };

  const markCanonicalPreparation = async (
    input: RecommendationPoolV2CanonicalBatchPreparationInput | FinalizeInput,
  ): Promise<void> => {
    await client.query(
      `UPDATE backlinks.backlink_jobs
          SET status='running',step='canonical_batch_preparation',
              progress=GREATEST(progress,50),updated_at=statement_timestamp(),
              updated_by=$8,version=version+1
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND job_type='recommendation_pool_v2_generation'
          AND source_object_type='project-context-snapshot'
          AND source_object_id=$5
          AND result_summary->>'generationContractId'=$4::uuid::text
          AND result_summary->>'visiblePoolGeneration'=$6::integer::text
          AND result_summary->>'inputPinId'=$7::uuid::text
          AND status IN ('queued','running','waiting_provider')
          AND (status<>'running' OR step<>'canonical_batch_preparation')
          AND EXISTS (
            SELECT 1 FROM backlinks.backlink_recommendation_generation_contracts g
             WHERE g.organization_id=$1 AND g.workspace_id=$2
               AND g.website_project_id=$3 AND g.id=$4
               AND g.effective_unique_candidate_count>0
               AND g.discovery_completed_at IS NOT NULL
          )`,
      [...scopeValues(input), input.actorId],
    );
  };

  const finalizeGeneration = async (
    input: FinalizeInput,
  ): Promise<RecommendationPoolV2GenerationFinalization> => {
    const locked = await client.query(
      `SELECT effective_unique_candidate_count "effectiveUniqueCandidateCount",
              discovery_terminal_reason "discoveryTerminalReason",
              discovery_completed_at "discoveryCompletedAt",
              recommendation_marker_version "recommendationMarkerVersion",
              market,location,language
         FROM backlinks.backlink_recommendation_generation_contracts
        WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
          AND id=$4 AND recommendation_context_version_id=$5
          AND visible_pool_generation=$6 AND input_pin_id=$7
          AND pool_contract_version='recommendation-pool.v2'
        FOR UPDATE`,
      scopeValues(input),
    );
    const generation = locked.rows[0];
    if (generation === undefined) {
      throw new Error("RECOMMENDATION_POOL_V2_GENERATION_CONTRACT_MISSING");
    }
    if (generation.effectiveUniqueCandidateCount !== null) {
      await markCanonicalPreparation(input);
      return readFinalization(client, input, generation);
    }
    const candidateRows = await client.query(
      `SELECT authority.id "generationCandidateId",
              library.evidence_payload->'resourceLibrary' "resourceLibrary",
              library.source_ref "librarySourceRef",
              library.observed_at "libraryObservedAt",
              EXISTS (
                SELECT 1 FROM backlinks.backlink_recommendation_generation_candidate_sources s
                 WHERE s.organization_id=authority.organization_id
                   AND s.workspace_id=authority.workspace_id
                   AND s.website_project_id=authority.website_project_id
                   AND s.generation_candidate_id=authority.id
                   AND s.source_type<>'CURATED_RESOURCE_LIBRARY'
              ) "hasDiscoverySource",
              candidate.id "candidateId",
              link.recommendation_id "recommendationId",
              link.prospect_id "prospectId",
              link.inventory_id "inventoryId",
              authority.canonical_domain "canonicalDomain",
              authority.generation_contract_id "generationContractId",
              authority.recommendation_context_version_id
                "recommendationContextVersionId",
              authority.input_pin_id "inputPinId",
              authority.recommended,
              authority.recommendation_reason_codes
                "recommendationReasonCodes",
              generation.recommendation_marker_version
                "recommendationMarkerVersion",
              traffic.metric_value "trafficMetricValue",
              traffic.provider "trafficProvider",
              traffic.endpoint "trafficEndpoint",
              traffic.market "trafficMarket",
              traffic.location "trafficLocation",
              traffic.language "trafficLanguage",
              traffic.request_ref "trafficRequestRef",
              traffic.artifact_ref "trafficArtifactRef",
              traffic.observed_at "trafficObservedAt",
              rank.metric_value "rankMetricValue",
              rank.provider "rankProvider",
              rank.endpoint "rankEndpoint",
              rank.market "rankMarket",
              rank.location "rankLocation",
              rank.language "rankLanguage",
              rank.request_ref "rankRequestRef",
              rank.artifact_ref "rankArtifactRef",
              rank.observed_at "rankObservedAt",
              spam.metric_value "spamMetricValue",
              spam.provider "spamProvider",
              spam.endpoint "spamEndpoint",
              spam.market "spamMarket",
              spam.location "spamLocation",
              spam.language "spamLanguage",
              spam.request_ref "spamRequestRef",
              spam.artifact_ref "spamArtifactRef",
              spam.observed_at "spamObservedAt"
         FROM backlinks.backlink_recommendation_generation_candidates
           AS authority
         JOIN backlinks.backlink_recommendation_generation_candidate_links
           AS link
           ON link.organization_id=authority.organization_id
          AND link.workspace_id=authority.workspace_id
          AND link.website_project_id=authority.website_project_id
          AND link.generation_candidate_id=authority.id
          AND link.recommendation_context_version_id=
                authority.recommendation_context_version_id
          AND link.visible_pool_generation=authority.visible_pool_generation
         JOIN backlinks.backlink_commercial_candidates AS candidate
           ON candidate.organization_id=link.organization_id
          AND candidate.workspace_id=link.workspace_id
          AND candidate.website_project_id=link.website_project_id
          AND candidate.id=link.candidate_id
          AND candidate.recommendation_id=link.recommendation_id
          AND candidate.prospect_id=link.prospect_id
          AND candidate.project_context_version_id=
                link.recommendation_context_version_id
          AND candidate.visible_pool_generation=
                link.visible_pool_generation
         JOIN backlinks.backlink_commercial_discovery_batches AS batch
           ON batch.organization_id=candidate.organization_id
          AND batch.workspace_id=candidate.workspace_id
          AND batch.website_project_id=candidate.website_project_id
          AND batch.id=candidate.discovery_batch_id
          AND batch.generation_contract_id=authority.generation_contract_id
          AND batch.input_pin_id=authority.input_pin_id
          AND batch.pool_contract_version='recommendation-pool.v2'
          AND batch.materialization_contract_version=
                'recommendation-pool-materialization.v2'
          AND batch.request_intent='V2_MATERIALIZATION'
          AND batch.paid_cost_micros=0
         JOIN backlinks.backlink_recommendations AS recommendation
           ON recommendation.organization_id=link.organization_id
          AND recommendation.workspace_id=link.workspace_id
          AND recommendation.website_project_id=link.website_project_id
          AND recommendation.id=link.recommendation_id
          AND recommendation.prospect_id=link.prospect_id
          AND recommendation.recommendation_context_version_id=
                link.recommendation_context_version_id
          AND recommendation.generation_contract_id=
                authority.generation_contract_id
          AND recommendation.visible_pool_generation=
                authority.visible_pool_generation
          AND recommendation.input_pin_id=authority.input_pin_id
          AND recommendation.pool_contract_version='recommendation-pool.v2'
          AND recommendation.materialization_contract_version=
                'recommendation-pool-materialization.v2'
         JOIN backlinks.backlink_recommendation_inventory AS inventory
           ON inventory.organization_id=link.organization_id
          AND inventory.workspace_id=link.workspace_id
          AND inventory.website_project_id=link.website_project_id
          AND inventory.id=link.inventory_id
          AND inventory.recommendation_id=link.recommendation_id
          AND inventory.prospect_id=link.prospect_id
          AND inventory.recommendation_context_version_id=
                link.recommendation_context_version_id
          AND inventory.visible_pool_generation=
                link.visible_pool_generation
         JOIN backlinks.backlink_recommendation_generation_contracts
           AS generation
           ON generation.organization_id=authority.organization_id
          AND generation.workspace_id=authority.workspace_id
          AND generation.website_project_id=authority.website_project_id
          AND generation.id=authority.generation_contract_id
          AND generation.recommendation_context_version_id=
                authority.recommendation_context_version_id
          AND generation.visible_pool_generation=
                authority.visible_pool_generation
          AND generation.input_pin_id=authority.input_pin_id
          AND generation.pool_contract_version=authority.pool_contract_version
         ${releaseMetricJoin("TRAFFIC_ORGANIC_ETV", "traffic")}
         ${releaseMetricJoin("AUTHORITY_RANK", "rank")}
         ${releaseMetricJoin("SPAM_SCORE", "spam")}
         LEFT JOIN LATERAL (
           SELECT source.evidence_payload,source.source_ref,source.observed_at
             FROM backlinks.backlink_recommendation_generation_candidate_sources source
            WHERE source.organization_id=authority.organization_id
              AND source.workspace_id=authority.workspace_id
              AND source.website_project_id=authority.website_project_id
              AND source.generation_candidate_id=authority.id
              AND source.source_type='CURATED_RESOURCE_LIBRARY'
            ORDER BY source.observed_at,source.id LIMIT 1
         ) library ON true
        WHERE authority.organization_id=$1 AND authority.workspace_id=$2
          AND authority.website_project_id=$3
          AND authority.generation_contract_id=$4
          AND authority.recommendation_context_version_id=$5
          AND authority.visible_pool_generation=$6
          AND authority.input_pin_id=$7
          AND authority.pool_contract_version='recommendation-pool.v2'
          AND authority.admission_state='ADMITTED'
          AND candidate.score_model_version=
                'recommendation-pool-materialization.v2'
          AND candidate.state='v2_materialized'
          AND inventory.publication_status<>'PUBLISHED'
          AND inventory.fit_decision='unassessed'
          AND inventory.fit_score_model_version IS NULL
          AND EXISTS (
            SELECT 1
              FROM backlinks
                .backlink_recommendation_generation_candidate_sources
                AS source
             WHERE source.organization_id=authority.organization_id
               AND source.workspace_id=authority.workspace_id
               AND source.website_project_id=authority.website_project_id
               AND source.generation_candidate_id=authority.id
          )
        ORDER BY authority.canonical_domain,authority.id
        LIMIT $8`,
      [...scopeValues(input), input.hardCandidateLimit],
    );
    const persisted = candidateRows.rows.map(mapCandidate);
    const admittedCount = await client.query(
      `SELECT backlinks.backlink_recommendation_generation_admitted_count(
         $1,$2,$3,$4
       ) "count"`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.generationContractId,
      ],
    );
    if (persisted.length !== Number(admittedCount.rows[0]?.count ?? -1)) {
      throw new Error("RECOMMENDATION_POOL_V2_CANONICAL_LINEAGE_INCOMPLETE");
    }
    const completedAtResult = await client.query(
      `SELECT statement_timestamp() "completedAt"`,
    );
    const completedAt = new Date(
      String(completedAtResult.rows[0]?.completedAt),
    );
    const finalized = finalizeRecommendationGeneration({
      allocationPolicy: "hybrid",
      candidates: persisted.map((item) => item.candidate),
      terminalReason: input.terminalReason,
      completedAt,
    });
    const preparationStartedAt = new Date(completedAt);
    const preparationDeadlineAt = new Date(completedAt.getTime() + 86_400_000);
    const byCandidateId = new Map(
      persisted.map((item) => [item.candidate.id, item] as const),
    );
    const batches = [];
    for (const batch of finalized.batches) {
      const batchId = randomUUID();
      await client.query(
        `INSERT INTO backlinks.backlink_recommendation_release_batches (
           id,organization_id,workspace_id,website_project_id,
           generation_contract_id,recommendation_context_version_id,
           visible_pool_generation,input_pin_id,pool_contract_version,
           batch_ordinal,state,original_batch_size,selection_policy_version,
           order_fingerprint,contact_terminal_count,contact_total_count,
           preparation_started_at,deadline_at,created_by,updated_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',
           $9,'PREPARING',$10,$11,$12,0,$10,$13,$14,$15,$15
         )`,
        [
          batchId,
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.generationContractId,
          input.recommendationContextVersionId,
          input.visiblePoolGeneration,
          input.inputPinId,
          batch.ordinal,
          batch.originalSize,
          recommendationHybridBatchSelectionPolicyVersion,
          batch.orderFingerprint,
          preparationStartedAt,
          preparationDeadlineAt,
          input.actorId,
        ],
      );
      for (const item of batch.items) {
        const source = byCandidateId.get(item.candidate.id);
        if (source === undefined) {
          throw new Error("RECOMMENDATION_POOL_V2_CANONICAL_SOURCE_MISSING");
        }
        const metric = source.metrics;
        await client.query(
          `INSERT INTO backlinks.backlink_recommendation_release_batch_items (
             id,organization_id,workspace_id,website_project_id,batch_id,
             recommendation_context_version_id,visible_pool_generation,
             candidate_id,generation_candidate_id,recommendation_id,
             prospect_id,inventory_id,generation_contract_id,input_pin_id,
             pool_contract_version,canonical_domain,position,recommended,
             recommendation_reason_codes,recommendation_marker_version,
             traffic_snapshot_ref,rank_snapshot_ref,spam_snapshot_ref,
             traffic_snapshot,rank_snapshot,spam_snapshot,
             traffic_organic_etv,authority_rank,spam_score,primary_category,
             category_snapshot,legacy_imported,created_by,resource_library_snapshot
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             'recommendation-pool.v2',$15,$16,$17,$18::jsonb,$19,
             $20,$21,$22,$23::jsonb,$24::jsonb,$25::jsonb,
             $26,$27,$28,$29,$30::jsonb,false,$31,$32::jsonb
           )`,
          [
            randomUUID(),
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            batchId,
            input.recommendationContextVersionId,
            input.visiblePoolGeneration,
            source.candidate.id,
            source.generationCandidateId,
            source.candidate.recommendationId,
            source.candidate.prospectId,
            source.candidate.inventoryId,
            input.generationContractId,
            input.inputPinId,
            source.candidate.canonicalDomain,
            item.position,
            source.candidate.recommended,
            JSON.stringify(source.recommendationReasonCodes),
            source.recommendationMarkerVersion,
            metric.traffic_snapshot_ref,
            metric.rank_snapshot_ref,
            metric.spam_snapshot_ref,
            JSON.stringify(metric.traffic_snapshot),
            JSON.stringify(metric.rank_snapshot),
            JSON.stringify(metric.spam_snapshot),
            metric.traffic_organic_etv,
            metric.authority_rank,
            metric.spam_score,
            source.primaryCategory,
            source.categorySnapshot === null
              ? null
              : JSON.stringify(source.categorySnapshot),
            input.actorId,
            source.resourceLibrarySnapshot === null
              ? null : JSON.stringify(source.resourceLibrarySnapshot),
          ],
        );
      }
      batches.push(
        Object.freeze({
          batchId,
          ordinal: batch.ordinal,
          originalBatchSize: batch.originalSize,
        }),
      );
    }
    const updated = await client.query(
      `UPDATE backlinks.backlink_recommendation_generation_contracts
          SET effective_unique_candidate_count=$8,
              canonical_batch_size=$9,canonical_batch_count=$10,
              canonical_order_fingerprint=$11,
              discovery_terminal_reason=$12,discovery_completed_at=$13
        WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
          AND id=$4 AND recommendation_context_version_id=$5
          AND visible_pool_generation=$6 AND input_pin_id=$7
          AND pool_contract_version='recommendation-pool.v2'
          AND effective_unique_candidate_count IS NULL
        RETURNING id`,
      [
        ...scopeValues(input),
        finalized.effectiveUniqueCandidateCount,
        finalized.canonicalBatchSize,
        finalized.canonicalBatchCount,
        finalized.canonicalOrderFingerprint,
        finalized.discoveryTerminalReason,
        finalized.discoveryCompletedAt,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("RECOMMENDATION_POOL_V2_FINALIZATION_CONFLICT");
    }
    await markCanonicalPreparation(input);
    return Object.freeze({
      effectiveUniqueCandidateCount: finalized.effectiveUniqueCandidateCount,
      discoveryTerminalReason: finalized.discoveryTerminalReason,
      totalSettledCostMicros: input.totalSettledCostMicros,
      discoveryCompletedAt: completedAt.toISOString(),
      preparationStartedAt: preparationStartedAt.toISOString(),
      preparationDeadlineAt: preparationDeadlineAt.toISOString(),
      batches: Object.freeze(batches),
    });
  };

  const loadCanonicalContactSources = async (
    input: PrepareRecommendationPoolV2CanonicalBatchesInput,
  ) => {
    const loaded = await client.query(
      `SELECT item.batch_id "batchId",item.candidate_id "candidateId",
              item.recommendation_id "recommendationId",
              item.prospect_id "prospectId",item.inventory_id "inventoryId",
              item.generation_contract_id "generationContractId",
              item.recommendation_context_version_id
                "recommendationContextVersionId",
              item.input_pin_id "inputPinId",
              item.visible_pool_generation "visiblePoolGeneration"
         FROM backlinks.backlink_recommendation_release_batch_items AS item
         JOIN backlinks.backlink_recommendation_release_batches AS batch
           ON batch.organization_id=item.organization_id
          AND batch.workspace_id=item.workspace_id
          AND batch.website_project_id=item.website_project_id
           AND batch.id=item.batch_id
         JOIN backlinks.backlink_recommendation_generation_contracts AS generation
           ON generation.organization_id=item.organization_id
          AND generation.workspace_id=item.workspace_id
          AND generation.website_project_id=item.website_project_id
          AND generation.id=item.generation_contract_id
          AND generation.recommendation_context_version_id=
            item.recommendation_context_version_id
          AND generation.visible_pool_generation=item.visible_pool_generation
          AND generation.input_pin_id=item.input_pin_id
          AND generation.pool_contract_version='recommendation-pool.v2'
         JOIN backlinks.backlink_recommendation_pool_project_contracts AS contract
           ON contract.organization_id=item.organization_id
          AND contract.workspace_id=item.workspace_id
          AND contract.website_project_id=item.website_project_id
          AND contract.pool_contract_version='recommendation-pool.v2'
          AND ${recommendationPoolV2GeneratableContractSql}
         JOIN backlinks.backlink_project_context_snapshots AS context
           ON context.organization_id=item.organization_id
          AND context.workspace_id=item.workspace_id
          AND context.website_project_id=item.website_project_id
          AND context.id=item.recommendation_context_version_id
        WHERE item.organization_id=$1 AND item.workspace_id=$2
          AND item.website_project_id=$3
          AND item.generation_contract_id=$4
          AND item.recommendation_context_version_id=$5
          AND item.visible_pool_generation=$6 AND item.input_pin_id=$7
          AND item.batch_id=ANY($8::uuid[]) AND batch.state='PREPARING'
          AND context.project_status='ACTIVE'
          AND NOT EXISTS (
            SELECT 1
              FROM backlinks.backlink_project_context_snapshots AS newer
             WHERE newer.organization_id=context.organization_id
               AND newer.workspace_id=context.workspace_id
               AND newer.website_project_id=context.website_project_id
               AND newer.snapshot_version>context.snapshot_version
          )
         ORDER BY batch.batch_ordinal,item.position`,
      [...scopeValues(input), input.batchIds],
    );
    return Object.freeze(
      loaded.rows.map((row) =>
        Object.freeze({
          batchId: String(row.batchId),
          candidateId: String(row.candidateId),
          recommendationId: String(row.recommendationId),
          prospectId: String(row.prospectId),
          inventoryId: String(row.inventoryId),
          generationContractId: String(row.generationContractId),
          recommendationContextVersionId: String(
            row.recommendationContextVersionId,
          ),
          inputPinId: String(row.inputPinId),
          visiblePoolGeneration: Number(row.visiblePoolGeneration),
        }),
      ),
    );
  };

  const synchronizeNativeV2PublicEmailEvidence = async (
    input: RecommendationPoolV2CanonicalBatchPreparationInput,
  ) => {
    await client.query(
      `WITH terminal_items AS MATERIALIZED (
         SELECT item.id item_id,item.inventory_id,item.recommendation_id,
                item.prospect_id
           FROM backlinks.backlink_recommendation_release_batch_items AS item
           JOIN backlinks.backlink_recommendation_release_batches AS batch
             ON batch.organization_id=item.organization_id
            AND batch.workspace_id=item.workspace_id
            AND batch.website_project_id=item.website_project_id
            AND batch.id=item.batch_id
            AND batch.state IN ('PREPARING','AVAILABLE')
           JOIN backlinks.backlink_recommendation_generation_contracts
             AS generation
             ON generation.organization_id=item.organization_id
            AND generation.workspace_id=item.workspace_id
            AND generation.website_project_id=item.website_project_id
            AND generation.id=item.generation_contract_id
            AND generation.pool_contract_version='recommendation-pool.v2'
           JOIN backlinks.backlink_recommendation_pool_project_contracts
             AS contract
             ON contract.organization_id=item.organization_id
            AND contract.workspace_id=item.workspace_id
            AND contract.website_project_id=item.website_project_id
            AND contract.pool_contract_version='recommendation-pool.v2'
            AND ${recommendationPoolV2GeneratableContractSql}
           JOIN backlinks.backlink_project_context_snapshots AS context
             ON context.organization_id=item.organization_id
            AND context.workspace_id=item.workspace_id
            AND context.website_project_id=item.website_project_id
            AND context.id=item.recommendation_context_version_id
           JOIN backlinks.backlink_contact_enrichment_jobs AS job
             ON job.organization_id=item.organization_id
            AND job.workspace_id=item.workspace_id
            AND job.website_project_id=item.website_project_id
            AND job.recommendation_id=item.recommendation_id
            AND job.prospect_id=item.prospect_id
            AND job.recommendation_context_version_id=
                item.recommendation_context_version_id
          WHERE item.organization_id=$1 AND item.workspace_id=$2
            AND item.website_project_id=$3
            AND item.generation_contract_id=$4
            AND item.recommendation_context_version_id=$5
            AND item.visible_pool_generation=$6 AND item.input_pin_id=$7
            AND item.batch_id=ANY($8::uuid[])
            AND item.legacy_imported=false
            AND job.terminal_reason_code='PUBLIC_EMAIL_FOUND'
            AND job.completed_at IS NOT NULL
            AND (
              item.contact_terminal_reason_at_release IS NULL
              OR (
                item.contact_terminal_reason_at_release='PUBLIC_EMAIL_FOUND'
                AND item.contact_email_at_release IS NULL
              )
            )
            AND context.project_status='ACTIVE'
            AND NOT EXISTS (
              SELECT 1
                FROM backlinks.backlink_project_context_snapshots AS newer
               WHERE newer.organization_id=context.organization_id
                 AND newer.workspace_id=context.workspace_id
                 AND newer.website_project_id=context.website_project_id
                 AND newer.snapshot_version>context.snapshot_version
            )
       ),
       eligible_contacts AS MATERIALIZED (
         SELECT terminal.item_id,terminal.inventory_id,
                terminal.recommendation_id,terminal.prospect_id,
                candidate.id candidate_id,candidate.normalized_email,
                candidate.inferred_purpose,
                candidate.confidence contact_confidence,
                candidate.purpose_confidence,
                candidate.purpose_rule_version,
                evidence.id evidence_id,evidence.source_url,
                evidence.observed_at,
                evidence.confidence evidence_confidence,
                evidence.rule_version evidence_rule_version,
                count(*) OVER (
                  PARTITION BY terminal.item_id
                )::integer email_count,
                row_number() OVER (
                  PARTITION BY terminal.item_id
                  ORDER BY candidate.confidence DESC,
                           candidate.purpose_confidence DESC,
                           evidence.confidence DESC,candidate.id
                ) choice_rank
           FROM terminal_items AS terminal
           JOIN backlinks.backlink_contact_candidates AS candidate
             ON candidate.organization_id=$1
            AND candidate.workspace_id=$2
            AND candidate.website_project_id=$3
            AND candidate.prospect_id=terminal.prospect_id
            AND candidate.recommendation_context_version_id=$5
           JOIN LATERAL (
             SELECT contact_evidence.id,contact_evidence.source_url,
                    contact_evidence.observed_at,
                    contact_evidence.confidence,
                    contact_evidence.rule_version
               FROM backlinks.backlink_contact_evidence AS contact_evidence
              WHERE contact_evidence.organization_id=$1
                AND contact_evidence.workspace_id=$2
                AND contact_evidence.website_project_id=$3
                AND contact_evidence.candidate_id=candidate.id
                AND contact_evidence.invalidated_at IS NULL
                AND contact_evidence.expires_at>statement_timestamp()
                AND contact_evidence.extraction_method IN (
                  'mailto','visible_text','obfuscated_text','json_ld'
                )
                AND contact_evidence.confidence>=80
              ORDER BY contact_evidence.confidence DESC,
                       contact_evidence.observed_at DESC,
                       contact_evidence.id
              LIMIT 1
           ) AS evidence ON true
          WHERE candidate.status IN ('candidate','promoted')
            AND candidate.invalidated_at IS NULL
            AND candidate.guessed=false
            AND candidate.confidence>=80
            AND candidate.purpose_confidence>=70
            AND candidate.inferred_purpose IN (
              'press','editorial','partnerships','advertising','business',
              'marketing','site_owner','general'
            )
            AND lower(candidate.normalized_email) ~
              '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
            AND split_part(lower(candidate.normalized_email),'@',1)
              !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
            AND candidate.email_domain_ascii NOT IN (
              'example.com','example.org','example.net'
            )
            AND candidate.email_domain_ascii NOT LIKE '%.invalid'
       ),
       selected AS MATERIALIZED (
         SELECT *
           FROM eligible_contacts
          WHERE choice_rank=1
       ),
       inserted_snapshot AS (
         INSERT INTO backlinks.backlink_contact_evidence_snapshots (
           id,organization_id,workspace_id,website_project_id,
           recommendation_id,prospect_id,recommendation_context_version_id,
           contact_candidate_id,contact_evidence_id,source_url,email_sha256,
           email_reference,inferred_purpose,contact_confidence,
           purpose_confidence,evidence_confidence,collected_at,rules_version,
           created_by
         )
         SELECT gen_random_uuid(),$1,$2,$3,selected.recommendation_id,
                selected.prospect_id,$5,selected.candidate_id,
                selected.evidence_id,selected.source_url,
                encode(
                  sha256(convert_to(selected.normalized_email,'UTF8')),
                  'hex'
                ),
                'contact-candidate:'||selected.candidate_id::text,
                selected.inferred_purpose,selected.contact_confidence,
                selected.purpose_confidence,selected.evidence_confidence,
                selected.observed_at,
                'contact-publication-rules.v2|'||
                  selected.purpose_rule_version||'|'||
                  selected.evidence_rule_version,
                $9
           FROM selected
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           recommendation_id,recommendation_context_version_id,
           contact_candidate_id,contact_evidence_id,rules_version
         ) DO NOTHING
         RETURNING *
       ),
       chosen_snapshot AS MATERIALIZED (
         SELECT inserted.*
           FROM inserted_snapshot AS inserted
         UNION ALL
         SELECT snapshot.*
           FROM selected
           JOIN backlinks.backlink_contact_evidence_snapshots AS snapshot
             ON snapshot.organization_id=$1
            AND snapshot.workspace_id=$2
            AND snapshot.website_project_id=$3
            AND snapshot.recommendation_id=selected.recommendation_id
            AND snapshot.recommendation_context_version_id=$5
            AND snapshot.contact_candidate_id=selected.candidate_id
            AND snapshot.contact_evidence_id=selected.evidence_id
            AND snapshot.rules_version=
                'contact-publication-rules.v2|'||
                  selected.purpose_rule_version||'|'||
                  selected.evidence_rule_version
          WHERE NOT EXISTS (
            SELECT 1
              FROM inserted_snapshot AS inserted
             WHERE inserted.recommendation_id=selected.recommendation_id
               AND inserted.contact_candidate_id=selected.candidate_id
               AND inserted.contact_evidence_id=selected.evidence_id
          )
       )
       UPDATE backlinks.backlink_recommendation_inventory AS inventory
          SET contact_decision='eligible',
              contact_reason_code='PUBLIC_EMAIL_FOUND',
              verified_public_email_count=selected.email_count,
              contact_evidence_snapshot_id=snapshot.id,
              default_contact_candidate_id=snapshot.contact_candidate_id,
              default_contact_source_url=snapshot.source_url,
              default_contact_email_sha256=snapshot.email_sha256,
              default_contact_email_reference=snapshot.email_reference,
              contact_collected_at=snapshot.collected_at,
              contact_rules_version=snapshot.rules_version,
              updated_at=statement_timestamp(),updated_by=$9,
              version=inventory.version+1
         FROM selected
         JOIN chosen_snapshot AS snapshot
           ON snapshot.recommendation_id=selected.recommendation_id
          AND snapshot.contact_candidate_id=selected.candidate_id
          AND snapshot.contact_evidence_id=selected.evidence_id
        WHERE inventory.organization_id=$1 AND inventory.workspace_id=$2
          AND inventory.website_project_id=$3
          AND inventory.id=selected.inventory_id
          AND inventory.recommendation_id=selected.recommendation_id
          AND inventory.prospect_id=selected.prospect_id
          AND inventory.recommendation_context_version_id=$5
          AND (
            inventory.contact_decision IS DISTINCT FROM 'eligible'
            OR inventory.contact_reason_code IS DISTINCT FROM
                 'PUBLIC_EMAIL_FOUND'
            OR inventory.verified_public_email_count IS DISTINCT FROM
                 selected.email_count
            OR inventory.contact_evidence_snapshot_id IS DISTINCT FROM
                 snapshot.id
            OR inventory.default_contact_candidate_id IS DISTINCT FROM
                 snapshot.contact_candidate_id
            OR inventory.default_contact_source_url IS DISTINCT FROM
                 snapshot.source_url
            OR inventory.default_contact_email_sha256 IS DISTINCT FROM
                 snapshot.email_sha256
            OR inventory.default_contact_email_reference IS DISTINCT FROM
                 snapshot.email_reference
            OR inventory.contact_collected_at IS DISTINCT FROM
                 snapshot.collected_at
            OR inventory.contact_rules_version IS DISTINCT FROM
                 snapshot.rules_version
          )`,
      [...scopeValues(input), input.batchIds, input.actorId],
    );
  };

  const synchronizeTerminalContacts = async (
    input: RecommendationPoolV2CanonicalBatchPreparationInput,
  ) => {
    await synchronizeNativeV2PublicEmailEvidence(input);
    await client.query(
      `WITH terminal AS (
         SELECT item.id,job.terminal_reason_code,job.completed_at,
                candidate.normalized_email,
                contact_page.observed_page_url
           FROM backlinks.backlink_recommendation_release_batch_items AS item
           JOIN backlinks.backlink_recommendation_release_batches AS batch
             ON batch.organization_id=item.organization_id
            AND batch.workspace_id=item.workspace_id
            AND batch.website_project_id=item.website_project_id
            AND batch.id=item.batch_id
            AND batch.state IN ('PREPARING','AVAILABLE')
           JOIN backlinks.backlink_recommendation_generation_contracts
             AS generation
             ON generation.organization_id=item.organization_id
            AND generation.workspace_id=item.workspace_id
            AND generation.website_project_id=item.website_project_id
            AND generation.id=item.generation_contract_id
            AND generation.pool_contract_version='recommendation-pool.v2'
           JOIN backlinks.backlink_recommendation_pool_project_contracts
             AS contract
             ON contract.organization_id=item.organization_id
             AND contract.workspace_id=item.workspace_id
             AND contract.website_project_id=item.website_project_id
             AND contract.pool_contract_version='recommendation-pool.v2'
             AND ${recommendationPoolV2GeneratableContractSql}
           JOIN backlinks.backlink_project_context_snapshots AS context
             ON context.organization_id=item.organization_id
            AND context.workspace_id=item.workspace_id
            AND context.website_project_id=item.website_project_id
            AND context.id=item.recommendation_context_version_id
           JOIN backlinks.backlink_contact_enrichment_jobs AS job
             ON job.organization_id=item.organization_id
            AND job.workspace_id=item.workspace_id
            AND job.website_project_id=item.website_project_id
            AND job.recommendation_id=item.recommendation_id
            AND job.prospect_id=item.prospect_id
            AND job.recommendation_context_version_id=
              item.recommendation_context_version_id
           LEFT JOIN backlinks.backlink_recommendation_inventory AS inventory
             ON inventory.organization_id=item.organization_id
            AND inventory.workspace_id=item.workspace_id
            AND inventory.website_project_id=item.website_project_id
            AND inventory.id=item.inventory_id
           LEFT JOIN backlinks.backlink_contact_evidence_snapshots AS snapshot
             ON snapshot.organization_id=inventory.organization_id
            AND snapshot.workspace_id=inventory.workspace_id
            AND snapshot.website_project_id=inventory.website_project_id
            AND snapshot.id=inventory.contact_evidence_snapshot_id
           LEFT JOIN backlinks.backlink_contact_candidates AS candidate
             ON candidate.organization_id=snapshot.organization_id
            AND candidate.workspace_id=snapshot.workspace_id
            AND candidate.website_project_id=snapshot.website_project_id
            AND candidate.id=snapshot.contact_candidate_id
           LEFT JOIN LATERAL (
             ${observedContactPageSql("item", "job.terminal_reason_code")}
           ) contact_page ON true
          WHERE item.organization_id=$1 AND item.workspace_id=$2
            AND item.website_project_id=$3
            AND item.generation_contract_id=$4
            AND item.recommendation_context_version_id=$5
            AND item.visible_pool_generation=$6 AND item.input_pin_id=$7
            AND item.batch_id=ANY($8::uuid[])
             AND (
               item.contact_terminal_reason_at_release IS NULL
               OR (
                 batch.state='AVAILABLE'
                 AND item.contact_terminal_reason_at_release=
                       'PUBLIC_EMAIL_FOUND'
                 AND item.contact_email_at_release IS NULL
                 AND candidate.normalized_email IS NOT NULL
               )
             )
             AND job.terminal_reason_code IS NOT NULL
             AND job.completed_at IS NOT NULL
             AND (
               job.terminal_reason_code<>'PUBLIC_EMAIL_FOUND'
               OR candidate.normalized_email IS NOT NULL
             )
             AND context.project_status='ACTIVE'
             AND NOT EXISTS (
               SELECT 1
                 FROM backlinks.backlink_project_context_snapshots AS newer
                WHERE newer.organization_id=context.organization_id
                  AND newer.workspace_id=context.workspace_id
                  AND newer.website_project_id=context.website_project_id
                  AND newer.snapshot_version>context.snapshot_version
             )
       )
       UPDATE backlinks.backlink_recommendation_release_batch_items AS item
          SET contact_terminal_reason_at_release=COALESCE(
                item.contact_terminal_reason_at_release,
                terminal.terminal_reason_code
              ),
              contact_email_at_release=CASE
                WHEN terminal.terminal_reason_code='PUBLIC_EMAIL_FOUND'
                  THEN terminal.normalized_email
                ELSE NULL
              END,
              contact_page_url_at_release=
                CASE
                  WHEN item.contact_terminal_reason_at_release IS NOT NULL
                    THEN item.contact_page_url_at_release
                  ELSE terminal.observed_page_url
                END,
              contact_completed_at_release=COALESCE(
                item.contact_completed_at_release,
                terminal.completed_at
              )
         FROM terminal
        WHERE item.id=terminal.id`,
      [...scopeValues(input), input.batchIds],
    );
    await client.query(
      `WITH counts AS (
         SELECT batch.id,
                count(item.id) FILTER (
                  WHERE item.contact_terminal_reason_at_release IS NOT NULL
                    AND item.contact_completed_at_release IS NOT NULL
                )::integer terminal_count,
                count(item.id)::integer total_count
           FROM backlinks.backlink_recommendation_release_batches AS batch
           JOIN backlinks.backlink_recommendation_generation_contracts
             AS generation
             ON generation.organization_id=batch.organization_id
            AND generation.workspace_id=batch.workspace_id
            AND generation.website_project_id=batch.website_project_id
            AND generation.id=batch.generation_contract_id
            AND generation.recommendation_context_version_id=
              batch.recommendation_context_version_id
            AND generation.visible_pool_generation=batch.visible_pool_generation
            AND generation.input_pin_id=batch.input_pin_id
            AND generation.pool_contract_version='recommendation-pool.v2'
           JOIN backlinks.backlink_recommendation_pool_project_contracts
             AS contract
             ON contract.organization_id=batch.organization_id
             AND contract.workspace_id=batch.workspace_id
             AND contract.website_project_id=batch.website_project_id
             AND contract.pool_contract_version='recommendation-pool.v2'
             AND ${recommendationPoolV2GeneratableContractSql}
           JOIN backlinks.backlink_project_context_snapshots AS context
             ON context.organization_id=batch.organization_id
            AND context.workspace_id=batch.workspace_id
            AND context.website_project_id=batch.website_project_id
            AND context.id=batch.recommendation_context_version_id
           JOIN backlinks.backlink_recommendation_release_batch_items AS item
             ON item.organization_id=batch.organization_id
            AND item.workspace_id=batch.workspace_id
            AND item.website_project_id=batch.website_project_id
            AND item.batch_id=batch.id
          WHERE batch.organization_id=$1 AND batch.workspace_id=$2
            AND batch.website_project_id=$3
            AND batch.generation_contract_id=$4
            AND batch.recommendation_context_version_id=$5
             AND batch.visible_pool_generation=$6 AND batch.input_pin_id=$7
             AND batch.id=ANY($8::uuid[])
             AND context.project_status='ACTIVE'
             AND NOT EXISTS (
               SELECT 1
                 FROM backlinks.backlink_project_context_snapshots AS newer
                WHERE newer.organization_id=context.organization_id
                  AND newer.workspace_id=context.workspace_id
                  AND newer.website_project_id=context.website_project_id
                  AND newer.snapshot_version>context.snapshot_version
             )
           GROUP BY batch.id
       )
       UPDATE backlinks.backlink_recommendation_release_batches AS batch
          SET contact_terminal_count=counts.terminal_count,
              state=CASE WHEN counts.terminal_count=counts.total_count
                THEN 'AVAILABLE' ELSE batch.state END,
              available_at=CASE WHEN counts.terminal_count=counts.total_count
                THEN COALESCE(batch.available_at,statement_timestamp())
                ELSE batch.available_at END,
              updated_at=statement_timestamp(),updated_by=$9,
              version=batch.version+1
         FROM counts
        WHERE batch.id=counts.id
          AND batch.state='PREPARING'
          AND (
            batch.contact_terminal_count IS DISTINCT FROM counts.terminal_count
            OR counts.terminal_count=counts.total_count
          )`,
      [...scopeValues(input), input.batchIds, input.actorId],
    );
  };

  const inspectCanonicalBatchPreparation = async (
    input: RecommendationPoolV2CanonicalBatchPreparationInput,
  ): Promise<RecommendationPoolV2PreparationInspection> => {
    await markCanonicalPreparation(input);
    await synchronizeTerminalContacts(input);
    const result = await client.query(
      `SELECT statement_timestamp() "databaseNow",
              count(*)::integer "totalBatchCount",
              count(*) FILTER (
                WHERE state IN ('AVAILABLE','SUPERSEDED')
              )::integer "terminalBatchCount",
              CASE
                WHEN bool_and(state='SUPERSEDED') THEN 'SUPERSEDED'
                WHEN bool_and(state='AVAILABLE') THEN 'AVAILABLE'
                ELSE 'PREPARING'
              END "state"
         FROM backlinks.backlink_recommendation_release_batches
        WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
          AND generation_contract_id=$4
          AND recommendation_context_version_id=$5
          AND visible_pool_generation=$6 AND input_pin_id=$7
          AND id=ANY($8::uuid[])`,
      [...scopeValues(input), input.batchIds],
    );
    const row = result.rows[0] ?? {};
    return Object.freeze({
      databaseNow: new Date(String(row.databaseNow)).toISOString(),
      state: String(
        row.state,
      ) as RecommendationPoolV2PreparationInspection["state"],
      terminalBatchCount: Number(row.terminalBatchCount ?? 0),
      totalBatchCount: Number(row.totalBatchCount ?? 0),
    });
  };

  const convergeCanonicalBatchPreparation = async (
    input: RecommendationPoolV2CanonicalBatchPreparationInput,
  ): Promise<void> => {
    const batchIds = [...new Set(input.batchIds)];
    if (batchIds.length === 0 || batchIds.length > 2) {
      throw new Error("RECOMMENDATION_POOL_V2_BATCH_SCOPE_MISMATCH");
    }
    const deadline = await client.query(
      `WITH locked_batches AS (
         SELECT state,deadline_at
           FROM backlinks.backlink_recommendation_release_batches
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
            AND generation_contract_id=$4
            AND recommendation_context_version_id=$5
            AND visible_pool_generation=$6 AND input_pin_id=$7
            AND id=ANY($8::uuid[])
          FOR UPDATE
       )
       SELECT count(*)::integer "batchCount",
              COALESCE(bool_and(state='PREPARING'),false) "allPreparing",
              min(deadline_at) "minimumDeadlineAt",
              max(deadline_at) "maximumDeadlineAt",
              statement_timestamp()>=min(deadline_at) "expired"
         FROM locked_batches`,
      [...scopeValues(input), batchIds],
    );
    const deadlineRow = deadline.rows[0] ?? {};
    if (Number(deadlineRow.batchCount ?? 0) !== batchIds.length) {
      throw new Error("RECOMMENDATION_POOL_V2_BATCH_SCOPE_MISMATCH");
    }
    if (deadlineRow.allPreparing !== true) {
      throw new Error("RECOMMENDATION_POOL_V2_BATCH_NOT_PREPARING");
    }
    const minimumDeadlineAt = new Date(
      String(deadlineRow.minimumDeadlineAt),
    ).toISOString();
    const maximumDeadlineAt = new Date(
      String(deadlineRow.maximumDeadlineAt),
    ).toISOString();
    const requestedDeadlineAt = new Date(
      input.preparationDeadlineAt,
    ).toISOString();
    if (
      minimumDeadlineAt !== maximumDeadlineAt ||
      requestedDeadlineAt !== minimumDeadlineAt
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_CONTACT_DEADLINE_MISMATCH");
    }
    if (deadlineRow.expired !== true) {
      throw new Error("RECOMMENDATION_POOL_V2_CONTACT_DEADLINE_NOT_REACHED");
    }
    await client.query(
      `UPDATE backlinks.backlink_contact_enrichment_jobs AS job
          SET status='partially_completed',retry_after=NULL,
              finished_at=statement_timestamp(),
              completed_at=statement_timestamp(),
              terminal_reason_code='COMPLETED_PARTIAL',
              method=CASE
                WHEN browser_used AND pages_visited>0 THEN 'static_and_browser'
                WHEN browser_used THEN 'browser'
                WHEN pages_visited>0 THEN 'static'
                ELSE 'none'
              END,
              last_error_category=COALESCE(
                last_error_category,'PREPARATION_DEADLINE_REACHED'
              ),
              last_error_code=COALESCE(
                last_error_code,'PREPARATION_DEADLINE_REACHED'
              ),
              updated_at=statement_timestamp(),updated_by=$9,
              version=version+1
        WHERE job.organization_id=$1 AND job.workspace_id=$2
          AND job.website_project_id=$3
          AND job.recommendation_context_version_id=$5
          AND job.status IN ('pending','running','retry_scheduled')
          AND EXISTS (
            SELECT 1
              FROM backlinks.backlink_recommendation_release_batch_items AS item
             WHERE item.organization_id=job.organization_id
               AND item.workspace_id=job.workspace_id
               AND item.website_project_id=job.website_project_id
               AND item.recommendation_id=job.recommendation_id
               AND item.prospect_id=job.prospect_id
               AND item.generation_contract_id=$4
               AND item.visible_pool_generation=$6
               AND item.input_pin_id=$7
               AND item.batch_id=ANY($8::uuid[])
          )`,
      [...scopeValues(input), batchIds, input.actorId],
    );
    await synchronizeTerminalContacts({
      ...input,
      batchIds,
    });
  };

  const activateGeneration = async (
    input: ActivateGenerationInput,
  ): Promise<void> => {
    const contractResult = await client.query(
      `SELECT pool_contract_version "poolContractVersion",
              migration_state "migrationState",
              state_reason_codes "stateReasonCodes",
              CASE
                WHEN migration_state='MIGRATION_BLOCKED'
                  THEN COALESCE((
                    backlinks
                      .backlink_recommendation_pool_v2_native_generation_verify()
                      ->>'v1WritesFrozen'
                  )::boolean,false)
                ELSE false
              END "v1WritesFrozen",
              generation_contract_id "generationContractId",
              visible_pool_generation "visiblePoolGeneration",
              version
         FROM backlinks.backlink_recommendation_pool_project_contracts
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
        FOR UPDATE`,
      [input.organizationId, input.workspaceId, input.websiteProjectId],
    );
    const contract = contractResult.rows[0];
    if (
      contract === undefined ||
      !isRecommendationPoolV2ProjectGeneratable(contract)
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_PROJECT_NOT_GENERATABLE");
    }

    const generationResult = await client.query(
      `SELECT generation.effective_unique_candidate_count
                 "effectiveUniqueCandidateCount",
              generation.discovery_terminal_reason
                "discoveryTerminalReason",
              (
                SELECT snapshot.id
                  FROM backlinks.backlink_project_context_snapshots AS snapshot
                 WHERE snapshot.organization_id=generation.organization_id
                   AND snapshot.workspace_id=generation.workspace_id
                   AND snapshot.website_project_id=generation.website_project_id
                 ORDER BY snapshot.snapshot_version DESC
                 LIMIT 1
              ) "authoritativeContextId"
         FROM backlinks.backlink_recommendation_generation_contracts
           AS generation
        WHERE generation.organization_id=$1
          AND generation.workspace_id=$2
          AND generation.website_project_id=$3
          AND generation.id=$4
          AND generation.recommendation_context_version_id=$5
          AND generation.visible_pool_generation=$6
          AND generation.input_pin_id=$7
          AND generation.pool_contract_version='recommendation-pool.v2'`,
      scopeValues(input),
    );
    const generation = generationResult.rows[0];
    if (
      generation === undefined ||
      Number(generation.effectiveUniqueCandidateCount ?? 0) < 1
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_NATIVE_GENERATION_EMPTY");
    }
    if (
      String(generation.authoritativeContextId ?? "") !==
      input.recommendationContextVersionId
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_CONTEXT_SUPERSEDED");
    }
    const admittedCount = Number(generation.effectiveUniqueCandidateCount);
    const discoveryTerminalReason = String(
      generation.discoveryTerminalReason ?? "",
    );
    const boundedExhaustion = boundedExhaustionReasons.has(
      discoveryTerminalReason,
    );
    if (
      input.publicationOutcome === "PARTIAL_EXHAUSTED" &&
      (admittedCount >= recommendationDiscoverySupplyThreshold ||
        !boundedExhaustion)
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_PARTIAL_OUTCOME_MISMATCH");
    }
    if (
      input.publicationOutcome === "READY" &&
      admittedCount < recommendationDiscoverySupplyThreshold &&
      boundedExhaustion
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_READY_OUTCOME_MISMATCH");
    }

    const batchIds = [...new Set(input.batchIds)];
    if (batchIds.length === 0 || batchIds.length > 2) {
      throw new Error("RECOMMENDATION_POOL_V2_BATCH_SCOPE_MISMATCH");
    }
    const batchResult = await client.query(
      `SELECT batch.id,
              batch.original_batch_size "originalBatchSize"
         FROM backlinks.backlink_recommendation_release_batches AS batch
        WHERE batch.organization_id=$1 AND batch.workspace_id=$2
          AND batch.website_project_id=$3
          AND batch.generation_contract_id=$4
          AND batch.recommendation_context_version_id=$5
          AND batch.visible_pool_generation=$6
          AND batch.input_pin_id=$7
          AND batch.id=ANY($8::uuid[])
          AND batch.state='AVAILABLE'
          AND NOT EXISTS (
            SELECT 1
              FROM backlinks.backlink_recommendation_release_batch_items AS item
             WHERE item.organization_id=batch.organization_id
               AND item.workspace_id=batch.workspace_id
               AND item.website_project_id=batch.website_project_id
               AND item.batch_id=batch.id
               AND item.legacy_imported
          )
        ORDER BY batch.batch_ordinal
        LIMIT 1`,
      [...scopeValues(input), batchIds],
    );
    const firstBatch = batchResult.rows[0];
    if (firstBatch === undefined) {
      throw new Error("RECOMMENDATION_POOL_V2_NATIVE_BATCH_NOT_AVAILABLE");
    }
    const releasedCount = Number(firstBatch.originalBatchSize);
    if (
      !Number.isSafeInteger(releasedCount) ||
      releasedCount < 1 ||
      releasedCount > admittedCount
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_RELEASE_COUNT_MISMATCH");
    }

    const alreadyActive =
      String(contract.generationContractId ?? "") ===
      input.generationContractId;
    if (!alreadyActive) {
      const currentGeneration = Number(contract.visiblePoolGeneration ?? 0);
      if (currentGeneration >= input.visiblePoolGeneration) {
        throw new Error("RECOMMENDATION_POOL_V2_ACTIVATION_ORDER_CONFLICT");
      }
      const updated = await client.query(
        `UPDATE backlinks.backlink_recommendation_pool_project_contracts
            SET migration_state='V2_ACTIVE',
                generation_contract_id=$4,
                recommendation_context_version_id=$5,
                visible_pool_generation=$6,
                input_pin_id=$7,
                state_reason_codes='[]'::jsonb,
                activated_at=COALESCE(activated_at,statement_timestamp()),
                updated_at=statement_timestamp(),updated_by=$8,
                version=version+1
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND version=$9
          RETURNING id`,
        [...scopeValues(input), input.actorId, Number(contract.version)],
      );
      if (updated.rowCount !== 1) {
        throw new Error("RECOMMENDATION_POOL_V2_ACTIVATION_CONFLICT");
      }
    }

    const publicationCommand = [
      "initial",
      input.generationContractId,
      input.visiblePoolGeneration,
    ].join(":");
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_user_publications (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,visible_pool_generation,
         user_id,batch_id,published_by_command_id,created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$7)
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,user_id,batch_id
       ) DO NOTHING`,
      [
        randomUUID(),
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        input.actorId,
        firstBatch.id,
        publicationCommand,
      ],
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_user_cursors (
         organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,visible_pool_generation,user_id,
         highest_published_batch_ordinal,current_batch_id,updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$6)
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,visible_pool_generation,user_id
       ) DO NOTHING`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        input.actorId,
        firstBatch.id,
      ],
    );
    const terminalProjection =
      input.publicationOutcome === undefined
        ? Object.freeze({})
        : Object.freeze({
            outcome: input.publicationOutcome,
            terminalReason: discoveryTerminalReason,
            discoveryTerminalReason,
            admittedCount,
            releasedCount,
            releaseResult: "AVAILABLE",
          });
    const published = await client.query(
      `UPDATE backlinks.backlink_jobs
          SET status='success',step='published',progress=100,
              finished_at=statement_timestamp(),
              error=NULL,
              result_summary=(
                COALESCE(result_summary,'{}'::jsonb)
                - 'failureCode'
                - 'failureMessage'
              ) ||
                jsonb_build_object(
                  'final',true,
                  'outcome','PUBLISHED',
                  'publishedGenerationContractId',$4::uuid::text,
                   'publishedVisiblePoolGeneration',$6::integer,
                   'publishedInputPinId',$7::uuid::text,
                   'publishedBatchId',$8::uuid::text
                ) ||
                $9::jsonb,
              updated_at=statement_timestamp(),updated_by=$10,
              version=version+1
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$11
          AND job_type='recommendation_pool_v2_generation'
          AND source_object_type='project-context-snapshot'
          AND source_object_id=$5
          AND result_summary->>'generationContractId'=$4::uuid::text
          AND result_summary->>'inputPinId'=$7::uuid::text`,
      [
        ...scopeValues(input),
        firstBatch.id,
        JSON.stringify(terminalProjection),
        input.actorId,
        input.jobId,
      ],
    );
    if (published.rowCount !== 1) {
      throw new Error("RECOMMENDATION_POOL_V2_PUBLICATION_TERMINAL_CONFLICT");
    }
  };

  const completeGenerationWithoutPublication = async (
    input: CompleteWithoutPublicationInput,
  ): Promise<void> => {
    if (input.reason === "NO_VALID_CANDIDATES_AFTER_EXHAUSTION") {
      const completed = await client.query(
        `WITH terminal AS MATERIALIZED (
           SELECT fact.id "terminalFactId",
                  fact.terminal_reason "terminalReason",
                  fact.effective_unique_candidate_count
                    "effectiveUniqueCandidateCount",
                  fact.total_settled_cost_micros "totalSettledCostMicros"
             FROM backlinks
               .backlink_recommendation_discovery_generation_terminal_facts
               AS fact
             JOIN backlinks.backlink_recommendation_generation_contracts
               AS generation
               ON generation.organization_id=fact.organization_id
              AND generation.workspace_id=fact.workspace_id
              AND generation.website_project_id=fact.website_project_id
              AND generation.id=fact.generation_contract_id
              AND generation.recommendation_context_version_id=
                    fact.recommendation_context_version_id
              AND generation.visible_pool_generation=
                    fact.visible_pool_generation
              AND generation.input_pin_id=fact.input_pin_id
              AND generation.pool_contract_version=fact.pool_contract_version
            WHERE fact.organization_id=$1 AND fact.workspace_id=$2
              AND fact.website_project_id=$3
              AND fact.generation_contract_id=$4
              AND fact.recommendation_context_version_id=$5
              AND fact.visible_pool_generation=$6
              AND fact.input_pin_id=$7
              AND fact.pool_contract_version='recommendation-pool.v2'
              AND fact.effective_unique_candidate_count=0
              AND generation.effective_unique_candidate_count=0
              AND generation.discovery_terminal_reason=fact.terminal_reason
         ),
         updated AS (
           UPDATE backlinks.backlink_jobs AS job
              SET status='success',
                  step='completed_no_valid_candidates',
                  progress=100,
                  finished_at=COALESCE(
                    job.finished_at,
                    statement_timestamp()
                  ),
                  result_summary=(
                    COALESCE(job.result_summary,'{}'::jsonb)
                    - 'failureCode'
                    - 'failureMessage'
                    - 'failureRetryable'
                  ) ||
                    jsonb_build_object(
                      'final',true,
                      'outcome',$8::text,
                      'terminalReason',$8::text,
                      'discoveryTerminalReason',terminal."terminalReason",
                      'effectiveUniqueCandidateCount',
                        terminal."effectiveUniqueCandidateCount",
                      'admittedCount',0,
                      'releasedCount',0,
                      'releaseResult','NO_BATCH',
                      'totalSettledCostMicros',
                        terminal."totalSettledCostMicros",
                      'terminalFactId',terminal."terminalFactId"::text
                    ),
                  error=NULL,
                  updated_at=statement_timestamp(),updated_by=$9,
                  version=job.version+1
             FROM terminal
            WHERE job.organization_id=$1 AND job.workspace_id=$2
              AND job.website_project_id=$3 AND job.id=$10
              AND job.job_type='recommendation_pool_v2_generation'
              AND job.source_object_type='project-context-snapshot'
              AND job.source_object_id=$5
              AND job.result_summary->>'generationContractId'=$4::uuid::text
              AND job.result_summary->>'visiblePoolGeneration'=
                    $6::integer::text
              AND job.result_summary->>'inputPinId'=$7::uuid::text
              AND job.status IN ('queued','running','waiting_provider')
           RETURNING job.id
         )
         SELECT EXISTS (
           SELECT 1 FROM updated
         ) OR EXISTS (
           SELECT 1
             FROM backlinks.backlink_jobs AS job
             CROSS JOIN terminal
            WHERE job.organization_id=$1 AND job.workspace_id=$2
              AND job.website_project_id=$3 AND job.id=$10
              AND job.status='success'
              AND job.step='completed_no_valid_candidates'
              AND job.result_summary->>'outcome'=$8::text
              AND job.result_summary->>'terminalFactId'=
                    terminal."terminalFactId"::text
              AND job.error IS NULL
         ) "completed"`,
        [...scopeValues(input), input.reason, input.actorId, input.jobId],
      );
      if (completed.rows[0]?.completed !== true) {
        throw new Error(
          "RECOMMENDATION_POOL_V2_EMPTY_GENERATION_TERMINAL_CONFLICT",
        );
      }
      return;
    }
    const completed = await client.query(
      `WITH terminal AS MATERIALIZED (
         SELECT fact.id "terminalFactId",
                fact.terminal_reason "terminalReason",
                fact.effective_unique_candidate_count
                  "effectiveUniqueCandidateCount",
                fact.total_settled_cost_micros "totalSettledCostMicros"
           FROM backlinks
             .backlink_recommendation_discovery_generation_terminal_facts
             AS fact
           JOIN backlinks.backlink_recommendation_generation_contracts
             AS generation
             ON generation.organization_id=fact.organization_id
            AND generation.workspace_id=fact.workspace_id
            AND generation.website_project_id=fact.website_project_id
            AND generation.id=fact.generation_contract_id
            AND generation.recommendation_context_version_id=
                  fact.recommendation_context_version_id
            AND generation.visible_pool_generation=
                  fact.visible_pool_generation
            AND generation.input_pin_id=fact.input_pin_id
            AND generation.pool_contract_version=fact.pool_contract_version
          WHERE fact.organization_id=$1 AND fact.workspace_id=$2
            AND fact.website_project_id=$3
            AND fact.generation_contract_id=$4
            AND fact.recommendation_context_version_id=$5
            AND fact.visible_pool_generation=$6
            AND fact.input_pin_id=$7
            AND fact.pool_contract_version='recommendation-pool.v2'
            AND fact.effective_unique_candidate_count=0
            AND generation.effective_unique_candidate_count=0
            AND generation.discovery_terminal_reason=fact.terminal_reason
       ),
       updated AS (
         UPDATE backlinks.backlink_jobs AS job
            SET status='failed',
                step='input_required_no_native_candidates',
                progress=100,
                finished_at=COALESCE(
                  job.finished_at,
                  statement_timestamp()
                ),
                result_summary=
                  COALESCE(job.result_summary,'{}'::jsonb) ||
                  jsonb_build_object(
                    'outcome','INPUT_REQUIRED',
                    'terminalReason',terminal."terminalReason",
                    'effectiveUniqueCandidateCount',
                      terminal."effectiveUniqueCandidateCount",
                    'totalSettledCostMicros',
                      terminal."totalSettledCostMicros",
                    'terminalFactId',terminal."terminalFactId"::text
                  ),
                error=jsonb_build_object(
                  'code',$8::text,
                  'message','No native V2 candidates passed qualification.'
                ),
                updated_at=statement_timestamp(),updated_by=$9,
                version=job.version+1
           FROM terminal
          WHERE job.organization_id=$1 AND job.workspace_id=$2
            AND job.website_project_id=$3 AND job.id=$10
            AND job.job_type='recommendation_pool_v2_generation'
            AND job.source_object_type='project-context-snapshot'
            AND job.source_object_id=$5
            AND job.result_summary->>'generationContractId'=$4::uuid::text
            AND job.result_summary->>'visiblePoolGeneration'=
                  $6::integer::text
            AND job.result_summary->>'inputPinId'=$7::uuid::text
            AND job.status IN ('queued','running','waiting_provider')
         RETURNING job.id
       )
       SELECT EXISTS (
         SELECT 1 FROM updated
       ) OR EXISTS (
         SELECT 1
           FROM backlinks.backlink_jobs AS job
           CROSS JOIN terminal
          WHERE job.organization_id=$1 AND job.workspace_id=$2
            AND job.website_project_id=$3 AND job.id=$10
            AND job.status='failed'
            AND job.step='input_required_no_native_candidates'
            AND job.result_summary->>'terminalFactId'=
                  terminal."terminalFactId"::text
            AND job.error->>'code'=$8::text
       ) "completed"`,
      [...scopeValues(input), input.reason, input.actorId, input.jobId],
    );
    if (completed.rows[0]?.completed !== true) {
      throw new Error(
        "RECOMMENDATION_POOL_V2_EMPTY_GENERATION_TERMINAL_CONFLICT",
      );
    }
  };

  const failGeneration = async (input: FailGenerationInput): Promise<void> => {
    const failed = await client.query(
      `WITH updated AS (
         UPDATE backlinks.backlink_jobs AS job
            SET status='failed',
                step='workflow_failed',
                progress=100,
                finished_at=COALESCE(
                  job.finished_at,
                  statement_timestamp()
                ),
                result_summary=
                  COALESCE(job.result_summary,'{}'::jsonb) ||
                  jsonb_build_object(
                    'final',true,
                    'outcome','FAILED',
                    'terminalReason',$8::text,
                    'failureCode',$8::text,
                    'failureMessage',left($9::text,2000),
                    'failureRetryable',$10::boolean
                  ),
                error=jsonb_build_object(
                  'code',$8::text,
                  'message',left($9::text,2000),
                  'retryable',$10::boolean
                ),
                updated_at=statement_timestamp(),updated_by=$11,
                version=job.version+1
          WHERE job.organization_id=$1 AND job.workspace_id=$2
            AND job.website_project_id=$3 AND job.id=$12
            AND job.job_type='recommendation_pool_v2_generation'
            AND job.source_object_type='project-context-snapshot'
            AND job.source_object_id=$5
            AND job.result_summary->>'generationContractId'=$4::uuid::text
            AND job.status IN ('queued','running','waiting_provider')
        RETURNING job.id
       )
       SELECT EXISTS (SELECT 1 FROM updated)
         OR EXISTS (
            SELECT 1
              FROM backlinks.backlink_jobs AS job
             WHERE job.organization_id=$1 AND job.workspace_id=$2
              AND job.website_project_id=$3 AND job.id=$12
              AND job.status='failed'
              AND job.step='workflow_failed'
              AND job.result_summary->>'generationContractId'=$4::uuid::text
              AND job.result_summary->>'visiblePoolGeneration'=
                    $6::integer::text
              AND job.result_summary->>'inputPinId'=$7::uuid::text
              AND job.error->>'code'=$8::text
              AND job.error->>'retryable'=$10::boolean::text
         ) AS "failed"`,
      [
        ...scopeValues(input),
        input.failureCode,
        input.failureMessage,
        input.failureRetryable ?? false,
        input.actorId,
        input.jobId,
      ],
    );
    if (failed.rows[0]?.failed !== true) {
      throw new Error("RECOMMENDATION_POOL_V2_FAILURE_TERMINAL_CONFLICT");
    }
  };

  const completeGenerationSupersession = async (
    input: RecommendationPoolV2GenerationSupersessionInput,
  ): Promise<void> => {
    const terminalReason =
      input.supersession?.reason ?? "PROJECT_CONTEXT_SUPERSEDED";
    await client.query(
      `UPDATE backlinks.backlink_recommendation_release_batch_items AS item
          SET contact_terminal_reason_at_release=$8,
              contact_email_at_release=NULL,
              contact_page_url_at_release=NULL,
              contact_completed_at_release=statement_timestamp()
        WHERE item.organization_id=$1 AND item.workspace_id=$2
          AND item.website_project_id=$3
          AND item.generation_contract_id=$4
          AND item.recommendation_context_version_id=$5
          AND item.visible_pool_generation=$6 AND item.input_pin_id=$7
          AND item.contact_terminal_reason_at_release IS NULL
          AND EXISTS (
            SELECT 1
              FROM backlinks.backlink_recommendation_release_batches AS batch
             WHERE batch.organization_id=item.organization_id
               AND batch.workspace_id=item.workspace_id
               AND batch.website_project_id=item.website_project_id
               AND batch.id=item.batch_id
               AND batch.state='PREPARING'
          )`,
      [...scopeValues(input), terminalReason],
    );
    await client.query(
      `UPDATE backlinks.backlink_recommendation_release_batches
          SET state='SUPERSEDED',updated_at=statement_timestamp(),
              updated_by=$8,version=version+1
        WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
          AND generation_contract_id=$4
          AND recommendation_context_version_id=$5
          AND visible_pool_generation=$6 AND input_pin_id=$7
          AND state='PREPARING'`,
      [...scopeValues(input), input.actorId],
    );
  };

  const loadCanonicalBatchPreparationRecovery = async (
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      actorId: string;
    }>,
  ): Promise<RecommendationPoolV2CanonicalBatchRecoveryResult> => {
    const loaded = await client.query(
      `WITH project AS MATERIALIZED (
         SELECT contract.organization_id,contract.workspace_id,
                contract.website_project_id,
                contract.pool_contract_version,
                contract.migration_state,
                contract.state_reason_codes,
                CASE
                  WHEN contract.migration_state='MIGRATION_BLOCKED'
                    THEN COALESCE((
                      backlinks
                        .backlink_recommendation_pool_v2_native_generation_verify()
                        ->>'v1WritesFrozen'
                    )::boolean,false)
                  ELSE false
                END v1_writes_frozen,
                contract.generation_contract_id,
                contract.visible_pool_generation,
                (
                  SELECT snapshot.id
                    FROM backlinks.backlink_project_context_snapshots
                      AS snapshot
                   WHERE snapshot.organization_id=contract.organization_id
                     AND snapshot.workspace_id=contract.workspace_id
                     AND snapshot.website_project_id=contract.website_project_id
                   ORDER BY snapshot.snapshot_version DESC
                   LIMIT 1
                ) authoritative_context_id
           FROM backlinks.backlink_recommendation_pool_project_contracts
             AS contract
          WHERE contract.organization_id=$1 AND contract.workspace_id=$2
            AND contract.website_project_id=$3
       ),
       recovery_generation AS MATERIALIZED (
         SELECT generation.id generation_contract_id,
                generation.recommendation_context_version_id,
                generation.visible_pool_generation,
                generation.input_pin_id,
                generation.effective_unique_candidate_count,
                generation.discovery_terminal_reason,
                preparation.current_ordinal,
                job.id job_id,
                job.workflow_id,
                job.created_by activation_actor_id
           FROM project
           JOIN backlinks.backlink_recommendation_generation_contracts
             AS generation
             ON generation.organization_id=project.organization_id
            AND generation.workspace_id=project.workspace_id
            AND generation.website_project_id=project.website_project_id
           JOIN backlinks.backlink_generation_input_pins AS pin
             ON pin.organization_id=generation.organization_id
            AND pin.workspace_id=generation.workspace_id
            AND pin.website_project_id=generation.website_project_id
            AND pin.id=generation.input_pin_id
           CROSS JOIN LATERAL (
             SELECT GREATEST(1,COALESCE(
                      max(cursor.highest_published_batch_ordinal),1
                    )) current_ordinal
               FROM backlinks.backlink_recommendation_user_cursors AS cursor
              WHERE cursor.organization_id=generation.organization_id
                AND cursor.workspace_id=generation.workspace_id
                AND cursor.website_project_id=generation.website_project_id
                AND cursor.recommendation_context_version_id=
                    generation.recommendation_context_version_id
                AND cursor.visible_pool_generation=
                    generation.visible_pool_generation
           ) AS preparation
           LEFT JOIN LATERAL (
             SELECT candidate_job.id,candidate_job.workflow_id,
                    candidate_job.created_by
               FROM backlinks.backlink_jobs AS candidate_job
              WHERE candidate_job.organization_id=generation.organization_id
                AND candidate_job.workspace_id=generation.workspace_id
                AND candidate_job.website_project_id=
                    generation.website_project_id
                AND candidate_job.job_type=
                    'recommendation_pool_v2_generation'
                AND candidate_job.source_object_type=
                    'project-context-snapshot'
                 AND candidate_job.source_object_id=
                     generation.recommendation_context_version_id
                 AND candidate_job.result_summary->>'generationContractId'=
                     generation.id::text
                 AND candidate_job.finished_at IS NULL
               ORDER BY candidate_job.created_at DESC
               LIMIT 1
           ) AS job ON true
          WHERE generation.pool_contract_version='recommendation-pool.v2'
            AND generation.qualification_contract_version=
                'recommendation-pool-admission.v2'
            AND generation.visibility_contract_version=
                'recommendation-pool-release-visibility.v2'
            AND generation.score_model_version=
                'recommendation-pool-materialization.v2'
            AND generation.creator_worker_contract_version=
                'recommendation-pool-worker.v2'
            AND pin.qualification_contract_version=
                'recommendation-pool-admission.v2'
            AND generation.recommendation_context_version_id=
                project.authoritative_context_id
            AND NOT EXISTS (
              SELECT 1
                FROM backlinks.backlink_recommendation_release_batch_items
                  AS item
               WHERE item.organization_id=generation.organization_id
                 AND item.workspace_id=generation.workspace_id
                 AND item.website_project_id=generation.website_project_id
                 AND item.generation_contract_id=generation.id
                 AND (item.legacy_imported OR item.generation_candidate_id IS NULL)
            )
            AND EXISTS (
              SELECT 1
                FROM backlinks.backlink_recommendation_release_batches
                  AS batch
               WHERE batch.organization_id=generation.organization_id
                 AND batch.workspace_id=generation.workspace_id
                 AND batch.website_project_id=generation.website_project_id
                 AND batch.generation_contract_id=generation.id
                 AND batch.recommendation_context_version_id=
                     generation.recommendation_context_version_id
                 AND batch.visible_pool_generation=
                     generation.visible_pool_generation
                 AND batch.input_pin_id=generation.input_pin_id
                 AND batch.state IN ('PREPARING','AVAILABLE')
                 AND batch.batch_ordinal BETWEEN preparation.current_ordinal
                     AND preparation.current_ordinal+1
                 AND (
                   batch.state='PREPARING'
                   OR generation.visible_pool_generation>
                      project.visible_pool_generation
                   OR (
                     generation.id=project.generation_contract_id
                     AND job.id IS NOT NULL
                   )
                   OR EXISTS (
                     SELECT 1
                       FROM backlinks
                         .backlink_recommendation_release_batch_items AS item
                       JOIN backlinks.backlink_contact_enrichment_jobs
                         AS contact_job
                         ON contact_job.organization_id=item.organization_id
                        AND contact_job.workspace_id=item.workspace_id
                        AND contact_job.website_project_id=
                            item.website_project_id
                        AND contact_job.recommendation_id=
                            item.recommendation_id
                        AND contact_job.prospect_id=item.prospect_id
                        AND contact_job.recommendation_context_version_id=
                            item.recommendation_context_version_id
                       JOIN backlinks.backlink_contact_candidates AS candidate
                         ON candidate.organization_id=item.organization_id
                        AND candidate.workspace_id=item.workspace_id
                        AND candidate.website_project_id=
                            item.website_project_id
                        AND candidate.prospect_id=item.prospect_id
                        AND candidate.recommendation_context_version_id=
                            item.recommendation_context_version_id
                       JOIN backlinks.backlink_contact_evidence AS evidence
                         ON evidence.organization_id=candidate.organization_id
                        AND evidence.workspace_id=candidate.workspace_id
                        AND evidence.website_project_id=
                            candidate.website_project_id
                        AND evidence.candidate_id=candidate.id
                      WHERE item.batch_id=batch.id
                        AND item.legacy_imported=false
                        AND item.contact_terminal_reason_at_release=
                            'PUBLIC_EMAIL_FOUND'
                        AND item.contact_email_at_release IS NULL
                        AND contact_job.terminal_reason_code=
                            'PUBLIC_EMAIL_FOUND'
                        AND contact_job.completed_at IS NOT NULL
                        AND candidate.status IN ('candidate','promoted')
                        AND candidate.invalidated_at IS NULL
                        AND candidate.guessed=false
                        AND candidate.confidence>=80
                        AND candidate.purpose_confidence>=70
                        AND candidate.inferred_purpose IN (
                          'press','editorial','partnerships','advertising',
                          'business','marketing','site_owner','general'
                        )
                        AND lower(candidate.normalized_email) ~
                          '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
                        AND split_part(
                              lower(candidate.normalized_email),'@',1
                            ) !~
                            '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
                        AND candidate.email_domain_ascii NOT IN (
                          'example.com','example.org','example.net'
                        )
                        AND candidate.email_domain_ascii NOT LIKE '%.invalid'
                        AND evidence.invalidated_at IS NULL
                        AND evidence.expires_at>statement_timestamp()
                        AND evidence.extraction_method IN (
                          'mailto','visible_text','obfuscated_text','json_ld'
                        )
                        AND evidence.confidence>=80
                   )
                 )
            )
          ORDER BY generation.visible_pool_generation DESC
          LIMIT 1
       )
       SELECT project.pool_contract_version "poolContractVersion",
              project.migration_state "migrationState",
              project.state_reason_codes "stateReasonCodes",
              project.v1_writes_frozen "v1WritesFrozen",
              recovery.generation_contract_id "generationContractId",
              recovery.recommendation_context_version_id
                "recommendationContextVersionId",
              recovery.visible_pool_generation "visiblePoolGeneration",
              recovery.input_pin_id "inputPinId",
              recovery.effective_unique_candidate_count
                "effectiveUniqueCandidateCount",
              recovery.discovery_terminal_reason "discoveryTerminalReason",
              project.authoritative_context_id "authoritativeContextId",
              recovery.job_id "jobId",
              recovery.workflow_id "workflowId",
              recovery.activation_actor_id "activationActorId",
              ARRAY(
                SELECT batch.id
                  FROM backlinks.backlink_recommendation_release_batches
                    AS batch
                 WHERE batch.organization_id=project.organization_id
                   AND batch.workspace_id=project.workspace_id
                   AND batch.website_project_id=project.website_project_id
                   AND batch.generation_contract_id=
                     recovery.generation_contract_id
                   AND batch.recommendation_context_version_id=
                     recovery.recommendation_context_version_id
                   AND batch.visible_pool_generation=
                     recovery.visible_pool_generation
                   AND batch.input_pin_id=recovery.input_pin_id
                   AND batch.state IN ('PREPARING','AVAILABLE')
                   AND batch.batch_ordinal BETWEEN recovery.current_ordinal
                       AND recovery.current_ordinal+1
                 ORDER BY batch.batch_ordinal
              ) "batchIds",
              ARRAY(
                SELECT batch.id
                  FROM backlinks.backlink_recommendation_release_batches
                    AS batch
                 WHERE batch.organization_id=project.organization_id
                   AND batch.workspace_id=project.workspace_id
                   AND batch.website_project_id=project.website_project_id
                   AND batch.generation_contract_id=
                     recovery.generation_contract_id
                   AND batch.recommendation_context_version_id=
                     recovery.recommendation_context_version_id
                   AND batch.visible_pool_generation=
                     recovery.visible_pool_generation
                   AND batch.input_pin_id=recovery.input_pin_id
                   AND batch.state='PREPARING'
                   AND batch.batch_ordinal BETWEEN recovery.current_ordinal
                       AND recovery.current_ordinal+1
                 ORDER BY batch.batch_ordinal
              ) "preparingBatchIds",
              (
                SELECT min(batch.deadline_at)
                  FROM backlinks.backlink_recommendation_release_batches
                    AS batch
                 WHERE batch.organization_id=project.organization_id
                   AND batch.workspace_id=project.workspace_id
                   AND batch.website_project_id=project.website_project_id
                   AND batch.generation_contract_id=
                     recovery.generation_contract_id
                   AND batch.recommendation_context_version_id=
                     recovery.recommendation_context_version_id
                   AND batch.visible_pool_generation=
                     recovery.visible_pool_generation
                   AND batch.input_pin_id=recovery.input_pin_id
                   AND batch.state IN ('PREPARING','AVAILABLE')
                   AND batch.batch_ordinal BETWEEN recovery.current_ordinal
                       AND recovery.current_ordinal+1
              ) "preparationDeadlineAt"
         FROM project
         LEFT JOIN recovery_generation AS recovery ON true`,
      [input.organizationId, input.workspaceId, input.websiteProjectId],
    );
    const row = loaded.rows[0];
    if (
      row === undefined ||
      String(row.poolContractVersion) !== "recommendation-pool.v2"
    ) {
      return Object.freeze({ status: "contract_not_applicable" });
    }
    if (
      !isRecommendationPoolV2ProjectGeneratable(row) ||
      String(row.authoritativeContextId ?? "") !==
        String(row.recommendationContextVersionId ?? "")
    ) {
      return Object.freeze({ status: "idle" });
    }
    const batchIds = Array.isArray(row.batchIds)
      ? row.batchIds.map(String)
      : [];
    const preparingBatchIds = Array.isArray(row.preparingBatchIds)
      ? row.preparingBatchIds.map(String)
      : [];
    if (batchIds.length === 0) {
      return Object.freeze({ status: "idle" });
    }
    if (
      batchIds.length > 2 ||
      preparingBatchIds.length > batchIds.length ||
      preparingBatchIds.some((batchId) => !batchIds.includes(batchId)) ||
      row.preparationDeadlineAt === null
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_PREPARATION_RECOVERY_INVALID");
    }
    const activationActorId = String(row.activationActorId ?? "").trim();
    const jobId = String(row.jobId ?? "").trim();
    const workflowId = String(row.workflowId ?? "").trim();
    const effectiveUniqueCandidateCount = Number(
      row.effectiveUniqueCandidateCount,
    );
    const discoveryTerminalReason = String(row.discoveryTerminalReason ?? "");
    if (
      !Number.isSafeInteger(effectiveUniqueCandidateCount) ||
      effectiveUniqueCandidateCount <= 0
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_PREPARATION_RECOVERY_INVALID");
    }
    const publicationOutcome =
      effectiveUniqueCandidateCount < recommendationDiscoverySupplyThreshold &&
      boundedExhaustionReasons.has(discoveryTerminalReason)
        ? ("PARTIAL_EXHAUSTED" as const)
        : ("READY" as const);
    return Object.freeze({
      status: "preparing",
      preparingBatchIds: Object.freeze(preparingBatchIds),
      input: Object.freeze({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        generationContractId: String(row.generationContractId),
        recommendationContextVersionId: String(
          row.recommendationContextVersionId,
        ),
        visiblePoolGeneration: Number(row.visiblePoolGeneration),
        inputPinId: String(row.inputPinId),
        actorId:
          activationActorId.length > 0 ? activationActorId : input.actorId,
        batchIds: Object.freeze(batchIds),
        preparationDeadlineAt: new Date(
          String(row.preparationDeadlineAt),
        ).toISOString(),
        publicationOutcome,
        ...(jobId.length === 0 ? {} : { jobId }),
        ...(workflowId.length === 0 ? {} : { workflowId }),
      }),
    });
  };

  return Object.freeze({
    loadGeneration,
    finalizeGeneration,
    loadCanonicalContactSources,
    inspectCanonicalBatchPreparation,
    convergeCanonicalBatchPreparation,
    activateGeneration,
    completeGenerationWithoutPublication,
    failGeneration,
    completeGenerationSupersession,
    loadCanonicalBatchPreparationRecovery,
  });
}
