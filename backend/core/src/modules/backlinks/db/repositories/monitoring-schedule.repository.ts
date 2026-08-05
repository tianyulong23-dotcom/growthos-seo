import type {
  PlacementMonitoringHealthStatus,
} from "../../domain/monitoring/schedule-policy.js";

export type MonitoringScheduleQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type ListDueMonitoringInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  dueAt: Date;
  limit: number;
}>;

export type DueMonitoringPlacement = Readonly<{
  monitorPolicyId: string;
  placementId: string;
  policyVersion: string;
  normalIntervalSeconds: number;
  suspectedRecheckIntervalSeconds: number;
  jitterWindowSeconds: number;
  browserFallbackEnabled: boolean;
  nextCheckAt: Date;
  placementVersion: number;
  healthStatus: PlacementMonitoringHealthStatus;
  sourcePageUrl: string;
  targetUrl: string;
  projectContextSnapshotVersion: number;
}>;

function validateListInput(input: ListDueMonitoringInput): void {
  if (
    !Number.isFinite(input.dueAt.getTime()) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new TypeError("dueAt and limit must be valid");
  }
}

export function createMonitoringScheduleRepository(
  client: MonitoringScheduleQueryClient,
) {
  return {
    async listDue(
      input: ListDueMonitoringInput,
    ): Promise<readonly DueMonitoringPlacement[]> {
      validateListInput(input);
      const result = await client.query(`
        WITH current_project AS (
          SELECT snapshot_version
            FROM backlink_project_context_snapshots
           WHERE organization_id=$1
             AND workspace_id=$2
             AND website_project_id=$3
             AND project_status='ACTIVE'
             AND snapshot_version=(
               SELECT max(latest.snapshot_version)
                 FROM backlink_project_context_snapshots latest
                WHERE latest.organization_id=$1
                  AND latest.workspace_id=$2
                  AND latest.website_project_id=$3
             )
        )
        SELECT policy.id AS "monitorPolicyId",
               policy.placement_id AS "placementId",
               policy.policy_version AS "policyVersion",
               policy.normal_interval_seconds AS "normalIntervalSeconds",
               policy.suspected_recheck_interval_seconds
                 AS "suspectedRecheckIntervalSeconds",
               policy.jitter_window_seconds AS "jitterWindowSeconds",
               policy.browser_fallback_enabled AS "browserFallbackEnabled",
               policy.next_check_at AS "nextCheckAt",
               placement.version AS "placementVersion",
               placement.health_status AS "healthStatus",
               placement.source_page_url AS "sourcePageUrl",
               placement.target_url AS "targetUrl",
               current_project.snapshot_version
                 AS "projectContextSnapshotVersion"
          FROM backlink_monitor_policies policy
          JOIN backlink_placements placement
            ON (
              placement.organization_id,
              placement.workspace_id,
              placement.website_project_id,
              placement.id
            )=(
              policy.organization_id,
              policy.workspace_id,
              policy.website_project_id,
              policy.placement_id
            )
         CROSS JOIN current_project
         WHERE policy.organization_id=$1
           AND policy.workspace_id=$2
           AND policy.website_project_id=$3
           AND policy.next_check_at<=$4
           AND placement.monitoring_status='enabled'
           AND NOT EXISTS (
             SELECT 1
               FROM backlink_monitor_runs run
              WHERE (
                run.organization_id,
                run.workspace_id,
                run.website_project_id,
                run.placement_id,
                run.scheduled_for,
                run.policy_version,
                run.execution_mode
              )=(
                policy.organization_id,
                policy.workspace_id,
                policy.website_project_id,
                policy.placement_id,
                policy.next_check_at,
                policy.policy_version,
                'static'
              )
           )
         ORDER BY policy.next_check_at, policy.placement_id,
                  policy.policy_version
         LIMIT $5
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.dueAt,
        input.limit,
      ]);
      return result.rows as readonly DueMonitoringPlacement[];
    },
  };
}
