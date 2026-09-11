export const recommendationPoolContractVersions = Object.freeze({
  v1: "recommendation-pool.v1",
  v2: "recommendation-pool.v2",
} as const);

export const recommendationRefillRequestedEventType =
  "backlinks.recommendation-refill.requested.v1";

export const recommendationPoolContractGuardQueryMarker =
  "recommendation_pool_contract_guard";

export type RecommendationPoolContractNotApplicable = Readonly<{
  status: "contract_not_applicable";
  poolContractVersion: typeof recommendationPoolContractVersions.v2;
}>;

export const recommendationPoolContractNotApplicable =
  Object.freeze<RecommendationPoolContractNotApplicable>({
    status: "contract_not_applicable",
    poolContractVersion: recommendationPoolContractVersions.v2,
  });

type RecommendationPoolContractQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

type ApplicableRecommendationPoolContract = Readonly<{
  status: "applicable";
  poolContractVersion: typeof recommendationPoolContractVersions.v1;
  visiblePoolGeneration: number;
}>;

export type RecommendationPoolContractGuardResult =
  | ApplicableRecommendationPoolContract
  | RecommendationPoolContractNotApplicable;

type RecommendationPoolProjectScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

const legacyQualificationContractVersion =
  "recommendation-qualification.v1";
const legacyVisibilityContractVersion =
  "recommendation-visibility.v1";
const legacyScoreModelVersions = new Set([
  "recommendation-commercial-fit.v3",
  "recommendation-commercial-fit.v4",
]);

const unavailable = () =>
  new Error("BACKLINK_RECOMMENDATION_POOL_CONTRACT_UNAVAILABLE");

export async function guardV1RecommendationPoolProjectWrites(
  client: RecommendationPoolContractQueryClient,
  input: RecommendationPoolProjectScope,
): Promise<
  | Readonly<{
      status: "applicable";
      poolContractVersion: typeof recommendationPoolContractVersions.v1;
    }>
  | RecommendationPoolContractNotApplicable
> {
  const result = await client.query(
    `/* ${recommendationPoolContractGuardQueryMarker}:project_writes */
     SELECT contract.pool_contract_version "poolContractVersion",
            contract.migration_state "migrationState",
            EXISTS (
              SELECT 1
                FROM backlink_recommendation_pool_v2_cutover_control
               WHERE control_key='GLOBAL'
                 AND state='V1_WRITES_FROZEN'
            ) "v1WritesFrozen"
       FROM backlink_recommendation_pool_project_contracts AS contract
      WHERE (
        contract.organization_id,contract.workspace_id,
        contract.website_project_id
      )=($1,$2,$3)
      LIMIT 2`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
    ],
  );
  if (result.rows.length !== 1) throw unavailable();
  const row = result.rows[0];
  if (row === undefined) throw unavailable();
  if (
    row.v1WritesFrozen === true
    || row.poolContractVersion === recommendationPoolContractVersions.v2
    || row.migrationState !== "V1_ACTIVE"
  ) {
    return recommendationPoolContractNotApplicable;
  }
  if (row.poolContractVersion !== recommendationPoolContractVersions.v1) {
    throw unavailable();
  }
  return Object.freeze({
    status: "applicable",
    poolContractVersion: recommendationPoolContractVersions.v1,
  });
}

function classifyExactGeneration(
  rows: readonly Record<string, unknown>[],
): RecommendationPoolContractGuardResult {
  if (rows.length !== 1) throw unavailable();
  const row = rows[0];
  if (row === undefined) throw unavailable();
  const visiblePoolGeneration = Number(row.visiblePoolGeneration);
  if (!Number.isSafeInteger(visiblePoolGeneration) || visiblePoolGeneration < 1)
    throw unavailable();

  if (
    row.poolContractVersion === recommendationPoolContractVersions.v2
  ) {
    return recommendationPoolContractNotApplicable;
  }
  if (
    row.poolContractVersion === recommendationPoolContractVersions.v1
    || (
      row.poolContractVersion == null
      && row.qualificationContractVersion
        === legacyQualificationContractVersion
      && row.visibilityContractVersion === legacyVisibilityContractVersion
      && typeof row.scoreModelVersion === "string"
      && legacyScoreModelVersions.has(row.scoreModelVersion)
    )
  ) {
    return Object.freeze({
      status: "applicable",
      poolContractVersion: recommendationPoolContractVersions.v1,
      visiblePoolGeneration,
    });
  }
  throw unavailable();
}

const contractProjection = (alias: string) => `
       to_jsonb(${alias})->>'pool_contract_version' "poolContractVersion",
       ${alias}.qualification_contract_version "qualificationContractVersion",
       ${alias}.visibility_contract_version "visibilityContractVersion",
       ${alias}.score_model_version "scoreModelVersion",
       ${alias}.visible_pool_generation "visiblePoolGeneration"`;

export function v1RecommendationPoolContractSqlPredicate(
  alias: string,
): string {
  return `(
    to_jsonb(${alias})->>'pool_contract_version'=
      '${recommendationPoolContractVersions.v1}'
    OR (
      to_jsonb(${alias})->>'pool_contract_version' IS NULL
      AND ${alias}.qualification_contract_version=
        '${legacyQualificationContractVersion}'
      AND ${alias}.visibility_contract_version=
        '${legacyVisibilityContractVersion}'
      AND ${alias}.score_model_version IN (
        'recommendation-commercial-fit.v3',
        'recommendation-commercial-fit.v4'
      )
    )
  )`;
}

export async function guardV1RecommendationPoolGeneration(
  client: RecommendationPoolContractQueryClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    recommendationContextVersionId: string;
    visiblePoolGeneration: number;
  }>,
): Promise<RecommendationPoolContractGuardResult> {
  const projectContract = await guardV1RecommendationPoolProjectWrites(
    client,
    input,
  );
  if (projectContract.status === "contract_not_applicable") {
    return projectContract;
  }
  const result = await client.query(
    `/* ${recommendationPoolContractGuardQueryMarker}:generation */
     SELECT ${contractProjection("contract")}
       FROM backlink_recommendation_generation_contracts AS contract
      WHERE (
        contract.organization_id,contract.workspace_id,
        contract.website_project_id,
        contract.recommendation_context_version_id,
        contract.visible_pool_generation
      )=($1,$2,$3,$4,$5)
      LIMIT 2`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
    ],
  );
  return classifyExactGeneration(result.rows);
}

export async function guardV1RecommendationPoolJob(
  client: RecommendationPoolContractQueryClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    jobId: string;
  }>,
): Promise<RecommendationPoolContractGuardResult> {
  const projectContract = await guardV1RecommendationPoolProjectWrites(
    client,
    input,
  );
  if (projectContract.status === "contract_not_applicable") {
    return projectContract;
  }
  const result = await client.query(
    `/* ${recommendationPoolContractGuardQueryMarker}:job */
     SELECT ${contractProjection("contract")}
       FROM backlink_jobs AS job
       JOIN backlink_recommendation_refills AS refill
         ON (
           refill.organization_id,refill.workspace_id,
           refill.website_project_id,refill.job_id
         )=(
           job.organization_id,job.workspace_id,
           job.website_project_id,job.id
         )
       JOIN backlink_recommendation_generation_contracts AS contract
         ON (
           contract.organization_id,contract.workspace_id,
           contract.website_project_id,
           contract.recommendation_context_version_id,
           contract.visible_pool_generation
         )=(
           refill.organization_id,refill.workspace_id,
           refill.website_project_id,
           refill.recommendation_context_version_id,
           refill.visible_pool_generation
         )
      WHERE (
        job.organization_id,job.workspace_id,
        job.website_project_id,job.id
      )=($1,$2,$3,$4)
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
      LIMIT 2`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.jobId,
    ],
  );
  return classifyExactGeneration(result.rows);
}

export async function guardV1RecommendationPoolCurrentGeneration(
  client: RecommendationPoolContractQueryClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    recommendationContextVersionId: string;
  }>,
): Promise<RecommendationPoolContractGuardResult> {
  const projectContract = await guardV1RecommendationPoolProjectWrites(
    client,
    input,
  );
  if (projectContract.status === "contract_not_applicable") {
    return projectContract;
  }
  const result = await client.query(
    `/* ${recommendationPoolContractGuardQueryMarker}:current_generation */
     SELECT ${contractProjection("contract")}
       FROM backlink_commercial_inventory_policies AS policy
       JOIN backlink_recommendation_generation_contracts AS contract
         ON (
           contract.organization_id,contract.workspace_id,
           contract.website_project_id,
           contract.recommendation_context_version_id,
           contract.visible_pool_generation
         )=(
           policy.organization_id,policy.workspace_id,
           policy.website_project_id,
           policy.project_context_version_id,
           policy.visible_pool_generation
         )
      WHERE (
        policy.organization_id,policy.workspace_id,
        policy.website_project_id,policy.project_context_version_id
      )=($1,$2,$3,$4)
      LIMIT 2`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
    ],
  );
  return classifyExactGeneration(result.rows);
}
