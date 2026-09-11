import { createHash, randomUUID } from "node:crypto";

import { resolveDataForSeoProjectLocale } from "../adapters/dataforseo/project-locale.js";
import type { CommercialRecommendationNativeV2RequestPort } from "../application/services/commercial-recommendation-discovery.service.js";
import {
  createRecommendationPoolV2CandidateAdmissionService,
  type RecommendationPoolV2ArtifactObservation,
  type RecommendationPoolV2CandidateAdmissionResult,
} from "../application/services/recommendation-pool-v2-candidate-admission.service.js";
import {
  createRecommendationPoolV2DiscoveryFinalizer,
  type RecommendationPoolV2ProposedRound2Path,
} from "../application/services/recommendation-pool-v2-discovery-finalizer.service.js";
import type { RecommendationPoolV2DiscoveryRoundExecutor } from "../application/services/recommendation-pool-v2-generation.service.js";
import type { RecommendationPoolV2DiscoveryRoundResult } from "../application/services/recommendation-pool-v2-workflow.service.js";
import {
  commercialDiscoveryArtifactSchema,
  commercialDiscoveryCallSchema,
  fingerprintCommercialDiscoveryCall,
  fingerprintCommercialDiscoverySemanticRequest,
  parseCommercialDiscoveryRequestPayload,
  serializeCommercialDiscoveryRequestPayload,
  type CommercialDiscoveryCall,
} from "../domain/recommendations/commercial-discovery-source.js";
import { commercialSemanticDiscoveryPaidCallReserve } from "../domain/recommendations/provider-operation-budget.js";
import { createRecommendationDomainKey } from "../domain/recommendations/domain-key.js";
import {
  recommendationDiscoveryBudgetPolicyVersion,
  recommendationDiscoveryHardCandidateLimit,
  recommendationDiscoveryRoundBudgetMicros,
  recommendationDiscoverySupplyThreshold,
  recommendationPoolV2OperationalPolicy,
} from "../domain/recommendations/recommendation-pool-v2-policy.js";
import { createRecommendationPoolV2CandidateRepository } from "../db/repositories/recommendation-pool-v2-candidate.repository.js";
import {
  createRecommendationPoolV2DiscoveryLedgerRepository,
  type RecommendationDiscoveryGenerationLineage,
} from "../db/repositories/recommendation-pool-v2-discovery-ledger.repository.js";
import {
  createRecommendationPoolV2TimingRepository,
  createScopedRecommendationPoolV2TimingRecorder,
} from "../db/repositories/recommendation-pool-v2-timing.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../db/tenant-transaction.js";
import type { LocalProductDataForSeoRuntime } from "./local-product-dataforseo-runtime.js";

type ExecuteInput = Parameters<
  RecommendationPoolV2DiscoveryRoundExecutor["execute"]
>[0];

type ProviderSuccess = Readonly<{
  acquisitionMode: "LIVE_PROVIDER" | "EVIDENCE_REPLAY";
  sourceRequestOutcomeId: string | null;
  callFingerprint: string;
  authorizedCostMicros: number;
  rawCandidateCount: number;
  providerRequestId: string | null;
  providerBatchRequestId: string | null;
  providerUsageLedgerId: string | null;
  providerTaskId: string | null;
  actualCostMicros: number;
  finishedAt: string;
  intentId: string;
}>;

type ReusableProviderEvidence = Readonly<{
  outcomeId: string;
  requestFingerprint: string;
  rawCandidateCount: number;
  finishedAt: string;
  result: NonNullable<
    Awaited<
      ReturnType<CommercialRecommendationNativeV2RequestPort["prepareRequest"]>
    >["replayResult"]
  >;
}>;

type PersistedRequestCompletion = Readonly<{
  requestFingerprint: string;
  authorizedCostMicros: number;
  rawCandidateCount: number;
  effectiveCandidateCount: number;
  newUniqueCount: number;
  duplicateCount: number;
  actualCostMicros: number;
  finishedAt: string;
}>;

type DiscoveryProgress = Readonly<{
  completedRequestCount: number;
  nextWindowOrdinal: number;
  roundSettledAuthorizedCostMicros: number;
  rawObservationCount: number;
  candidateCount: number;
}>;

type PreparedRequest = Readonly<{
  seed: Awaited<ReturnType<typeof seedFacts>>;
  reusableEvidence: ReusableProviderEvidence | null;
  providerIdentity: ReturnType<
    typeof createRecommendationPoolV2ProviderIdentity
  >;
  canonicalRequestFingerprint: string;
  authorizedCostMicros: number;
  windowOrdinal: number;
  pageOrdinal: number;
}>;

type RequestIngestionCounts = Readonly<{
  rawCandidateCount: number;
  canonicalCandidateCount: number;
  newUniqueCount: number;
  duplicateCount: number;
  admittedCount: number;
  hardExcludedCount: number;
}>;

export function reconcileRecommendationPoolV2RequestIngestion(
  input: Readonly<{
    admissionResult: RecommendationPoolV2CandidateAdmissionResult | null;
    persistedFacts: RequestIngestionCounts;
    persistedCompletion: Pick<
      PersistedRequestCompletion,
      | "rawCandidateCount"
      | "effectiveCandidateCount"
      | "newUniqueCount"
      | "duplicateCount"
    > | null;
  }>,
): RequestIngestionCounts {
  const { admissionResult, persistedFacts, persistedCompletion } = input;
  if (
    admissionResult !== null &&
    (admissionResult.rawCandidateCount !== persistedFacts.rawCandidateCount ||
      admissionResult.canonicalCandidateCount !==
        persistedFacts.canonicalCandidateCount ||
      admissionResult.newUniqueCount !== persistedFacts.newUniqueCount ||
      admissionResult.duplicateCount !== persistedFacts.duplicateCount ||
      admissionResult.admittedCount !== persistedFacts.admittedCount ||
      admissionResult.hardExcludedCount !== persistedFacts.hardExcludedCount)
  ) {
    throw new Error(
      "RECOMMENDATION_POOL_V2_REQUEST_INGESTION_PERSISTENCE_CONFLICT",
    );
  }
  if (
    persistedCompletion !== null &&
    (persistedFacts.rawCandidateCount !==
      persistedCompletion.rawCandidateCount ||
      persistedFacts.canonicalCandidateCount !==
        persistedCompletion.effectiveCandidateCount ||
      persistedFacts.newUniqueCount !== persistedCompletion.newUniqueCount ||
      persistedFacts.duplicateCount !== persistedCompletion.duplicateCount)
  ) {
    throw new Error("RECOMMENDATION_POOL_V2_REQUEST_INGESTION_REPLAY_CONFLICT");
  }
  if (admissionResult === null) return persistedFacts;
  return Object.freeze({
    rawCandidateCount: admissionResult.rawCandidateCount,
    canonicalCandidateCount: admissionResult.canonicalCandidateCount,
    newUniqueCount: admissionResult.newUniqueCount,
    duplicateCount: admissionResult.duplicateCount,
    admittedCount: admissionResult.admittedCount,
    hardExcludedCount: admissionResult.hardExcludedCount,
  });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function semanticUuid(namespace: string, value: unknown): string {
  const digest = hash({ namespace, value });
  const variants = ["8", "9", "a", "b"] as const;
  const variant = variants[Number.parseInt(digest.charAt(16), 16) % 4] ?? "8";
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(
    13,
    16,
  )}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function createRecommendationPoolV2ProviderIdentity(
  input: Readonly<{
    lineage: RecommendationDiscoveryGenerationLineage;
    requestFingerprint: string;
  }>,
) {
  const intentId = semanticUuid("recommendation-v2-intent", input);
  return Object.freeze({
    intentId,
    requestId: intentId,
    budgetReservationId: intentId,
    actorId: intentId,
  });
}

export function recommendationPoolV2DiscoveryWindowOrdinal(
  round: 1 | 2,
  requestOrdinal: number,
): number {
  if (
    !Number.isSafeInteger(requestOrdinal) ||
    requestOrdinal < 1 ||
    requestOrdinal > commercialSemanticDiscoveryPaidCallReserve
  ) {
    throw new TypeError(
      "Recommendation V2 discovery request ordinal is invalid.",
    );
  }
  return (
    (round - 1) * commercialSemanticDiscoveryPaidCallReserve + requestOrdinal
  );
}

function tenantScope(input: ExecuteInput) {
  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
  };
}

function canonicalPathFingerprint(
  input: ExecuteInput,
  round: 1 | 2,
  call: CommercialDiscoveryCall,
): string {
  return hash({
    generationContractId: input.generationContractId,
    round,
    call,
  });
}

async function queryOne(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  text: string,
  values: readonly unknown[],
): Promise<Record<string, unknown>> {
  return withBacklinkTenantTransaction(
    pool,
    tenantScope(input),
    async (client) => {
      const result = await client.query(text, values);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("RECOMMENDATION_POOL_V2_LINEAGE_NOT_FOUND");
      }
      return row;
    },
  );
}

export function recommendationPoolV2CompletedSemanticRequestFingerprint(
  input: Readonly<{
    discoverySource: string;
    requestType: string;
    requestPayload: unknown;
    responseSchemaVersion: string;
  }>,
): string {
  const persisted = parseCommercialDiscoveryRequestPayload(
    input.requestPayload,
  );
  const call = commercialDiscoveryCallSchema.parse({
    endpoint: input.requestType,
    intent: "DISCOVERY",
    sourceType: input.discoverySource,
    request: persisted.request,
    ...(persisted.plannerLineage === undefined
      ? {}
      : { plannerLineage: persisted.plannerLineage }),
    responseSchemaVersion: input.responseSchemaVersion,
    estimatedCostMicros: 1,
  });
  return fingerprintCommercialDiscoverySemanticRequest(call);
}

async function completedSemanticRequestFingerprints(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
): Promise<readonly string[]> {
  return withBacklinkTenantTransaction(
    pool,
    tenantScope(input),
    async (client) => {
      const result = await client.query(
        `SELECT DISTINCT history."discoverySource",
                         history."requestType",
                         history."requestPayload",
                         history."responseSchemaVersion"
           FROM (
             SELECT intent.discovery_source AS "discoverySource",
                    intent.request_type AS "requestType",
                    provider_request.request_payload AS "requestPayload",
                    provider_batch.response_schema_version
                      AS "responseSchemaVersion"
               FROM backlinks.backlink_recommendation_discovery_request_intents
                      AS intent
               JOIN backlinks.backlink_recommendation_discovery_request_outcomes
                      AS outcome
                 ON (outcome.organization_id,outcome.workspace_id,
                     outcome.website_project_id,outcome.request_intent_id)=
                    (intent.organization_id,intent.workspace_id,
                     intent.website_project_id,intent.id)
               JOIN backlinks.backlink_provider_requests AS provider_request
                 ON (provider_request.organization_id,
                     provider_request.workspace_id,
                     provider_request.website_project_id,
                     provider_request.id)=
                    (outcome.organization_id,outcome.workspace_id,
                     outcome.website_project_id,outcome.provider_request_id)
               JOIN backlinks.provider_batch_requests AS provider_batch
                 ON (provider_batch.organization_id,
                     provider_batch.workspace_id,
                     provider_batch.website_project_id,
                     provider_batch.id)=
                    (outcome.organization_id,outcome.workspace_id,
                     outcome.website_project_id,
                     outcome.provider_batch_request_id)
              WHERE intent.organization_id=$1
                AND intent.workspace_id=$2
                AND intent.website_project_id=$3
                AND intent.recommendation_context_version_id=$4
                AND intent.generation_contract_id<>$5
                AND intent.pool_contract_version='recommendation-pool.v2'
                AND intent.discovery_source='BLUEPRINT_SERP_STANDARD_QUEUE'
                AND outcome.acquisition_mode='LIVE_PROVIDER'
                AND outcome.status IN ('SUCCEEDED','PARTIAL')
                AND outcome.charge_state='SETTLED'
                AND provider_request.provider='dataforseo'
                AND provider_request.status='succeeded'
                AND provider_batch.provider='dataforseo'
                AND provider_batch.status IN ('succeeded','partial')
             UNION ALL
             SELECT 'BLUEPRINT_SERP_STANDARD_QUEUE' AS "discoverySource",
                    provider_batch.endpoint AS "requestType",
                    provider_request.request_payload AS "requestPayload",
                    provider_batch.response_schema_version
                      AS "responseSchemaVersion"
               FROM backlinks.provider_fetch_leases AS lease
               JOIN backlinks.provider_batch_requests AS provider_batch
                 ON provider_batch.normalized_request_hash=
                      lease.artifact_fingerprint
                AND provider_batch.request_id=lease.owner_request_id
               JOIN backlinks.backlink_provider_requests AS provider_request
                 ON (provider_request.organization_id,
                     provider_request.workspace_id,
                     provider_request.website_project_id,
                     provider_request.id)=
                    (provider_batch.organization_id,
                     provider_batch.workspace_id,
                     provider_batch.website_project_id,
                     provider_batch.id)
              WHERE provider_batch.organization_id=$1
                AND provider_batch.workspace_id=$2
                AND provider_batch.website_project_id=$3
                AND provider_batch.provider='dataforseo'
                AND provider_batch.request_intent='DISCOVERY'
                AND provider_batch.endpoint=
                      '/v3/serp/google/organic/task_post'
                AND (
                  lease.artifact_fingerprint !~ '^[a-f0-9]{64}$'
                  OR (
                    NOT EXISTS (
                      SELECT 1
                        FROM backlinks.backlink_jobs AS lease_job
                       WHERE lease_job.id::text=lease.owner_request_id
                         AND lease_job.job_type='project-analysis'
                         AND lease_job.source_object_type=
                               'project-context-snapshot'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM backlinks
                               .backlink_recommendation_discovery_request_intents
                               AS lease_intent
                       WHERE lease_intent.pool_contract_version=
                               'recommendation-pool.v2'
                         AND lease_intent.canonical_request_fingerprint=
                               lease.artifact_fingerprint
                         AND lease.owner_request_id IN (
                           lease_intent.id::text,
                           lease_intent.idempotency_key
                         )
                    )
                  )
                )
           ) AS history`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.recommendationContextVersionId,
          input.generationContractId,
        ],
      );
      return Object.freeze(
        [
          ...new Set(
            result.rows.map((row) =>
              recommendationPoolV2CompletedSemanticRequestFingerprint({
                discoverySource: String(row.discoverySource),
                requestType: String(row.requestType),
                requestPayload: row.requestPayload,
                responseSchemaVersion: String(row.responseSchemaVersion),
              }),
            ),
          ),
        ].sort(),
      );
    },
  );
}

async function settledGenerationCostMicros(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  excludedRequestIntentId: string,
): Promise<number> {
  const row = await queryOne(
    pool,
    input,
    `SELECT coalesce(sum(actual_cost_micros),0)::bigint
              AS "settledCostMicros"
       FROM backlinks.backlink_recommendation_discovery_request_outcomes
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND generation_contract_id=$4
        AND request_intent_id<>$5
        AND charge_state='SETTLED'`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.generationContractId,
      excludedRequestIntentId,
    ],
  );
  return Number(row.settledCostMicros);
}

async function generationFacts(pool: BacklinkTenantPool, input: ExecuteInput) {
  const row = await queryOne(
    pool,
    input,
    `SELECT context.canonical_domain "canonicalDomain",
            context.country_code "countryCode",
            context.locale "languageCode",
            pin.immutable_fingerprint "businessDirectionFingerprint",
            binding.authoritative_blueprint_id "authoritativeBlueprintId",
            generation.created_at "startedAt"
       FROM backlinks.backlink_recommendation_generation_contracts generation
       JOIN backlinks.backlink_project_context_snapshots context
         ON (context.organization_id,context.workspace_id,
             context.website_project_id,context.id)=
            (generation.organization_id,generation.workspace_id,
             generation.website_project_id,
             generation.recommendation_context_version_id)
       JOIN backlinks.backlink_generation_input_pins pin
         ON (pin.organization_id,pin.workspace_id,
             pin.website_project_id,pin.id)=
            (generation.organization_id,generation.workspace_id,
             generation.website_project_id,generation.input_pin_id)
       JOIN LATERAL (
         SELECT min(assignment.blueprint_id::text)::uuid
                  AS authoritative_blueprint_id
           FROM backlinks.backlink_commercial_blueprint_seeds assignment
           JOIN backlinks.backlink_commercial_discovery_blueprints blueprint
             ON (blueprint.organization_id,blueprint.workspace_id,
                 blueprint.website_project_id,blueprint.id)=
                (assignment.organization_id,assignment.workspace_id,
                 assignment.website_project_id,assignment.blueprint_id)
          WHERE assignment.organization_id=generation.organization_id
            AND assignment.workspace_id=generation.workspace_id
            AND assignment.website_project_id=generation.website_project_id
            AND assignment.generation_contract_id=generation.id
            AND assignment.recommendation_context_version_id=
                generation.recommendation_context_version_id
            AND assignment.visible_pool_generation=
                generation.visible_pool_generation
            AND blueprint.project_context_version_id=
                generation.recommendation_context_version_id
            AND blueprint.status='active'
            AND blueprint.generator='DETERMINISTIC_FALLBACK'
            AND blueprint.schema_version='recommendation-blueprint.v2'
            AND blueprint.prompt_version='recommendation-seed.v2'
            AND blueprint.model_version IS NULL
            AND blueprint.rule_version='recommendation-discovery.v2'
            AND blueprint.seed_snapshot_fingerprint IS NOT NULL
            AND blueprint.blueprint->>'contractVersion'=
                'recommendation-blueprint.v2'
            AND blueprint.blueprint->>'generationContractId'=
                generation.id::text
            AND blueprint.blueprint->>'recommendationContextVersionId'=
                generation.recommendation_context_version_id::text
            AND blueprint.blueprint->>'visiblePoolGeneration'=
                generation.visible_pool_generation::text
            AND blueprint.blueprint->>'inputPinId'=
                generation.input_pin_id::text
            AND blueprint.blueprint->>'seedSnapshotFingerprint'=
                blueprint.seed_snapshot_fingerprint
            AND jsonb_typeof(blueprint.blueprint->'seeds')='array'
            AND jsonb_array_length(blueprint.blueprint->'seeds')>0
         HAVING count(DISTINCT assignment.blueprint_id)=1
       ) binding ON true
      WHERE generation.organization_id=$1 AND generation.workspace_id=$2
        AND generation.website_project_id=$3 AND generation.id=$4
        AND generation.recommendation_context_version_id=$5
        AND generation.visible_pool_generation=$6
        AND generation.input_pin_id=$7
        AND generation.pool_contract_version='recommendation-pool.v2'
        AND generation.discovery_budget_policy_version=$8
        AND generation.discovery_completed_at IS NULL`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.generationContractId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
      input.inputPinId,
      recommendationDiscoveryBudgetPolicyVersion,
    ],
  );
  const providerLocale = resolveDataForSeoProjectLocale({
    countryCode: String(row.countryCode),
    locale: String(row.languageCode),
  });
  return Object.freeze({
    canonicalDomain: String(row.canonicalDomain),
    countryCode: providerLocale.countryCode,
    languageCode: providerLocale.languageCode,
    businessDirectionFingerprint: String(row.businessDirectionFingerprint),
    authoritativeBlueprintId: String(row.authoritativeBlueprintId),
    startedAt: new Date(String(row.startedAt)).toISOString(),
  });
}

async function generationSeedRows(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  blueprintId: string | undefined,
) {
  return withBacklinkTenantTransaction(
    pool,
    tenantScope(input),
    async (client) => {
      const result = await client.query(
        `SELECT seed.id,seed.seed_fingerprint "fingerprint",
                seed.seed_kind "kind",seed.source,
                seed.normalized_value "normalizedValue",
                seed.validation_status "validationStatus"
           FROM backlinks.backlink_commercial_discovery_seeds seed
           LEFT JOIN backlinks.backlink_commercial_blueprint_seeds assignment
             ON assignment.organization_id=seed.organization_id
            AND assignment.workspace_id=seed.workspace_id
            AND assignment.website_project_id=seed.website_project_id
            AND assignment.seed_id=seed.id
            AND assignment.generation_contract_id=seed.generation_contract_id
          WHERE seed.organization_id=$1 AND seed.workspace_id=$2
            AND seed.website_project_id=$3
            AND seed.generation_contract_id=$4
            AND seed.recommendation_context_version_id=$5
            AND seed.visible_pool_generation=$6 AND seed.input_pin_id=$7
            AND seed.validation_status
                  IN ('VERIFIED','RETAINED_LOW_CONFIDENCE')
            AND ($8::uuid IS NULL OR assignment.blueprint_id=$8)
          ORDER BY assignment.seed_ordinal NULLS LAST,seed.created_at,seed.id`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.generationContractId,
          input.recommendationContextVersionId,
          input.visiblePoolGeneration,
          input.inputPinId,
          blueprintId ?? null,
        ],
      );
      return result.rows;
    },
  );
}

async function seedFacts(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  blueprintId: string | undefined,
  requestOrdinal: number,
  call?: CommercialDiscoveryCall,
) {
  const rows = await generationSeedRows(pool, input, blueprintId);
  if (rows.length === 0) {
    throw new Error("RECOMMENDATION_POOL_V2_LINEAGE_NOT_FOUND");
  }
  const row = call?.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS"
    ? rows.find((seed) =>
        seed.kind === "SEO_COMPETITOR"
        && seed.validationStatus === "VERIFIED"
        && createRecommendationDomainKey(String(seed.normalizedValue)).registrableDomain
          === call.request.target)
    : rows[requestOrdinal % rows.length];
  if (row === undefined) {
    throw new Error("RECOMMENDATION_POOL_V2_LINEAGE_NOT_FOUND");
  }
  return Object.freeze({
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    kind: String(row.kind) as "KEYWORD" | "CATEGORY" | "SEO_COMPETITOR",
    source: String(row.source) as
      | "USER_INPUT"
      | "USER_TRIGGERED_GENERATION"
      | "SYSTEM_FALLBACK"
      | "SYSTEM_SUPPLEMENT",
  });
}

function seedDimensions(seed: Awaited<ReturnType<typeof seedFacts>>): Readonly<{
  keywordFingerprint: string;
  competitorFingerprint: string;
}> {
  return seed.kind === "SEO_COMPETITOR"
    ? Object.freeze({
        keywordFingerprint: "seed-dimension:not-applicable",
        competitorFingerprint: seed.fingerprint,
      })
    : Object.freeze({
        keywordFingerprint: seed.fingerprint,
        competitorFingerprint: "seed-dimension:not-applicable",
      });
}

async function providerFinishedAt(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  providerBatchRequestId: string,
): Promise<string> {
  const row = await queryOne(
    pool,
    input,
    `SELECT finished_at "finishedAt"
       FROM backlinks.provider_batch_requests
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4 AND status='succeeded'`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      providerBatchRequestId,
    ],
  );
  return new Date(String(row.finishedAt)).toISOString();
}

async function reusableProviderEvidence(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  request: Readonly<{
    requestPayload: Readonly<Record<string, unknown>>;
    discoverySource: string;
    requestType: string;
    pageType: string;
    countryCode: string;
    languageCode: string;
    businessDirectionFingerprint: string;
    responseSchemaVersion: string;
  }>,
): Promise<ReusableProviderEvidence | null> {
  return withBacklinkTenantTransaction(
    pool,
    tenantScope(input),
    async (client) => {
      const result = await client.query(
        `SELECT outcome.id AS "outcomeId",
                outcome.raw_candidate_count AS "rawCandidateCount",
                outcome.finished_at AS "finishedAt",
                provider_request.request_fingerprint AS "requestFingerprint",
                artifact.normalized_payload AS "normalizedPayload"
           FROM backlinks.backlink_recommendation_discovery_request_outcomes
                  AS outcome
           JOIN backlinks.backlink_recommendation_discovery_request_intents
                  AS intent
             ON (intent.organization_id,intent.workspace_id,
                 intent.website_project_id,intent.id)=
                (outcome.organization_id,outcome.workspace_id,
                 outcome.website_project_id,outcome.request_intent_id)
           JOIN backlinks.backlink_provider_requests AS provider_request
             ON (provider_request.organization_id,
                 provider_request.workspace_id,
                 provider_request.website_project_id,
                 provider_request.id)=
                (outcome.organization_id,outcome.workspace_id,
                 outcome.website_project_id,outcome.provider_request_id)
           JOIN backlinks.backlink_commercial_discovery_artifacts AS artifact
             ON artifact.organization_id=outcome.organization_id
            AND artifact.workspace_id=outcome.workspace_id
            AND artifact.website_project_id=outcome.website_project_id
            AND artifact.project_context_version_id=$4
            AND artifact.request_fingerprint=
                  provider_request.request_fingerprint
            AND artifact.response_schema_version=$12
            AND artifact.stale_until>now()
          WHERE outcome.organization_id=$1
            AND outcome.workspace_id=$2
            AND outcome.website_project_id=$3
            AND outcome.generation_contract_id<>$13
            AND outcome.acquisition_mode='LIVE_PROVIDER'
            AND outcome.charge_state='SETTLED'
            AND outcome.status IN ('SUCCEEDED','PARTIAL')
            AND provider_request.provider='dataforseo'
            AND provider_request.status='succeeded'
            AND provider_request.request_payload=$5::jsonb
            AND intent.discovery_source=$6
            AND intent.request_type=$7
            AND intent.page_type=$8
            AND intent.country_code=$9
            AND intent.language_code=$10
            AND intent.business_direction_fingerprint=$11
          ORDER BY outcome.finished_at DESC,outcome.id DESC
          LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.recommendationContextVersionId,
          JSON.stringify(request.requestPayload),
          request.discoverySource,
          request.requestType,
          request.pageType,
          request.countryCode,
          request.languageCode,
          request.businessDirectionFingerprint,
          request.responseSchemaVersion,
          input.generationContractId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return Object.freeze({
        outcomeId: String(row.outcomeId),
        requestFingerprint: String(row.requestFingerprint),
        rawCandidateCount: Number(row.rawCandidateCount),
        finishedAt: new Date(String(row.finishedAt)).toISOString(),
        result: Object.freeze({
          source: "cache" as const,
          artifact: commercialDiscoveryArtifactSchema.parse(
            row.normalizedPayload,
          ),
        }),
      });
    },
  );
}

async function persistedRequestCompletion(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  requestIntentId: string,
): Promise<PersistedRequestCompletion | null> {
  return withBacklinkTenantTransaction(
    pool,
    tenantScope(input),
    async (client) => {
      const result = await client.query(
        `SELECT intent.canonical_request_fingerprint
                  AS "requestFingerprint",
                intent.authorized_cost_micros AS "authorizedCostMicros",
                outcome.raw_candidate_count AS "rawCandidateCount",
                outcome.effective_candidate_count
                  AS "effectiveCandidateCount",
                outcome.new_unique_count AS "newUniqueCount",
                outcome.duplicate_count AS "duplicateCount",
                outcome.actual_cost_micros AS "actualCostMicros",
                outcome.finished_at AS "finishedAt"
           FROM backlinks.backlink_recommendation_discovery_request_intents
                  AS intent
           JOIN backlinks.backlink_recommendation_discovery_request_outcomes
                  AS outcome
             ON (outcome.organization_id,outcome.workspace_id,
                 outcome.website_project_id,outcome.request_intent_id)=
                (intent.organization_id,intent.workspace_id,
                 intent.website_project_id,intent.id)
          WHERE intent.organization_id=$1
            AND intent.workspace_id=$2
            AND intent.website_project_id=$3
            AND intent.generation_contract_id=$4
            AND intent.id=$5
            AND outcome.charge_state='SETTLED'
            AND outcome.status IN ('SUCCEEDED','PARTIAL')
          LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.generationContractId,
          requestIntentId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return Object.freeze({
        requestFingerprint: String(row.requestFingerprint),
        authorizedCostMicros: Number(row.authorizedCostMicros),
        rawCandidateCount: Number(row.rawCandidateCount),
        effectiveCandidateCount: Number(row.effectiveCandidateCount),
        newUniqueCount: Number(row.newUniqueCount),
        duplicateCount: Number(row.duplicateCount),
        actualCostMicros: Number(row.actualCostMicros),
        finishedAt: new Date(String(row.finishedAt)).toISOString(),
      });
    },
  );
}

async function nativeCandidateCountThroughRound(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
): Promise<number> {
  const row = await queryOne(
    pool,
    input,
    `SELECT count(*)::integer "candidateCount"
       FROM backlinks.backlink_recommendation_generation_candidates candidate
       JOIN backlinks.backlink_recommendation_discovery_request_intents
              first_intent
         ON (first_intent.organization_id,first_intent.workspace_id,
             first_intent.website_project_id,first_intent.id::text)=
            (candidate.organization_id,candidate.workspace_id,
             candidate.website_project_id,candidate.first_seen_request_intent)
      WHERE candidate.organization_id=$1 AND candidate.workspace_id=$2
        AND candidate.website_project_id=$3
        AND candidate.recommendation_context_version_id=$4
        AND candidate.visible_pool_generation=$5
        AND candidate.generation_contract_id=$6
        AND candidate.input_pin_id=$7
        AND first_intent.generation_contract_id=$6
        AND first_intent.round_number<=$8
        AND candidate.pool_contract_version='recommendation-pool.v2'
        AND candidate.admission_contract_version=
              'recommendation-pool-admission.v2'
        AND candidate.admission_state='ADMITTED'`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
      input.generationContractId,
      input.inputPinId,
      input.round,
    ],
  );
  return Number(row.candidateCount);
}

async function discoveryProgress(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
): Promise<DiscoveryProgress> {
  const row = await queryOne(
    pool,
    input,
    `SELECT
       (
         SELECT coalesce(sum(window_fact.completed_request_count),0)::integer
           FROM backlinks.backlink_recommendation_discovery_window_facts
                  window_fact
          WHERE window_fact.organization_id=$1
            AND window_fact.workspace_id=$2
            AND window_fact.website_project_id=$3
            AND window_fact.generation_contract_id=$4
       ) AS "completedRequestCount",
       (
         SELECT coalesce(max(window_fact.window_ordinal),0)::integer + 1
           FROM backlinks.backlink_recommendation_discovery_window_facts
                  window_fact
          WHERE window_fact.organization_id=$1
            AND window_fact.workspace_id=$2
            AND window_fact.website_project_id=$3
            AND window_fact.generation_contract_id=$4
       ) AS "nextWindowOrdinal",
       (
         SELECT coalesce(sum(intent.authorized_cost_micros),0)::bigint
           FROM backlinks
                  .backlink_recommendation_discovery_request_intents intent
           JOIN backlinks
                  .backlink_recommendation_discovery_request_outcomes outcome
             ON (outcome.organization_id,outcome.workspace_id,
                 outcome.website_project_id,outcome.request_intent_id)=
                (intent.organization_id,intent.workspace_id,
                 intent.website_project_id,intent.id)
          WHERE intent.organization_id=$1 AND intent.workspace_id=$2
            AND intent.website_project_id=$3
            AND intent.generation_contract_id=$4
            AND intent.round_number=$8
            AND outcome.charge_state='SETTLED'
            AND outcome.status IN ('SUCCEEDED','PARTIAL')
       ) AS "roundSettledAuthorizedCostMicros",
       (
         SELECT coalesce(sum(outcome.raw_candidate_count),0)::bigint
           FROM backlinks
                  .backlink_recommendation_discovery_request_outcomes outcome
          WHERE outcome.organization_id=$1 AND outcome.workspace_id=$2
            AND outcome.website_project_id=$3
            AND outcome.generation_contract_id=$4
            AND outcome.charge_state='SETTLED'
            AND outcome.status IN ('SUCCEEDED','PARTIAL')
       ) AS "rawObservationCount",
       (
         SELECT count(*)::integer
           FROM backlinks
                  .backlink_recommendation_generation_candidates candidate
          WHERE candidate.organization_id=$1 AND candidate.workspace_id=$2
            AND candidate.website_project_id=$3
            AND candidate.recommendation_context_version_id=$5
            AND candidate.visible_pool_generation=$6
            AND candidate.generation_contract_id=$4
            AND candidate.input_pin_id=$7
            AND candidate.pool_contract_version='recommendation-pool.v2'
            AND candidate.admission_contract_version=
                  'recommendation-pool-admission.v2'
            AND candidate.admission_state='ADMITTED'
       ) AS "candidateCount"`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.generationContractId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
      input.inputPinId,
      input.round,
    ],
  );
  return Object.freeze({
    completedRequestCount: Number(row.completedRequestCount),
    nextWindowOrdinal: Number(row.nextWindowOrdinal),
    roundSettledAuthorizedCostMicros: Number(
      row.roundSettledAuthorizedCostMicros,
    ),
    rawObservationCount: Number(row.rawObservationCount),
    candidateCount: Number(row.candidateCount),
  });
}

async function requestIngestionCounts(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
  requestIntentId: string,
): Promise<RequestIngestionCounts> {
  const row = await queryOne(
    pool,
    input,
    `SELECT
       count(source.id)::integer AS "rawCandidateCount",
       count(DISTINCT source.generation_candidate_id)::integer
         AS "canonicalCandidateCount",
       count(DISTINCT source.generation_candidate_id)
         FILTER (
           WHERE candidate.first_seen_request_intent=$8
         )::integer AS "newUniqueCount",
       count(DISTINCT source.generation_candidate_id)
          FILTER (WHERE candidate.admission_state='ADMITTED')::integer
            AS "admittedCount",
       count(DISTINCT source.generation_candidate_id)
         FILTER (WHERE candidate.admission_state='EXCLUDED')::integer
           AS "hardExcludedCount"
       FROM backlinks.backlink_recommendation_generation_candidate_sources
              source
       JOIN backlinks.backlink_recommendation_generation_candidates candidate
         ON (candidate.organization_id,candidate.workspace_id,
             candidate.website_project_id,candidate.id)=
            (source.organization_id,source.workspace_id,
             source.website_project_id,source.generation_candidate_id)
       WHERE source.organization_id=$1 AND source.workspace_id=$2
         AND source.website_project_id=$3
         AND candidate.generation_contract_id=$4
         AND candidate.recommendation_context_version_id=$5
         AND candidate.visible_pool_generation=$6
         AND candidate.input_pin_id=$7
         AND source.request_intent=$8`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.generationContractId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
      input.inputPinId,
      requestIntentId,
    ],
  );
  const rawCandidateCount = Number(row.rawCandidateCount);
  const canonicalCandidateCount = Number(row.canonicalCandidateCount);
  const newUniqueCount = Number(row.newUniqueCount);
  return Object.freeze({
    rawCandidateCount,
    canonicalCandidateCount,
    newUniqueCount,
    duplicateCount: canonicalCandidateCount - newUniqueCount,
    admittedCount: Number(row.admittedCount),
    hardExcludedCount: Number(row.hardExcludedCount),
  });
}

async function completedRoundWindows(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
) {
  return withBacklinkTenantTransaction(
    pool,
    tenantScope(input),
    async (client) => {
      const result = await client.query(
        `SELECT window_fact.raw_candidate_count AS "rawCandidateCount",
                window_fact.effective_candidate_count
                  AS "canonicalCandidateCount",
                window_fact.new_unique_count AS "newUniqueCount",
                count(DISTINCT candidate.id)
                  FILTER (WHERE candidate.admission_state='ADMITTED')::integer
                    AS "admittedCount",
                count(DISTINCT candidate.id)
                  FILTER (WHERE candidate.admission_state='EXCLUDED')::integer
                    AS "hardExcludedCount"
           FROM backlinks.backlink_recommendation_discovery_window_facts
                  window_fact
           LEFT JOIN
                backlinks.backlink_recommendation_discovery_request_intents
                  intent
             ON intent.organization_id=window_fact.organization_id
            AND intent.workspace_id=window_fact.workspace_id
            AND intent.website_project_id=window_fact.website_project_id
            AND intent.generation_contract_id=window_fact.generation_contract_id
            AND intent.round_number=window_fact.round_number
            AND intent.discovery_window_ordinal=window_fact.window_ordinal
           LEFT JOIN
                backlinks.backlink_recommendation_generation_candidate_sources
                  source
             ON source.organization_id=intent.organization_id
            AND source.workspace_id=intent.workspace_id
            AND source.website_project_id=intent.website_project_id
            AND source.request_intent=intent.id::text
           LEFT JOIN backlinks.backlink_recommendation_generation_candidates
                  candidate
             ON candidate.organization_id=source.organization_id
            AND candidate.workspace_id=source.workspace_id
            AND candidate.website_project_id=source.website_project_id
            AND candidate.id=source.generation_candidate_id
          WHERE window_fact.organization_id=$1
            AND window_fact.workspace_id=$2
            AND window_fact.website_project_id=$3
            AND window_fact.generation_contract_id=$4
            AND window_fact.round_number=$5
          GROUP BY window_fact.window_ordinal,
                   window_fact.raw_candidate_count,
                   window_fact.effective_candidate_count,
                   window_fact.new_unique_count
          ORDER BY window_fact.window_ordinal`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.generationContractId,
          input.round,
        ],
      );
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            completed: true,
            rawCandidateCount: Number(row.rawCandidateCount),
            canonicalCandidateCount: Number(row.canonicalCandidateCount),
            newUniqueCount: Number(row.newUniqueCount),
            admittedCount: Number(row.admittedCount),
            hardExcludedCount: Number(row.hardExcludedCount),
          }),
        ),
      );
    },
  );
}

async function completedRoundReplay(
  pool: BacklinkTenantPool,
  input: ExecuteInput,
): Promise<RecommendationPoolV2DiscoveryRoundResult | null> {
  const roundFact = await withBacklinkTenantTransaction(
    pool,
    tenantScope(input),
    async (client) => {
      const result = await client.query(
        `SELECT fact.completed_window_count AS "completedWindowCount",
                fact.completed_request_count AS "completedRequestCount",
                fact.raw_candidate_count AS "rawCandidateCount",
                fact.effective_candidate_count AS "effectiveCandidateCount",
                fact.new_unique_count AS "newUniqueCount",
                fact.duplicate_count AS "duplicateCount",
                fact.round_settled_cost_micros AS "roundSettledCostMicros",
                fact.charge_state AS "chargeState",
                fact.paths_exhausted AS "pathsExhausted"
           FROM backlinks.backlink_recommendation_discovery_round_facts fact
          WHERE fact.organization_id=$1 AND fact.workspace_id=$2
            AND fact.website_project_id=$3
            AND fact.generation_contract_id=$4
            AND fact.recommendation_context_version_id=$5
            AND fact.visible_pool_generation=$6
            AND fact.input_pin_id=$7
            AND fact.discovery_budget_policy_version=$8
            AND fact.round_number=$9`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.generationContractId,
          input.recommendationContextVersionId,
          input.visiblePoolGeneration,
          input.inputPinId,
          recommendationDiscoveryBudgetPolicyVersion,
          input.round,
        ],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) {
        throw new Error(
          "RECOMMENDATION_POOL_V2_DISCOVERY_ROUND_REPLAY_CONFLICT",
        );
      }
      return result.rows[0] ?? null;
    },
  );
  if (roundFact === null) return null;

  const completedWindowCount = Number(roundFact.completedWindowCount);
  const completedRequestCount = Number(roundFact.completedRequestCount);
  const rawCandidateCount = Number(roundFact.rawCandidateCount);
  const effectiveCandidateCount = Number(roundFact.effectiveCandidateCount);
  const newUniqueCount = Number(roundFact.newUniqueCount);
  const duplicateCount = Number(roundFact.duplicateCount);
  const chargeState = String(roundFact.chargeState);
  const pathsExhausted = roundFact.pathsExhausted;
  const persistedCost = roundFact.roundSettledCostMicros;
  const costMicros = persistedCost === null ? null : Number(persistedCost);
  const counts = [
    completedWindowCount,
    completedRequestCount,
    rawCandidateCount,
    effectiveCandidateCount,
    newUniqueCount,
    duplicateCount,
  ];
  if (
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    completedRequestCount === 0 ||
    typeof pathsExhausted !== "boolean" ||
    (chargeState !== "SETTLED" && chargeState !== "UNKNOWN_CHARGE") ||
    (chargeState === "SETTLED" &&
      (costMicros === null ||
        !Number.isSafeInteger(costMicros) ||
        costMicros < 0)) ||
    (chargeState === "UNKNOWN_CHARGE" && costMicros !== null)
  ) {
    throw new Error("RECOMMENDATION_POOL_V2_DISCOVERY_ROUND_REPLAY_CONFLICT");
  }

  const completedWindows = await completedRoundWindows(pool, input);
  const windowRawCandidateCount = completedWindows.reduce(
    (total, window) => total + window.rawCandidateCount,
    0,
  );
  const windowEffectiveCandidateCount = completedWindows.reduce(
    (total, window) => total + window.canonicalCandidateCount,
    0,
  );
  const windowNewUniqueCount = completedWindows.reduce(
    (total, window) => total + window.newUniqueCount,
    0,
  );
  if (
    completedWindows.length !== completedWindowCount ||
    windowRawCandidateCount !== rawCandidateCount ||
    windowEffectiveCandidateCount !== effectiveCandidateCount ||
    windowNewUniqueCount !== newUniqueCount ||
    windowEffectiveCandidateCount - windowNewUniqueCount !== duplicateCount
  ) {
    throw new Error("RECOMMENDATION_POOL_V2_DISCOVERY_ROUND_REPLAY_CONFLICT");
  }

  return Object.freeze({
    round: input.round,
    requestFingerprint: input.requestFingerprint,
    chargeState:
      chargeState === "SETTLED"
        ? ("settled" as const)
        : ("unknown_charge" as const),
    costMicros,
    totalUniqueCandidateCount: await nativeCandidateCountThroughRound(
      pool,
      input,
    ),
    pathsExhausted,
    completedWindows,
  });
}

export function createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor(
  dependencies: Readonly<{
    pool: BacklinkTenantPool;
    runtime: LocalProductDataForSeoRuntime | null;
  }>,
): RecommendationPoolV2DiscoveryRoundExecutor {
  return Object.freeze({
    async execute(input) {
      const completed = await completedRoundReplay(dependencies.pool, input);
      if (completed !== null) return completed;
      if (dependencies.runtime === null) {
        throw new Error("RECOMMENDATION_POOL_V2_DATAFORSEO_INPUT_REQUIRED");
      }
      const generation = await generationFacts(dependencies.pool, input);
      const executionAttemptId = randomUUID();
      const timing = createScopedRecommendationPoolV2TimingRecorder(
        dependencies.pool,
      );
      const recordTiming = (
        event: Omit<
          Parameters<typeof timing.record>[0],
          | "organizationId"
          | "workspaceId"
          | "websiteProjectId"
          | "generationContractId"
          | "jobId"
          | "actorId"
        >,
      ) =>
        timing.record({
          ...tenantScope(input),
          generationContractId: input.generationContractId,
          jobId: input.jobId,
          actorId: input.actorId,
          ...event,
        });
      const ledger = createRecommendationPoolV2DiscoveryLedgerRepository(
        dependencies.pool,
      );
      const lineage: RecommendationDiscoveryGenerationLineage = Object.freeze({
        ...tenantScope(input),
        generationContractId: input.generationContractId,
        recommendationContextVersionId: input.recommendationContextVersionId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        inputPinId: input.inputPinId,
        discoveryBudgetPolicyVersion:
          recommendationDiscoveryBudgetPolicyVersion,
      });
      const progress = await discoveryProgress(dependencies.pool, input);
      const maximumRequestCount =
        recommendationPoolV2OperationalPolicy.discovery.maximumPaidRequests;
      const remainingRequestCount = Math.max(
        0,
        maximumRequestCount - progress.completedRequestCount,
      );
      const remainingRoundCostMicros = Math.max(
        0,
        Math.min(
          input.maxCostMicros,
          recommendationDiscoveryRoundBudgetMicros,
        ) - progress.roundSettledAuthorizedCostMicros,
      );
      const initialStopReached =
        progress.candidateCount >= recommendationDiscoverySupplyThreshold ||
        progress.candidateCount >= recommendationDiscoveryHardCandidateLimit ||
        progress.rawObservationCount >=
          recommendationPoolV2OperationalPolicy.discovery.rawObservationLimit ||
        remainingRequestCount === 0;
      const preparedRequests = new Map<number, PreparedRequest>();
      let proposedRound2Path: RecommendationPoolV2ProposedRound2Path | null =
        null;
      const excludedSemanticRequestFingerprints =
        await completedSemanticRequestFingerprints(dependencies.pool, input);
      const requestPort: CommercialRecommendationNativeV2RequestPort =
        Object.freeze({
          authoritativeBlueprintId: generation.authoritativeBlueprintId,
          verifiedCompetitorDomains: (await generationSeedRows(
            dependencies.pool,
            input,
            generation.authoritativeBlueprintId,
          )).filter((seed) => seed.kind === "SEO_COMPETITOR"
            && seed.validationStatus === "VERIFIED")
            .map((seed) => String(seed.normalizedValue)),
          maxRequests: Math.max(
            1,
            Math.min(
              commercialSemanticDiscoveryPaidCallReserve,
              remainingRequestCount,
            ),
          ),
          maxAuthorizedCostMicros: initialStopReached
            ? 0
            : remainingRoundCostMicros,
          requestOffset: progress.completedRequestCount,
          excludedSemanticRequestFingerprints,
          async recordRequestPlan(request) {
            await recordTiming({
              eventType: "REQUEST_PLAN_CREATED",
              idempotencyKey: `request-plan:${input.round}:${executionAttemptId}`,
              roundNumber: input.round,
              observedState: "PLANNED",
              details: {
                executionAttemptId,
                callCount: request.calls.length,
                selectedCallCount: request.selectedCalls.length,
              },
            });
            if (input.round !== 1) return;
            const lastSelectedCall = request.selectedCalls.at(-1);
            const nextPlanIndex =
              lastSelectedCall === undefined
                ? progress.completedRequestCount
                : request.calls.indexOf(lastSelectedCall) + 1;
            const nextCall = request.calls[nextPlanIndex];
            if (nextCall === undefined) return;
            const seed = await seedFacts(
              dependencies.pool,
              input,
              nextCall.plannerLineage?.blueprintId,
              nextPlanIndex,
              nextCall,
            );
            const dimensions = seedDimensions(seed);
            const nextReusableEvidence = await reusableProviderEvidence(
              dependencies.pool,
              input,
              {
                requestPayload:
                  serializeCommercialDiscoveryRequestPayload(nextCall),
                discoverySource: nextCall.sourceType,
                requestType: nextCall.endpoint,
                pageType: nextCall.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS" ? "backlinks" : "organic",
                countryCode: generation.countryCode,
                languageCode: generation.languageCode,
                businessDirectionFingerprint:
                  generation.businessDirectionFingerprint,
                responseSchemaVersion: nextCall.responseSchemaVersion,
              },
            );
            const canonicalRequestFingerprint =
              nextReusableEvidence?.requestFingerprint ??
              fingerprintCommercialDiscoveryCall(nextCall);
            proposedRound2Path = Object.freeze({
              canonicalRequestFingerprint,
              canonicalPathFingerprint: canonicalPathFingerprint(
                input,
                2,
                nextCall,
              ),
              ...dimensions,
              sourceType: nextCall.sourceType,
              pageType: nextCall.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS" ? "backlinks" : "organic",
              strategyVersion: nextCall.endpoint,
              countryCode: generation.countryCode,
              languageCode: generation.languageCode,
              businessDirectionFingerprint:
                generation.businessDirectionFingerprint,
              authorizedCostMicros:
                nextReusableEvidence === null
                  ? Math.min(
                      input.maxCostMicros,
                      recommendationDiscoveryRoundBudgetMicros,
                      nextCall.estimatedCostMicros,
                    )
                  : 0,
            });
          },
          async prepareRequest(request) {
            const pageOrdinal = progress.completedRequestCount + request.index;
            const seed = await seedFacts(
              dependencies.pool,
              input,
              request.call.plannerLineage?.blueprintId,
              pageOrdinal,
              request.call,
            );
            const reusableEvidence = await reusableProviderEvidence(
              dependencies.pool,
              input,
              {
                requestPayload: serializeCommercialDiscoveryRequestPayload(
                  request.call,
                ),
                discoverySource: request.call.sourceType,
                requestType: request.call.endpoint,
                pageType: request.call.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS" ? "backlinks" : "organic",
                countryCode: generation.countryCode,
                languageCode: generation.languageCode,
                businessDirectionFingerprint:
                  generation.businessDirectionFingerprint,
                responseSchemaVersion: request.call.responseSchemaVersion,
              },
            );
            const canonicalRequestFingerprint =
              reusableEvidence?.requestFingerprint ??
              request.requestFingerprint;
            const providerIdentity = createRecommendationPoolV2ProviderIdentity(
              {
                lineage,
                requestFingerprint: canonicalRequestFingerprint,
              },
            );
            const idempotencyKey = [
              input.idempotencyKey,
              pageOrdinal + 1,
              canonicalRequestFingerprint,
            ].join(":");
            const authorizedCostMicros =
              reusableEvidence === null ? request.call.estimatedCostMicros : 0;
            const windowOrdinal = progress.nextWindowOrdinal + request.index;
            await ledger.recordRequestIntent({
              ...lineage,
              id: providerIdentity.intentId,
              seedId: seed.id,
              seedFingerprint: seed.fingerprint,
              seedKind: seed.kind,
              seedSource: seed.source,
              roundNumber: input.round,
              discoveryWindowOrdinal: windowOrdinal,
              discoverySource: request.call.sourceType,
              requestType: request.call.endpoint,
              pageType: request.call.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS" ? "backlinks" : "organic",
              pageOrdinal,
              canonicalRequestFingerprint,
              canonicalPathFingerprint: canonicalPathFingerprint(
                input,
                input.round,
                request.call,
              ),
              countryCode: generation.countryCode,
              languageCode: generation.languageCode,
              businessDirectionFingerprint:
                generation.businessDirectionFingerprint,
              authorizedCostMicros,
              idempotencyKey,
              idempotencyHash: hash(idempotencyKey),
              startedAt: generation.startedAt,
              createdBy: input.actorId,
            });
            await recordTiming({
              eventType: "PROVIDER_REQUEST_QUEUED",
              idempotencyKey: `provider-queued:${providerIdentity.intentId}:${executionAttemptId}`,
              roundNumber: input.round,
              requestIntentId: providerIdentity.intentId,
              observedState:
                reusableEvidence === null ? "LIVE_PROVIDER" : "EVIDENCE_REPLAY",
              details: {
                executionAttemptId,
                pageOrdinal,
                windowOrdinal,
                authorizedCostMicros,
              },
            });
            preparedRequests.set(
              request.index,
              Object.freeze({
                seed,
                reusableEvidence,
                providerIdentity,
                canonicalRequestFingerprint,
                authorizedCostMicros,
                windowOrdinal,
                pageOrdinal,
              }),
            );
            return Object.freeze({
              context: Object.freeze({
                ...tenantScope(input),
                requestId: providerIdentity.requestId,
                idempotencyKey,
                budgetReservationId: providerIdentity.budgetReservationId,
              }),
              actorId: providerIdentity.actorId,
              refreshMode:
                reusableEvidence === null ? "FORCE_LIVE" : "CACHE_PREFERRED",
              ...(reusableEvidence === null
                ? {}
                : { replayResult: reusableEvidence.result }),
            });
          },
          async recordRequestStarted(request) {
            const prepared = preparedRequests.get(request.index);
            if (prepared === undefined) {
              throw new Error(
                "RECOMMENDATION_POOL_V2_REQUEST_INTENT_NOT_PREPARED",
              );
            }
            await recordTiming({
              eventType: "PROVIDER_REQUEST_STARTED",
              idempotencyKey: `provider-started:${prepared.providerIdentity.intentId}:${executionAttemptId}`,
              roundNumber: input.round,
              requestIntentId: prepared.providerIdentity.intentId,
              observedState: request.replayed
                ? "EVIDENCE_REPLAY"
                : "LIVE_PROVIDER",
              details: {
                executionAttemptId,
                requestFingerprint: prepared.canonicalRequestFingerprint,
              },
            });
          },
          async recordRequestCompleted(request) {
            const prepared = preparedRequests.get(request.index);
            if (prepared === undefined) {
              throw new Error(
                "RECOMMENDATION_POOL_V2_REQUEST_INTENT_NOT_PREPARED",
              );
            }
            await recordTiming({
              eventType: "PROVIDER_REQUEST_COMPLETED",
              idempotencyKey: `provider-completed:${prepared.providerIdentity.intentId}:${executionAttemptId}`,
              roundNumber: input.round,
              requestIntentId: prepared.providerIdentity.intentId,
              observedState: request.status,
              details: {
                executionAttemptId,
                replayed: request.replayed,
                requestFingerprint: prepared.canonicalRequestFingerprint,
              },
            });
          },
          async recordRequestSuccess(request) {
            const prepared = preparedRequests.get(request.index);
            if (prepared === undefined) {
              throw new Error(
                "RECOMMENDATION_POOL_V2_REQUEST_INTENT_NOT_PREPARED",
              );
            }
            const persistedCompletion = await persistedRequestCompletion(
              dependencies.pool,
              input,
              prepared.providerIdentity.intentId,
            );
            const trace = request.result.providerTrace;
            if (
              trace === undefined &&
              prepared.reusableEvidence === null &&
              persistedCompletion === null
            ) {
              throw new Error("RECOMMENDATION_POOL_V2_PROVIDER_TRACE_MISSING");
            }
            const replayed = trace === undefined;
            const settled: ProviderSuccess = Object.freeze({
              acquisitionMode: replayed ? "EVIDENCE_REPLAY" : "LIVE_PROVIDER",
              sourceRequestOutcomeId: replayed
                ? (prepared.reusableEvidence?.outcomeId ?? null)
                : null,
              callFingerprint: prepared.canonicalRequestFingerprint,
              authorizedCostMicros: prepared.authorizedCostMicros,
              rawCandidateCount:
                prepared.reusableEvidence?.rawCandidateCount ??
                request.result.artifact.candidates.length,
              providerRequestId: trace?.providerRequestId ?? null,
              providerBatchRequestId: trace?.providerBatchRequestId ?? null,
              providerUsageLedgerId: trace?.providerUsageLedgerId ?? null,
              providerTaskId: trace?.providerTaskId ?? null,
              actualCostMicros: trace?.actualCostMicros ?? 0,
              finishedAt:
                trace === undefined
                  ? (prepared.reusableEvidence?.finishedAt ??
                    persistedCompletion?.finishedAt ??
                    new Date().toISOString())
                  : await providerFinishedAt(
                      dependencies.pool,
                      input,
                      trace.providerBatchRequestId,
                    ),
              intentId: prepared.providerIdentity.intentId,
            });
            let admitted: RecommendationPoolV2CandidateAdmissionResult | null =
              null;
            if (persistedCompletion === null) {
              const observation: RecommendationPoolV2ArtifactObservation =
                Object.freeze({
                  requestIntentId: settled.intentId,
                  providerOutcome:
                    request.result.artifact.candidates.length === 0
                      ? "EMPTY"
                      : "SUCCEEDED",
                  artifact: request.result.artifact,
                });
              admitted = await withBacklinkTenantTransaction(
                dependencies.pool,
                tenantScope(input),
                (client) =>
                  createRecommendationPoolV2CandidateAdmissionService(
                    createRecommendationPoolV2CandidateRepository(client),
                    {
                      record: (event) => {
                        const correlation =
                          event.generationCandidateId ??
                          String(
                            event.details?.canonicalDomain ??
                              event.requestIntentId ??
                              "generation",
                          );
                        return createRecommendationPoolV2TimingRepository(
                          client,
                        ).record({
                          ...tenantScope(input),
                          generationContractId: input.generationContractId,
                          jobId: input.jobId,
                          actorId: input.actorId,
                          eventType: event.eventType,
                          idempotencyKey: [
                            event.eventType,
                            event.requestIntentId ?? "none",
                            correlation,
                          ].join(":"),
                          roundNumber: input.round,
                          ...(event.requestIntentId === undefined
                            ? {}
                            : {
                                requestIntentId: event.requestIntentId,
                              }),
                          ...(event.generationCandidateId === undefined
                            ? {}
                            : {
                                generationCandidateId:
                                  event.generationCandidateId,
                              }),
                          ...(event.details === undefined
                            ? {}
                            : { details: event.details }),
                        });
                      },
                    },
                  ).ingestArtifacts({
                    ...tenantScope(input),
                    generationContractId: input.generationContractId,
                    recommendationContextVersionId:
                      input.recommendationContextVersionId,
                    visiblePoolGeneration: input.visiblePoolGeneration,
                    inputPinId: input.inputPinId,
                    projectDomain: generation.canonicalDomain,
                    market: generation.countryCode,
                    location: generation.countryCode,
                    language: generation.languageCode,
                    observations: Object.freeze([observation]),
                    createdBy: input.actorId,
                  }),
              );
            }
            const persistedIngestion = await requestIngestionCounts(
              dependencies.pool,
              input,
              settled.intentId,
            );
            const ingestion = reconcileRecommendationPoolV2RequestIngestion({
              admissionResult: admitted,
              persistedFacts: persistedIngestion,
              persistedCompletion,
            });
            const rawCandidateCount =
              persistedCompletion?.rawCandidateCount ??
              ingestion.rawCandidateCount;
            const effectiveCandidateCount =
              persistedCompletion?.effectiveCandidateCount ??
              ingestion.canonicalCandidateCount;
            const newUniqueCount =
              persistedCompletion?.newUniqueCount ?? ingestion.newUniqueCount;
            const duplicateCount =
              persistedCompletion?.duplicateCount ?? ingestion.duplicateCount;
            const actualCostMicros =
              persistedCompletion?.actualCostMicros ?? settled.actualCostMicros;
            const completedAt =
              persistedCompletion?.finishedAt ?? settled.finishedAt;
            const requestFingerprint =
              persistedCompletion?.requestFingerprint ??
              settled.callFingerprint;
            const authorizedCostMicros =
              persistedCompletion?.authorizedCostMicros ??
              settled.authorizedCostMicros;
            if (persistedCompletion === null) {
              const cumulativeCostMicros =
                (await settledGenerationCostMicros(
                  dependencies.pool,
                  input,
                  settled.intentId,
                )) + actualCostMicros;
              await ledger.recordRequestOutcome({
                ...lineage,
                id: semanticUuid("recommendation-v2-outcome", settled.intentId),
                requestIntentId: settled.intentId,
                acquisitionMode: settled.acquisitionMode,
                sourceRequestOutcomeId: settled.sourceRequestOutcomeId,
                providerRequestId: settled.providerRequestId,
                providerBatchRequestId: settled.providerBatchRequestId,
                providerUsageLedgerId: settled.providerUsageLedgerId,
                providerTaskId: settled.providerTaskId,
                rawCandidateCount,
                effectiveCandidateCount,
                newUniqueCount,
                duplicateCount,
                actualCostMicros,
                cumulativeCostMicros,
                status: "SUCCEEDED",
                chargeState: "SETTLED",
                failureCode: null,
                finishedAt: completedAt,
                createdBy: input.actorId,
              });
            }
            await recordTiming({
              eventType: "PROVIDER_OUTCOME_PERSISTED",
              idempotencyKey: `provider-outcome-persisted:${settled.intentId}`,
              roundNumber: input.round,
              requestIntentId: settled.intentId,
              observedState: "SUCCEEDED",
              details: {
                acquisitionMode: settled.acquisitionMode,
                rawCandidateCount,
                effectiveCandidateCount,
                newUniqueCount,
                duplicateCount,
                actualCostMicros,
              },
            });
            const currentProgress = await discoveryProgress(
              dependencies.pool,
              input,
            );
            if (prepared.windowOrdinal !== currentProgress.nextWindowOrdinal) {
              return;
            }
            const completedWindowRequestCount = 1;
            await ledger.recordWindowFact({
              ...lineage,
              id: semanticUuid("recommendation-v2-window", {
                lineage,
                windowOrdinal: prepared.windowOrdinal,
              }),
              roundNumber: input.round,
              windowOrdinal: prepared.windowOrdinal,
              completedRequestCount: completedWindowRequestCount,
              rawCandidateCount,
              effectiveCandidateCount,
              newUniqueCount,
              duplicateCount,
              newUniqueRateNumerator: newUniqueCount,
              newUniqueRateDenominator: effectiveCandidateCount,
              windowAuthorizedCostMicros: authorizedCostMicros,
              windowSettledCostMicros: actualCostMicros,
              chargeState: "SETTLED",
              canonicalRequestSetFingerprint: hash([requestFingerprint]),
              completedAt,
              createdBy: input.actorId,
            });
          },
          async recordRequestFailure() {
            // The provider error remains authoritative and Temporal retries.
          },
          async shouldContinue() {
            const current = await discoveryProgress(dependencies.pool, input);
            return (
              current.completedRequestCount < maximumRequestCount &&
              current.rawObservationCount <
                recommendationPoolV2OperationalPolicy.discovery
                  .rawObservationLimit &&
              current.candidateCount < recommendationDiscoverySupplyThreshold &&
              current.candidateCount < recommendationDiscoveryHardCandidateLimit
            );
          },
        });
      const refill = {
        ...tenantScope(input),
        recommendationContextVersionId: input.recommendationContextVersionId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        jobId: input.jobId,
        workflowId: input.workflowId,
        correlationId: input.workflowId,
        actorId: input.actorId,
        refillWindowKey: `recommendation-pool-v2:${input.generationContractId}:r${input.round}`,
        lowWatermark: 0,
        highWatermark: 5,
      } as const;
      const execution = await dependencies.runtime.execute({
        ...refill,
        requestedCount: 5,
        source: "paid",
        nativeV2: {
          generationContractId: input.generationContractId,
          discoveryBudgetPolicyVersion:
            recommendationDiscoveryBudgetPolicyVersion,
          round: input.round,
          maxCostMicros: input.maxCostMicros,
          requestFingerprint: input.requestFingerprint,
          requestPort,
        },
      });
      if (!("candidates" in execution)) {
        throw new Error("RECOMMENDATION_POOL_V2_NATIVE_DISCOVERY_INCOMPLETE");
      }
      const completion = await discoveryProgress(dependencies.pool, input);
      if (completion.completedRequestCount === 0) {
        throw new Error("RECOMMENDATION_POOL_V2_NATIVE_DISCOVERY_INCOMPLETE");
      }
      const finalized = await createRecommendationPoolV2DiscoveryFinalizer(
        ledger,
      ).finalize({ lineage, proposedRound2Path });
      const candidateCount = await nativeCandidateCountThroughRound(
        dependencies.pool,
        input,
      );
      const windows = await completedRoundWindows(dependencies.pool, input);
      return Object.freeze({
        round: input.round,
        requestFingerprint: input.requestFingerprint,
        chargeState: "settled" as const,
        costMicros: finalized.roundFact.roundSettledCostMicros ?? 0,
        totalUniqueCandidateCount: candidateCount,
        pathsExhausted:
          finalized.kind === "TERMINAL" &&
          finalized.reason === "PATHS_EXHAUSTED",
        completedWindows: windows,
      });
    },
  });
}
