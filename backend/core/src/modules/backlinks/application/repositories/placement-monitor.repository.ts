import type {
  PlacementMonitorObservationResult,
  PreviousSuccessfulMonitorObservation,
} from "../activities/placement-static-monitor.activity.js";
import type {
  PlacementMonitoringHealthStatus,
} from "../../domain/monitoring/schedule-policy.js";
import {
  placementMonitoringStatusDecisionFactContractVersion,
  placementMonitoringStatusDecisionFactEventType,
  type PlacementMonitoringStatusDecision,
  type PlacementMonitoringStatusEvidence,
} from "../../domain/monitoring/status-policy.js";
import type {
  PlacementMonitoringRecoveryProjection,
} from "../../domain/monitoring/recovery-policy.js";

const monitoringLifecycleOutboxEventType =
  "backlinks.placement-monitoring.lifecycle.v1";

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

type RunIdentity = Scope & Readonly<{
  placementId: string;
  monitorPolicyId: string;
  policyVersion: string;
  scheduledFor: Date;
  runId: string;
}>;

export type PlacementMonitorExecution = Readonly<{
  runId: string;
  placementId: string;
  monitorPolicyId: string;
  policyVersion: string;
  scheduledFor: Date;
  executionMode: "static";
  attemptCount: number;
  sourcePageUrl: string;
  targetUrl: string;
  healthStatus: PlacementMonitoringHealthStatus;
  placementVersion: number;
  normalIntervalSeconds: number;
  suspectedRecheckIntervalSeconds: number;
  jitterWindowSeconds: number;
  retryInitialDelaySeconds: number;
  retryMaxDelaySeconds: number;
  retryBackoffMultiplier: number;
  maxRetryAttempts: number;
  lossConfirmationCount: number;
  changeConfirmationCount: number;
  recentSamePolicyObservations:
    readonly PlacementMonitoringStatusEvidence[];
  previousSuccessfulObservation:
    PreviousSuccessfulMonitorObservation | null;
}>;

export type PlacementMonitorRunStatus =
  | "SCHEDULED"
  | "RUNNING"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type PlacementMonitorRunRecord = Readonly<{
  runId: string;
  status: PlacementMonitorRunStatus;
  attemptCount: number;
  nextRetryAt: Date | null;
  retryAfterSeconds: number | null;
  errorCode: string | null;
  observationResult: PlacementMonitorObservationResult | null;
}>;

export type PreparePlacementMonitorInput = RunIdentity & Readonly<{
  workerId: string;
  now: Date;
}>;

export type PreparePlacementMonitorResult =
  | Readonly<{ state: "ready"; execution: PlacementMonitorExecution }>
  | Readonly<{ state: "retry_wait"; run: PlacementMonitorRunRecord }>
  | Readonly<{ state: "completed"; run: PlacementMonitorRunRecord }>
  | Readonly<{ state: "in_progress"; run: PlacementMonitorRunRecord }>
  | Readonly<{ state: "not_eligible" }>;

export type SchedulePlacementMonitorRetryInput =
  RunIdentity & Readonly<{
    expectedAttemptCount: number;
    errorCode: string;
    retryAfterSeconds: number;
    nextRetryAt: Date;
    workerId: string;
    recordedAt: Date;
  }>;

export type CompletePlacementMonitorInput =
  RunIdentity & Readonly<{
    expectedAttemptCount: number;
    observationId: string;
    expectedPlacementVersion: number;
    expectedHealthStatus: PlacementMonitoringHealthStatus;
    statusDecision: PlacementMonitoringStatusDecision;
    decisionFactId: string;
    lossConfirmationCount: number;
    changeConfirmationCount: number;
    recoveryProjection: (
      (
        PlacementMonitoringRecoveryProjection
        | Readonly<{
            eventType:
              | "placement.confirmed"
              | "placement.changed"
              | "placement.lost";
            nextHealthStatus: PlacementMonitoringHealthStatus;
            reasonCode: string;
            kpiProjection: null;
          }>
      )
      & Readonly<{
        lifecycleEventId: string;
        outboxEventId: string | null;
      }>
    ) | null;
    observation: Readonly<{
      result: PlacementMonitorObservationResult;
      failureCode: string | null;
      evidenceSnapshot: Readonly<Record<string, unknown>>;
      evidenceSnapshotHash: string;
      evidenceFingerprint: string;
      evidenceContractVersion: string;
      evidenceSchemaVersion: number;
      observedAt: Date;
    }>;
    terminalStatus: "SUCCEEDED" | "FAILED";
    nextCheckAt: Date;
    workerId: string;
    completedAt: Date;
  }>;

export type PlacementMonitorRepository = Readonly<{
  prepare(
    input: PreparePlacementMonitorInput,
  ): Promise<PreparePlacementMonitorResult>;
  scheduleRetry(
    input: SchedulePlacementMonitorRetryInput,
  ): Promise<PlacementMonitorRunRecord>;
  complete(
    input: CompletePlacementMonitorInput,
  ): Promise<PlacementMonitorRunRecord>;
}>;

export type PlacementMonitorQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

type LoadedRun = Readonly<{
  record: PlacementMonitorRunRecord;
  execution: PlacementMonitorExecution;
  projectActive: boolean;
  monitoringStatus: string;
}>;

const healthStatuses = new Set<PlacementMonitoringHealthStatus>([
  "pending_verification",
  "active",
  "suspected_changed",
  "changed",
  "suspected_lost",
  "lost",
]);
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

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Placement Monitor date is invalid.");
  }
  return date;
}

function requiredDate(value: unknown): Date {
  const date = nullableDate(value);
  if (date === null) throw new Error("Placement Monitor date is missing.");
  return date;
}

function runStatus(value: unknown): PlacementMonitorRunStatus {
  if (
    typeof value === "string"
    && runStatuses.has(value as PlacementMonitorRunStatus)
  ) {
    return value as PlacementMonitorRunStatus;
  }
  throw new Error("Placement Monitor Run status is invalid.");
}

function observationResult(
  value: unknown,
): PlacementMonitorObservationResult | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string"
    && observationResults.has(value as PlacementMonitorObservationResult)
  ) {
    return value as PlacementMonitorObservationResult;
  }
  throw new Error("Placement Monitor Observation result is invalid.");
}

function healthStatus(value: unknown): PlacementMonitoringHealthStatus {
  if (
    typeof value === "string"
    && healthStatuses.has(value as PlacementMonitoringHealthStatus)
  ) {
    return value as PlacementMonitoringHealthStatus;
  }
  throw new Error("Placement monitoring health status is invalid.");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value), name);
    } catch {
      throw new Error(`${name} is invalid JSON.`);
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function samePolicyObservations(
  value: unknown,
): readonly PlacementMonitoringStatusEvidence[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error("Placement Monitor observation history is invalid.");
  }
  return parsed.map((candidate, index) => {
    const observation = record(candidate, `observationHistory[${index}]`);
    const result = observationResult(observation.result);
    const evidenceFingerprint = nullableString(observation.evidenceFingerprint);
    if (result === null || evidenceFingerprint === null) {
      throw new Error("Placement Monitor observation history is incomplete.");
    }
    return {
      result,
      evidenceFingerprint,
      observedAt: requiredDate(observation.observedAt),
    };
  });
}

function mapRun(row: Record<string, unknown>): LoadedRun {
  const previousResult = observationResult(row.previousResult);
  if (previousResult === "inaccessible") {
    throw new Error("Last successful Observation cannot be inaccessible.");
  }
  const previousFingerprint = nullableString(
    row.previousEvidenceFingerprint,
  );
  const previousSuccessfulObservation = previousResult === null
    || previousFingerprint === null
    ? null
    : {
        result: previousResult,
        evidenceFingerprint: previousFingerprint,
      };
  const record = {
    runId: String(row.runId),
    status: runStatus(row.status),
    attemptCount: Number(row.attemptCount),
    nextRetryAt: nullableDate(row.nextRetryAt),
    retryAfterSeconds: row.retryAfterSeconds === null
      || row.retryAfterSeconds === undefined
      ? null
      : Number(row.retryAfterSeconds),
    errorCode: nullableString(row.errorCode),
    observationResult: observationResult(row.observationResult),
  } satisfies PlacementMonitorRunRecord;
  return {
    record,
    projectActive: row.projectActive === true,
    monitoringStatus: String(row.monitoringStatus),
    execution: {
      runId: record.runId,
      placementId: String(row.placementId),
      monitorPolicyId: String(row.monitorPolicyId),
      policyVersion: String(row.policyVersion),
      scheduledFor: requiredDate(row.scheduledFor),
      executionMode: "static",
      attemptCount: record.attemptCount,
      sourcePageUrl: String(row.sourcePageUrl),
      targetUrl: String(row.targetUrl),
      healthStatus: healthStatus(row.healthStatus),
      placementVersion: Number(row.placementVersion),
      normalIntervalSeconds: Number(row.normalIntervalSeconds),
      suspectedRecheckIntervalSeconds: Number(
        row.suspectedRecheckIntervalSeconds,
      ),
      jitterWindowSeconds: Number(row.jitterWindowSeconds),
      retryInitialDelaySeconds: Number(row.retryInitialDelaySeconds),
      retryMaxDelaySeconds: Number(row.retryMaxDelaySeconds),
      retryBackoffMultiplier: Number(row.retryBackoffMultiplier),
      maxRetryAttempts: Number(row.maxRetryAttempts),
      lossConfirmationCount: Number(row.lossConfirmationCount),
      changeConfirmationCount: Number(row.changeConfirmationCount),
      recentSamePolicyObservations: samePolicyObservations(
        row.recentSamePolicyObservations ?? [],
      ),
      previousSuccessfulObservation,
    },
  };
}

function validateDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date.`);
  }
}

function validateIdentity(input: RunIdentity): void {
  validateDate(input.scheduledFor, "scheduledFor");
  for (const value of [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.placementId,
    input.monitorPolicyId,
    input.policyVersion,
    input.runId,
  ]) {
    if (value.trim().length === 0) {
      throw new TypeError("Placement Monitor identity must be non-empty.");
    }
  }
}

export function createPlacementMonitorRepository(
  client: PlacementMonitorQueryClient,
): PlacementMonitorRepository {
  const loadRun = async (input: RunIdentity): Promise<LoadedRun | null> => {
    const result = await client.query(`
      WITH current_project AS (
        SELECT project_status
          FROM backlink_project_context_snapshots
         WHERE organization_id=$1
           AND workspace_id=$2
           AND website_project_id=$3
         ORDER BY snapshot_version DESC
         LIMIT 1
      )
      SELECT run.id AS "runId",run.status,run.attempt_count AS "attemptCount",
        run.next_retry_at AS "nextRetryAt",
        run.retry_after_seconds AS "retryAfterSeconds",
        run.error_code AS "errorCode",
        run.placement_id AS "placementId",
        run.monitor_policy_id AS "monitorPolicyId",
        run.policy_version AS "policyVersion",
        run.scheduled_for AS "scheduledFor",
        placement.source_page_url AS "sourcePageUrl",
        placement.target_url AS "targetUrl",
        placement.health_status AS "healthStatus",
        placement.version AS "placementVersion",
        placement.monitoring_status AS "monitoringStatus",
        policy.normal_interval_seconds AS "normalIntervalSeconds",
        policy.suspected_recheck_interval_seconds
          AS "suspectedRecheckIntervalSeconds",
        policy.jitter_window_seconds AS "jitterWindowSeconds",
        policy.retry_initial_delay_seconds AS "retryInitialDelaySeconds",
        policy.retry_max_delay_seconds AS "retryMaxDelaySeconds",
        policy.retry_backoff_multiplier AS "retryBackoffMultiplier",
        policy.max_retry_attempts AS "maxRetryAttempts",
        policy.loss_confirmation_count AS "lossConfirmationCount",
        policy.change_confirmation_count AS "changeConfirmationCount",
        COALESCE(project.project_status='ACTIVE',false) AS "projectActive",
        current_observation.result AS "observationResult",
        previous.result AS "previousResult",
        previous.evidence_fingerprint AS "previousEvidenceFingerprint",
        COALESCE(history.observations,'[]'::jsonb)
          AS "recentSamePolicyObservations"
      FROM backlink_monitor_runs run
      JOIN backlink_placements placement ON (
        placement.organization_id,placement.workspace_id,
        placement.website_project_id,placement.id
      )=(
        run.organization_id,run.workspace_id,
        run.website_project_id,run.placement_id
      )
      JOIN backlink_monitor_policies policy ON (
        policy.organization_id,policy.workspace_id,
        policy.website_project_id,policy.id,policy.placement_id,
        policy.policy_version
      )=(
        run.organization_id,run.workspace_id,
        run.website_project_id,run.monitor_policy_id,run.placement_id,
        run.policy_version
      )
      LEFT JOIN current_project project ON true
      LEFT JOIN backlink_monitor_observations current_observation ON (
        current_observation.organization_id,
        current_observation.workspace_id,
        current_observation.website_project_id,
        current_observation.monitor_run_id
      )=(
        run.organization_id,run.workspace_id,
        run.website_project_id,run.id
      )
      LEFT JOIN LATERAL (
        SELECT observation.result,observation.evidence_fingerprint
        FROM backlink_monitor_observations observation
        WHERE (
          observation.organization_id,observation.workspace_id,
          observation.website_project_id,observation.placement_id
        )=(
          run.organization_id,run.workspace_id,
          run.website_project_id,run.placement_id
        )
          AND observation.monitor_run_id<>run.id
          AND observation.result<>'inaccessible'
        ORDER BY observation.observed_at DESC,observation.created_at DESC,
          observation.id DESC
        LIMIT 1
      ) previous ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'result',history_observation.result,
            'evidenceFingerprint',history_observation.evidence_fingerprint,
            'observedAt',history_observation.observed_at
          )
          ORDER BY history_observation.observed_at DESC,
            history_observation.created_at DESC,history_observation.id DESC
        ) AS observations
        FROM (
          SELECT DISTINCT ON (same_policy.observed_at)
            same_policy.result,same_policy.evidence_fingerprint,
            same_policy.observed_at,same_policy.created_at,same_policy.id
          FROM backlink_monitor_observations same_policy
          WHERE (
            same_policy.organization_id,same_policy.workspace_id,
            same_policy.website_project_id,same_policy.placement_id,
            same_policy.monitor_policy_id,same_policy.policy_version
          )=(
            run.organization_id,run.workspace_id,run.website_project_id,
            run.placement_id,run.monitor_policy_id,run.policy_version
          )
            AND same_policy.monitor_run_id<>run.id
          ORDER BY same_policy.observed_at DESC,same_policy.created_at DESC,
            same_policy.id DESC
        ) history_observation
      ) history ON true
      WHERE (
        run.organization_id,run.workspace_id,run.website_project_id,
        run.placement_id,run.monitor_policy_id,run.policy_version,
        run.scheduled_for,run.execution_mode
      )=($1,$2,$3,$4,$5,$6,$7,'static')
    `, [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.placementId,
      input.monitorPolicyId,
      input.policyVersion,
      input.scheduledFor,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : mapRun(row);
  };

  const currentRecord = async (
    input: RunIdentity,
  ): Promise<PlacementMonitorRunRecord> => {
    const loaded = await loadRun(input);
    if (loaded === null) {
      throw new Error("Placement Monitor Run no longer exists.");
    }
    return loaded.record;
  };

  return {
    async prepare(input) {
      validateIdentity(input);
      validateDate(input.now, "now");
      await client.query(`
        INSERT INTO backlink_monitor_runs (
          id,organization_id,workspace_id,website_project_id,placement_id,
          monitor_policy_id,policy_version,scheduled_for,execution_mode,
          status,schema_version,created_at,updated_at,created_by,updated_by
        )
        SELECT $8,policy.organization_id,policy.workspace_id,
          policy.website_project_id,policy.placement_id,policy.id,
          policy.policy_version,$7,'static','SCHEDULED',1,$9,$9,$10,$10
        FROM backlink_monitor_policies policy
        JOIN backlink_placements placement ON (
          placement.organization_id,placement.workspace_id,
          placement.website_project_id,placement.id
        )=(
          policy.organization_id,policy.workspace_id,
          policy.website_project_id,policy.placement_id
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
        WHERE (
          policy.organization_id,policy.workspace_id,
          policy.website_project_id,policy.placement_id,policy.id,
          policy.policy_version,policy.next_check_at
        )=($1,$2,$3,$4,$5,$6,$7)
          AND placement.monitoring_status='enabled'
        ON CONFLICT (
          organization_id,workspace_id,website_project_id,placement_id,
          scheduled_for,policy_version,execution_mode
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
        input.now,
        input.workerId,
      ]);

      let loaded = await loadRun(input);
      if (loaded === null) return { state: "not_eligible" };
      if (!loaded.projectActive || loaded.monitoringStatus !== "enabled") {
        await client.query(`
          UPDATE backlink_monitor_runs
          SET status='CANCELLED',next_retry_at=NULL,retry_after_seconds=NULL,
            error_code='MONITOR_NOT_ELIGIBLE',finished_at=$8,
            version=version+1,updated_at=$8,updated_by=$9
          WHERE (
            organization_id,workspace_id,website_project_id,id,
            placement_id,monitor_policy_id,policy_version,scheduled_for,
            execution_mode
          )=($1,$2,$3,$4,$5,$6,$7,$10,'static')
            AND status IN ('SCHEDULED','RUNNING','RETRY_WAIT')
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
          input.scheduledFor,
        ]);
        return {
          state: "completed",
          run: await currentRecord({
            ...input,
            runId: loaded.record.runId,
          }),
        };
      }
      if (
        loaded.record.status === "SUCCEEDED"
        || loaded.record.status === "FAILED"
        || loaded.record.status === "CANCELLED"
      ) {
        return { state: "completed", run: loaded.record };
      }
      if (
        loaded.record.status === "RETRY_WAIT"
        && loaded.record.nextRetryAt !== null
        && loaded.record.nextRetryAt > input.now
      ) {
        return { state: "retry_wait", run: loaded.record };
      }
      if (loaded.record.status === "RUNNING") {
        return { state: "ready", execution: loaded.execution };
      }

      await client.query(`
        UPDATE backlink_monitor_runs
        SET status='RUNNING',attempt_count=attempt_count+1,
          next_retry_at=NULL,retry_after_seconds=NULL,error_code=NULL,
          started_at=COALESCE(started_at,$8),version=version+1,
          updated_at=$8,updated_by=$9
        WHERE (
          organization_id,workspace_id,website_project_id,id,
          placement_id,monitor_policy_id,policy_version,scheduled_for,
          execution_mode
        )=($1,$2,$3,$4,$5,$6,$7,$10,'static')
          AND (
            status='SCHEDULED'
            OR (
              status='RETRY_WAIT'
              AND next_retry_at<=$8
            )
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
        input.scheduledFor,
      ]);
      loaded = await loadRun({
        ...input,
        runId: loaded.record.runId,
      });
      if (loaded === null) return { state: "not_eligible" };
      if (loaded.record.status === "RUNNING") {
        return { state: "ready", execution: loaded.execution };
      }
      if (loaded.record.status === "RETRY_WAIT") {
        return { state: "retry_wait", run: loaded.record };
      }
      if (
        loaded.record.status === "SUCCEEDED"
        || loaded.record.status === "FAILED"
        || loaded.record.status === "CANCELLED"
      ) {
        return { state: "completed", run: loaded.record };
      }
      return { state: "in_progress", run: loaded.record };
    },

    async scheduleRetry(input) {
      validateIdentity(input);
      validateDate(input.recordedAt, "recordedAt");
      validateDate(input.nextRetryAt, "nextRetryAt");
      if (
        !Number.isInteger(input.expectedAttemptCount)
        || input.expectedAttemptCount < 1
        || !Number.isInteger(input.retryAfterSeconds)
        || input.retryAfterSeconds < 1
        || input.errorCode.trim().length === 0
        || input.nextRetryAt <= input.recordedAt
      ) {
        throw new TypeError("Placement Monitor retry input is invalid.");
      }
      await client.query(`
        UPDATE backlink_monitor_runs
        SET status='RETRY_WAIT',next_retry_at=$8,retry_after_seconds=$9,
          error_code=$10,version=version+1,updated_at=$11,updated_by=$12
        WHERE (
          organization_id,workspace_id,website_project_id,id,
          placement_id,monitor_policy_id,policy_version,scheduled_for,
          execution_mode
        )=($1,$2,$3,$4,$5,$6,$7,$13,'static')
          AND status='RUNNING'
          AND attempt_count=$14
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
      return currentRecord(input);
    },

    async complete(input) {
      validateIdentity(input);
      validateDate(input.completedAt, "completedAt");
      validateDate(input.nextCheckAt, "nextCheckAt");
      validateDate(input.observation.observedAt, "observedAt");
      if (
        !Number.isInteger(input.expectedAttemptCount)
        || input.expectedAttemptCount < 1
        || input.observationId.trim().length === 0
        || input.decisionFactId.trim().length === 0
        || !Number.isInteger(input.expectedPlacementVersion)
        || input.expectedPlacementVersion < 1
        || !Number.isInteger(input.lossConfirmationCount)
        || input.lossConfirmationCount < 2
        || input.lossConfirmationCount > 10
        || !Number.isInteger(input.changeConfirmationCount)
        || input.changeConfirmationCount < 2
        || input.changeConfirmationCount > 10
        || input.statusDecision.nextHealthStatus.trim().length === 0
      ) {
        throw new TypeError("Placement Monitor completion input is invalid.");
      }
      const result = await client.query(`
        WITH target AS MATERIALIZED (
          SELECT run.*,placement.health_status AS previous_health_status,
            placement.version AS previous_placement_version
          FROM backlink_monitor_runs run
          JOIN backlink_placements placement ON (
            placement.organization_id,placement.workspace_id,
            placement.website_project_id,placement.id
          )=(
            run.organization_id,run.workspace_id,
            run.website_project_id,run.placement_id
          )
          WHERE (
            run.organization_id,run.workspace_id,run.website_project_id,
            run.id,run.placement_id,run.monitor_policy_id,
            run.policy_version,run.scheduled_for,run.execution_mode
          )=($1,$2,$3,$4,$5,$6,$7,$18,'static')
            AND run.status='RUNNING'
            AND run.attempt_count=$19
            AND placement.version=$23
            AND placement.health_status=$24
          FOR UPDATE OF run,placement
        ), inserted_observation AS (
          INSERT INTO backlink_monitor_observations (
            id,organization_id,workspace_id,website_project_id,
            monitor_run_id,placement_id,monitor_policy_id,policy_version,
            scheduled_for,execution_mode,result,failure_code,
            evidence_snapshot,evidence_snapshot_hash,evidence_fingerprint,
            evidence_contract_version,evidence_schema_version,observed_at,
            created_at,created_by
          )
          SELECT $8,target.organization_id,target.workspace_id,
            target.website_project_id,target.id,target.placement_id,
            target.monitor_policy_id,target.policy_version,
            target.scheduled_for,target.execution_mode,$9,$10,$11::jsonb,
            $12,$13,$14,$15,$16,$17,$20
          FROM target
          ON CONFLICT (
            organization_id,workspace_id,website_project_id,monitor_run_id
          ) DO NOTHING
          RETURNING evidence_snapshot_hash
        ), chosen_observation AS (
          SELECT evidence_snapshot_hash FROM inserted_observation
          UNION ALL
          SELECT observation.evidence_snapshot_hash
          FROM backlink_monitor_observations observation
          JOIN target ON (
            observation.organization_id,observation.workspace_id,
            observation.website_project_id,observation.monitor_run_id
          )=(
            target.organization_id,target.workspace_id,
            target.website_project_id,target.id
          )
          WHERE NOT EXISTS (SELECT 1 FROM inserted_observation)
        ), updated_run AS (
          UPDATE backlink_monitor_runs run
          SET status=$21,next_retry_at=NULL,retry_after_seconds=NULL,
            error_code=CASE WHEN $21='FAILED' THEN $10 ELSE NULL END,
            finished_at=$17,version=run.version+1,updated_at=$17,
            updated_by=$20
          FROM target,chosen_observation
          WHERE run.id=target.id
            AND chosen_observation.evidence_snapshot_hash=$12
          RETURNING run.*
        ), updated_placement AS (
          UPDATE backlink_placements placement
          SET health_status=$25,version=placement.version+1,
            updated_at=$17,updated_by=$20
          FROM target,chosen_observation
          WHERE (
            placement.organization_id,placement.workspace_id,
            placement.website_project_id,placement.id
          )=(
            target.organization_id,target.workspace_id,
            target.website_project_id,target.placement_id
          )
            AND placement.version=target.previous_placement_version
            AND placement.health_status IS DISTINCT FROM $25
            AND chosen_observation.evidence_snapshot_hash=$12
          RETURNING placement.*
        ), current_placement AS (
          SELECT * FROM updated_placement
          UNION ALL
          SELECT placement.*
          FROM backlink_placements placement
          JOIN target ON (
            placement.organization_id,placement.workspace_id,
            placement.website_project_id,placement.id
          )=(
            target.organization_id,target.workspace_id,
            target.website_project_id,target.placement_id
          )
          WHERE NOT EXISTS (SELECT 1 FROM updated_placement)
        ), inserted_decision AS (
          INSERT INTO backlink_lifecycle_events (
            id,organization_id,workspace_id,website_project_id,
            aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
            actor_type,actor_id,after_state,reason,correlation_id,causation_id,
            idempotency_key,created_at,event_schema_version
          )
          SELECT $32,target.organization_id,target.workspace_id,
            target.website_project_id,'placement_monitor_run',target.id,1,1,
            $33::text,'worker',$20,
            jsonb_build_object(
              'monitorRunId',target.id,
              'placementId',target.placement_id,
              'observationId',$8::uuid,
              'previousHealthStatus',target.previous_health_status,
              'nextHealthStatus',placement.health_status,
              'policyId',target.monitor_policy_id,
              'policyVersion',target.policy_version,
              'policyContractVersion',$34::text,
              'lossConfirmationCount',$35::integer,
              'changeConfirmationCount',$36::integer,
              'matchingEvidenceCount',$37::integer,
              'requiredConfirmationCount',$38::integer,
              'confirmationType',$39::text,
              'reasonCode',$40::text,
              'occurredAt',$17::timestamptz,
              'contractVersion',$41::text
            ),
            $40::text,target.id::text,$8,
            'placement-monitoring-status-decision:'||target.id,$17,1
          FROM target
          JOIN updated_run run ON run.id=target.id
          JOIN current_placement placement ON true
          RETURNING id
        ), inserted_lifecycle AS (
          INSERT INTO backlink_lifecycle_events (
            id,organization_id,workspace_id,website_project_id,
            aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
            actor_type,actor_id,before_state,after_state,reason,
            correlation_id,causation_id,idempotency_key,created_at
          )
          SELECT $26,target.organization_id,target.workspace_id,
            target.website_project_id,'placement',placement.id,
            placement.version,placement.version,$28::text,'worker',$20,
            jsonb_build_object(
              'healthStatus',target.previous_health_status,
              'placementVersion',target.previous_placement_version
            ),
            jsonb_build_object(
              'healthStatus',placement.health_status,
              'placementVersion',placement.version,
              'observationId',$8
            ),
            $29::text,target.id,$8,
            'placement-monitoring-state:'||target.id||':'||$28::text,$17
          FROM target
          JOIN inserted_decision decision ON true
          JOIN current_placement placement ON true
          WHERE $26::uuid IS NOT NULL
          RETURNING *
        ), inserted_outbox AS (
          INSERT INTO backlink_outbox_events (
            id,organization_id,workspace_id,website_project_id,event_type,
            aggregate_id,aggregate_version,idempotency_key,payload,
            payload_schema_version,available_at,created_at,updated_at,
            created_by,updated_by
          )
          SELECT $27,lifecycle.organization_id,lifecycle.workspace_id,
            lifecycle.website_project_id,$30::text,lifecycle.aggregate_id,
            lifecycle.aggregate_version,
            'placement-monitoring-lifecycle:'||target.id||':'||$28,
            jsonb_build_object(
              'contractVersion',$30::text,
              'lifecycleEventId',lifecycle.id,
              'lifecycleEventType',lifecycle.event_type,
              'placementId',lifecycle.aggregate_id,
              'monitorRunId',target.id,
              'monitorPolicyId',target.monitor_policy_id,
              'observationId',$8,
              'previousHealthStatus',target.previous_health_status,
              'healthStatus',placement.health_status,
              'kpiProjection',$31::jsonb
            ),
            1,$17,$17,$17,$20,$20
          FROM inserted_lifecycle lifecycle
          JOIN target ON true
          JOIN current_placement placement ON true
          WHERE $27::uuid IS NOT NULL
          RETURNING *
        ), updated_policy AS (
          UPDATE backlink_monitor_policies policy
          SET next_check_at=$22,version=policy.version+1,updated_at=$17,
            updated_by=$20
          FROM updated_run run,inserted_decision
          WHERE (
            policy.organization_id,policy.workspace_id,
            policy.website_project_id,policy.id,policy.placement_id,
            policy.policy_version,policy.next_check_at
          )=(
            run.organization_id,run.workspace_id,
            run.website_project_id,run.monitor_policy_id,run.placement_id,
            run.policy_version,run.scheduled_for
          )
          RETURNING policy.id
        )
        SELECT run.id AS "runId",run.status,
          run.attempt_count AS "attemptCount",
          run.next_retry_at AS "nextRetryAt",
          run.retry_after_seconds AS "retryAfterSeconds",
          run.error_code AS "errorCode",
          observation.result AS "observationResult"
        FROM updated_run run
        JOIN backlink_monitor_observations observation ON (
          observation.organization_id,observation.workspace_id,
          observation.website_project_id,observation.monitor_run_id
        )=(
          run.organization_id,run.workspace_id,
          run.website_project_id,run.id
        )
        LEFT JOIN updated_policy policy ON true
      `, [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.runId,
        input.placementId,
        input.monitorPolicyId,
        input.policyVersion,
        input.observationId,
        input.observation.result,
        input.observation.failureCode,
        JSON.stringify(input.observation.evidenceSnapshot),
        input.observation.evidenceSnapshotHash,
        input.observation.evidenceFingerprint,
        input.observation.evidenceContractVersion,
        input.observation.evidenceSchemaVersion,
        input.observation.observedAt,
        input.completedAt,
        input.scheduledFor,
        input.expectedAttemptCount,
        input.workerId,
        input.terminalStatus,
        input.nextCheckAt,
        input.expectedPlacementVersion,
        input.expectedHealthStatus,
        input.recoveryProjection?.nextHealthStatus
          ?? input.statusDecision.nextHealthStatus,
        input.recoveryProjection?.lifecycleEventId ?? null,
        input.recoveryProjection?.outboxEventId ?? null,
        input.recoveryProjection?.eventType ?? null,
        input.recoveryProjection?.reasonCode ?? null,
        monitoringLifecycleOutboxEventType,
        JSON.stringify(input.recoveryProjection?.kpiProjection ?? null),
        input.decisionFactId,
        placementMonitoringStatusDecisionFactEventType,
        input.statusDecision.policyVersion,
        input.lossConfirmationCount,
        input.changeConfirmationCount,
        input.statusDecision.matchingEvidenceCount,
        input.statusDecision.requiredConfirmationCount,
        input.statusDecision.confirmationType,
        input.recoveryProjection?.reasonCode
          ?? input.statusDecision.reasonCode,
        placementMonitoringStatusDecisionFactContractVersion,
      ]);
      const row = result.rows[0];
      if (row !== undefined) return mapRunRecord(row);
      const record = await currentRecord(input);
      if (record.status === "RUNNING") {
        throw new Error(
          "Placement Monitor state changed before completion.",
        );
      }
      return record;
    },
  };
}

function mapRunRecord(
  row: Record<string, unknown>,
): PlacementMonitorRunRecord {
  return {
    runId: String(row.runId),
    status: runStatus(row.status),
    attemptCount: Number(row.attemptCount),
    nextRetryAt: nullableDate(row.nextRetryAt),
    retryAfterSeconds: row.retryAfterSeconds === null
      || row.retryAfterSeconds === undefined
      ? null
      : Number(row.retryAfterSeconds),
    errorCode: nullableString(row.errorCode),
    observationResult: observationResult(row.observationResult),
  };
}
