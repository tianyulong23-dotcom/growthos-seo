import {
  withBacklinkWorkspaceTransaction,
  type BacklinkTenantPool,
} from "../tenant-transaction.js";
import {
  projectScopeLanes,
  type ActiveProjectScope,
  type ProjectScopeProvider,
} from "../../ports/project-scope-provider.port.js";

const maximumPageSize = 100;

export function createPostgresqlProjectScopeProvider(
  pool: BacklinkTenantPool,
): ProjectScopeProvider {
  return Object.freeze({
    async listActiveProjectScopes(input) {
      if (
        !projectScopeLanes.includes(input.lane)
        || !Number.isInteger(input.limit)
        || input.limit < 1
        || input.limit > maximumPageSize
      ) {
        throw new Error("BACKLINK_PROJECT_SCOPE_PAGE_INVALID");
      }
      return withBacklinkWorkspaceTransaction(
        pool,
        input,
        async (client) => {
          const result = await client.query(
            `SELECT organization_id AS "organizationId",
                    workspace_id AS "workspaceId",
                    website_project_id AS "websiteProjectId",
                    project_context_snapshot_id AS
                      "projectContextSnapshotId",
                    project_context_snapshot_version AS
                      "projectContextSnapshotVersion"
               FROM backlinks.backlink_list_active_project_scopes(
                 $1,$2,$3,$4
               )`,
            [
              input.organizationId,
              input.workspaceId,
              input.cursor,
              input.limit + 1,
            ],
          );
          const rows = result.rows.map((row): ActiveProjectScope => ({
            organizationId: String(row.organizationId),
            workspaceId: String(row.workspaceId),
            websiteProjectId: String(row.websiteProjectId),
            projectContextSnapshotId: String(
              row.projectContextSnapshotId,
            ),
            projectContextSnapshotVersion: Number(
              row.projectContextSnapshotVersion,
            ),
          }));
          const scopes = rows.slice(0, input.limit);
          return Object.freeze({
            scopes: Object.freeze(scopes),
            nextCursor: rows.length > input.limit
              ? scopes.at(-1)?.websiteProjectId ?? null
              : null,
          });
        },
      );
    },
  });
}
