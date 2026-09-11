export type BacklinksDeploymentManifestStep = Readonly<{
  migrationId: string;
  fileName: string;
  sql: string;
}>;

export type BacklinksDeploymentManifestPlanOptions = Readonly<{
  startRevision: string;
  targetRevision: string;
  manifestUrl?: URL;
  migrationsDirectoryUrl?: URL;
  bootstrapUrl?: URL;
}>;

export function planBacklinksDeploymentManifest(
  options: BacklinksDeploymentManifestPlanOptions,
): Promise<readonly BacklinksDeploymentManifestStep[]>;

export function applyBacklinksDeploymentManifest(
  options: BacklinksDeploymentManifestPlanOptions &
    Readonly<{
      query(sql: string): Promise<unknown>;
    }>,
): Promise<readonly BacklinksDeploymentManifestStep[]>;
