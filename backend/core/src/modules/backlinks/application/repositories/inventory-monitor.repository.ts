import type {
  PlacementMonitorObservationResult,
  PreviousSuccessfulMonitorObservation,
} from "../activities/placement-static-monitor.activity.js";
import type {
  PlacementMonitorExecution,
  PlacementMonitorQueryClient,
  PlacementMonitorRepository,
  PlacementMonitorRunRecord,
  PlacementMonitorRunStatus,
} from "./placement-monitor.repository.js";
import type {
  PlacementMonitoringHealthStatus,
} from "../../domain/monitoring/schedule-policy.js";
import type {
  PlacementMonitoringStatusEvidence,
} from "../../domain/monitoring/status-policy.js";
import { buildBacklinksWorkflowId } from "../../workflows/namespaces.js";

type Row = Record<string, unknown>;
type InventoryMonitorIdentity = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  placementId: string;
  monitorPolicyId: string;
  policyVersion: string;
  scheduledFor: Date;
}>;

const runStatuses = new Set<PlacementMonitorRunStatus>([
  "SCHEDULED",
  "RUNNING",
  "RETRY_WAIT",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
const observationResults = new Set<PlacementMonitorObservationResult>([
  "present",
  "changed",
  "absent",
  "inaccessible",
]);
const healthStatuses = new Set<PlacementMonitoringHealthStatus>([
  "pending_verification",
  "active",
  "suspected_changed",
  "changed",
  "suspected_lost",
  "lost",
]);

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function date(value: unknown): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Inventory Monitor date is invalid.");
  }
  return parsed;
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function runStatus(value: unknown): PlacementMonitorRunStatus {
  if (typeof value === "string" && runStatuses.has(value as PlacementMonitorRunStatus)) {
    return value as PlacementMonitorRunStatus;
  }
  throw new Error("Inventory Monitor Run status is invalid.");
}

function observationResult(value: unknown): PlacementMonitorObservationResult | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string"
    && observationResults.has(value as PlacementMonitorObservationResult)
  ) {
    return value as PlacementMonitorObservationResult;
  }
  throw new Error("Inventory Monitor Observation result is invalid.");
}

function healthStatus(value: unknown): PlacementMonitoringHealthStatus {
  if (
    typeof value === "string"
    && healthStatuses.has(value as PlacementMonitoringHealthStatus)
  ) {
    return value as PlacementMonitoringHealthStatus;
  }
  throw new Error("Inventory Monitor health status is invalid.");
}

function jsonArray(value: unknown): readonly Row[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error("Inventory Monitor history is invalid.");
  }
  return parsed as readonly Row[];
}

function mapHistory(value: unknown): readonly PlacementMonitoringStatusEvidence[] {
  return jsonArray(value).map((row) => {
    const result = observationResult(row.result);
    if (result === null) throw new Error("Inventory Monitor history is incomplete.");
    return {
      result,
      evidenceFingerprint: String(row.evidenceFingerprint),
      observedAt: date(row.observedAt),
    };
  });
}

function mapRecord(row: Row): PlacementMonitorRunRecord {
  return {
    runId: String(row.runId),
    status: runStatus(row.status),
    attemptCount: Number(row.attemptCount),
    nextRetryAt: nullableDate(row.nextRetryAt),
    retryAfterSeconds: row.retryAfterSeconds === null
        || row.retryAfterSeconds === undefined
      ? null
      : Number(row.retryAfterSeconds),
    errorCode: nullableText(row.errorCode),
    observationResult: observationResult(row.observationResult),
  };
}

type Loaded = Readonly<{
  record: PlacementMonitorRunRecord;
  execution: PlacementMonitorExecution;
  projectActive: boolean;
  monitoringStatus: string;
}>;

function mapLoaded(row: Row): Loaded {
  const record = mapRecord(row);
  const previousResult = observationResult(row.previousResult);
  const previousFingerprint = nullableText(row.previousEvidenceFingerprint);
  const previousSuccessfulObservation:
    PreviousSuccessfulMonitorObservation | null = previousResult === null
      || previousResult === "inaccessible"
      || previousFingerprint === null
    ? null
    : { result: previousResult, evidenceFingerprint: previousFingerprint };
  return {
    record,
    projectActive: row.projectActive === true,
    monitoringStatus: String(row.monitoringStatus),
    execution: {
      runId: record.runId,
      placementId: String(row.inventoryItemId),
      monitorPolicyId: String(row.monitorPolicyId),
      policyVersion: String(row.policyVersion),
      scheduledFor: date(row.scheduledFor),
      executionMode: "static",
      attemptCount: record.attemptCount,
      sourcePageUrl: String(row.sourcePageUrl),
      targetUrl: String(row.targetUrl),
      healthStatus: healthStatus(row.healthStatus),
      placementVersion: Number(row.inventoryVersion),
      normalIntervalSeconds: Number(row.normalIntervalSeconds),
      suspectedRecheckIntervalSeconds: Number(
        row.suspectedRecheckIntervalSeconds,
      ),
      jitterWindowSeconds: Number(row.jitterWindowSeconds),
      browserFallbackEnabled: row.browserFallbackEnabled === true,
      retryInitialDelaySeconds: Number(row.retryInitialDelaySeconds),
      retryMaxDelaySeconds: Number(row.retryMaxDelaySeconds),
      retryBackoffMultiplier: Number(row.retryBackoffMultiplier),
      maxRetryAttempts: Number(row.maxRetryAttempts),
      lossConfirmationCount: Number(row.lossConfirmationCount),
      changeConfirmationCount: Number(row.changeConfirmationCount),
      recentSamePolicyObservations: mapHistory(
        row.recentSamePolicyObservations ?? [],
      ),
      previousSuccessfulObservation,
    },
  };
}

function directStatus(
  input: Parameters<PlacementMonitorRepository["complete"]>[0],
): string {
  if (input.observation.result === "inaccessible") return "INACCESSIBLE";
  if (input.recoveryProjection !== null) return "RECOVERED";
  switch (input.statusDecision.nextHealthStatus) {
    case "active":
      return "VALID";
    case "suspected_changed":
      return "SUSPECTED_CHANGED";
    case "changed":
      return "CHANGED";
    case "suspected_lost":
      return "SUSPECTED_LOST";
    case "lost":
      return "LOST";
    default:
      return "UNVERIFIED";
  }
}

export function createInventoryMonitorRepository(
  client: PlacementMonitorQueryClient,
): PlacementMonitorRepository {
  const load = async (
    input: InventoryMonitorIdentity,
  ): Promise<Loaded | null> => {
    const result = await client.query(`
      WITH current_project AS (
        SELECT project_status
          FROM backlink_project_context_snapshots
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3
         ORDER BY snapshot_version DESC
         LIMIT 1
      )
      SELECT run.id "runId",run.status,run.attempt_count "attemptCount",
             run.next_retry_at "nextRetryAt",
             run.retry_after_seconds "retryAfterSeconds",
             run.error_code "errorCode",
             run.inventory_item_id "inventoryItemId",
             run.monitor_policy_id "monitorPolicyId",
             run.policy_version "policyVersion",
             run.scheduled_for "scheduledFor",
             inventory.normalized_source_url "sourcePageUrl",
             inventory.normalized_target_url "targetUrl",
             inventory.direct_health_status "healthStatus",
             inventory.version "inventoryVersion",
             policy.monitoring_status "monitoringStatus",
             policy.normal_interval_seconds "normalIntervalSeconds",
             policy.suspected_recheck_interval_seconds
               "suspectedRecheckIntervalSeconds",
             policy.jitter_window_seconds "jitterWindowSeconds",
             policy.browser_fallback_enabled "browserFallbackEnabled",
             policy.retry_initial_delay_seconds "retryInitialDelaySeconds",
             policy.retry_max_delay_seconds "retryMaxDelaySeconds",
             policy.retry_backoff_multiplier "retryBackoffMultiplier",
             policy.max_retry_attempts "maxRetryAttempts",
             policy.loss_confirmation_count "lossConfirmationCount",
             policy.change_confirmation_count "changeConfirmationCount",
             COALESCE(project.project_status='ACTIVE',false) "projectActive",
             current_observation.result "observationResult",
             previous.result "previousResult",
             previous.evidence_fingerprint "previousEvidenceFingerprint",
             COALESCE(history.observations,'[]'::jsonb)
               "recentSamePolicyObservations"
        FROM backlink_inventory_monitor_runs run
        JOIN backlink_inventory_items inventory ON (
          inventory.organization_id,inventory.workspace_id,
          inventory.website_project_id,inventory.id
        )=(
          run.organization_id,run.workspace_id,
          run.website_project_id,run.inventory_item_id
        )
        JOIN backlink_inventory_monitor_policies policy ON (
          policy.organization_id,policy.workspace_id,
          policy.website_project_id,policy.id,policy.inventory_item_id,
          policy.policy_version
        )=(
          run.organization_id,run.workspace_id,
          run.website_project_id,run.monitor_policy_id,
          run.inventory_item_id,run.policy_version
        )
        LEFT JOIN current_project project ON true
        LEFT JOIN backlink_inventory_monitor_observations current_observation
          ON current_observation.monitor_run_id=run.id
         AND current_observation.organization_id=run.organization_id
         AND current_observation.workspace_id=run.workspace_id
         AND current_observation.website_project_id=run.website_project_id
        LEFT JOIN LATERAL (
          SELECT observation.result,observation.evidence_fingerprint
            FROM backlink_inventory_monitor_observations observation
           WHERE observation.organization_id=run.organization_id
             AND observation.workspace_id=run.workspace_id
             AND observation.website_project_id=run.website_project_id
             AND observation.inventory_item_id=run.inventory_item_id
             AND observation.monitor_run_id<>run.id
             AND observation.result<>'inaccessible'
           ORDER BY observation.observed_at DESC,observation.id DESC
           LIMIT 1
        ) previous ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'result',sample.result,
            'evidenceFingerprint',sample.evidence_fingerprint,
            'observedAt',sample.observed_at
          ) ORDER BY sample.observed_at DESC,sample.id DESC) observations
          FROM (
            SELECT observation.result,observation.evidence_fingerprint,
                   observation.observed_at,observation.id
              FROM backlink_inventory_monitor_observations observation
             WHERE observation.organization_id=run.organization_id
               AND observation.workspace_id=run.workspace_id
               AND observation.website_project_id=run.website_project_id
               AND observation.inventory_item_id=run.inventory_item_id
               AND observation.monitor_policy_id=run.monitor_policy_id
               AND observation.policy_version=run.policy_version
               AND observation.monitor_run_id<>run.id
             ORDER BY observation.observed_at DESC,observation.id DESC
             LIMIT 10
          ) sample
        ) history ON true
       WHERE run.organization_id=$1 AND run.workspace_id=$2
         AND run.website_project_id=$3 AND run.inventory_item_id=$4
         AND run.monitor_policy_id=$5 AND run.policy_version=$6
         AND run.scheduled_for=$7 AND run.execution_mode='static'
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.placementId,
      input.monitorPolicyId,
      input.policyVersion,
      input.scheduledFor,
    ]);
    return result.rows[0] === undefined ? null : mapLoaded(result.rows[0]);
  };

  const currentRecord = async (
    input: InventoryMonitorIdentity,
  ): Promise<PlacementMonitorRunRecord> => {
    const loaded = await load(input);
    if (loaded === null) throw new Error("Inventory Monitor Run was not found.");
    return loaded.record;
  };

  return {
    async prepare(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "placement-monitoring",
        instanceId: input.runId,
      });
      await client.query(`
        WITH eligible AS (
          SELECT policy.*
            FROM backlink_inventory_monitor_policies policy
            JOIN backlink_inventory_items inventory ON (
              inventory.organization_id,inventory.workspace_id,
              inventory.website_project_id,inventory.id
            )=(
              policy.organization_id,policy.workspace_id,
              policy.website_project_id,policy.inventory_item_id
            )
            JOIN LATERAL (
              SELECT snapshot.project_status
                FROM backlink_project_context_snapshots snapshot
               WHERE snapshot.organization_id=policy.organization_id
                 AND snapshot.workspace_id=policy.workspace_id
                 AND snapshot.website_project_id=policy.website_project_id
               ORDER BY snapshot.snapshot_version DESC
               LIMIT 1
            ) project ON project.project_status='ACTIVE'
           WHERE policy.organization_id=$1 AND policy.workspace_id=$2
             AND policy.website_project_id=$3
             AND policy.inventory_item_id=$4 AND policy.id=$5
             AND policy.policy_version=$6
             AND date_trunc('milliseconds',policy.next_check_at)
               =date_trunc('milliseconds',$7::timestamptz)
             AND policy.monitoring_status='enabled'
        ), inserted_job AS (
          INSERT INTO backlink_jobs (
            id,organization_id,workspace_id,website_project_id,job_type,
            source_object_type,source_object_id,status,step,progress,
            workflow_id,correlation_id,created_at,updated_at,
            created_by,updated_by
          )
          SELECT $8::uuid,organization_id,workspace_id,website_project_id,
            'backlink_inventory_monitor','backlink_inventory_item',
            inventory_item_id,'queued','scheduled',0,$9::text,
            ($8::uuid)::text,
            $10,$10,$11,$11
          FROM eligible
          ON CONFLICT (workspace_id,workflow_id) DO NOTHING
          RETURNING id,organization_id,workspace_id,website_project_id
        ), selected_job AS (
          SELECT id,organization_id,workspace_id,website_project_id
            FROM inserted_job
          UNION ALL
          SELECT id,organization_id,workspace_id,website_project_id
            FROM backlink_jobs
           WHERE workspace_id=$2 AND workflow_id=$9::text
             AND NOT EXISTS (SELECT 1 FROM inserted_job)
        )
        INSERT INTO backlink_inventory_monitor_runs (
          id,organization_id,workspace_id,website_project_id,
          inventory_item_id,monitor_policy_id,backlink_job_id,
          policy_version,scheduled_for,execution_mode,status,
          created_at,updated_at,created_by,updated_by
        )
        SELECT $8::uuid,eligible.organization_id,eligible.workspace_id,
          eligible.website_project_id,eligible.inventory_item_id,eligible.id,
          job.id,eligible.policy_version,$7,'static','SCHEDULED',
          $10,$10,$11,$11
        FROM eligible
        JOIN selected_job job ON job.id=$8::uuid
         AND job.organization_id=eligible.organization_id
         AND job.workspace_id=eligible.workspace_id
         AND job.website_project_id=eligible.website_project_id
        ON CONFLICT (
          organization_id,workspace_id,website_project_id,
          inventory_item_id,scheduled_for,policy_version,execution_mode
        ) DO NOTHING
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.placementId,
        input.monitorPolicyId,
        input.policyVersion,
        input.scheduledFor,
        input.runId,
        workflowId,
        input.now,
        input.workerId,
      ]);

      let loaded = await load(input);
      if (loaded === null) return { state: "not_eligible" };
      if (!loaded.projectActive || loaded.monitoringStatus !== "enabled") {
        await client.query(`
          UPDATE backlink_inventory_monitor_runs
             SET status='CANCELLED',error_code='MONITOR_NOT_ELIGIBLE',
                 finished_at=$8,updated_at=$8,updated_by=$9,version=version+1
           WHERE organization_id=$1 AND workspace_id=$2
             AND website_project_id=$3 AND id=$4
             AND inventory_item_id=$5 AND monitor_policy_id=$6
             AND policy_version=$7 AND status IN (
               'SCHEDULED','RUNNING','RETRY_WAIT'
             )
        `, [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          loaded.record.runId,
          input.placementId,
          input.monitorPolicyId,
          input.policyVersion,
          input.now,
          input.workerId,
        ]);
        return { state: "completed", run: await currentRecord(input) };
      }
      if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(loaded.record.status)) {
        return { state: "completed", run: loaded.record };
      }
      if (
        loaded.record.status === "RETRY_WAIT"
        && loaded.record.nextRetryAt !== null
        && loaded.record.nextRetryAt > input.now
      ) {
        return { state: "retry_wait", run: loaded.record };
      }
      if (loaded.record.status !== "RUNNING") {
        await client.query(`
          UPDATE backlink_inventory_monitor_runs
             SET status='RUNNING',attempt_count=attempt_count+1,
                 next_retry_at=NULL,retry_after_seconds=NULL,error_code=NULL,
                 started_at=COALESCE(started_at,$8),
                 updated_at=$8,updated_by=$9,version=version+1
           WHERE organization_id=$1 AND workspace_id=$2
             AND website_project_id=$3 AND id=$4
             AND inventory_item_id=$5 AND monitor_policy_id=$6
             AND policy_version=$7
             AND (
               status='SCHEDULED'
               OR (status='RETRY_WAIT' AND next_retry_at<=$8)
             )
        `, [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          loaded.record.runId,
          input.placementId,
          input.monitorPolicyId,
          input.policyVersion,
          input.now,
          input.workerId,
        ]);
        await client.query(`
          UPDATE backlink_jobs
             SET status='running',step='direct_validation',progress=20,
                 started_at=COALESCE(started_at,$5),
                 updated_at=$5,updated_by=$6,version=version+1
           WHERE organization_id=$1 AND workspace_id=$2
             AND website_project_id=$3 AND id=$4
             AND status IN ('queued','running')
        `, [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          loaded.record.runId,
          input.now,
          input.workerId,
        ]);
        loaded = await load(input);
        if (loaded === null) return { state: "not_eligible" };
      }
      return loaded.record.status === "RUNNING"
        ? { state: "ready", execution: loaded.execution }
        : { state: "in_progress", run: loaded.record };
    },

    async scheduleRetry(input) {
      await client.query(`
        UPDATE backlink_inventory_monitor_runs
           SET status='RETRY_WAIT',next_retry_at=$8,
               retry_after_seconds=$9,error_code=$10,
               updated_at=$11,updated_by=$12,version=version+1
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND id=$4
           AND inventory_item_id=$5 AND monitor_policy_id=$6
           AND policy_version=$7 AND scheduled_for=$13
           AND status='RUNNING' AND attempt_count=$14
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.placementId,
        input.monitorPolicyId,
        input.policyVersion,
        input.nextRetryAt,
        input.retryAfterSeconds,
        input.errorCode,
        input.recordedAt,
        input.workerId,
        input.scheduledFor,
        input.expectedAttemptCount,
      ]);
      await client.query(`
        UPDATE backlink_jobs
           SET step='retry_wait',retry_count=$5,
               error=jsonb_build_object('code',$6::text),
               updated_at=$7,updated_by=$8,version=version+1
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND id=$4 AND status='running'
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.expectedAttemptCount,
        input.errorCode,
        input.recordedAt,
        input.workerId,
      ]);
      return currentRecord(input);
    },

    async complete(input) {
      const targetResult = await client.query(`
        SELECT run.status,run.attempt_count "attemptCount",
               inventory.version "inventoryVersion",
               inventory.direct_health_status "healthStatus"
          FROM backlink_inventory_monitor_runs run
          JOIN backlink_inventory_items inventory ON (
            inventory.organization_id,inventory.workspace_id,
            inventory.website_project_id,inventory.id
          )=(
            run.organization_id,run.workspace_id,
            run.website_project_id,run.inventory_item_id
          )
         WHERE run.organization_id=$1 AND run.workspace_id=$2
           AND run.website_project_id=$3 AND run.id=$4
           AND run.inventory_item_id=$5 AND run.monitor_policy_id=$6
           AND run.policy_version=$7 AND run.scheduled_for=$8
         FOR UPDATE OF run,inventory
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.placementId,
        input.monitorPolicyId,
        input.policyVersion,
        input.scheduledFor,
      ]);
      const target = targetResult.rows[0];
      if (target === undefined) {
        throw new Error("Inventory Monitor completion target was not found.");
      }
      if (runStatus(target.status) !== "RUNNING") {
        return currentRecord(input);
      }
      if (
        Number(target.attemptCount) !== input.expectedAttemptCount
        || Number(target.inventoryVersion) !== input.expectedPlacementVersion
        || String(target.healthStatus) !== input.expectedHealthStatus
      ) {
        throw new Error("Inventory Monitor state changed before completion.");
      }

      const validationStatus = directStatus(input);
      const nextHealthStatus = input.recoveryProjection?.nextHealthStatus
        ?? input.statusDecision.nextHealthStatus;
      const restrictionReason = input.observation.result === "inaccessible"
        ? input.observation.failureCode
        : null;
      const insertedObservation = await client.query(`
        INSERT INTO backlink_inventory_monitor_observations (
          id,organization_id,workspace_id,website_project_id,
          monitor_run_id,inventory_item_id,monitor_policy_id,policy_version,
          scheduled_for,execution_mode,result,direct_validation_status,
          failure_code,restriction_reason,evidence_snapshot,
          evidence_snapshot_hash,evidence_fingerprint,
          evidence_contract_version,evidence_schema_version,observed_at,
          created_at,created_by
        ) VALUES (
          $8,$1,$2,$3,$4,$5,$6,$7,$9,'static',$10,$11,$12,$13,$14::jsonb,
          $15,$16,$17,$18,$19,$20,$21
        )
        ON CONFLICT (
          organization_id,workspace_id,website_project_id,monitor_run_id
        ) DO NOTHING
        RETURNING evidence_snapshot_hash "evidenceSnapshotHash"
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.placementId,
        input.monitorPolicyId,
        input.policyVersion,
        input.observationId,
        input.scheduledFor,
        input.observation.result,
        validationStatus,
        input.observation.failureCode,
        restrictionReason,
        JSON.stringify(input.observation.evidenceSnapshot),
        input.observation.evidenceSnapshotHash,
        input.observation.evidenceFingerprint,
        input.observation.evidenceContractVersion,
        input.observation.evidenceSchemaVersion,
        input.observation.observedAt,
        input.completedAt,
        input.workerId,
      ]);
      let storedEvidenceHash = nullableText(
        insertedObservation.rows[0]?.evidenceSnapshotHash,
      );
      if (storedEvidenceHash === null) {
        const existingObservation = await client.query(`
          SELECT evidence_snapshot_hash "evidenceSnapshotHash"
            FROM backlink_inventory_monitor_observations
           WHERE organization_id=$1 AND workspace_id=$2
             AND website_project_id=$3 AND monitor_run_id=$4
        `, [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.runId,
        ]);
        storedEvidenceHash = nullableText(
          existingObservation.rows[0]?.evidenceSnapshotHash,
        );
      }
      if (storedEvidenceHash !== input.observation.evidenceSnapshotHash) {
        throw new Error("Inventory Monitor evidence hash changed.");
      }

      await client.query(`
        UPDATE backlink_inventory_monitor_runs
           SET status=$8,next_retry_at=NULL,retry_after_seconds=NULL,
               error_code=CASE WHEN $8='FAILED' THEN $9 ELSE NULL END,
               finished_at=$10,updated_at=$10,updated_by=$11,
               version=version+1
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND id=$4
           AND inventory_item_id=$5 AND monitor_policy_id=$6
           AND policy_version=$7 AND status='RUNNING'
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.placementId,
        input.monitorPolicyId,
        input.policyVersion,
        input.terminalStatus,
        input.observation.failureCode,
        input.completedAt,
        input.workerId,
      ]);
      const updatedInventory = await client.query(`
        UPDATE backlink_inventory_items
           SET direct_health_status=$7,direct_validation_status=$8,
               last_direct_checked_at=$9,latest_direct_evidence_id=$10,
               restriction_reason=$11,updated_at=$12,updated_by=$13,
               version=version+1
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND id=$4
           AND version=$5 AND direct_health_status=$6
        RETURNING version
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.placementId,
        input.expectedPlacementVersion,
        input.expectedHealthStatus,
        nextHealthStatus,
        validationStatus,
        input.observation.observedAt,
        input.observationId,
        restrictionReason,
        input.completedAt,
        input.workerId,
      ]);
      const inventoryVersion = Number(updatedInventory.rows[0]?.version ?? 0);
      if (inventoryVersion === 0) {
        throw new Error("Inventory Monitor item update was not applied.");
      }
      await client.query(`
        UPDATE backlink_inventory_monitor_policies
           SET next_check_at=$8,updated_at=$9,updated_by=$10,
               version=version+1
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND id=$4
           AND inventory_item_id=$5 AND policy_version=$6
           AND date_trunc('milliseconds',next_check_at)
             =date_trunc('milliseconds',$7::timestamptz)
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.monitorPolicyId,
        input.placementId,
        input.policyVersion,
        input.scheduledFor,
        input.nextCheckAt,
        input.completedAt,
        input.workerId,
      ]);
      await client.query(`
        UPDATE backlink_jobs
           SET status=$5,step='completed',progress=100,
               result_summary=jsonb_build_object(
                 'inventoryItemId',$6::text,
                 'directValidationStatus',$7::text,
                 'observationId',$8::text
               ),
               error=CASE WHEN $5='failed'
                 THEN jsonb_build_object('code',$9::text)
                 ELSE NULL
               END,
               finished_at=$10,updated_at=$10,updated_by=$11,
               version=version+1
         WHERE organization_id=$1 AND workspace_id=$2
           AND website_project_id=$3 AND id=$4
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.terminalStatus === "SUCCEEDED" ? "success" : "failed",
        input.placementId,
        validationStatus,
        input.observationId,
        input.observation.failureCode,
        input.completedAt,
        input.workerId,
      ]);
      await client.query(`
        INSERT INTO backlink_lifecycle_events (
          id,organization_id,workspace_id,website_project_id,job_id,
          aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
          actor_type,actor_id,before_state,after_state,reason,
          correlation_id,causation_id,idempotency_key,created_at
        ) VALUES (
          $6,$1,$2,$3,$4::uuid,'backlink_inventory_item',$5,$7,$7,$8,
          'worker',$9,
          jsonb_build_object('directHealthStatus',$10::text),
          jsonb_build_object(
            'directHealthStatus',$11::text,
            'directValidationStatus',$12::text,
            'observationId',$13::text,
            'nextCheckAt',$14::timestamptz
          ),
          $15,$4::text,$13::uuid,
          'inventory-monitoring-state:'||$4::text,$16
        )
        ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.placementId,
        input.decisionFactId,
        inventoryVersion,
        `inventory.direct.${validationStatus.toLowerCase()}`,
        input.workerId,
        input.expectedHealthStatus,
        nextHealthStatus,
        validationStatus,
        input.observationId,
        input.nextCheckAt,
        input.recoveryProjection?.reasonCode ?? input.statusDecision.reasonCode,
        input.completedAt,
      ]);
      return currentRecord(input);
    },
  };
}
