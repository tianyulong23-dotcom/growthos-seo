import { BacklinkError, backlinkErrorCodes } from "../errors/backlink-error.js";
import { recommendationPoolContractVersions } from "./recommendation-pool-contract-guard.js";

export const recommendationPoolReadContractQueryMarker =
  "recommendation_pool_read_contract";

type RecommendationPoolReadContractClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

type RecommendationPoolReadScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

const unavailable = () =>
  new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message: "The legacy recommendation pool read contract is unavailable.",
  });

export async function assertV1RecommendationPoolReadContract(
  client: RecommendationPoolReadContractClient,
  scope: RecommendationPoolReadScope,
): Promise<void> {
  let result: Readonly<{ rows: readonly Record<string, unknown>[] }>;
  try {
    result = await client.query(
      `/* ${recommendationPoolReadContractQueryMarker}:project */
       SELECT contract.pool_contract_version "poolContractVersion",
              contract.migration_state "migrationState"
         FROM backlink_recommendation_pool_project_contracts AS contract
        WHERE (
          contract.organization_id,contract.workspace_id,
          contract.website_project_id
        )=($1,$2,$3)
        ORDER BY contract.id
        LIMIT 2
        FOR SHARE OF contract`,
      [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "42P01"
    ) {
      return;
    }
    throw error;
  }
  if (result.rows.length === 0) return;
  if (result.rows.length !== 1) throw unavailable();
  const row = result.rows[0];
  if (
    row?.poolContractVersion !== recommendationPoolContractVersions.v1 ||
    (row.migrationState !== "V1_ACTIVE" &&
      row.migrationState !== "MIGRATION_BLOCKED")
  ) {
    throw unavailable();
  }
}
