import { createHash, randomUUID } from "node:crypto";

import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BACKLINK_PLACEMENT_MONITORING_REQUESTED,
} from "../../workflows/outbox-relay.js";
import type {
  PlacementMonitorPublicStatus,
} from "../queries/placement-links.query.js";

export type PlacementReverifyCommandClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
export type PlacementReverifyCommandInput = Readonly<{
  context: ResolvedProjectContext;
  placementId: string;
  expectedVersion: number;
  idempotencyKey: string;
  requestId: string;
}>;
export type PlacementReverifyResult = Readonly<{
  placementId: string;
  placementVersion: number;
  accepted: boolean;
  replayed: boolean;
  browserFallbackAllowed: false;
  monitorRun: Readonly<{
    monitorRunId: string;
    status: Exclude<PlacementMonitorPublicStatus, "idle">;
    scheduledFor: string;
  }>;
}>;

type ResultRow = Readonly<{
  state: string;
  requestHash: string;
  responseBody?: unknown;
}>;

function authorize(context: ResolvedProjectContext): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role))
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Placement revalidation permission is required.",
    });
  }
}

const conflict = (message: string) => new BacklinkError({
  code: backlinkErrorCodes.conflict,
  message,
});

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function result(
  row: ResultRow | undefined,
  requestHash: string,
): PlacementReverifyResult {
  if (row === undefined || row.state === "in_progress") {
    throw conflict("The idempotent command is already in progress.");
  }
  if (row.requestHash !== requestHash) {
    throw conflict("Idempotency key is already bound to a different request.");
  }
  if (row.state === "not_found") {
    throw new BacklinkError({
      code: backlinkErrorCodes.notFound,
      message: "Placement link was not found in this project.",
    });
  }
  if (!["completed", "replay"].includes(row.state) || row.responseBody === undefined) {
    throw conflict(
      "ExpectedVersion does not match a monitorable Placement.",
    );
  }
  return {
    ...(row.responseBody as Omit<PlacementReverifyResult, "replayed">),
    replayed: row.state === "replay",
  };
}

export function createPlacementReverifyCommand(
  client: PlacementReverifyCommandClient,
  options: Readonly<{
    newId?: () => string;
    now?: () => Date;
  }> = {},
) {
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async execute(
      input: PlacementReverifyCommandInput,
    ): Promise<PlacementReverifyResult> {
      authorize(input.context);
      const requestHash = digest({
        organizationId: input.context.tenant.organizationId,
        workspaceId: input.context.tenant.workspaceId,
        websiteProjectId: input.context.project.websiteProjectId,
        placementId: input.placementId,
        expectedVersion: input.expectedVersion,
      });
      const idempotencyRecordId = newId();
      const monitorRunId = newId();
      const observationId = newId();
      const outboxEventId = newId();
      const requestedAt = now();
      const { tenant, project, actor } = input.context;
      const query = await client.query(`
        WITH guard AS (
          SELECT
            pg_advisory_xact_lock(hashtextextended(
              $2::uuid::text||':'||$7||':placement.reverify',0
            )),
            pg_advisory_xact_lock(hashtextextended(
              $2::uuid::text||':'||$5::uuid::text||':placement.monitor',0
            ))
        ), prior AS (
          SELECT idempotency.request_hash "requestHash",
                 idempotency.response_body "responseBody"
            FROM guard
            CROSS JOIN LATERAL (
              SELECT *
                FROM backlink_idempotency_records
               WHERE workspace_id=$2
                 AND idempotency_key=$7
                 AND command_type='placement.reverify'
            ) idempotency
        ), present AS (
          SELECT placement.*
            FROM guard
            CROSS JOIN backlink_placements placement
           WHERE (
             placement.organization_id,placement.workspace_id,
             placement.website_project_id,placement.id
           )=($1,$2,$3,$5::uuid)
        ), target AS (
          SELECT placement.*,policy.id "monitorPolicyId",
                 policy.policy_version "policyVersion",
                 policy.schema_version "policySchemaVersion"
            FROM present placement
            JOIN LATERAL (
              SELECT current_policy.*
                FROM backlink_monitor_policies current_policy
               WHERE (
                 current_policy.organization_id,current_policy.workspace_id,
                 current_policy.website_project_id,
                 current_policy.placement_id
               )=(
                 placement.organization_id,placement.workspace_id,
                 placement.website_project_id,placement.id
               )
               ORDER BY current_policy.created_at DESC,current_policy.id DESC
               LIMIT 1
            ) policy ON true
           WHERE placement.version=$6
             AND placement.monitoring_status='enabled'
             AND NOT EXISTS (SELECT 1 FROM prior)
        ), active_run AS (
          SELECT run.*
            FROM target
            JOIN LATERAL (
              SELECT current_run.*
                FROM backlink_monitor_runs current_run
               WHERE (
                 current_run.organization_id,current_run.workspace_id,
                 current_run.website_project_id,current_run.placement_id
               )=(
                 target.organization_id,target.workspace_id,
                 target.website_project_id,target.id
               )
                 AND current_run.status IN ('SCHEDULED','RUNNING','RETRY_WAIT')
               ORDER BY current_run.created_at DESC,current_run.id DESC
               LIMIT 1
            ) run ON true
        ), updated_placement AS (
          UPDATE backlink_placements placement
             SET version=placement.version+1,updated_at=$14,updated_by=$4
            FROM target
           WHERE placement.id=target.id
             AND NOT EXISTS (SELECT 1 FROM active_run)
          RETURNING placement.*
        ), updated_policy AS (
          UPDATE backlink_monitor_policies policy
             SET next_check_at=$14,version=policy.version+1,
                 updated_at=$14,updated_by=$4
            FROM target
            JOIN updated_placement placement ON placement.id=target.id
           WHERE (
             policy.organization_id,policy.workspace_id,
             policy.website_project_id,policy.id,policy.placement_id,
             policy.policy_version
           )=(
             target.organization_id,target.workspace_id,
             target.website_project_id,target."monitorPolicyId",target.id,
             target."policyVersion"
           )
          RETURNING policy.*
        ), created_run AS (
          INSERT INTO backlink_monitor_runs (
            id,organization_id,workspace_id,website_project_id,placement_id,
            monitor_policy_id,policy_version,scheduled_for,execution_mode,
            status,schema_version,created_at,updated_at,created_by,updated_by
          )
          SELECT $10,target.organization_id,target.workspace_id,
                 target.website_project_id,target.id,target."monitorPolicyId",
                 target."policyVersion",$14,'static','SCHEDULED',
                 target."policySchemaVersion",$14,$14,$4,$4
            FROM target
            JOIN updated_placement placement ON placement.id=target.id
            JOIN updated_policy policy ON policy.id=target."monitorPolicyId"
           WHERE NOT EXISTS (SELECT 1 FROM active_run)
          RETURNING *
        ), inserted_outbox AS (
          INSERT INTO backlink_outbox_events (
            id,organization_id,workspace_id,website_project_id,event_type,
            aggregate_id,aggregate_version,idempotency_key,payload,
            payload_schema_version,available_at,created_at,updated_at,
            created_by,updated_by
          )
          SELECT $12,run.organization_id,run.workspace_id,
                 run.website_project_id,$15,run.placement_id,
                 placement.version,
                 'placement-monitoring-reverify:'||run.id,
                 jsonb_build_object(
                   'contractVersion',$15::text,
                   'requestKind','reverify',
                   'placementId',target.id,
                   'candidateId',target.candidate_id,
                   'opportunityId',target.opportunity_id,
                   'initialValidationId',target.initial_validation_id,
                   'websiteProjectId',target.website_project_id,
                   'monitorRunId',run.id,
                   'monitorPolicyId',run.monitor_policy_id,
                   'policyVersion',run.policy_version,
                   'scheduledFor',run.scheduled_for,
                   'observationId',$11::uuid,
                   'requestId',$13::text,
                   'executionMode','static',
                   'browserFallbackAllowed',false
                 ),
                 1,$14,$14,$14,$4,$4
            FROM created_run run
            JOIN target ON target.id=run.placement_id
            JOIN updated_placement placement ON placement.id=run.placement_id
          RETURNING id
        ), response_source AS (
          SELECT active.id "monitorRunId",active.status,
                 active.scheduled_for "scheduledFor",
                 target.id "placementId",target.version "placementVersion",
                 false "accepted"
            FROM active_run active
            JOIN target ON target.id=active.placement_id
          UNION ALL
          SELECT run.id,run.status,run.scheduled_for,
                 placement.id,placement.version,true
            FROM created_run run
            JOIN updated_placement placement ON placement.id=run.placement_id
            JOIN inserted_outbox outbox ON true
        ), completed AS (
          INSERT INTO backlink_idempotency_records (
            id,organization_id,workspace_id,website_project_id,
            idempotency_key,command_type,request_hash,response_status,
            response_body,response_schema_version,completed_at,expires_at,
            created_by,updated_by
          )
          SELECT $9,$1,$2,$3,$7,'placement.reverify',$8,202,
                 jsonb_build_object(
                   'placementId',source."placementId",
                   'placementVersion',source."placementVersion",
                   'accepted',source.accepted,
                   'browserFallbackAllowed',false,
                   'monitorRun',jsonb_build_object(
                     'monitorRunId',source."monitorRunId",
                     'status',CASE source.status
                       WHEN 'SCHEDULED' THEN 'scheduled'
                       WHEN 'RUNNING' THEN 'running'
                       WHEN 'RETRY_WAIT' THEN 'retry_wait'
                       WHEN 'FAILED' THEN 'failed'
                       ELSE 'completed'
                     END,
                     'scheduledFor',source."scheduledFor"
                   )
                 ),
                 1,$14,$14+interval '24 hours',$4,$4
            FROM response_source source
          RETURNING request_hash "requestHash",response_body "responseBody"
        )
        SELECT 'completed' state,* FROM completed
        UNION ALL
        SELECT 'replay',"requestHash","responseBody" FROM prior
        UNION ALL
        SELECT CASE WHEN EXISTS (SELECT 1 FROM present)
                    THEN 'version_conflict' ELSE 'not_found' END,
               $8,NULL
         WHERE NOT EXISTS (SELECT 1 FROM completed)
           AND NOT EXISTS (SELECT 1 FROM prior)
      `, [
        tenant.organizationId,
        tenant.workspaceId,
        project.websiteProjectId,
        actor.userId,
        input.placementId,
        input.expectedVersion,
        input.idempotencyKey,
        requestHash,
        idempotencyRecordId,
        monitorRunId,
        observationId,
        outboxEventId,
        input.requestId,
        requestedAt,
        BACKLINK_PLACEMENT_MONITORING_REQUESTED,
      ]);
      return result(query.rows[0] as ResultRow | undefined, requestHash);
    },
  });
}
