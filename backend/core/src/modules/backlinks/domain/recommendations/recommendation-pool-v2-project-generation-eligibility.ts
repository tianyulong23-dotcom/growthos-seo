const generatableMigrationStates = new Set(["V2_READY", "V2_ACTIVE"]);
const candidateLineageIncompleteReason = "V2_CANDIDATE_LINEAGE_INCOMPLETE";

export function isRecommendationPoolV2ProjectGeneratable(
  project: Readonly<{
    poolContractVersion?: unknown;
    migrationState?: unknown;
    stateReasonCodes?: unknown;
    v1WritesFrozen?: unknown;
  }>,
): boolean {
  if (project.poolContractVersion !== "recommendation-pool.v2") {
    return false;
  }
  if (generatableMigrationStates.has(String(project.migrationState))) {
    return true;
  }
  return (
    project.migrationState === "MIGRATION_BLOCKED" &&
    project.v1WritesFrozen === true &&
    Array.isArray(project.stateReasonCodes) &&
    project.stateReasonCodes.length === 1 &&
    project.stateReasonCodes[0] === candidateLineageIncompleteReason
  );
}
