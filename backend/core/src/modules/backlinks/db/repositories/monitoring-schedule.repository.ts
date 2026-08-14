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

export type DueMonitoringInventoryItem = Readonly<{
  monitorPolicyId: string;
  placementId: string;
  policyVersion: "inventory-monitoring-v1";
  nextCheckAt: Date;
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
               WHERE run.organization_id=policy.organization_id
                 AND run.workspace_id=policy.workspace_id
                 AND run.website_project_id=policy.website_project_id
                 AND run.placement_id=policy.placement_id
                 AND date_trunc('milliseconds',run.scheduled_for)
                   =date_trunc('milliseconds',policy.next_check_at)
                 AND run.policy_version=policy.policy_version
                 AND run.execution_mode='static'
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

export function createInventoryMonitoringScheduleRepository(
  client: MonitoringScheduleQueryClient,
) {
  return {
    async listDue(
      input: ListDueMonitoringInput,
    ): Promise<readonly DueMonitoringInventoryItem[]> {
      validateListInput(input);
      const result = await client.query(`
        WITH current_project AS (
          SELECT project_status
            FROM backlink_project_context_snapshots
           WHERE organization_id=$1 AND workspace_id=$2
             AND website_project_id=$3
           ORDER BY snapshot_version DESC
           LIMIT 1
        )
        SELECT policy.id "monitorPolicyId",
               policy.inventory_item_id "placementId",
               policy.policy_version "policyVersion",
               policy.next_check_at "nextCheckAt"
          FROM backlink_inventory_monitor_policies policy
          JOIN current_project project ON project.project_status='ACTIVE'
         WHERE policy.organization_id=$1 AND policy.workspace_id=$2
           AND policy.website_project_id=$3
           AND policy.monitoring_status='enabled'
           AND policy.next_check_at<=$4
           AND NOT EXISTS (
             SELECT 1
               FROM backlink_inventory_monitor_runs run
              WHERE run.organization_id=policy.organization_id
                AND run.workspace_id=policy.workspace_id
                AND run.website_project_id=policy.website_project_id
                AND run.inventory_item_id=policy.inventory_item_id
                AND date_trunc('milliseconds',run.scheduled_for)
                  =date_trunc('milliseconds',policy.next_check_at)
                AND run.policy_version=policy.policy_version
                AND run.execution_mode='static'
           )
         ORDER BY policy.next_check_at,policy.inventory_item_id
         LIMIT $5
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.dueAt,
        input.limit,
      ]);
      return result.rows.map((row) => ({
        monitorPolicyId: String(row.monitorPolicyId),
        placementId: String(row.placementId),
        policyVersion: "inventory-monitoring-v1" as const,
        nextCheckAt: row.nextCheckAt instanceof Date
          ? row.nextCheckAt
          : new Date(String(row.nextCheckAt)),
      }));
    },
  };
}
