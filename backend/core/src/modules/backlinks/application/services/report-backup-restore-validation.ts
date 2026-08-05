export type BackupRestoreEvidence = Readonly<{
  targetEnvironment: string;
  sourceBackupCreatedAt: Date;
  validationStartedAt: Date;
  validationCompletedAt: Date;
  expectedMigrationHead: string;
  restoredMigrationHead: string;
  sourceCounts: Readonly<Record<string, number>>;
  restoredCounts: Readonly<Record<string, number>>;
  rpoMilliseconds: number;
  rtoMilliseconds: number;
}>;

export function validateBackupRestoreEvidence(
  evidence: BackupRestoreEvidence,
) {
  if (evidence.targetEnvironment !== "temporary") {
    throw new Error("Backup restore validation must target a temporary database.");
  }
  const recoveryPointAge =
    evidence.validationStartedAt.getTime()
    - evidence.sourceBackupCreatedAt.getTime();
  const recoveryDuration =
    evidence.validationCompletedAt.getTime()
    - evidence.validationStartedAt.getTime();
  if (
    recoveryPointAge < 0
    || recoveryPointAge > evidence.rpoMilliseconds
  ) {
    throw new Error("Backup restore evidence exceeds the declared RPO.");
  }
  if (
    recoveryDuration < 0
    || recoveryDuration > evidence.rtoMilliseconds
  ) {
    throw new Error("Backup restore evidence exceeds the declared RTO.");
  }
  if (evidence.restoredMigrationHead !== evidence.expectedMigrationHead) {
    throw new Error("Restored migration head does not match.");
  }
  const tableNames = [...new Set([
    ...Object.keys(evidence.sourceCounts),
    ...Object.keys(evidence.restoredCounts),
  ])].sort();
  for (const tableName of tableNames) {
    if (
      evidence.sourceCounts[tableName] !== evidence.restoredCounts[tableName]
    ) {
      throw new Error(`Restored key table count differs for ${tableName}.`);
    }
  }
  return {
    valid: true,
    migrationHead: evidence.restoredMigrationHead,
    recoveryPointAgeMilliseconds: recoveryPointAge,
    recoveryDurationMilliseconds: recoveryDuration,
    validatedTables: tableNames,
  } as const;
}
