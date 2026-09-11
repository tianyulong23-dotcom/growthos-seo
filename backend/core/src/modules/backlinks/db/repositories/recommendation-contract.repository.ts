import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../tenant-transaction.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  CORRECTED_SCORE_MODEL_VERSION,
  CORRECTED_VISIBILITY_CONTRACT_VERSION,
  RecommendationContractVersionMismatchError,
  type AssertCorrectedGenerationAvailableInput,
  type CorrectedRecommendationContractRecord,
  type CreateCorrectedGenerationInput,
  type LegacyRecommendationContractRecord,
  type ReadRecommendationContractInput,
  type RecommendationContractPort,
  type RecommendationContractRecord,
  type WriteCorrectedRecommendationInput,
  type WriteQualificationFactInput,
} from "../../ports/recommendation-contract.port.js";

type GenerationContractRow = Readonly<{
  id?: unknown;
  qualificationContractVersion?: unknown;
  visibilityContractVersion?: unknown;
  scoreModelVersion?: unknown;
}>;

const tenantContext = (
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
  }>,
) => ({
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
  websiteProjectId: input.websiteProjectId,
});

const assertWorkerVersion = (workerContractVersion: string): void => {
  if (
    workerContractVersion !== CORRECTED_QUALIFICATION_CONTRACT_VERSION
  ) {
    throw new RecommendationContractVersionMismatchError(
      workerContractVersion,
    );
  }
};

const assertGenerationContract = (
  row: GenerationContractRow | undefined,
  generationContractId: string,
): void => {
  if (row?.id !== generationContractId) {
    throw new Error("Corrected recommendation generation contract was not found.");
  }
  if (
    row.qualificationContractVersion
      !== CORRECTED_QUALIFICATION_CONTRACT_VERSION
    || row.visibilityContractVersion !== CORRECTED_VISIBILITY_CONTRACT_VERSION
    || row.scoreModelVersion !== CORRECTED_SCORE_MODEL_VERSION
  ) {
    throw new Error("Corrected recommendation generation contract is incompatible.");
  }
};

const findGenerationContract = async (
  client: BacklinkTransactionClient,
  input: RecommendationContractScopeWithGeneration,
): Promise<GenerationContractRow | undefined> => {
  const result = await client.query(
    `SELECT id::text AS id,
            qualification_contract_version AS "qualificationContractVersion",
            visibility_contract_version AS "visibilityContractVersion",
            score_model_version AS "scoreModelVersion"
       FROM backlinks.backlink_recommendation_generation_contracts
       WHERE organization_id = $1
         AND workspace_id = $2
         AND website_project_id = $3
         AND recommendation_context_version_id = $4
         AND id = $5`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
      input.generationContractId,
    ],
  );
  return result.rows[0];
};

const findGenerationContractForVisibleGeneration = async (
  client: BacklinkTransactionClient,
  input: AssertCorrectedGenerationAvailableInput,
): Promise<GenerationContractRow | undefined> => {
  const result = await client.query(
    `SELECT id::text AS id,
            qualification_contract_version AS "qualificationContractVersion",
            visibility_contract_version AS "visibilityContractVersion",
            score_model_version AS "scoreModelVersion"
       FROM backlinks.backlink_recommendation_generation_contracts
       WHERE organization_id = $1
         AND workspace_id = $2
         AND website_project_id = $3
         AND recommendation_context_version_id = $4
         AND visible_pool_generation = $5`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
    ],
  );
  return result.rows[0];
};

type RecommendationContractScopeWithGeneration = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  recommendationContextVersionId: string;
  generationContractId: string;
}>;

const json = (value: unknown): string => JSON.stringify(value);

async function createGeneration(
  client: BacklinkTransactionClient,
  input: CreateCorrectedGenerationInput,
): Promise<void> {
  let generation = await findGenerationContract(client, input);
  if (generation === undefined) {
    await client.query(
      `INSERT INTO backlinks.backlink_recommendation_generation_contracts (
       id, organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, visible_pool_generation,
       input_pin_id, qualification_contract_version,
       visibility_contract_version, score_model_version, metric_scope,
       market, location, language, traffic_location_code,
       traffic_language_code, request_fingerprints,
       creator_worker_contract_version, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17::jsonb, $18, $19
     )
     ON CONFLICT ON CONSTRAINT backlink_rec_generation_scope_generation_uq
     DO NOTHING`,
      [
        input.generationContractId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        input.inputPinId,
        CORRECTED_QUALIFICATION_CONTRACT_VERSION,
        CORRECTED_VISIBILITY_CONTRACT_VERSION,
        CORRECTED_SCORE_MODEL_VERSION,
        input.metricScope,
        input.market,
        input.location,
        input.language,
        input.trafficLocationCode,
        input.trafficLanguageCode,
        json(input.requestFingerprints),
        input.workerContractVersion,
        input.createdBy,
      ],
    );
    generation = await findGenerationContract(client, input);
  }
  assertGenerationContract(generation, input.generationContractId);

  await client.query(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(
         hashtextextended(
           $2::uuid::text||':'||$3::uuid::text||':'||$4::uuid::text||':'||
             $5::uuid::text||':'||$7||':recommendation.generation.operation',
           0
         )
       )
     ),
     next_attempt AS (
       SELECT GREATEST(
         $9::integer,
         COALESCE(MAX(existing.attempt) + 1, 1)
       ) attempt
       FROM guard
       LEFT JOIN backlinks.backlink_generation_operation_facts existing
         ON existing.organization_id=$2
        AND existing.workspace_id=$3
        AND existing.website_project_id=$4
        AND existing.generation_contract_id=$5
        AND existing.operation_id=$7
     )
     INSERT INTO backlinks.backlink_generation_operation_facts (
       id, organization_id, workspace_id, website_project_id,
       generation_contract_id, recommendation_context_version_id,
       operation_id, operation_state, attempt, reason_code,
       fact_contract_version, worker_contract_version, evidence,
       observed_at, created_by
     )
     SELECT
       $1, $2, $3, $4, $5, $6, $7, $8, next_attempt.attempt,
       $10, $11, $12,
       $13::jsonb, $14, $15
     FROM next_attempt
     ON CONFLICT (id) DO NOTHING`,
    [
      input.operation.factId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.generationContractId,
      input.recommendationContextVersionId,
      input.operation.operationId,
      input.operation.state,
      input.operation.attempt,
      input.operation.reasonCode,
      CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      input.workerContractVersion,
      json(input.operation.evidence),
      input.operation.observedAt,
      input.createdBy,
    ],
  );
}

async function writeLegacyCompatibilityProjection(
  client: BacklinkTransactionClient,
  input: WriteCorrectedRecommendationInput,
): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_prospects (
       id, organization_id, workspace_id, website_project_id,
       recommendation_context_version_id, hostname_ascii,
       registrable_domain, normalization_version, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.prospectId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
      input.canonicalDomain,
      input.normalizationVersion,
      input.createdBy,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendations (
       id, organization_id, workspace_id, website_project_id, prospect_id,
       recommendation_context_version_id, status, created_by, updated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $7)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.recommendationId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.prospectId,
      input.recommendationContextVersionId,
      input.createdBy,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_scores (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       score_model_version, rule_version, total_score, components, weights,
       evidence, generated_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
       $12::jsonb, $13::jsonb, $14, $15
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      input.scoreId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationId,
      input.prospectId,
      input.recommendationContextVersionId,
      CORRECTED_SCORE_MODEL_VERSION,
      input.qualification.ruleVersion,
      input.totalScore,
      json(input.scoreComponents),
      json(input.scoreWeights),
      json(input.scoreEvidence),
      input.observedAt,
      input.createdBy,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_inventory (
       id, organization_id, workspace_id, website_project_id,
       recommendation_id, prospect_id, recommendation_context_version_id,
       visible_pool_generation, status, publication_status,
       verified_public_email_count, fit_decision, contact_decision,
       contact_reason_code, fit_score_model_version, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'ready', 'CONTACT_REVIEW',
       0, 'unassessed', 'pending', 'CORRECTED_CONTRACT_NOT_ACTIVE', NULL,
       $9, $9
     )
     ON CONFLICT (id) DO NOTHING`,
    [
      input.inventoryId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationId,
      input.prospectId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
      input.createdBy,
    ],
  );
}

async function writeCorrectedFacts(
  client: BacklinkTransactionClient,
  input: WriteCorrectedRecommendationInput,
): Promise<void> {
  const factBase = [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.generationContractId,
    input.recommendationContextVersionId,
    input.recommendationId,
    input.prospectId,
    input.canonicalDomain,
  ] as const;
  await client.query(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(
         hashtextextended(
           $2::uuid::text||':'||$3::uuid::text||':'||$4::uuid::text||':'||
             $5::uuid::text||':'||$9||':recommendation.qualification.fact',
           0
         )
       )
     ),
     next_attempt AS (
       SELECT GREATEST(
         $16::integer,
         COALESCE(MAX(existing.attempt) + 1, 1)
       ) attempt
       FROM guard
       LEFT JOIN backlinks.backlink_recommendation_qualification_facts
         existing
         ON existing.organization_id=$2
        AND existing.workspace_id=$3
        AND existing.website_project_id=$4
        AND existing.generation_contract_id=$5
        AND existing.canonical_domain=$9
     )
     INSERT INTO backlinks.backlink_recommendation_qualification_facts (
       id, organization_id, workspace_id, website_project_id,
       generation_contract_id, recommendation_context_version_id,
       recommendation_id, prospect_id, canonical_domain, metric_scope,
       traffic_organic_etv, spam_score, authority_rank,
       accessibility_decision, semantic_score, attempt, decision,
       decision_reason_code, score_model_version, model_version,
       prompt_version, rule_version, fact_contract_version,
       worker_contract_version, request_fingerprints, evidence,
       observed_at, created_by
     )
     SELECT
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, next_attempt.attempt, $17, $18, $19, $20, $21, $22, $23, $24,
       $25::jsonb, $26::jsonb, $27, $28
     FROM next_attempt
     ON CONFLICT (id) DO NOTHING`,
    [
      input.qualification.factId,
      ...factBase,
      input.qualification.metricScope,
      input.qualification.trafficOrganicEtv,
      input.qualification.spamScore,
      input.qualification.authorityRank,
      input.qualification.accessibilityDecision,
      input.qualification.semanticScore,
      input.qualification.attempt,
      input.qualification.decision,
      input.qualification.decisionReasonCode,
      CORRECTED_SCORE_MODEL_VERSION,
      input.qualification.modelVersion,
      input.qualification.promptVersion,
      input.qualification.ruleVersion,
      CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      input.workerContractVersion,
      json(input.qualification.requestFingerprints),
      json(input.qualification.evidence),
      input.observedAt,
      input.createdBy,
    ],
  );
  await client.query(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(
         hashtextextended(
           $2::uuid::text||':'||$3::uuid::text||':'||$4::uuid::text||':'||
             $5::uuid::text||':'||$10||':recommendation.visibility.fact',
           0
         )
       )
     ),
     next_attempt AS (
       SELECT GREATEST(
         $13::integer,
         COALESCE(MAX(existing.attempt) + 1, 1)
       ) attempt
       FROM guard
       LEFT JOIN backlinks.backlink_recommendation_visibility_facts
         existing
         ON existing.organization_id=$2
        AND existing.workspace_id=$3
        AND existing.website_project_id=$4
        AND existing.generation_contract_id=$5
        AND existing.canonical_domain=$10
     )
     INSERT INTO backlinks.backlink_recommendation_visibility_facts (
       id, organization_id, workspace_id, website_project_id,
       generation_contract_id, recommendation_context_version_id,
       qualification_fact_id, recommendation_id, prospect_id,
       canonical_domain, decision, decision_reason_code, attempt,
       rule_version, fact_contract_version, worker_contract_version,
       evidence, observed_at, created_by
     )
     SELECT
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       next_attempt.attempt,
       $14, $15, $16, $17::jsonb, $18, $19
     FROM next_attempt
     ON CONFLICT (id) DO NOTHING`,
    [
      input.visibility.factId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.generationContractId,
      input.recommendationContextVersionId,
      input.qualification.factId,
      input.recommendationId,
      input.prospectId,
      input.canonicalDomain,
      input.visibility.decision,
      input.visibility.decisionReasonCode,
      input.visibility.attempt,
      input.visibility.ruleVersion,
      CORRECTED_VISIBILITY_CONTRACT_VERSION,
      input.workerContractVersion,
      json(input.visibility.evidence),
      input.observedAt,
      input.createdBy,
    ],
  );
  for (const fact of [
    {
      table: "backlink_recommendation_contact_facts",
      id: input.contact.factId,
      decision: input.contact.decision,
      reasonCode: input.contact.decisionReasonCode,
      pathType: null,
      attempt: input.contact.attempt,
      evidence: input.contact.evidence,
    },
    {
      table: "backlink_recommendation_cooperation_path_facts",
      id: input.cooperationPath.factId,
      decision: input.cooperationPath.decision,
      reasonCode: input.cooperationPath.decisionReasonCode,
      pathType: input.cooperationPath.pathType,
      attempt: input.cooperationPath.attempt,
      evidence: input.cooperationPath.evidence,
    },
  ] as const) {
    const pathColumn = fact.pathType === null && fact.table.includes("contact")
      ? ""
      : ", path_type";
    const pathValue = pathColumn.length === 0 ? "" : ", $13";
    const versionOffset = pathColumn.length === 0 ? 0 : 1;
    await client.query(
      `WITH guard AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(
           hashtextextended(
             $2::uuid::text||':'||$3::uuid::text||':'||$4::uuid::text||':'||
               $5::uuid::text||':'||$9||':recommendation.${fact.table}.fact',
             0
           )
         )
       ),
       next_attempt AS (
         SELECT GREATEST(
           $12::integer,
           COALESCE(MAX(existing.attempt) + 1, 1)
         ) attempt
         FROM guard
         LEFT JOIN backlinks.${fact.table}
           existing
           ON existing.organization_id=$2
          AND existing.workspace_id=$3
          AND existing.website_project_id=$4
          AND existing.generation_contract_id=$5
          AND existing.canonical_domain=$9
       )
       INSERT INTO backlinks.${fact.table} (
         id, organization_id, workspace_id, website_project_id,
         generation_contract_id, recommendation_context_version_id,
         recommendation_id, prospect_id, canonical_domain, decision,
         decision_reason_code, attempt${pathColumn}, fact_contract_version,
         worker_contract_version, evidence, observed_at, created_by
       )
       SELECT
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         next_attempt.attempt${pathValue},
         $${13 + versionOffset}, $${14 + versionOffset},
         $${15 + versionOffset}::jsonb, $${16 + versionOffset},
         $${17 + versionOffset}
       FROM next_attempt
       ON CONFLICT (id) DO NOTHING`,
      [
        fact.id,
        ...factBase,
        fact.decision,
        fact.reasonCode,
        fact.attempt,
        ...(pathColumn.length === 0 ? [] : [fact.pathType]),
        CORRECTED_QUALIFICATION_CONTRACT_VERSION,
        input.workerContractVersion,
        json(fact.evidence),
        input.observedAt,
        input.createdBy,
      ],
    );
  }
}

export async function writeCorrectedRecommendationFactsInTransaction(
  client: BacklinkTransactionClient,
  input: WriteCorrectedRecommendationInput,
): Promise<void> {
  assertWorkerVersion(input.workerContractVersion);
  const generation = await findGenerationContract(client, input);
  assertGenerationContract(generation, input.generationContractId);
  await writeCorrectedFacts(client, input);
}

async function writeQualificationFact(
  client: BacklinkTransactionClient,
  input: WriteQualificationFactInput,
): Promise<void> {
  await client.query(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(
         hashtextextended(
           $2::uuid::text||':'||$3::uuid::text||':'||$4::uuid::text||':'||
             $5::uuid::text||':'||$8||':recommendation.qualification.fact',
           0
         )
       )
     ),
     next_attempt AS (
       SELECT GREATEST(
         $15::integer,
         COALESCE(MAX(existing.attempt) + 1, 1)
       ) attempt
       FROM guard
       LEFT JOIN backlinks.backlink_recommendation_qualification_facts
         existing
         ON existing.organization_id=$2
        AND existing.workspace_id=$3
        AND existing.website_project_id=$4
        AND existing.generation_contract_id=$5
        AND existing.canonical_domain=$8
     )
     INSERT INTO backlinks.backlink_recommendation_qualification_facts
       AS qualification (
       id, organization_id, workspace_id, website_project_id,
       generation_contract_id, recommendation_context_version_id,
       candidate_id, recommendation_id, prospect_id, canonical_domain,
       metric_scope, traffic_organic_etv, spam_score, authority_rank,
       accessibility_decision, semantic_score, attempt, decision,
       decision_reason_code, score_model_version, model_version,
       prompt_version, rule_version, fact_contract_version,
       worker_contract_version, request_fingerprints, evidence,
       observed_at, created_by
     )
     SELECT
       $1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $9, $10, $11, $12,
       $13, $14, next_attempt.attempt, $16, $17, $18, $19, $20, $21, $22, $23,
       $24::jsonb, $25::jsonb, $26, $27
     FROM next_attempt
     ON CONFLICT (id) DO NOTHING`,
    [
      input.qualification.factId,
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.generationContractId,
      input.recommendationContextVersionId,
      input.candidateId,
      input.canonicalDomain,
      input.qualification.metricScope,
      input.qualification.trafficOrganicEtv,
      input.qualification.spamScore,
      input.qualification.authorityRank,
      input.qualification.accessibilityDecision,
      input.qualification.semanticScore,
      input.qualification.attempt,
      input.qualification.decision,
      input.qualification.decisionReasonCode,
      CORRECTED_SCORE_MODEL_VERSION,
      input.qualification.modelVersion,
      input.qualification.promptVersion,
      input.qualification.ruleVersion,
      CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      input.workerContractVersion,
      json(input.qualification.requestFingerprints),
      json(input.qualification.evidence),
      input.observedAt,
      input.createdBy,
    ],
  );
}

const mapCorrectedRecord = (
  row: Record<string, unknown>,
): CorrectedRecommendationContractRecord => ({
  contractKind: "corrected-v1",
  recommendationId: String(row.recommendationId),
  prospectId: String(row.prospectId),
  canonicalDomain: String(row.canonicalDomain),
  visiblePoolGeneration: Number(row.visiblePoolGeneration),
  totalScore: Number(row.totalScore),
  qualificationDecision: String(row.qualificationDecision),
  qualificationReasonCode: String(row.qualificationReasonCode),
  visibilityDecision:
    row.visibilityDecision === null ? null : String(row.visibilityDecision),
  contactDecision:
    row.contactDecision === null ? null : String(row.contactDecision),
  cooperationPathDecision:
    row.cooperationPathDecision === null
      ? null
      : String(row.cooperationPathDecision),
});

const mapLegacyRecord = (
  row: Record<string, unknown>,
): LegacyRecommendationContractRecord => ({
  contractKind: "legacy-v3",
  recommendationId: String(row.recommendationId),
  prospectId: String(row.prospectId),
  canonicalDomain: String(row.canonicalDomain),
  visiblePoolGeneration: Number(row.visiblePoolGeneration),
  totalScore: Number(row.totalScore),
  publicationStatus: String(row.publicationStatus),
  fitDecision: String(row.fitDecision),
  contactDecision: String(row.contactDecision),
});

async function readRecommendation(
  client: BacklinkTransactionClient,
  input: ReadRecommendationContractInput,
): Promise<RecommendationContractRecord | null> {
  const values = [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.recommendationContextVersionId,
    input.recommendationId,
  ];
  const corrected = await client.query(
    `SELECT q.recommendation_id::text AS "recommendationId",
            q.prospect_id::text AS "prospectId",
            q.canonical_domain AS "canonicalDomain",
            generation.visible_pool_generation AS "visiblePoolGeneration",
            score.total_score AS "totalScore",
            q.decision AS "qualificationDecision",
            q.decision_reason_code AS "qualificationReasonCode",
            visibility.decision AS "visibilityDecision",
            contact.decision AS "contactDecision",
            cooperation.decision AS "cooperationPathDecision"
       FROM backlinks.backlink_recommendation_qualification_facts q
       JOIN backlinks.backlink_recommendation_generation_contracts generation
         ON generation.id = q.generation_contract_id
        AND generation.organization_id = q.organization_id
        AND generation.workspace_id = q.workspace_id
        AND generation.website_project_id = q.website_project_id
       JOIN LATERAL (
         SELECT total_score
           FROM backlinks.backlink_recommendation_scores
          WHERE organization_id = q.organization_id
            AND workspace_id = q.workspace_id
            AND website_project_id = q.website_project_id
            AND recommendation_id = q.recommendation_id
          ORDER BY generated_at DESC, id DESC
          LIMIT 1
       ) score ON true
       LEFT JOIN LATERAL (
         SELECT decision
           FROM backlinks.backlink_recommendation_visibility_facts
          WHERE organization_id = q.organization_id
            AND workspace_id = q.workspace_id
            AND website_project_id = q.website_project_id
            AND qualification_fact_id = q.id
          ORDER BY attempt DESC
          LIMIT 1
       ) visibility ON true
       LEFT JOIN LATERAL (
         SELECT decision
           FROM backlinks.backlink_recommendation_contact_facts
          WHERE organization_id = q.organization_id
            AND workspace_id = q.workspace_id
            AND website_project_id = q.website_project_id
            AND recommendation_id = q.recommendation_id
          ORDER BY attempt DESC
          LIMIT 1
       ) contact ON true
       LEFT JOIN LATERAL (
         SELECT decision
           FROM backlinks.backlink_recommendation_cooperation_path_facts
          WHERE organization_id = q.organization_id
            AND workspace_id = q.workspace_id
            AND website_project_id = q.website_project_id
            AND recommendation_id = q.recommendation_id
          ORDER BY attempt DESC
          LIMIT 1
       ) cooperation ON true
      WHERE q.organization_id = $1
        AND q.workspace_id = $2
        AND q.website_project_id = $3
        AND q.recommendation_context_version_id = $4
        AND q.recommendation_id = $5
      ORDER BY q.attempt DESC
      LIMIT 1`,
    values,
  );
  const correctedRow = corrected.rows[0];
  if (correctedRow !== undefined) {
    return mapCorrectedRecord(correctedRow);
  }

  const legacy = await client.query(
    `SELECT inventory.recommendation_id::text AS "recommendationId",
            inventory.prospect_id::text AS "prospectId",
            prospect.registrable_domain AS "canonicalDomain",
            inventory.visible_pool_generation AS "visiblePoolGeneration",
            COALESCE(score.total_score, 0) AS "totalScore",
            inventory.publication_status AS "publicationStatus",
            inventory.fit_decision AS "fitDecision",
            inventory.contact_decision AS "contactDecision"
       FROM backlinks.backlink_recommendation_inventory inventory
       JOIN backlinks.backlink_prospects prospect
         ON prospect.organization_id = inventory.organization_id
        AND prospect.workspace_id = inventory.workspace_id
        AND prospect.website_project_id = inventory.website_project_id
        AND prospect.id = inventory.prospect_id
        AND prospect.recommendation_context_version_id =
            inventory.recommendation_context_version_id
       LEFT JOIN LATERAL (
         SELECT total_score
           FROM backlinks.backlink_recommendation_scores
          WHERE organization_id = inventory.organization_id
            AND workspace_id = inventory.workspace_id
            AND website_project_id = inventory.website_project_id
            AND recommendation_id = inventory.recommendation_id
          ORDER BY generated_at DESC, id DESC
          LIMIT 1
       ) score ON true
      WHERE inventory.organization_id = $1
        AND inventory.workspace_id = $2
        AND inventory.website_project_id = $3
        AND inventory.recommendation_context_version_id = $4
        AND inventory.recommendation_id = $5
      ORDER BY inventory.visible_pool_generation DESC
      LIMIT 1`,
    values,
  );
  const legacyRow = legacy.rows[0];
  return legacyRow === undefined ? null : mapLegacyRecord(legacyRow);
}

export function createRecommendationContractRepository(
  pool: BacklinkTenantPool,
): RecommendationContractPort {
  return Object.freeze({
    assertCorrectedGenerationAvailable: async (
      input: AssertCorrectedGenerationAvailableInput,
    ) => {
      assertWorkerVersion(input.workerContractVersion);
      await withBacklinkTenantTransaction(
        pool,
        tenantContext(input),
        async (client) => {
          const generation =
            await findGenerationContractForVisibleGeneration(client, input);
          if (generation !== undefined) {
            assertGenerationContract(
              generation,
              input.generationContractId,
            );
          }
        },
      );
    },
    createCorrectedGeneration: async (
      input: CreateCorrectedGenerationInput,
    ) => {
      assertWorkerVersion(input.workerContractVersion);
      await withBacklinkTenantTransaction(
        pool,
        tenantContext(input),
        (client) => createGeneration(client, input),
      );
    },
    writeCorrectedRecommendation: async (
      input: WriteCorrectedRecommendationInput,
    ) => {
      assertWorkerVersion(input.workerContractVersion);
      await withBacklinkTenantTransaction(
        pool,
        tenantContext(input),
        async (client) => {
          const generation = await findGenerationContract(client, input);
          assertGenerationContract(generation, input.generationContractId);
          await writeLegacyCompatibilityProjection(client, input);
          await writeCorrectedFacts(client, input);
        },
      );
    },
    writeQualificationFact: async (
      input: WriteQualificationFactInput,
    ) => {
      assertWorkerVersion(input.workerContractVersion);
      await withBacklinkTenantTransaction(
        pool,
        tenantContext(input),
        async (client) => {
          const generation = await findGenerationContract(client, input);
          assertGenerationContract(generation, input.generationContractId);
          await writeQualificationFact(client, input);
        },
      );
    },
    readRecommendation: (input: ReadRecommendationContractInput) =>
      withBacklinkTenantTransaction(
        pool,
        tenantContext(input),
        (client) => readRecommendation(client, input),
      ),
  });
}
