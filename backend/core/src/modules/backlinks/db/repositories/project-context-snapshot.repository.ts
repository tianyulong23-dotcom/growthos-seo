import {
  projectContextSnapshotStatuses,
} from "../schema/project-context-snapshot.js";

export type ProjectContextSnapshotStatus =
  (typeof projectContextSnapshotStatuses)[number];
export type ProjectContextSnapshotQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<Readonly<{
    rows: readonly Record<string, unknown>[];
  }>>;
}>;
type ProjectContextSnapshotScope = Readonly<{
  organizationId: string; workspaceId: string; websiteProjectId: string;
}>;
export type AppendProjectContextSnapshotInput =
  ProjectContextSnapshotScope & Readonly<{
    snapshotId: string; snapshotVersion: number;
    projectStatus: ProjectContextSnapshotStatus; canonicalDomain: string;
    locale: string; countryCode: string; profileVersionId: string;
    promotionTargetVersionId: string;
    products: readonly string[]; keywords: readonly string[];
    targetUrls: readonly string[];
    actorId: string;
  }>;
export type ProjectContextSnapshot = Omit<
  AppendProjectContextSnapshotInput,
  "actorId"
> & Readonly<{ createdAt: Date; createdBy: string }>;

const selection = `
  id AS "snapshotId", organization_id AS "organizationId",
  workspace_id AS "workspaceId", website_project_id AS "websiteProjectId",
  snapshot_version AS "snapshotVersion", project_status AS "projectStatus",
  canonical_domain AS "canonicalDomain", locale, country_code AS "countryCode",
  profile_version_id AS "profileVersionId",
  promotion_target_version_id AS "promotionTargetVersionId",
  products, keywords, target_urls AS "targetUrls",
  created_at AS "createdAt", created_by AS "createdBy"`;

export function createProjectContextSnapshotRepository(
  client: ProjectContextSnapshotQueryClient,
) {
  return {
    async append(input: AppendProjectContextSnapshotInput):
      Promise<ProjectContextSnapshot> {
      const result = await client.query(
        `INSERT INTO backlink_project_context_snapshots (
           id, organization_id, workspace_id, website_project_id,
           snapshot_version, project_status, canonical_domain, locale,
           country_code, profile_version_id, promotion_target_version_id,
           products, keywords, target_urls, created_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,
           $14::jsonb,$15
         )
         RETURNING ${selection}`,
        [
          input.snapshotId, input.organizationId, input.workspaceId, input.websiteProjectId,
          input.snapshotVersion, input.projectStatus, input.canonicalDomain,
          input.locale, input.countryCode,
          input.profileVersionId, input.promotionTargetVersionId,
          JSON.stringify(input.products), JSON.stringify(input.keywords),
          JSON.stringify(input.targetUrls), input.actorId,
        ],
      );
      return result.rows[0] as ProjectContextSnapshot;
    },

    async findLatest(scope: ProjectContextSnapshotScope):
      Promise<ProjectContextSnapshot | null> {
      const result = await client.query(
        `SELECT ${selection}
           FROM backlink_project_context_snapshots
          WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
          ORDER BY snapshot_version DESC
          LIMIT 1`,
        [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
      );
      return (result.rows[0] as ProjectContextSnapshot | undefined) ?? null;
    },
  };
}
