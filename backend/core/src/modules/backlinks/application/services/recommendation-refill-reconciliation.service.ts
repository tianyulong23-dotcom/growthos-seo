import { createHash } from "node:crypto";

import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";
import {
  completeRecommendationRefillSupersession,
  requestRecommendationRefillSupersession,
} from "./recommendation-refill-supersession.service.js";
import type {
  RecommendationRefillContextIdentity,
  RecommendationRefillSupersessionSignal,
} from "../../workflows/definitions/backlink-recommendation-refill.orchestration.js";

export type RecommendationRefillWorkflowState =
  | "running"
  | "closed"
  | "missing"
  | "unknown";

export type RecommendationRefillWorkflowProbe = Readonly<{
  inspect(workflowId: string): Promise<RecommendationRefillWorkflowState>;
  readSupersession(
    workflowId: string,
  ): Promise<RecommendationRefillSupersessionSignal | null>;
  signalSuperseded(
    workflowId: string,
    signal: RecommendationRefillSupersessionSignal,
  ): Promise<void>;
}>;

export type RecommendationRefillReconciliationMode = "dry-run" | "apply";

export type RecommendationRefillOperationIdentity = Readonly<{
  jobId: string;
  workflowId: string;
}>;

export type RecommendationRefillReconciliationEntry = Readonly<{
  websiteProjectId: string;
  projectContextVersionId: string;
  jobId?: string;
  workflowId?: string;
  state: "running" | "failed";
  reason:
    | "LIVE_JOB"
    | "PENDING_WORKFLOW_START"
    | "LIVE_PROVIDER_LEASE"
    | "PROVIDER_SIDE_EFFECT"
    | "LIVE_WORKFLOW"
    | "SUPERSEDED_LIVE_WORKFLOW"
    | "SUPERSEDED_LIVE_WORKFLOW_SIGNALLED"
    | "SUPERSEDED_FAILED_WORKFLOW"
    | "FAILED_WORKFLOW"
    | "WORKFLOW_LIVENESS_UNKNOWN"
    | "NO_LIVE_JOB_WORKFLOW_OR_LEASE";
  plannedAction:
    | "NO_CHANGE"
    | "SIGNAL_SUPERSEDE"
    | "AWAIT_SUPERSEDED_TERMINAL"
    | "COMPENSATE_SUPERSEDED_TERMINAL"
    | "RESET_RUNNING_TO_IDLE";
  applied: boolean;
}>;

export type RecommendationRefillReconciliationResult = Readonly<{
  mode: RecommendationRefillReconciliationMode;
  scannedRunningCount: number;
  projectCount: number;
  plannedChangeCount: number;
  appliedChangeCount: number;
  entries: readonly RecommendationRefillReconciliationEntry[];
}>;

type WorkflowExecution = Readonly<{
  jobId: string;
  workflowId: string;
  status: string;
}>;

type RunningState = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  projectContextVersionId: string;
  state: "running" | "failed";
  workflowExecutions: readonly WorkflowExecution[];
  hasPendingOutbox: boolean;
  hasLiveLease: boolean;
  hasProviderSideEffect: boolean;
  currentContext: RecommendationRefillContextIdentity | null;
  latestContext: RecommendationRefillContextIdentity | null;
}>;

type WorkflowObservation = Readonly<{
  state: RecommendationRefillWorkflowState;
  supersession: RecommendationRefillSupersessionSignal | null;
}>;

const reconciliationLockSql =
  `SELECT pg_advisory_xact_lock(
     hashtextextended($1::uuid::text||':'||$2::uuid::text||
       ':recommendation-refill-reconcile',0)
   )`;

const runningStatesSql =
  `WITH candidate_contexts AS (
     SELECT policy.website_project_id,
            policy.project_context_version_id
       FROM backlink_commercial_inventory_policies AS policy
      WHERE (policy.organization_id,policy.workspace_id,
             policy.website_project_id)=($4,$1,$2)
        AND policy.refill_state='running'
     UNION
     SELECT job.website_project_id,job.source_object_id
       FROM backlink_jobs AS job
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id)=($4,$1,$2)
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
        AND job.status IN ('queued','running','waiting_provider')
     UNION
     SELECT job.website_project_id,job.source_object_id
       FROM backlink_jobs AS job
       JOIN backlink_project_context_snapshots AS old_context
         ON (old_context.organization_id,old_context.workspace_id,
             old_context.website_project_id,old_context.id)=
            (job.organization_id,job.workspace_id,
             job.website_project_id,job.source_object_id)
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id)=($4,$1,$2)
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
        AND job.status='failed'
        AND EXISTS (
          SELECT 1
            FROM backlink_project_context_snapshots AS newer_context
           WHERE (newer_context.organization_id,newer_context.workspace_id,
                  newer_context.website_project_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id)
             AND newer_context.snapshot_version>
                 old_context.snapshot_version
        )
   )
   SELECT candidate.website_project_id "websiteProjectId",
          candidate.project_context_version_id "projectContextVersionId",
          CASE
            WHEN EXISTS (
              SELECT 1
                FROM backlink_commercial_inventory_policies AS policy
               WHERE (policy.organization_id,policy.workspace_id,
                      policy.website_project_id,
                      policy.project_context_version_id)=
                     ($4,$1,candidate.website_project_id,
                      candidate.project_context_version_id)
                 AND policy.refill_state='running'
            ) OR EXISTS (
              SELECT 1
                FROM backlink_jobs AS job
               WHERE (job.organization_id,job.workspace_id,
                      job.website_project_id,job.source_object_id)=
                     ($4,$1,candidate.website_project_id,
                      candidate.project_context_version_id)
                 AND job.job_type='recommendation_refill'
                 AND job.source_object_type='recommendation_context'
                 AND job.status IN ('queued','running','waiting_provider')
            )
            THEN 'running'
            ELSE 'failed'
          END state,
          COALESCE((
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'jobId',job.id::text,
                       'workflowId',job.workflow_id,
                       'status',job.status
                     )
                     ORDER BY job.created_at DESC
                   )
              FROM backlink_jobs AS job
             WHERE (job.organization_id,job.workspace_id,
                    job.website_project_id)=
                   ($4,$1,candidate.website_project_id)
               AND job.job_type='recommendation_refill'
               AND job.source_object_type='recommendation_context'
               AND job.source_object_id=
                   candidate.project_context_version_id
          ),'[]'::jsonb) "workflowExecutions",
          EXISTS (
            SELECT 1
              FROM backlink_jobs AS job
              JOIN backlink_outbox_events AS event
                ON (event.organization_id,event.workspace_id,
                    event.website_project_id,event.aggregate_id)=
                   (job.organization_id,job.workspace_id,
                    job.website_project_id,job.id)
               AND event.event_type=
                   'backlinks.recommendation-refill.requested.v1'
             WHERE (job.organization_id,job.workspace_id,
                    job.website_project_id)=
                   ($4,$1,candidate.website_project_id)
               AND job.job_type='recommendation_refill'
               AND job.source_object_type='recommendation_context'
               AND job.source_object_id=
                   candidate.project_context_version_id
               AND event.status IN ('pending','processing')
          ) "hasPendingOutbox",
          EXISTS (
            SELECT 1
              FROM backlink_jobs AS job
              JOIN backlink_commercial_discovery_batches AS batch
                ON (batch.organization_id,batch.workspace_id,
                    batch.website_project_id,batch.refill_job_id)=
                   (job.organization_id,job.workspace_id,
                    job.website_project_id,job.id)
              JOIN provider_fetch_leases AS lease
                ON lease.owner_request_id LIKE
                   regexp_replace(
                     batch.idempotency_key,
                     '^commercial-discovery:',
                     ''
                   )||':%'
             WHERE (job.organization_id,job.workspace_id,
                    job.website_project_id)=
                   ($4,$1,candidate.website_project_id)
               AND job.job_type='recommendation_refill'
               AND job.source_object_type='recommendation_context'
               AND job.source_object_id=
                   candidate.project_context_version_id
               AND lease.status='acquired'
               AND lease.lease_expires_at>$3
          ) "hasLiveLease",
          (
            EXISTS (
              SELECT 1
                FROM backlink_jobs AS job
                JOIN backlink_commercial_discovery_batches AS batch
                  ON (batch.organization_id,batch.workspace_id,
                      batch.website_project_id,batch.refill_job_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id,job.id)
                JOIN backlink_provider_usage_ledger AS usage
                  ON (usage.organization_id,usage.workspace_id,
                      usage.website_project_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id)
                 AND usage.provider='dataforseo'
                 AND usage.reservation_key LIKE
                     regexp_replace(
                       batch.idempotency_key,
                       '^commercial-discovery:',
                       ''
                     )||':%'
                 AND usage.status='reserved'
               WHERE (job.organization_id,job.workspace_id,
                      job.website_project_id)=
                     ($4,$1,candidate.website_project_id)
                 AND job.job_type='recommendation_refill'
                 AND job.source_object_type='recommendation_context'
                 AND job.source_object_id=
                     candidate.project_context_version_id
            )
            OR EXISTS (
              SELECT 1
                FROM backlink_jobs AS job
                JOIN backlink_commercial_discovery_batches AS batch
                  ON (batch.organization_id,batch.workspace_id,
                      batch.website_project_id,batch.refill_job_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id,job.id)
                JOIN provider_batch_requests AS request
                  ON (request.organization_id,request.workspace_id,
                      request.website_project_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id)
                 AND request.request_id LIKE
                     regexp_replace(
                       batch.idempotency_key,
                       '^commercial-discovery:',
                       ''
                     )||':%'
               WHERE (job.organization_id,job.workspace_id,
                      job.website_project_id)=
                     ($4,$1,candidate.website_project_id)
                 AND job.job_type='recommendation_refill'
                 AND job.source_object_type='recommendation_context'
                 AND job.source_object_id=
                     candidate.project_context_version_id
                 AND request.status IN ('running','unknown_charge')
            )
          ) "hasProviderSideEffect",
          current_context.id "currentContextVersionId",
          current_context.snapshot_version "currentSnapshotVersion",
          current_context.profile_version_id "currentProfileVersionId",
          current_context.promotion_target_version_id
            "currentPromotionTargetVersionId",
          current_pin.immutable_fingerprint
            "currentGenerationInputFingerprint",
          latest_context.id "latestContextVersionId",
          latest_context.snapshot_version "latestSnapshotVersion",
          latest_context.profile_version_id "latestProfileVersionId",
          latest_context.promotion_target_version_id
            "latestPromotionTargetVersionId",
          latest_pin.immutable_fingerprint
            "latestGenerationInputFingerprint"
     FROM candidate_contexts AS candidate
     LEFT JOIN backlink_project_context_snapshots AS current_context
       ON (current_context.organization_id,current_context.workspace_id,
           current_context.website_project_id,current_context.id)=
          ($4,$1,candidate.website_project_id,
           candidate.project_context_version_id)
     LEFT JOIN backlink_generation_input_pins AS current_pin
       ON (current_pin.organization_id,current_pin.workspace_id,
           current_pin.website_project_id,
           current_pin.project_context_version)=
          (current_context.organization_id,current_context.workspace_id,
           current_context.website_project_id,
           current_context.snapshot_version)
     LEFT JOIN LATERAL (
       SELECT snapshot.*
         FROM backlink_project_context_snapshots AS snapshot
        WHERE (snapshot.organization_id,snapshot.workspace_id,
               snapshot.website_project_id)=
              ($4,$1,candidate.website_project_id)
        ORDER BY snapshot.snapshot_version DESC
        LIMIT 1
     ) AS latest_context ON true
     LEFT JOIN backlink_generation_input_pins AS latest_pin
       ON (latest_pin.organization_id,latest_pin.workspace_id,
           latest_pin.website_project_id,
           latest_pin.project_context_version)=
          (latest_context.organization_id,latest_context.workspace_id,
           latest_context.website_project_id,
           latest_context.snapshot_version)
    ORDER BY candidate.project_context_version_id`;

const applyReconciliationSql =
  `WITH orphan_jobs AS (
     UPDATE backlink_jobs AS job
        SET status='failed',
            step='orphan_operation_reconciled',
            progress=100,
            error=jsonb_build_object(
              'code','ORPHAN_REFILL_OPERATION',
              'rootCause','ORPHAN_OPERATION',
              'recovery','RESTART_SERVICE',
              'providerCallOccurred',false,
              'diagnosticId',
                'refill-'||left(replace(job.id::text,'-',''),12)||'-orphan',
              'message',
                'The operation has no live owner. Reconcile or restart the service.'
            ),
            finished_at=$5,
            updated_at=$5,
            updated_by=$6,
            version=version+1
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id,job.source_object_id)=($1,$2,$3,$4)
        AND job.id=ANY($7::uuid[])
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
        AND job.status IN ('queued','running','waiting_provider')
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_outbox_events AS event
           WHERE (event.organization_id,event.workspace_id,
                  event.website_project_id,event.aggregate_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND event.event_type=
                 'backlinks.recommendation-refill.requested.v1'
             AND event.status IN ('pending','processing')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_commercial_discovery_batches AS batch
            JOIN backlink_provider_usage_ledger AS usage
              ON (usage.organization_id,usage.workspace_id,
                  usage.website_project_id)=
                 (batch.organization_id,batch.workspace_id,
                  batch.website_project_id)
             AND usage.provider='dataforseo'
             AND usage.reservation_key LIKE
                 regexp_replace(
                   batch.idempotency_key,
                   '^commercial-discovery:',
                   ''
                 )||':%'
             AND usage.status='reserved'
           WHERE (batch.organization_id,batch.workspace_id,
                  batch.website_project_id,batch.refill_job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_commercial_discovery_batches AS batch
            JOIN provider_batch_requests AS request
              ON (request.organization_id,request.workspace_id,
                  request.website_project_id)=
                 (batch.organization_id,batch.workspace_id,
                  batch.website_project_id)
             AND request.request_id LIKE
                 regexp_replace(
                   batch.idempotency_key,
                   '^commercial-discovery:',
                   ''
                 )||':%'
           WHERE (batch.organization_id,batch.workspace_id,
                  batch.website_project_id,batch.refill_job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND request.status IN ('running','unknown_charge')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_commercial_discovery_batches AS batch
            JOIN provider_fetch_leases AS lease
              ON lease.owner_request_id LIKE
                 regexp_replace(
                   batch.idempotency_key,
                   '^commercial-discovery:',
                   ''
                 )||':%'
           WHERE (batch.organization_id,batch.workspace_id,
                  batch.website_project_id,batch.refill_job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND lease.status='acquired'
             AND lease.lease_expires_at>$5
        )
    RETURNING job.id
   ),
   reconciled_policy AS (
     UPDATE backlink_commercial_inventory_policies AS policy
        SET refill_state='idle',
            pause_reason='orphan_operation_reconciled',
            termination_reason=NULL,
            next_refill_at=$5,
            updated_at=$5,
            updated_by=$6,
            version=version+1
      WHERE (policy.organization_id,policy.workspace_id,
             policy.website_project_id,
             policy.project_context_version_id)=($1,$2,$3,$4)
        AND policy.refill_state='running'
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_jobs AS job
           WHERE (job.organization_id,job.workspace_id,
                  job.website_project_id)=
                 (policy.organization_id,policy.workspace_id,
                  policy.website_project_id)
             AND job.job_type='recommendation_refill'
             AND job.source_object_type='recommendation_context'
             AND job.source_object_id=policy.project_context_version_id
             AND job.status IN ('queued','running','waiting_provider')
             AND NOT EXISTS (
               SELECT 1
                 FROM orphan_jobs
                WHERE orphan_jobs.id=job.id
             )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_jobs AS job
            JOIN backlink_outbox_events AS event
              ON (event.organization_id,event.workspace_id,
                  event.website_project_id,event.aggregate_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND event.event_type=
                 'backlinks.recommendation-refill.requested.v1'
           WHERE (job.organization_id,job.workspace_id,
                  job.website_project_id)=
                 (policy.organization_id,policy.workspace_id,
                  policy.website_project_id)
             AND job.job_type='recommendation_refill'
             AND job.source_object_type='recommendation_context'
             AND job.source_object_id=policy.project_context_version_id
             AND event.status IN ('pending','processing')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_jobs AS job
            JOIN backlink_commercial_discovery_batches AS batch
              ON (batch.organization_id,batch.workspace_id,
                  batch.website_project_id,batch.refill_job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
            JOIN provider_fetch_leases AS lease
              ON lease.owner_request_id LIKE
                 regexp_replace(
                   batch.idempotency_key,
                   '^commercial-discovery:',
                   ''
                 )||':%'
           WHERE (job.organization_id,job.workspace_id,
                  job.website_project_id)=
                 (policy.organization_id,policy.workspace_id,
                  policy.website_project_id)
             AND job.job_type='recommendation_refill'
             AND job.source_object_type='recommendation_context'
             AND job.source_object_id=policy.project_context_version_id
             AND lease.status='acquired'
             AND lease.lease_expires_at>$5
        )
    RETURNING policy.project_context_version_id
   ),
   closed_batches AS (
     UPDATE backlink_commercial_discovery_batches AS batch
        SET status='failed',
            pause_reason='orphan_operation_reconciled',
            finished_at=COALESCE(batch.finished_at,$5)
      WHERE (batch.organization_id,batch.workspace_id,
             batch.website_project_id,
             batch.project_context_version_id)=($1,$2,$3,$4)
        AND batch.status='running'
        AND (
          EXISTS (SELECT 1 FROM reconciled_policy)
          OR EXISTS (SELECT 1 FROM orphan_jobs)
        )
    RETURNING batch.id
   )
   SELECT (
            EXISTS (SELECT 1 FROM orphan_jobs)
            OR EXISTS (SELECT 1 FROM reconciled_policy)
          ) applied,
          (SELECT count(*)::integer FROM closed_batches) "closedBatchCount"`;

function boolean(value: unknown): boolean {
  return value === true || value === "true";
}

function contextIdentity(
  row: Record<string, unknown>,
  prefix: "current" | "latest",
): RecommendationRefillContextIdentity | null {
  const contextVersionId = row[`${prefix}ContextVersionId`];
  const snapshotVersion = Number(row[`${prefix}SnapshotVersion`]);
  const profileVersionId = row[`${prefix}ProfileVersionId`];
  const promotionTargetVersionId =
    row[`${prefix}PromotionTargetVersionId`];
  const generationInputFingerprint =
    row[`${prefix}GenerationInputFingerprint`];
  if (
    typeof contextVersionId !== "string"
    || !Number.isSafeInteger(snapshotVersion)
    || snapshotVersion < 1
    || typeof profileVersionId !== "string"
    || typeof promotionTargetVersionId !== "string"
    || typeof generationInputFingerprint !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    contextVersionId,
    snapshotVersion,
    profileVersionId,
    promotionTargetVersionId,
    generationInputFingerprint,
  });
}

function workflowExecutions(value: unknown): readonly WorkflowExecution[] {
  if (typeof value === "string") {
    try {
      return workflowExecutions(JSON.parse(value) as unknown);
    } catch {
      return Object.freeze([]);
    }
  }
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.jobId !== "string"
      || typeof record.workflowId !== "string"
      || typeof record.status !== "string"
    ) {
      return [];
    }
    return [Object.freeze({
      jobId: record.jobId,
      workflowId: record.workflowId,
      status: record.status,
    })];
  }));
}

async function listRunningStates(
  client: BacklinkTransactionClient,
  scope: BacklinkTenantContext,
  observedAt: Date,
): Promise<readonly RunningState[]> {
  await client.query(reconciliationLockSql, [
    scope.workspaceId,
    scope.websiteProjectId,
  ]);
  const result = await client.query(runningStatesSql, [
    scope.workspaceId,
    scope.websiteProjectId,
    observedAt,
    scope.organizationId,
  ]);
  return Object.freeze(result.rows.map((row) => Object.freeze({
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    websiteProjectId: String(row.websiteProjectId),
    projectContextVersionId: String(row.projectContextVersionId),
    state: row.state === "failed" ? "failed" : "running",
    workflowExecutions: workflowExecutions(row.workflowExecutions),
    hasPendingOutbox: boolean(row.hasPendingOutbox),
    hasLiveLease: boolean(row.hasLiveLease),
    hasProviderSideEffect: boolean(row.hasProviderSideEffect),
    currentContext: contextIdentity(row, "current"),
    latestContext: contextIdentity(row, "latest"),
  })));
}

async function inspectWorkflows(
  states: readonly RunningState[],
  probe: RecommendationRefillWorkflowProbe,
): Promise<ReadonlyMap<string, WorkflowObservation>> {
  const workflowIds = [...new Set(states.flatMap((state) =>
    state.workflowExecutions.map(({ workflowId }) => workflowId)
  ))];
  const observations = await Promise.all(workflowIds.map(
    async (workflowId) => {
      const state = await probe.inspect(workflowId);
      return [
        workflowId,
        Object.freeze({
          state,
          supersession: state === "running"
            ? await probe.readSupersession(workflowId)
            : null,
        }),
      ] as const;
    },
  ));
  return new Map(observations);
}

function hasNewerAuthority(state: RunningState): boolean {
  return state.currentContext !== null
    && state.latestContext !== null
    && state.latestContext.snapshotVersion
      > state.currentContext.snapshotVersion;
}

function matchingSupersession(
  state: RunningState,
  execution: WorkflowExecution,
  signal: RecommendationRefillSupersessionSignal | null,
): boolean {
  return signal !== null
    && state.currentContext !== null
    && state.latestContext !== null
    && signal.organizationId === state.organizationId
    && signal.workspaceId === state.workspaceId
    && signal.websiteProjectId === state.websiteProjectId
    && signal.jobId === execution.jobId
    && signal.workflowId === execution.workflowId
    && signal.oldContext.contextVersionId
      === state.currentContext.contextVersionId
    && signal.oldContext.snapshotVersion
      === state.currentContext.snapshotVersion
    && signal.oldContext.profileVersionId
      === state.currentContext.profileVersionId
    && signal.oldContext.promotionTargetVersionId
      === state.currentContext.promotionTargetVersionId
    && signal.oldContext.generationInputFingerprint
      === state.currentContext.generationInputFingerprint
    && signal.authoritativeContext.contextVersionId
      === state.latestContext.contextVersionId
    && signal.authoritativeContext.snapshotVersion
      === state.latestContext.snapshotVersion
    && signal.authoritativeContext.profileVersionId
      === state.latestContext.profileVersionId
    && signal.authoritativeContext.promotionTargetVersionId
      === state.latestContext.promotionTargetVersionId
    && signal.authoritativeContext.generationInputFingerprint
      === state.latestContext.generationInputFingerprint
    && signal.idempotencyKey
      === `recommendation-refill.supersede:${execution.jobId}:`
        + state.latestContext.contextVersionId;
}

function classify(
  state: RunningState,
  observations: ReadonlyMap<string, WorkflowObservation>,
): RecommendationRefillReconciliationEntry["reason"] {
  const liveExecutions = state.workflowExecutions.filter(({ status }) =>
    status === "queued" || status === "running" || status === "waiting_provider"
  );
  const inspected = liveExecutions.length > 0
    ? liveExecutions
    : state.workflowExecutions;
  const statuses = inspected.map(({ workflowId }) =>
    observations.get(workflowId)?.state ?? "unknown"
  );
  if (statuses.includes("running") && hasNewerAuthority(state)) {
    const signalled = inspected.some((execution) =>
      observations.get(execution.workflowId)?.state === "running"
      && matchingSupersession(
        state,
        execution,
        observations.get(execution.workflowId)?.supersession ?? null,
      )
    );
    return signalled
      ? "SUPERSEDED_LIVE_WORKFLOW_SIGNALLED"
      : "SUPERSEDED_LIVE_WORKFLOW";
  }
  if (statuses.includes("running")) return "LIVE_WORKFLOW";
  if (state.hasPendingOutbox) return "PENDING_WORKFLOW_START";
  if (state.hasLiveLease) return "LIVE_PROVIDER_LEASE";
  if (state.hasProviderSideEffect) return "PROVIDER_SIDE_EFFECT";
  if (statuses.includes("unknown")) return "WORKFLOW_LIVENESS_UNKNOWN";
  if (state.state === "failed") {
    return hasNewerAuthority(state)
      ? "SUPERSEDED_FAILED_WORKFLOW"
      : "FAILED_WORKFLOW";
  }
  return "NO_LIVE_JOB_WORKFLOW_OR_LEASE";
}

function operationEntries(
  state: RunningState,
  observations: ReadonlyMap<string, WorkflowObservation>,
): readonly RecommendationRefillReconciliationEntry[] {
  if (!hasNewerAuthority(state)) return Object.freeze([]);
  const entries = state.workflowExecutions.flatMap((execution) => {
    const workflowState =
      observations.get(execution.workflowId)?.state ?? "unknown";
    if (
      (
        execution.status === "queued"
        || execution.status === "running"
        || execution.status === "waiting_provider"
      )
      && workflowState === "running"
    ) {
      const reason = matchingSupersession(
        state,
        execution,
        observations.get(execution.workflowId)?.supersession ?? null,
      )
        ? "SUPERSEDED_LIVE_WORKFLOW_SIGNALLED"
        : "SUPERSEDED_LIVE_WORKFLOW";
      return [entry(state, observations, false, execution, reason)];
    }
    if (
      execution.status === "failed"
      && ["closed", "missing"].includes(workflowState)
      && !state.hasPendingOutbox
      && !state.hasLiveLease
      && !state.hasProviderSideEffect
    ) {
      return [entry(
        state,
        observations,
        false,
        execution,
        "SUPERSEDED_FAILED_WORKFLOW",
      )];
    }
    return [];
  });
  return Object.freeze(entries);
}

function orphanJobIds(
  state: RunningState,
  observations: ReadonlyMap<string, WorkflowObservation>,
): readonly string[] {
  return Object.freeze(state.workflowExecutions
    .filter(({ status, workflowId }) =>
      (
        status === "queued"
        || status === "running"
        || status === "waiting_provider"
      )
      && ["closed", "missing"].includes(
        observations.get(workflowId)?.state ?? "unknown",
      )
    )
    .map(({ jobId }) => jobId));
}

function entry(
  state: RunningState,
  observations: ReadonlyMap<string, WorkflowObservation>,
  applied: boolean,
  execution?: WorkflowExecution,
  reasonOverride?: RecommendationRefillReconciliationEntry["reason"],
): RecommendationRefillReconciliationEntry {
  const reason = reasonOverride ?? classify(state, observations);
  const plannedAction = reason === "NO_LIVE_JOB_WORKFLOW_OR_LEASE"
    ? "RESET_RUNNING_TO_IDLE"
    : reason === "SUPERSEDED_LIVE_WORKFLOW"
    ? "SIGNAL_SUPERSEDE"
    : reason === "SUPERSEDED_LIVE_WORKFLOW_SIGNALLED"
    ? "AWAIT_SUPERSEDED_TERMINAL"
    : reason === "SUPERSEDED_FAILED_WORKFLOW"
    ? "COMPENSATE_SUPERSEDED_TERMINAL"
    : "NO_CHANGE";
  return Object.freeze({
    websiteProjectId: state.websiteProjectId,
    projectContextVersionId: state.projectContextVersionId,
    ...(execution === undefined
      ? {}
      : {
          jobId: execution.jobId,
          workflowId: execution.workflowId,
        }),
    state: state.state,
    reason,
    plannedAction,
    applied,
  });
}

function result(
  mode: RecommendationRefillReconciliationMode,
  entries: readonly RecommendationRefillReconciliationEntry[],
): RecommendationRefillReconciliationResult {
  const planned = entries.filter(
    ({ plannedAction }) =>
      plannedAction === "RESET_RUNNING_TO_IDLE"
      || plannedAction === "SIGNAL_SUPERSEDE"
      || plannedAction === "COMPENSATE_SUPERSEDED_TERMINAL",
  );
  return Object.freeze({
    mode,
    scannedRunningCount: entries.length,
    projectCount: new Set(planned.map(({ websiteProjectId }) =>
      websiteProjectId
    )).size,
    plannedChangeCount: planned.length,
    appliedChangeCount: entries.filter(({ applied }) => applied).length,
    entries: Object.freeze(entries),
  });
}

function entries(
  state: RunningState,
  observations: ReadonlyMap<string, WorkflowObservation>,
): readonly RecommendationRefillReconciliationEntry[] {
  const perOperation = operationEntries(state, observations);
  return perOperation.length > 0
    ? perOperation
    : Object.freeze([entry(state, observations, false)]);
}

function selectOperation(
  states: readonly RunningState[],
  operation: RecommendationRefillOperationIdentity | undefined,
): readonly RunningState[] {
  if (operation === undefined) return states;
  return Object.freeze(states.flatMap((state) => {
    const selected = state.workflowExecutions.filter((execution) =>
      execution.jobId === operation.jobId
      && execution.workflowId === operation.workflowId
      && (
        execution.status === "queued"
        || execution.status === "running"
        || execution.status === "waiting_provider"
        || execution.status === "failed"
      )
    );
    if (selected.length === 0) return [];
    return [Object.freeze({
      ...state,
      state: selected.some(({ status }) =>
          status === "queued"
          || status === "running"
          || status === "waiting_provider"
        )
        ? "running" as const
        : "failed" as const,
      workflowExecutions: Object.freeze(selected),
    })];
  }));
}

function requiresOperationIdentity(
  states: readonly RunningState[],
  observations: ReadonlyMap<string, WorkflowObservation>,
): boolean {
  return states.some((state) =>
    entries(state, observations).some(({ plannedAction }) =>
      plannedAction === "SIGNAL_SUPERSEDE"
      || plannedAction === "COMPENSATE_SUPERSEDED_TERMINAL"
    )
  );
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function supersessionSignal(
  scope: BacklinkTenantContext,
  state: RunningState,
  execution: WorkflowExecution,
  actorId: string,
): RecommendationRefillSupersessionSignal | null {
  if (!hasNewerAuthority(state)) return null;
  const oldContext = state.currentContext;
  const authoritativeContext = state.latestContext;
  if (oldContext === null || authoritativeContext === null) return null;
  const identity =
    `${scope.workspaceId}:${execution.jobId}:`
    + authoritativeContext.contextVersionId;
  return Object.freeze({
    contractVersion: 1,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    websiteProjectId: scope.websiteProjectId,
    jobId: execution.jobId,
    workflowId: execution.workflowId,
    oldContext,
    authoritativeContext,
    actorId,
    correlationId: `recommendation-refill-supersede:${identity}`,
    requestId: `recommendation-refill-supersede:${identity}`,
    idempotencyKey:
      `recommendation-refill.supersede:${execution.jobId}:`
      + authoritativeContext.contextVersionId,
    lifecycleEventId: deterministicUuid(`lifecycle:${identity}`),
    auditEventId: deterministicUuid(`audit:${identity}`),
  });
}

export async function reconcileRecommendationRefillOrphans(
  input: Readonly<{
    pool: BacklinkTenantPool;
    scope: BacklinkTenantContext;
    actorId: string;
    mode: RecommendationRefillReconciliationMode;
    operation?: RecommendationRefillOperationIdentity;
    workflowProbe: RecommendationRefillWorkflowProbe;
    now?: () => Date;
  }>,
): Promise<RecommendationRefillReconciliationResult> {
  const observedAt = (input.now ?? (() => new Date()))();
  const listed = await withBacklinkTenantTransaction(
    input.pool,
    input.scope,
    (client) => listRunningStates(client, input.scope, observedAt),
  );
  const current = selectOperation(listed, input.operation);
  const observations = await inspectWorkflows(
    current,
    input.workflowProbe,
  );
  if (
    input.mode === "apply"
    && input.operation === undefined
    && requiresOperationIdentity(current, observations)
  ) {
    throw new Error(
      "RECOMMENDATION_REFILL_RECONCILIATION_OPERATION_IDENTITY_REQUIRED",
    );
  }
  if (input.mode === "dry-run") {
    return result(
      input.mode,
      current.flatMap((state) => entries(state, observations)),
    );
  }

  const reconciled: RecommendationRefillReconciliationEntry[] = [];
  for (const state of current) {
    const candidates = entries(state, observations);
    const operationCandidates = candidates.filter(({ plannedAction }) =>
      plannedAction === "SIGNAL_SUPERSEDE"
      || plannedAction === "COMPENSATE_SUPERSEDED_TERMINAL"
    );
    if (operationCandidates.length > 0) {
      for (const candidate of operationCandidates) {
        const execution = state.workflowExecutions.find((item) =>
          item.jobId === candidate.jobId
          && item.workflowId === candidate.workflowId
        );
        if (execution === undefined) {
          reconciled.push(candidate);
          continue;
        }
        const signal = supersessionSignal(
          input.scope,
          state,
          execution,
          input.actorId,
        );
        if (signal === null) {
          reconciled.push(candidate);
          continue;
        }
        let applied = false;
        const integrityHash = createHash("sha256")
          .update(JSON.stringify(signal), "utf8")
          .digest("hex");
        const requested = await withBacklinkTenantTransaction(
          input.pool,
          input.scope,
          (client) => requestRecommendationRefillSupersession(client, {
            signal,
            now: observedAt,
            integrityHash,
          }),
        );
        if (requested.status !== "requested") {
          reconciled.push(candidate);
          continue;
        }
        if (candidate.plannedAction === "SIGNAL_SUPERSEDE") {
          await input.workflowProbe.signalSuperseded(
            execution.workflowId,
            signal,
          );
          applied = true;
        } else {
          const completed = await withBacklinkTenantTransaction(
            input.pool,
            input.scope,
            (client) => completeRecommendationRefillSupersession(client, {
              signal,
              now: observedAt,
              integrityHash,
            }),
          );
          applied = completed.status === "cancelled" && !completed.replayed;
        }
        reconciled.push(Object.freeze({ ...candidate, applied }));
      }
      continue;
    }
    const candidate = candidates[0];
    if (candidate === undefined) continue;
    if (candidate.plannedAction !== "RESET_RUNNING_TO_IDLE") {
      reconciled.push(candidate);
      continue;
    }
    const applied = await withBacklinkTenantTransaction(
      input.pool,
      input.scope,
      (client) => client.query(applyReconciliationSql, [
          input.scope.organizationId,
          input.scope.workspaceId,
          input.scope.websiteProjectId,
          state.projectContextVersionId,
          observedAt,
          input.actorId,
          orphanJobIds(state, observations),
        ]),
    );
    reconciled.push(entry(
      state,
      observations,
      boolean(applied.rows[0]?.applied),
    ));
  }
  return result(input.mode, reconciled);
}
