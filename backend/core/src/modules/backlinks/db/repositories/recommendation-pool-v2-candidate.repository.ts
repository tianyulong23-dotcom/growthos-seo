import { createHash } from "node:crypto";

import {
  createRecommendationDomainKey,
  recommendationDomainNormalizationVersion,
} from "../../domain/recommendations/domain-key.js";
import {
  recommendationPoolV2AdmissionContractVersion,
  recommendationPoolV2HardExclusionCodes,
  type RecommendationPoolV2HardExclusionCode,
} from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import type { BacklinkTransactionClient } from "../tenant-transaction.js";

const materializationContractVersion = "recommendation-pool-materialization.v2";
const poolContractVersion = "recommendation-pool.v2";

export type RecommendationPoolV2ExclusionReasonCode =
  RecommendationPoolV2HardExclusionCode;

export type RecommendationPoolV2CandidateMetricType =
  "TRAFFIC_ORGANIC_ETV" | "AUTHORITY_RANK" | "SPAM_SCORE"
  | "AHREFS_DR" | "LIBRARY_MONTHLY_TRAFFIC";

export type RecommendationPoolV2CandidateMetricValueState =
  "AVAILABLE" | "UNAVAILABLE" | "FAILED" | "UNSUPPORTED";

export type RecommendationPoolV2CandidateSourceOutcome =
  "SUCCEEDED" | "PARTIAL" | "EMPTY" | "FAILED" | "UNAVAILABLE" | "UNSUPPORTED";

export type RecommendationPoolV2CandidateLineage = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
}>;

export type RecommendationPoolV2GenerationCandidate = Readonly<{
  id: string;
  canonicalDomain: string;
  admissionState: "ADMITTED" | "EXCLUDED";
  exclusionReasonCode: RecommendationPoolV2ExclusionReasonCode | null;
}>;

export type RecommendationPoolV2CanonicalMaterialization = Readonly<{
  generationCandidateId: string;
  batchId: string;
  candidateId: string;
  recommendationId: string;
  prospectId: string;
  inventoryId: string;
}>;

type JsonObject = Readonly<Record<string, unknown>>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  if (serialized === undefined) {
    throw new TypeError("Recommendation pool V2 evidence is not JSON.");
  }
  return serialized;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function semanticUuid(namespace: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(`${namespace}:${stableJson(value)}`)
    .digest("hex");
  const variants = ["8", "9", "a", "b"] as const;
  const variant =
    variants[Number.parseInt(digest.charAt(16), 16) % variants.length];
  if (variant === undefined) {
    throw new Error("RECOMMENDATION_POOL_V2_IDENTITY_INVALID");
  }
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(
    13,
    16,
  )}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function isoTimestamp(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("Recommendation pool V2 timestamp is invalid.");
  }
  return parsed.toISOString();
}

function nonEmptyString(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`Recommendation pool V2 ${label} is empty.`);
  }
  return normalized;
}

function reasonCodes(values: readonly string[]): readonly string[] {
  const normalized = [...new Set(values.map((value) => value.trim()))].filter(
    (value) => value.length > 0,
  );
  if (normalized.length === 0) {
    throw new TypeError(
      "Recommendation pool V2 recommendation reasons are empty.",
    );
  }
  return Object.freeze(normalized);
}

function exactLineage(
  row: Record<string, unknown>,
  lineage: RecommendationPoolV2CandidateLineage,
): boolean {
  return (
    String(row.generationContractId) === lineage.generationContractId &&
    String(row.recommendationContextVersionId) ===
      lineage.recommendationContextVersionId &&
    Number(row.visiblePoolGeneration) === lineage.visiblePoolGeneration &&
    String(row.inputPinId) === lineage.inputPinId &&
    String(row.poolContractVersion) === poolContractVersion
  );
}

function scopeValues(
  lineage: RecommendationPoolV2CandidateLineage,
): readonly unknown[] {
  return [
    lineage.organizationId,
    lineage.workspaceId,
    lineage.websiteProjectId,
  ];
}

export function createRecommendationPoolV2CandidateRepository(
  client: BacklinkTransactionClient,
) {
  const findCandidate = async (
    input: RecommendationPoolV2CandidateLineage &
      Readonly<{ canonicalDomain: string }>,
  ): Promise<RecommendationPoolV2GenerationCandidate | null> => {
    const canonicalDomain = createRecommendationDomainKey(
      input.canonicalDomain,
    ).registrableDomain;
    const result = await client.query(
      `SELECT id,canonical_domain "canonicalDomain",
              admission_state "admissionState",
              admission_contract_version "admissionContractVersion",
              exclusion_reason_code "exclusionReasonCode",
              generation_contract_id "generationContractId",
              recommendation_context_version_id
                "recommendationContextVersionId",
              visible_pool_generation "visiblePoolGeneration",
              input_pin_id "inputPinId",
              pool_contract_version "poolContractVersion"
         FROM backlinks.backlink_recommendation_generation_candidates
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND generation_contract_id=$4
          AND canonical_domain=$5`,
      [...scopeValues(input), input.generationContractId, canonicalDomain],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (
      !exactLineage(row, input) ||
      row.admissionContractVersion !==
        recommendationPoolV2AdmissionContractVersion
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_CANDIDATE_LINEAGE_CONFLICT");
    }
    return Object.freeze({
      id: String(row.id),
      canonicalDomain: String(row.canonicalDomain),
      admissionState: String(
        row.admissionState,
      ) as RecommendationPoolV2GenerationCandidate["admissionState"],
      exclusionReasonCode:
        row.exclusionReasonCode === null
          ? null
          : (String(
              row.exclusionReasonCode,
            ) as RecommendationPoolV2ExclusionReasonCode),
    });
  };

  const recordCandidate = async (
    input: RecommendationPoolV2CandidateLineage &
      Readonly<{
        canonicalDomain: string;
        admissionState: "ADMITTED" | "EXCLUDED";
        exclusionReasonCode?: RecommendationPoolV2ExclusionReasonCode;
        exclusionEvidence?: JsonObject;
        decisionEvidence: JsonObject;
        firstSeenRequestIntent: string;
        recommended: boolean;
        recommendationReasonCodes: readonly string[];
        firstSeenAt: string;
        decidedAt: string;
        createdBy: string;
      }>,
  ): Promise<RecommendationPoolV2GenerationCandidate> => {
    const domain = createRecommendationDomainKey(input.canonicalDomain);
    const canonicalDomain = domain.registrableDomain;
    const requestedExclusionReasonCode =
      input.admissionState === "EXCLUDED"
        ? (input.exclusionReasonCode ?? null)
        : null;
    const requestedExclusionEvidence =
      input.admissionState === "EXCLUDED"
        ? (input.exclusionEvidence ?? {})
        : {};
    const requestedReasonCodes = reasonCodes(input.recommendationReasonCodes);
    if (
      input.admissionState === "EXCLUDED" &&
      (!recommendationPoolV2HardExclusionCodes.includes(
        requestedExclusionReasonCode as RecommendationPoolV2ExclusionReasonCode,
      ) ||
        Object.keys(requestedExclusionEvidence).length === 0 ||
        input.recommended)
    ) {
      throw new TypeError(
        "Excluded V2 candidates require a closed reason, evidence, and a false marker.",
      );
    }
    if (Object.keys(input.decisionEvidence).length === 0) {
      throw new TypeError("Recommendation pool V2 decision evidence is empty.");
    }
    const firstSeenRequestIntent = nonEmptyString(
      input.firstSeenRequestIntent,
      "first-seen request intent",
    );
    const firstSeenAt = isoTimestamp(input.firstSeenAt);
    const decidedAt = isoTimestamp(input.decidedAt);
    if (firstSeenAt > decidedAt) {
      throw new TypeError(
        "Recommendation pool V2 first-seen time follows its decision.",
      );
    }
    const candidateId = semanticUuid("recommendation-pool-v2-candidate", {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      generationContractId: input.generationContractId,
      canonicalDomain,
    });
    const requestedDecision = Object.freeze({
      admissionState: input.admissionState,
      evidence: input.decisionEvidence,
      recommendation: Object.freeze({
        recommended: input.recommended,
        reasonCodes: requestedReasonCodes,
      }),
    });
    const loadCandidate = () =>
      client.query(
        `SELECT id,canonical_domain "canonicalDomain",
                admission_state "admissionState",
                admission_contract_version "admissionContractVersion",
                exclusion_reason_code "exclusionReasonCode",
                exclusion_evidence "exclusionEvidence",
                decision_evidence "decisionEvidence",
                first_seen_request_intent "firstSeenRequestIntent",
                recommended,
                recommendation_reason_codes "recommendationReasonCodes",
                first_seen_at "firstSeenAt",admitted_at "admittedAt",
                excluded_at "excludedAt",decided_at "decidedAt",
                generation_contract_id "generationContractId",
                recommendation_context_version_id
                  "recommendationContextVersionId",
                visible_pool_generation "visiblePoolGeneration",
                input_pin_id "inputPinId",
                pool_contract_version "poolContractVersion"
           FROM backlinks.backlink_recommendation_generation_candidates
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND generation_contract_id=$4
            AND canonical_domain=$5`,
        [...scopeValues(input), input.generationContractId, canonicalDomain],
      );
    const existingResult = await loadCandidate();
    const existing = existingResult.rows[0];
    if (existing !== undefined) {
      const persistedDecision = existing.decisionEvidence as
        Record<string, unknown> | undefined;
      if (
        !exactLineage(existing, input) ||
        existing.admissionContractVersion !==
          recommendationPoolV2AdmissionContractVersion ||
        existing.firstSeenRequestIntent !== firstSeenRequestIntent ||
        isoTimestamp(existing.firstSeenAt as string | Date) !== firstSeenAt ||
        isoTimestamp(existing.decidedAt as string | Date) !== decidedAt ||
        stableJson(persistedDecision?.requestedDecision) !==
          stableJson(requestedDecision)
      ) {
        throw new Error("RECOMMENDATION_POOL_V2_CANDIDATE_REPLAY_CONFLICT");
      }
      return Object.freeze({
        id: String(existing.id),
        canonicalDomain: String(existing.canonicalDomain),
        admissionState: String(
          existing.admissionState,
        ) as RecommendationPoolV2GenerationCandidate["admissionState"],
        exclusionReasonCode:
          existing.exclusionReasonCode === null
            ? null
            : (String(
                existing.exclusionReasonCode,
              ) as RecommendationPoolV2ExclusionReasonCode),
      });
    }

    let history:
      | Readonly<{
          reasonCode: RecommendationPoolV2ExclusionReasonCode;
          objectType: string;
          objectId: string;
        }>
      | undefined;
    if (input.admissionState === "ADMITTED") {
      const historyResult = await client.query(
        `SELECT registry.reason_code "reasonCode",
                registry.object_type "objectType",
                registry.object_id "objectId"
           FROM (
             SELECT 1 AS priority,'SELF_DOMAIN'::text AS reason_code,
                    'PROJECT_CONTEXT'::text AS object_type,
                    context.id::text AS object_id
               FROM backlinks.backlink_project_context_snapshots AS context
              WHERE context.organization_id=$1 AND context.workspace_id=$2
                AND context.website_project_id=$3
                AND context.canonical_domain=$4
             UNION ALL
             SELECT 2,'ALREADY_RELEASED_TO_PROJECT','RELEASE_ITEM',
                    item.id::text
               FROM backlinks.backlink_recommendation_release_batch_items
                 AS item
              WHERE item.organization_id=$1 AND item.workspace_id=$2
                AND item.website_project_id=$3
                AND item.canonical_domain=$4
             UNION ALL
             SELECT 3,'EXISTING_PROJECT_OPPORTUNITY','OPPORTUNITY',
                    opportunity.id::text
               FROM backlinks.backlink_opportunities AS opportunity
              WHERE opportunity.organization_id=$1
                AND opportunity.workspace_id=$2
                AND opportunity.website_project_id=$3
                AND opportunity.target_site_key=$4
           ) AS registry
          ORDER BY registry.priority,registry.object_id
          LIMIT 1`,
        [...scopeValues(input), canonicalDomain],
      );
      const row = historyResult.rows[0];
      if (row !== undefined) {
        history = Object.freeze({
          reasonCode: String(
            row.reasonCode,
          ) as RecommendationPoolV2ExclusionReasonCode,
          objectType: String(row.objectType),
          objectId: String(row.objectId),
        });
      }
    }
    const effectiveAdmissionState =
      history === undefined ? input.admissionState : "EXCLUDED";
    const exclusionReasonCode =
      history?.reasonCode ?? requestedExclusionReasonCode;
    const exclusionEvidence =
      history === undefined
        ? requestedExclusionEvidence
        : Object.freeze({
            contractVersion: "recommendation-pool-v2-domain-registry.v1",
            canonicalDomain,
            matchedObjectType: history.objectType,
            matchedObjectId: history.objectId,
          });
    const recommended = history === undefined ? input.recommended : false;
    const effectiveReasonCodes =
      history === undefined
        ? requestedReasonCodes
        : Object.freeze([history.reasonCode]);
    const decisionEvidence = Object.freeze({
      contractVersion: recommendationPoolV2AdmissionContractVersion,
      requestedDecision,
      ...(history === undefined
        ? {}
        : {
            historyRegistry: Object.freeze({
              reasonCode: history.reasonCode,
              objectType: history.objectType,
              objectId: history.objectId,
            }),
          }),
    });
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_generation_candidates (
         id,organization_id,workspace_id,website_project_id,
         generation_contract_id,recommendation_context_version_id,
         visible_pool_generation,input_pin_id,pool_contract_version,
         canonical_domain,admission_state,admission_contract_version,
         exclusion_reason_code,exclusion_evidence,decision_evidence,
         first_seen_request_intent,recommended,recommendation_reason_codes,
         first_seen_at,admitted_at,excluded_at,decided_at,created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'recommendation-pool.v2',
         $9,$10,'recommendation-pool-admission.v2',$11,$12::jsonb,
         $13::jsonb,$14,$15,$16::jsonb,$17,
         CASE WHEN $10='ADMITTED' THEN $18::timestamptz ELSE NULL END,
         CASE WHEN $10='EXCLUDED' THEN $18::timestamptz ELSE NULL END,
         $18,$19
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         generation_contract_id,canonical_domain
       ) DO NOTHING`,
      [
        candidateId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.generationContractId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        input.inputPinId,
        canonicalDomain,
        effectiveAdmissionState,
        exclusionReasonCode,
        stableJson(exclusionEvidence),
        stableJson(decisionEvidence),
        firstSeenRequestIntent,
        recommended,
        stableJson(effectiveReasonCodes),
        firstSeenAt,
        decidedAt,
        input.createdBy,
      ],
    );
    const result = await loadCandidate();
    const row = result.rows[0];
    if (
      row === undefined ||
      !exactLineage(row, input) ||
      row.admissionContractVersion !==
        recommendationPoolV2AdmissionContractVersion ||
      String(row.admissionState) !== effectiveAdmissionState ||
      String(row.exclusionReasonCode ?? "") !==
        String(exclusionReasonCode ?? "") ||
      stableJson(row.exclusionEvidence) !== stableJson(exclusionEvidence) ||
      stableJson(row.decisionEvidence) !== stableJson(decisionEvidence) ||
      row.firstSeenRequestIntent !== firstSeenRequestIntent ||
      Boolean(row.recommended) !== recommended ||
      stableJson(row.recommendationReasonCodes) !==
        stableJson(effectiveReasonCodes) ||
      isoTimestamp(row.firstSeenAt as string | Date) !== firstSeenAt ||
      isoTimestamp(row.decidedAt as string | Date) !== decidedAt
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_CANDIDATE_REPLAY_CONFLICT");
    }
    return Object.freeze({
      id: String(row.id),
      canonicalDomain: String(row.canonicalDomain),
      admissionState: String(
        row.admissionState,
      ) as RecommendationPoolV2GenerationCandidate["admissionState"],
      exclusionReasonCode:
        row.exclusionReasonCode === null
          ? null
          : (String(
              row.exclusionReasonCode,
            ) as RecommendationPoolV2ExclusionReasonCode),
    });
  };

  const appendSource = async (
    input: Pick<
      RecommendationPoolV2CandidateLineage,
      "organizationId" | "workspaceId" | "websiteProjectId"
    > &
      Readonly<{
        generationCandidateId: string;
        requestIntent: string;
        providerOutcome: RecommendationPoolV2CandidateSourceOutcome;
        sourceType: string;
        discoveredUrl: string;
        sourceRef: string;
        evidencePayload: JsonObject;
        observedAt: string;
        createdBy: string;
      }>,
  ): Promise<string> => {
    const requestIntent = nonEmptyString(
      input.requestIntent,
      "source request intent",
    );
    const sourceType = nonEmptyString(input.sourceType, "source type");
    const discoveredUrl = nonEmptyString(
      input.discoveredUrl,
      "source discovered URL",
    );
    const sourceRef = nonEmptyString(input.sourceRef, "source reference");
    const observedAt = isoTimestamp(input.observedAt);
    const evidenceFingerprint = fingerprint({
      contract: "recommendation-pool-v2-candidate-source.v1",
      requestIntent,
      providerOutcome: input.providerOutcome,
      sourceType,
      discoveredUrl,
      sourceRef,
      evidencePayload: input.evidencePayload,
      observedAt,
    });
    const id = semanticUuid("recommendation-pool-v2-candidate-source", {
      generationCandidateId: input.generationCandidateId,
      evidenceFingerprint,
    });
    await client.query(
      `INSERT INTO
         backlinks.backlink_recommendation_generation_candidate_sources (
           id,organization_id,workspace_id,website_project_id,
           generation_candidate_id,request_intent,provider_outcome,
           source_type,discovered_url,source_ref,evidence_payload,
           evidence_fingerprint,observed_at,created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14
         )
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           generation_candidate_id,evidence_fingerprint
         ) DO NOTHING`,
      [
        id,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.generationCandidateId,
        requestIntent,
        input.providerOutcome,
        sourceType,
        discoveredUrl,
        sourceRef,
        stableJson(input.evidencePayload),
        evidenceFingerprint,
        observedAt,
        input.createdBy,
      ],
    );
    return id;
  };

  const appendMetric = async (
    input: Pick<
      RecommendationPoolV2CandidateLineage,
      "organizationId" | "workspaceId" | "websiteProjectId"
    > &
      Readonly<{
        generationCandidateId: string;
        metricType: RecommendationPoolV2CandidateMetricType;
        provider: string;
        endpoint: string;
        market: string;
        location: string;
        language: string;
        requestIntent: string;
        valueState: RecommendationPoolV2CandidateMetricValueState;
        metricValue: unknown | null;
        requestRef?: string;
        artifactRef?: string;
        observedAt: string;
        createdBy: string;
      }>,
  ): Promise<string> => {
    if (
      (input.requestRef?.trim().length ?? 0) === 0 &&
      (input.artifactRef?.trim().length ?? 0) === 0
    ) {
      throw new TypeError(
        "V2 candidate metrics require a request or artifact reference.",
      );
    }
    if (
      (input.valueState === "AVAILABLE" && input.metricValue === null) ||
      (input.valueState !== "AVAILABLE" && input.metricValue !== null)
    ) {
      throw new TypeError(
        "V2 candidate metric value does not match its value state.",
      );
    }
    const requestIntent = nonEmptyString(
      input.requestIntent,
      "metric request intent",
    );
    const observedAt = isoTimestamp(input.observedAt);
    const evidenceFingerprint = fingerprint({
      contract: "recommendation-pool-v2-candidate-metric.v1",
      metricType: input.metricType,
      valueState: input.valueState,
      provider: input.provider,
      endpoint: input.endpoint,
      market: input.market,
      location: input.location,
      language: input.language,
      requestIntent,
      metricValue: input.metricValue,
      requestRef: input.requestRef ?? null,
      artifactRef: input.artifactRef ?? null,
      observedAt,
    });
    const id = semanticUuid("recommendation-pool-v2-candidate-metric", {
      generationCandidateId: input.generationCandidateId,
      metricType: input.metricType,
      evidenceFingerprint,
    });
    await client.query(
      `INSERT INTO
         backlinks.backlink_recommendation_candidate_metric_snapshots (
           id,organization_id,workspace_id,website_project_id,
           generation_candidate_id,metric_type,value_state,provider,endpoint,
           market,location,language,request_intent,metric_value,
           request_ref,artifact_ref,
           evidence_fingerprint,observed_at,created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
           $15,$16,$17,$18,$19
         )
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           generation_candidate_id,metric_type,evidence_fingerprint
         ) DO NOTHING`,
      [
        id,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.generationCandidateId,
        input.metricType,
        input.valueState,
        input.provider,
        input.endpoint,
        input.market,
        input.location,
        input.language,
        requestIntent,
        input.metricValue === null ? null : stableJson(input.metricValue),
        input.requestRef ?? null,
        input.artifactRef ?? null,
        evidenceFingerprint,
        observedAt,
        input.createdBy,
      ],
    );
    return id;
  };

  const materializeCandidate = async (
    input: RecommendationPoolV2CandidateLineage &
      Readonly<{
        generationCandidateId: string;
        createdBy: string;
      }>,
  ): Promise<RecommendationPoolV2CanonicalMaterialization> => {
    const authorityResult = await client.query(
      `SELECT candidate.id,candidate.canonical_domain "canonicalDomain",
              candidate.generation_contract_id "generationContractId",
              candidate.recommendation_context_version_id
                "recommendationContextVersionId",
              candidate.visible_pool_generation "visiblePoolGeneration",
              candidate.input_pin_id "inputPinId",
              candidate.pool_contract_version "poolContractVersion"
         FROM backlinks.backlink_recommendation_generation_candidates
           AS candidate
        WHERE candidate.organization_id=$1 AND candidate.workspace_id=$2
          AND candidate.website_project_id=$3 AND candidate.id=$4
          AND candidate.admission_state='ADMITTED'
        FOR SHARE`,
      [...scopeValues(input), input.generationCandidateId],
    );
    const authority = authorityResult.rows[0];
    if (authority === undefined || !exactLineage(authority, input)) {
      throw new Error("RECOMMENDATION_POOL_V2_ADMITTED_CANDIDATE_MISSING");
    }
    const canonicalDomain = String(authority.canonicalDomain);
    const domain = createRecommendationDomainKey(canonicalDomain);

    const blueprintResult = await client.query(
      `SELECT seed.blueprint_id "blueprintId"
         FROM backlinks.backlink_commercial_blueprint_seeds AS seed
        WHERE seed.organization_id=$1 AND seed.workspace_id=$2
          AND seed.website_project_id=$3 AND seed.generation_contract_id=$4
          AND seed.recommendation_context_version_id=$5
          AND seed.visible_pool_generation=$6
        GROUP BY seed.blueprint_id`,
      [
        ...scopeValues(input),
        input.generationContractId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
      ],
    );
    if (blueprintResult.rows.length !== 1) {
      throw new Error(
        "RECOMMENDATION_POOL_V2_EXACT_BLUEPRINT_ASSIGNMENT_MISSING",
      );
    }
    const blueprintId = String(blueprintResult.rows[0]?.blueprintId);
    const batchId = semanticUuid(
      "recommendation-pool-v2-materialization-batch",
      {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        generationContractId: input.generationContractId,
      },
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_discovery_batches (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         project_context_version_id,status,idempotency_key,request_intent,
         source_types,provider_request_fingerprints,provider_collected_at,
         paid_cost_micros,pause_reason,started_at,finished_at,created_by,
         visible_pool_generation,generation_contract_id,input_pin_id,
         pool_contract_version,materialization_contract_version
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'completed',$7,'V2_MATERIALIZATION',
         '["V2_CANONICAL_MATERIALIZATION"]'::jsonb,'[]'::jsonb,NULL,
         0,NULL,statement_timestamp(),statement_timestamp(),$8,$9,$10,$11,
         'recommendation-pool.v2','recommendation-pool-materialization.v2'
       )
       ON CONFLICT DO NOTHING`,
      [
        batchId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        blueprintId,
        input.recommendationContextVersionId,
        `recommendation-pool-v2-materialization:${input.generationContractId}`,
        input.createdBy,
        input.visiblePoolGeneration,
        input.generationContractId,
        input.inputPinId,
      ],
    );

    const prospectIdentity = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      recommendationContextVersionId: input.recommendationContextVersionId,
      hostnameAscii: domain.hostnameAscii,
    };
    const proposedProspectId = semanticUuid(
      "recommendation-pool-v2-prospect",
      prospectIdentity,
    );
    await client.query(
      `INSERT INTO backlinks.backlink_prospects (
         id,organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,hostname_ascii,
         registrable_domain,normalization_version,created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         recommendation_context_version_id,hostname_ascii
       ) DO NOTHING`,
      [
        proposedProspectId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.recommendationContextVersionId,
        domain.hostnameAscii,
        domain.registrableDomain,
        recommendationDomainNormalizationVersion,
        input.createdBy,
      ],
    );
    const prospectResult = await client.query(
      `SELECT id,registrable_domain "registrableDomain",
              normalization_version "normalizationVersion"
         FROM backlinks.backlink_prospects
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND recommendation_context_version_id=$4
          AND hostname_ascii=$5`,
      [
        ...scopeValues(input),
        input.recommendationContextVersionId,
        domain.hostnameAscii,
      ],
    );
    const prospect = prospectResult.rows[0];
    if (
      prospect === undefined ||
      String(prospect.registrableDomain) !== domain.registrableDomain ||
      String(prospect.normalizationVersion) !==
        recommendationDomainNormalizationVersion
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_PROSPECT_REPLAY_CONFLICT");
    }
    const prospectId = String(prospect.id);

    const proposedRecommendationId = semanticUuid(
      "recommendation-pool-v2-recommendation",
      {
        ...prospectIdentity,
        generationContractId: input.generationContractId,
      },
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendations (
         id,organization_id,workspace_id,website_project_id,prospect_id,
         recommendation_context_version_id,status,created_by,updated_by,
         generation_contract_id,visible_pool_generation,input_pin_id,
         pool_contract_version,materialization_contract_version
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'ready',$7,$7,$8,$9,$10,
         'recommendation-pool.v2','recommendation-pool-materialization.v2'
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,prospect_id,
         recommendation_context_version_id
       ) DO NOTHING`,
      [
        proposedRecommendationId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        prospectId,
        input.recommendationContextVersionId,
        input.createdBy,
        input.generationContractId,
        input.visiblePoolGeneration,
        input.inputPinId,
      ],
    );
    const recommendationResult = await client.query(
      `SELECT id,generation_contract_id "generationContractId",
              recommendation_context_version_id
                "recommendationContextVersionId",
              visible_pool_generation "visiblePoolGeneration",
              input_pin_id "inputPinId",
              pool_contract_version "poolContractVersion",
              materialization_contract_version
                "materializationContractVersion"
         FROM backlinks.backlink_recommendations
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND prospect_id=$4
          AND recommendation_context_version_id=$5`,
      [...scopeValues(input), prospectId, input.recommendationContextVersionId],
    );
    const recommendation = recommendationResult.rows[0];
    if (
      recommendation === undefined ||
      !exactLineage(recommendation, input) ||
      recommendation.materializationContractVersion !==
        materializationContractVersion
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_RECOMMENDATION_REPLAY_CONFLICT");
    }
    const recommendationId = String(recommendation.id);

    const proposedInventoryId = semanticUuid(
      "recommendation-pool-v2-inventory",
      {
        recommendationId,
        visiblePoolGeneration: input.visiblePoolGeneration,
      },
    );
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_inventory (
         id,organization_id,workspace_id,website_project_id,
         recommendation_id,prospect_id,recommendation_context_version_id,
         status,publication_status,fit_decision,contact_decision,
         contact_reason_code,visible_pool_generation,created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'ready','CONTACT_PENDING','unassessed',
         'pending','CONTACT_PENDING',$8,$9,$9
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,recommendation_id,
         recommendation_context_version_id,visible_pool_generation
       ) DO NOTHING`,
      [
        proposedInventoryId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        recommendationId,
        prospectId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        input.createdBy,
      ],
    );
    const inventoryResult = await client.query(
      `SELECT id,prospect_id "prospectId",publication_status
                "publicationStatus",fit_decision "fitDecision",
              fit_score_model_version "fitScoreModelVersion"
         FROM backlinks.backlink_recommendation_inventory
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND recommendation_id=$4
          AND recommendation_context_version_id=$5
          AND visible_pool_generation=$6`,
      [
        ...scopeValues(input),
        recommendationId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
      ],
    );
    const inventory = inventoryResult.rows[0];
    if (
      inventory === undefined ||
      String(inventory.prospectId) !== prospectId ||
      inventory.publicationStatus === "PUBLISHED" ||
      inventory.fitDecision !== "unassessed" ||
      inventory.fitScoreModelVersion !== null
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_INVENTORY_REPLAY_CONFLICT");
    }
    const inventoryId = String(inventory.id);

    const candidateId = semanticUuid(
      "recommendation-pool-v2-canonical-candidate",
      {
        generationCandidateId: input.generationCandidateId,
        recommendationId,
        prospectId,
      },
    );
    await client.query(
      `INSERT INTO backlinks.backlink_commercial_candidates (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         discovery_batch_id,recommendation_id,prospect_id,
         project_context_version_id,canonical_domain,source_types,
         static_assessment,gate_decision,commercial_score,
         score_model_version,state,provider_collected_at,created_by,
         updated_by,visible_pool_generation
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         '["V2_CANONICAL_MATERIALIZATION"]'::jsonb,
         '{"assessment":"NOT_SCORED","contractVersion":"recommendation-pool-materialization.v2"}'::jsonb,
         '{"contractVersion":"recommendation-pool-materialization.v2","decision":"NOT_APPLICABLE"}'::jsonb,
         '{"contractVersion":"recommendation-pool-materialization.v2","score":null}'::jsonb,
         'recommendation-pool-materialization.v2','v2_materialized',NULL,
         $11,$11,$12
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,visible_pool_generation,
         canonical_domain,score_model_version
       ) DO NOTHING`,
      [
        candidateId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        blueprintId,
        batchId,
        recommendationId,
        prospectId,
        input.recommendationContextVersionId,
        canonicalDomain,
        input.createdBy,
        input.visiblePoolGeneration,
      ],
    );
    const candidateResult = await client.query(
      `SELECT id,recommendation_id "recommendationId",
              prospect_id "prospectId",discovery_batch_id "batchId",
              score_model_version "scoreModelVersion",state
         FROM backlinks.backlink_commercial_candidates
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND project_context_version_id=$4
          AND visible_pool_generation=$5 AND canonical_domain=$6
          AND score_model_version='recommendation-pool-materialization.v2'`,
      [
        ...scopeValues(input),
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        canonicalDomain,
      ],
    );
    const candidate = candidateResult.rows[0];
    if (
      candidate === undefined ||
      String(candidate.recommendationId) !== recommendationId ||
      String(candidate.prospectId) !== prospectId ||
      String(candidate.batchId) !== batchId ||
      candidate.state !== "v2_materialized"
    ) {
      throw new Error(
        "RECOMMENDATION_POOL_V2_CANONICAL_CANDIDATE_REPLAY_CONFLICT",
      );
    }
    const persistedCandidateId = String(candidate.id);

    const linkId = semanticUuid("recommendation-pool-v2-candidate-link", {
      generationCandidateId: input.generationCandidateId,
      candidateId: persistedCandidateId,
    });
    const linkIdempotencyFingerprint = fingerprint({
      contract: materializationContractVersion,
      generationCandidateId: input.generationCandidateId,
      candidateId: persistedCandidateId,
      recommendationId,
      prospectId,
      inventoryId,
    });
    await client.query(
      `INSERT INTO
         backlinks.backlink_recommendation_generation_candidate_links (
           id,organization_id,workspace_id,website_project_id,
           generation_candidate_id,candidate_id,recommendation_id,
           prospect_id,inventory_id,recommendation_context_version_id,
           visible_pool_generation,materialization_contract_version,
           idempotency_fingerprint,created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
           'recommendation-pool-materialization.v2',$12,$13
         )
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           generation_candidate_id
         ) DO NOTHING`,
      [
        linkId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.generationCandidateId,
        persistedCandidateId,
        recommendationId,
        prospectId,
        inventoryId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        linkIdempotencyFingerprint,
        input.createdBy,
      ],
    );
    const linkResult = await client.query(
      `SELECT candidate_id "candidateId",
              recommendation_id "recommendationId",
              prospect_id "prospectId",inventory_id "inventoryId",
              materialization_contract_version
                "materializationContractVersion",
              idempotency_fingerprint "idempotencyFingerprint"
         FROM backlinks.backlink_recommendation_generation_candidate_links
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND generation_candidate_id=$4`,
      [...scopeValues(input), input.generationCandidateId],
    );
    const link = linkResult.rows[0];
    if (
      link === undefined ||
      String(link.candidateId) !== persistedCandidateId ||
      String(link.recommendationId) !== recommendationId ||
      String(link.prospectId) !== prospectId ||
      String(link.inventoryId) !== inventoryId ||
      link.materializationContractVersion !== materializationContractVersion ||
      link.idempotencyFingerprint !== linkIdempotencyFingerprint
    ) {
      throw new Error("RECOMMENDATION_POOL_V2_CANDIDATE_LINK_REPLAY_CONFLICT");
    }
    return Object.freeze({
      generationCandidateId: input.generationCandidateId,
      batchId,
      candidateId: persistedCandidateId,
      recommendationId,
      prospectId,
      inventoryId,
    });
  };

  return Object.freeze({
    findCandidate,
    recordCandidate,
    appendSource,
    appendMetric,
    materializeCandidate,
  });
}
