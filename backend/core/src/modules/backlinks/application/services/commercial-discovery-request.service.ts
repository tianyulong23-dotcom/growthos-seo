import { createHash, randomUUID } from "node:crypto";

import type {
  CommercialDataForSeoRuntime,
} from "../../adapters/dataforseo/commercial-official-runtime.js";
import type {
  DataForSeoCallGate,
} from "../policies/dataforseo-call.policy.js";
import {
  commercialDiscoveryArtifactSchema,
  fingerprintCommercialDiscoveryCall,
  normalizeCommercialDiscoveryResponse,
  serializeCommercialDiscoveryRequestPayload,
  type CommercialDiscoveryArtifact,
  type CommercialDiscoveryCall,
} from "../../domain/recommendations/commercial-discovery-source.js";
import {
  createProviderBudgetRepository,
} from "../../db/repositories/provider-budget.repository.js";
import {
  createProviderFetchLeaseRepository,
} from "../../db/repositories/provider-fetch-lease.repository.js";
import type {
  ProviderRequestContext,
} from "../../ports/dataforseo.port.js";

export type CommercialDiscoveryQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<
    Readonly<{ rows: readonly Record<string, unknown>[] }>
  >;
}>;

export type CommercialDiscoveryRequestResult = Readonly<{
  source: "cache" | "stale-cache" | "single-flight" | "provider";
  artifact: CommercialDiscoveryArtifact;
  providerTrace?: Readonly<{
    providerRequestId: string;
    providerBatchRequestId: string;
    providerUsageLedgerId: string;
    providerTaskId: string | null;
    actualCostMicros: number;
  }>;
}>;

class ReconciledProviderRequestWithoutResultError extends Error {
  readonly providerRequestStatus = "failed" as const;

  constructor() {
    super("DATAFORSEO_RECONCILED_NO_RESULT");
    this.name = "ReconciledProviderRequestWithoutResultError";
  }
}

function hashPayload(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function providerFailure(error: unknown): Readonly<{
  status: "failed" | "unknown_charge";
  code: string;
}> {
  if (
    typeof error === "object"
    && error !== null
    && "providerRequestStatus" in error
    && error.providerRequestStatus === "failed"
  ) {
    return {
      status: "failed",
      code: "DATAFORSEO_PROVIDER_FAILED_BEFORE_DISPATCH",
    };
  }
  if (
    error instanceof Error
    && error.name === "DataForSeoCallBlockedError"
  ) {
    return { status: "failed", code: error.message };
  }
  return {
    status: "unknown_charge",
    code: error instanceof Error ? error.message : "DATAFORSEO_RESULT_UNKNOWN",
  };
}

function artifactFromRow(
  row: Readonly<Record<string, unknown>>,
): CommercialDiscoveryArtifact {
  return commercialDiscoveryArtifactSchema.parse(row.normalizedPayload);
}

export class CommercialDiscoveryRequestService {
  constructor(private readonly dependencies: Readonly<{
    client: CommercialDiscoveryQueryClient;
    provider: CommercialDataForSeoRuntime;
    gate: DataForSeoCallGate;
    now(): Date;
    requiredRemainingPaidCalls?: number;
    requiredRemainingCostMicros?: number;
    followerWaitMs?: number;
    followerPollMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }>) {}

  private async transitionInterruptedRequest(input: Readonly<{
    context: ProviderRequestContext;
    projectContextVersionId: string;
    call: CommercialDiscoveryCall;
    requestFingerprint: string;
    interruptedAt: Date;
  }>): Promise<Readonly<{
    batchRequestId: string;
    providerTaskId: string | null;
    leaseOwnerRequestId: string;
    budgetReserved: boolean;
    startedAt: Date;
  }> | null> {
    const interrupted = await this.dependencies.client.query(
      `WITH guard AS (
         SELECT pg_advisory_xact_lock(
           hashtextextended(
             $1::text||':'||$2::text||':'||$3::text||':'||$4,
             0
           )
         )
       ),
       candidate AS MATERIALIZED (
         SELECT batch.id,
                batch.request_id AS "leaseOwnerRequestId",
                batch.provider_task_id AS "providerTaskId",
                batch.started_at AS "startedAt",
                EXISTS (
                  SELECT 1
                    FROM backlink_provider_usage_ledger AS usage
                   WHERE (
                     usage.organization_id,usage.workspace_id,
                     usage.website_project_id
                   )=(
                     batch.organization_id,batch.workspace_id,
                     batch.website_project_id
                   )
                     AND usage.provider='dataforseo'
                     AND usage.provider_request_id=batch.id
                     AND usage.reservation_key=batch.budget_reservation_id
                     AND usage.status='reserved'
                ) AS "budgetReserved"
           FROM guard
           CROSS JOIN provider_batch_requests AS batch
           JOIN backlink_provider_requests AS provider_request
             ON (
               provider_request.organization_id,
               provider_request.workspace_id,
               provider_request.website_project_id,
               provider_request.id
             )=(
               batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id
             )
           JOIN provider_fetch_leases AS lease
             ON lease.artifact_fingerprint=batch.normalized_request_hash
            AND lease.owner_request_id=batch.request_id
          WHERE (batch.organization_id,batch.workspace_id,
                 batch.website_project_id)=(
                   $1::uuid,$2::uuid,$3::uuid
                 )
            AND batch.normalized_request_hash=$4
            AND batch.endpoint=$5
            AND batch.response_schema_version=$6
            AND batch.request_id=$7
            AND batch.status='running'
            AND provider_request.status='running'
            AND lease.status='acquired'
            AND lease.lease_expires_at<=$8
          ORDER BY batch.started_at DESC
          LIMIT 1
          FOR UPDATE OF batch,provider_request,lease
       ),
       marked_batch AS (
         UPDATE provider_batch_requests AS batch
            SET status='unknown_charge',
                failure_code=CASE
                  WHEN candidate."providerTaskId" IS NULL
                    THEN 'DATAFORSEO_WORKER_INTERRUPTED_DISPATCH_UNKNOWN'
                  ELSE 'DATAFORSEO_WORKER_INTERRUPTED_AFTER_TASK_ACCEPTED'
                END,
                failed_count=1,
                finished_at=$8
           FROM candidate
          WHERE batch.id=candidate.id AND batch.status='running'
          RETURNING
            batch.id AS "batchRequestId",
            candidate."leaseOwnerRequestId",
            candidate."providerTaskId",
            candidate."budgetReserved",
            candidate."startedAt"
       ),
       marked_request AS (
         UPDATE backlink_provider_requests AS provider_request
            SET status='unknown_charge',finished_at=$8
           FROM marked_batch
          WHERE provider_request.id=marked_batch."batchRequestId"
            AND provider_request.status='running'
          RETURNING provider_request.id
       ),
       marked_lease AS (
         UPDATE provider_fetch_leases AS lease
            SET status='unknown_charge',
                failure_code=CASE
                  WHEN marked_batch."providerTaskId" IS NULL
                    THEN 'DATAFORSEO_WORKER_INTERRUPTED_DISPATCH_UNKNOWN'
                  ELSE 'DATAFORSEO_WORKER_INTERRUPTED_AFTER_TASK_ACCEPTED'
                END,
                heartbeat_at=$8,lease_expires_at=$8,updated_at=$8
           FROM marked_batch,marked_request
          WHERE lease.artifact_fingerprint=$4
            AND lease.owner_request_id=marked_batch."leaseOwnerRequestId"
            AND lease.status='acquired'
            AND lease.lease_expires_at<=$8
          RETURNING lease.artifact_fingerprint
       )
       SELECT marked_batch.*
         FROM marked_batch,marked_request,marked_lease`,
      [
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        input.requestFingerprint,
        input.call.endpoint,
        input.call.responseSchemaVersion,
        input.context.requestId,
        input.interruptedAt,
      ],
    );
    const row = interrupted.rows[0];
    if (row === undefined) return null;
    return Object.freeze({
      batchRequestId: String(row.batchRequestId),
      providerTaskId:
        typeof row.providerTaskId === "string"
          ? row.providerTaskId
          : null,
      leaseOwnerRequestId: String(row.leaseOwnerRequestId),
      budgetReserved: row.budgetReserved === true,
      startedAt: new Date(String(row.startedAt)),
    });
  }

  private async reconcileNotDispatched(input: Readonly<{
    context: ProviderRequestContext;
    batchRequestId: string;
    requestFingerprint: string;
    leaseOwnerRequestId: string;
    reconciledAt: Date;
  }>): Promise<void> {
    const result = await this.dependencies.client.query(
      `/* DATAFORSEO_RECONCILED_NOT_DISPATCHED */
       WITH guard AS (
         SELECT pg_advisory_xact_lock(
           hashtextextended(
             $1::text||':'||$2::text||':'||$3::text||':'||$5,
             0
           )
         )
       ),
       candidate AS MATERIALIZED (
         SELECT batch.id,
                batch.organization_id AS "organizationId",
                batch.workspace_id AS "workspaceId",
                usage.id AS "usageId",
                usage.budget_id AS "budgetId",
                usage.estimated_cost_micros AS "estimatedCostMicros"
           FROM guard
           CROSS JOIN provider_batch_requests AS batch
           JOIN backlink_provider_requests AS provider_request
             ON (
               provider_request.organization_id,
               provider_request.workspace_id,
               provider_request.website_project_id,
               provider_request.id
             )=(
               batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id
             )
           JOIN backlink_provider_usage_ledger AS usage
             ON (
               usage.organization_id,usage.workspace_id,
               usage.website_project_id,usage.provider_request_id
             )=(
               batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id
             )
            AND usage.provider='dataforseo'
            AND usage.reservation_key=batch.budget_reservation_id
           JOIN provider_fetch_leases AS lease
             ON lease.artifact_fingerprint=batch.normalized_request_hash
            AND lease.owner_request_id=batch.request_id
          WHERE (batch.organization_id,batch.workspace_id,
                 batch.website_project_id)=($1::uuid,$2::uuid,$3::uuid)
            AND batch.id=$4::uuid
            AND batch.normalized_request_hash=$5
            AND batch.request_id=$6
            AND batch.status='unknown_charge'
            AND batch.provider_task_id IS NULL
            AND provider_request.status='unknown_charge'
            AND usage.status='reserved'
            AND lease.status='unknown_charge'
          FOR UPDATE OF batch,provider_request,usage,lease
       ),
       released_usage AS (
         UPDATE backlink_provider_usage_ledger AS usage
            SET status='released',released_at=$7
           FROM candidate
          WHERE usage.id=candidate."usageId"
            AND usage.status='reserved'
          RETURNING usage.budget_id,usage.estimated_cost_micros
       ),
       released_budget AS (
         UPDATE backlink_provider_budgets AS budget
            SET reserved_micros=
                  budget.reserved_micros-released_usage.estimated_cost_micros,
                version=budget.version+1
           FROM released_usage,candidate
          WHERE budget.id=released_usage.budget_id
            AND budget.organization_id=candidate."organizationId"
            AND budget.workspace_id=candidate."workspaceId"
            AND budget.reserved_micros
                  >=released_usage.estimated_cost_micros
          RETURNING budget.id
       ),
       failed_request AS (
         UPDATE backlink_provider_requests AS provider_request
            SET status='failed',finished_at=$7
           FROM candidate
          WHERE provider_request.id=candidate.id
            AND provider_request.status='unknown_charge'
          RETURNING provider_request.id
       ),
       failed_batch AS (
         UPDATE provider_batch_requests AS batch
            SET status='failed',
                failure_code='DATAFORSEO_RECONCILED_NOT_DISPATCHED',
                finished_at=$7
           FROM candidate
          WHERE batch.id=candidate.id
            AND batch.status='unknown_charge'
          RETURNING batch.id
       ),
       failed_lease AS (
         UPDATE provider_fetch_leases AS lease
            SET status='failed',
                failure_code='DATAFORSEO_RECONCILED_NOT_DISPATCHED',
                heartbeat_at=$7,lease_expires_at=$7,updated_at=$7
           FROM candidate
          WHERE lease.artifact_fingerprint=$5
            AND lease.owner_request_id=$6
            AND lease.status='unknown_charge'
          RETURNING lease.artifact_fingerprint
       )
       SELECT failed_batch.id
         FROM released_budget,failed_request,failed_batch,failed_lease`,
      [
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        input.batchRequestId,
        input.requestFingerprint,
        input.leaseOwnerRequestId,
        input.reconciledAt,
      ],
    );
    if (result.rows[0] === undefined) {
      throw new Error("DATAFORSEO_RECONCILIATION_STATE_CHANGED");
    }
  }

  private async persistSuccessfulRequest(input: Readonly<{
    request: Readonly<{
      context: ProviderRequestContext;
      projectContextVersionId: string;
      call: CommercialDiscoveryCall;
      actorId: string;
    }>;
    requestFingerprint: string;
    batchRequestId: string;
    leaseOwnerRequestId: string;
    expectedStatus: "running" | "unknown_charge";
    response: Record<string, unknown>;
  }>): Promise<CommercialDiscoveryRequestResult> {
    const completedAt = this.dependencies.now();
    const artifact = normalizeCommercialDiscoveryResponse({
      call: input.request.call,
      response: input.response,
      collectedAt: completedAt.toISOString(),
    });
    const freshUntil = new Date(completedAt.getTime() + 7 * 86_400_000);
    const staleUntil = new Date(completedAt.getTime() + 30 * 86_400_000);
    const payloadHash = hashPayload(input.response);
    const budgets = createProviderBudgetRepository(
      this.dependencies.client,
      this.dependencies.now,
    );
    let providerTrace:
      | NonNullable<CommercialDiscoveryRequestResult["providerTrace"]>
      | undefined;

    await this.dependencies.client.query("BEGIN");
    try {
      await this.dependencies.client.query(
        `INSERT INTO backlink_commercial_discovery_artifacts (
           id,organization_id,workspace_id,website_project_id,
           project_context_version_id,provider,endpoint,request_intent,
           request_fingerprint,source_type,response_schema_version,
           normalized_payload,provider_task_ids,collected_at,fresh_until,
           stale_until,cost_micros,created_by
         ) VALUES (
           $1,$2,$3,$4,$5,'dataforseo',$6,'DISCOVERY',$7,$8,$9,$10::jsonb,
           $11::jsonb,$12,$13,$14,$15,$16
         )
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           request_fingerprint,response_schema_version
         ) DO UPDATE SET
           project_context_version_id=EXCLUDED.project_context_version_id,
           normalized_payload=EXCLUDED.normalized_payload,
           provider_task_ids=EXCLUDED.provider_task_ids,
           collected_at=EXCLUDED.collected_at,
           fresh_until=EXCLUDED.fresh_until,
           stale_until=EXCLUDED.stale_until,
           cost_micros=EXCLUDED.cost_micros`,
        [
          randomUUID(),
          input.request.context.organizationId,
          input.request.context.workspaceId,
          input.request.context.websiteProjectId,
          input.request.projectContextVersionId,
          input.request.call.endpoint,
          input.requestFingerprint,
          input.request.call.sourceType,
          input.request.call.responseSchemaVersion,
          JSON.stringify(artifact),
          JSON.stringify(artifact.providerTaskIds),
          completedAt,
          freshUntil,
          staleUntil,
          artifact.costMicros,
          input.request.actorId,
        ],
      );
      const completedBatch = await this.dependencies.client.query(
        `UPDATE provider_batch_requests
            SET status='succeeded',
                succeeded_count=CASE
                  WHEN $2::integer > 0 THEN 1 ELSE 0
                END,
                negative_count=CASE
                  WHEN $2::integer = 0 THEN 1 ELSE 0
                END,
                failed_count=0,
                actual_cost_micros=$3,
                raw_payload_hash=$4,
                provider_task_id=COALESCE($5,provider_task_id),
                result_summary=$6::jsonb,
                failure_code=NULL,
                finished_at=$7
          WHERE id=$1 AND status=$8
          RETURNING id`,
        [
          input.batchRequestId,
          artifact.candidates.length,
          artifact.costMicros,
          payloadHash,
          artifact.providerTaskIds[0] ?? null,
          JSON.stringify([{
            itemKey: input.requestFingerprint,
            requestFingerprint: input.requestFingerprint,
            status: artifact.candidates.length === 0 ? "empty" : "success",
            allocatedCostMicros: artifact.costMicros,
          }]),
          completedAt,
          input.expectedStatus,
        ],
      );
      if (completedBatch.rows[0] === undefined) {
        throw new Error("DATAFORSEO_PROVIDER_BATCH_STATE_CHANGED");
      }
      await budgets.settle({
        batchRequestId: input.batchRequestId,
        actualCostMicros: artifact.costMicros,
        settledAt: completedAt,
        expectedRequestStatus: input.expectedStatus,
      });
      const trace = await this.dependencies.client.query(
        `SELECT request.id::text AS "providerRequestId",
                batch.id::text AS "providerBatchRequestId",
                usage.id::text AS "providerUsageLedgerId",
                batch.provider_task_id AS "providerTaskId",
                COALESCE(
                  usage.actual_cost_micros,
                  batch.actual_cost_micros,
                  0
                )::integer AS "actualCostMicros"
           FROM provider_batch_requests AS batch
           JOIN backlink_provider_requests AS request
             ON (request.organization_id,request.workspace_id,
                 request.website_project_id,request.id)=
                (batch.organization_id,batch.workspace_id,
                 batch.website_project_id,batch.id)
           JOIN backlink_provider_usage_ledger AS usage
             ON (usage.organization_id,usage.workspace_id,
                 usage.website_project_id,usage.provider_request_id)=
                (batch.organization_id,batch.workspace_id,
                 batch.website_project_id,batch.id)
            AND usage.provider='dataforseo'
            AND usage.reservation_key=batch.budget_reservation_id
          WHERE batch.id=$1::uuid
            AND batch.status='succeeded'
            AND request.status='succeeded'
            AND usage.status='settled'
          LIMIT 1`,
        [input.batchRequestId],
      );
      const traceRow = trace.rows[0];
      if (traceRow === undefined) {
        throw new Error("DATAFORSEO_PROVIDER_TRACE_MISSING");
      }
      providerTrace = Object.freeze({
        providerRequestId: String(traceRow.providerRequestId),
        providerBatchRequestId: String(traceRow.providerBatchRequestId),
        providerUsageLedgerId: String(traceRow.providerUsageLedgerId),
        providerTaskId:
          typeof traceRow.providerTaskId === "string"
            ? traceRow.providerTaskId
            : null,
        actualCostMicros: Number(traceRow.actualCostMicros),
      });
      const completedLease = await this.dependencies.client.query(
        `UPDATE provider_fetch_leases
            SET status='completed',heartbeat_at=$3,
                lease_expires_at=$3,failure_code=NULL,updated_at=$3
          WHERE artifact_fingerprint=$1 AND owner_request_id=$2
            AND status=$4
          RETURNING artifact_fingerprint`,
        [
          input.requestFingerprint,
          input.leaseOwnerRequestId,
          completedAt,
          input.expectedStatus === "running"
            ? "acquired"
            : "unknown_charge",
        ],
      );
      if (completedLease.rows[0] === undefined) {
        throw new Error("DATAFORSEO_PROVIDER_LEASE_STATE_CHANGED");
      }
      await this.dependencies.client.query("COMMIT");
    } catch (error) {
      await this.dependencies.client.query("ROLLBACK");
      throw error;
    }
    if (providerTrace === undefined) {
      throw new Error("DATAFORSEO_PROVIDER_TRACE_MISSING");
    }
    return Object.freeze({ source: "provider", artifact, providerTrace });
  }

  private async replaySucceededRequest(input: Readonly<{
    context: ProviderRequestContext;
    projectContextVersionId: string;
    call: CommercialDiscoveryCall;
    requestFingerprint: string;
  }>): Promise<CommercialDiscoveryRequestResult | null> {
    const result = await this.dependencies.client.query(
      `/* RECOMMENDATION_POOL_V2_SUCCEEDED_REQUEST_REPLAY */
       SELECT artifact.normalized_payload AS "normalizedPayload",
              request.id::text AS "providerRequestId",
              batch.id::text AS "providerBatchRequestId",
              usage.id::text AS "providerUsageLedgerId",
              batch.provider_task_id AS "providerTaskId",
              COALESCE(
                usage.actual_cost_micros,
                batch.actual_cost_micros,
                0
              )::integer AS "actualCostMicros"
         FROM provider_batch_requests AS batch
         JOIN backlink_provider_requests AS request
           ON (request.organization_id,request.workspace_id,
               request.website_project_id,request.id)=
              (batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id)
          AND request.provider='dataforseo'
          AND request.endpoint=batch.endpoint
          AND request.request_fingerprint=batch.normalized_request_hash
          AND request.status='succeeded'
         JOIN backlink_provider_usage_ledger AS usage
           ON (usage.organization_id,usage.workspace_id,
               usage.website_project_id,usage.provider_request_id)=
              (batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id)
          AND usage.provider='dataforseo'
          AND usage.reservation_key=batch.budget_reservation_id
          AND usage.status='settled'
         JOIN provider_fetch_leases AS lease
           ON lease.artifact_fingerprint=batch.normalized_request_hash
          AND lease.owner_request_id=batch.request_id
          AND lease.status='completed'
         JOIN backlink_commercial_discovery_artifacts AS artifact
           ON (artifact.organization_id,artifact.workspace_id,
               artifact.website_project_id)=
              (batch.organization_id,batch.workspace_id,
               batch.website_project_id)
          AND artifact.project_context_version_id=$4::uuid
          AND artifact.provider='dataforseo'
          AND artifact.endpoint=batch.endpoint
          AND artifact.request_intent='DISCOVERY'
          AND artifact.request_fingerprint=batch.normalized_request_hash
          AND artifact.response_schema_version=batch.response_schema_version
        WHERE (batch.organization_id,batch.workspace_id,
               batch.website_project_id)=($1::uuid,$2::uuid,$3::uuid)
          AND batch.provider='dataforseo'
          AND batch.request_intent='DISCOVERY'
          AND batch.normalized_request_hash=$5
          AND batch.endpoint=$6
          AND batch.response_schema_version=$7
          AND batch.request_id=$8
          AND batch.budget_reservation_id=$9
          AND batch.status='succeeded'
        LIMIT 1`,
      [
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        input.projectContextVersionId,
        input.requestFingerprint,
        input.call.endpoint,
        input.call.responseSchemaVersion,
        input.context.requestId,
        input.context.budgetReservationId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return Object.freeze({
      source: "provider",
      artifact: artifactFromRow(row),
      providerTrace: Object.freeze({
        providerRequestId: String(row.providerRequestId),
        providerBatchRequestId: String(row.providerBatchRequestId),
        providerUsageLedgerId: String(row.providerUsageLedgerId),
        providerTaskId:
          typeof row.providerTaskId === "string"
            ? row.providerTaskId
            : null,
        actualCostMicros: Number(row.actualCostMicros),
      }),
    });
  }

  async execute(input: Readonly<{
    context: ProviderRequestContext;
    projectContextVersionId: string;
    call: CommercialDiscoveryCall;
    locationCode: string;
    languageCode: string;
    refreshMode: "CACHE_PREFERRED" | "FORCE_LIVE";
    actorId: string;
    recoveryOnly?: boolean;
    preserveBudgetReservationId?: boolean;
    allowSucceededRequestReplay?: boolean;
  }>): Promise<CommercialDiscoveryRequestResult> {
    const requestFingerprint = fingerprintCommercialDiscoveryCall(input.call);
    const now = this.dependencies.now();
    const cached = await this.dependencies.client.query(
      `SELECT normalized_payload AS "normalizedPayload",
              fresh_until AS "freshUntil",
              stale_until AS "staleUntil"
         FROM backlink_commercial_discovery_artifacts
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND project_context_version_id=$4
          AND request_fingerprint=$5
          AND response_schema_version=$6
        LIMIT 1`,
      [
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        input.projectContextVersionId,
        requestFingerprint,
        input.call.responseSchemaVersion,
      ],
    );
    const cachedRow = cached.rows[0];
    if (cachedRow !== undefined && input.refreshMode !== "FORCE_LIVE") {
      const freshUntil = new Date(String(cachedRow.freshUntil));
      const staleUntil = new Date(String(cachedRow.staleUntil));
      if (freshUntil > now || staleUntil > now) {
        return Object.freeze({
          source: freshUntil > now ? "cache" : "stale-cache",
          artifact: artifactFromRow(cachedRow),
        });
      }
    }
    if (input.allowSucceededRequestReplay === true) {
      const replay = await this.replaySucceededRequest({
        context: input.context,
        projectContextVersionId: input.projectContextVersionId,
        call: input.call,
        requestFingerprint,
      });
      if (replay !== null) return replay;
    }

    const interrupted = await this.transitionInterruptedRequest({
      context: input.context,
      projectContextVersionId: input.projectContextVersionId,
      call: input.call,
      requestFingerprint,
      interruptedAt: now,
    });
    if (interrupted !== null && !interrupted.budgetReserved) {
      throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
    }

    const recoverable = interrupted === null
      ? await this.dependencies.client.query(
        `SELECT batch.id AS "batchRequestId",
                batch.provider_task_id AS "providerTaskId",
                batch.request_id AS "leaseOwnerRequestId",
                batch.started_at AS "startedAt",
                TRUE AS "budgetReserved"
           FROM provider_batch_requests AS batch
           JOIN backlink_provider_requests AS provider_request
             ON (
               provider_request.organization_id,
               provider_request.workspace_id,
               provider_request.website_project_id,
               provider_request.id
             )=(
               batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id
             )
           JOIN backlink_provider_usage_ledger AS usage
             ON (
               usage.organization_id,usage.workspace_id,
               usage.website_project_id,usage.provider_request_id
             )=(
               batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id
             )
            AND usage.provider='dataforseo'
            AND usage.reservation_key=batch.budget_reservation_id
            AND usage.status='reserved'
           JOIN provider_fetch_leases AS lease
             ON lease.artifact_fingerprint=batch.normalized_request_hash
            AND lease.owner_request_id=batch.request_id
            AND lease.status='unknown_charge'
          WHERE (batch.organization_id,batch.workspace_id,
                 batch.website_project_id)=($1,$2,$3)
            AND batch.normalized_request_hash=$4
            AND batch.endpoint=$5
            AND batch.response_schema_version=$6
            AND batch.request_id=$7
            AND batch.status='unknown_charge'
            AND provider_request.status='unknown_charge'
          ORDER BY batch.started_at DESC
          LIMIT 1`,
        [
          input.context.organizationId,
          input.context.workspaceId,
          input.context.websiteProjectId,
          requestFingerprint,
          input.call.endpoint,
          input.call.responseSchemaVersion,
          input.context.requestId,
        ],
      )
      : { rows: [interrupted] };
    const recoverableRow = recoverable.rows[0];
    let reconciledNotDispatched = false;
    if (recoverableRow !== undefined) {
      if (recoverableRow.budgetReserved !== true) {
        throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
      }
      let providerTaskId = typeof recoverableRow.providerTaskId === "string"
        ? recoverableRow.providerTaskId
        : null;
      if (providerTaskId === null) {
        const reconcileDispatchedTask =
          this.dependencies.provider.reconcileDispatchedTask;
        if (reconcileDispatchedTask === undefined) {
          throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
        }
        const reconciliation = await reconcileDispatchedTask(input.call, {
          dispatchedAt: new Date(String(recoverableRow.startedAt)),
          reconciledAt: now,
        });
        if (reconciliation.status === "accepted") {
          const stored = await this.dependencies.client.query(
            `UPDATE provider_batch_requests
                SET provider_task_id=$2
              WHERE id=$1 AND status='unknown_charge'
                AND provider_task_id IS NULL
              RETURNING id`,
            [
              String(recoverableRow.batchRequestId),
              reconciliation.providerTaskId,
            ],
          );
          if (stored.rows[0] === undefined) {
            throw new Error("DATAFORSEO_RECONCILIATION_STATE_CHANGED");
          }
          providerTaskId = reconciliation.providerTaskId;
        } else if (reconciliation.status === "not_found") {
          await this.reconcileNotDispatched({
            context: input.context,
            batchRequestId: String(recoverableRow.batchRequestId),
            requestFingerprint,
            leaseOwnerRequestId: String(
              recoverableRow.leaseOwnerRequestId,
            ),
            reconciledAt: now,
          });
          reconciledNotDispatched = true;
        } else {
          throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
        }
      }
      if (providerTaskId !== null) {
        const recoverAcceptedTask =
          this.dependencies.provider.recoverAcceptedTask;
        if (recoverAcceptedTask === undefined) {
          throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
        }
        const response = await recoverAcceptedTask(
          input.call,
          providerTaskId,
        );
        return this.persistSuccessfulRequest({
          request: input,
          requestFingerprint,
          batchRequestId: String(recoverableRow.batchRequestId),
          leaseOwnerRequestId: String(recoverableRow.leaseOwnerRequestId),
          expectedStatus: "unknown_charge",
          response,
        });
      }
    }
    if (input.recoveryOnly === true && !reconciledNotDispatched) {
      throw new Error("DATAFORSEO_ACCEPTED_TASK_RECOVERY_STATE_CHANGED");
    }

    if (input.refreshMode === "CACHE_PREFERRED") {
      const reconciledWithoutResult = await this.dependencies.client.query(
        `SELECT id
           FROM provider_batch_requests
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
            AND normalized_request_hash=$4
            AND endpoint=$5
            AND response_schema_version=$6
            AND request_id=$7
            AND status='failed'
            AND failure_code=
              'DATAFORSEO_RECONCILED_ASSUMED_CHARGE_NO_RESULT'
            AND NOT EXISTS (
              SELECT 1
                FROM provider_batch_requests AS unresolved
               WHERE unresolved.organization_id=$1
                 AND unresolved.workspace_id=$2
                 AND unresolved.website_project_id=$3
                 AND unresolved.normalized_request_hash=$4
                 AND unresolved.endpoint=$5
                 AND unresolved.response_schema_version=$6
                 AND unresolved.request_id=$7
                 AND unresolved.status='unknown_charge'
            )
          ORDER BY started_at DESC
          LIMIT 1`,
        [
          input.context.organizationId,
          input.context.workspaceId,
          input.context.websiteProjectId,
          requestFingerprint,
          input.call.endpoint,
          input.call.responseSchemaVersion,
          input.context.requestId,
        ],
      );
      if (reconciledWithoutResult.rows[0] !== undefined) {
        throw new ReconciledProviderRequestWithoutResultError();
      }
    }

    await this.dependencies.gate.preflight({
      context: input.context,
      requestFingerprint,
      estimatedCostMicros: input.call.estimatedCostMicros,
      requiredRemainingPaidCalls:
        this.dependencies.requiredRemainingPaidCalls ?? 0,
      requiredRemainingCostMicros:
        this.dependencies.requiredRemainingCostMicros ?? 0,
    });
    const leases = createProviderFetchLeaseRepository(
      this.dependencies.client,
    );
    const lease = await leases.acquire({
      artifactFingerprint: requestFingerprint,
      ownerRequestId: input.context.requestId,
      acquiredAt: now,
      leaseExpiresAt: new Date(now.getTime() + 120_000),
    });
    if (lease.status === "unknown_charge") {
      throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
    }
    if (!lease.acquired) {
      const sleep = this.dependencies.sleep
        ?? ((milliseconds: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
      const waitMs = this.dependencies.followerWaitMs ?? 5_000;
      const pollMs = this.dependencies.followerPollMs ?? 100;
      const deadline = this.dependencies.now().getTime() + waitMs;
      while (this.dependencies.now().getTime() < deadline) {
        await sleep(pollMs);
        const followed = await this.dependencies.client.query(
          `SELECT normalized_payload AS "normalizedPayload"
             FROM backlink_commercial_discovery_artifacts
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND project_context_version_id=$4
              AND request_fingerprint=$5
              AND response_schema_version=$6
            LIMIT 1`,
          [
            input.context.organizationId,
            input.context.workspaceId,
            input.context.websiteProjectId,
            input.projectContextVersionId,
            requestFingerprint,
            input.call.responseSchemaVersion,
          ],
        );
        if (followed.rows[0] !== undefined) {
          return Object.freeze({
            source: "single-flight",
            artifact: artifactFromRow(followed.rows[0]),
          });
        }
        const currentLease = await leases.read(requestFingerprint);
        if (currentLease?.status === "unknown_charge") {
          throw new Error(
            "BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED",
          );
        }
        if (currentLease?.status === "failed") break;
      }
      throw new Error("DATAFORSEO_REFRESH_PENDING");
    }

    const batchRequestId = randomUUID();
    const providerRequestContext = Object.freeze({
      ...input.context,
      budgetReservationId:
        input.preserveBudgetReservationId === true
          ? input.context.budgetReservationId
          : `${input.context.budgetReservationId}:${batchRequestId}`,
    });
    const budgets = createProviderBudgetRepository(
      this.dependencies.client,
      this.dependencies.now,
    );
    await this.dependencies.client.query("BEGIN");
    try {
      await this.dependencies.client.query(
        `INSERT INTO provider_batch_requests (
           id,organization_id,workspace_id,website_project_id,provider,
           endpoint,request_intent,refresh_mode,location_code,language_code,
           request_schema_version,response_schema_version,
           normalized_request_hash,request_count,estimated_cost_micros,status,
           started_at,request_id,budget_reservation_id,created_by
         ) VALUES (
           $1,$2,$3,$4,'dataforseo',$5,'DISCOVERY',$6,$7,$8,1,$9,$10,1,$11,
           'running',$12,$13,$14,$15
         )`,
        [
          batchRequestId,
          input.context.organizationId,
          input.context.workspaceId,
          input.context.websiteProjectId,
          input.call.endpoint,
          input.refreshMode,
          input.locationCode,
          input.languageCode,
          input.call.responseSchemaVersion,
          requestFingerprint,
          input.call.estimatedCostMicros,
          now,
          providerRequestContext.requestId,
          providerRequestContext.budgetReservationId,
          input.actorId,
        ],
      );
      await budgets.recordRequest({
        batchRequestId,
        context: providerRequestContext,
        endpoint: input.call.endpoint,
        requestFingerprint,
        requestSchemaVersion: 1,
        requestPayload: serializeCommercialDiscoveryRequestPayload(input.call),
        startedAt: now,
      });
      await this.dependencies.client.query("COMMIT");
    } catch (error) {
      await this.dependencies.client.query("ROLLBACK");
      await leases.fail({
        artifactFingerprint: requestFingerprint,
        ownerRequestId: input.context.requestId,
        status: "failed",
        failureCode: "DATAFORSEO_PROVIDER_REQUEST_START_FAILED",
        failedAt: this.dependencies.now(),
      });
      throw error;
    }

    try {
      await this.dependencies.gate.authorize({
        context: providerRequestContext,
        requestFingerprint,
        estimatedCostMicros: input.call.estimatedCostMicros,
        requiredRemainingPaidCalls:
          this.dependencies.requiredRemainingPaidCalls ?? 0,
        requiredRemainingCostMicros:
          this.dependencies.requiredRemainingCostMicros ?? 0,
      });
      const response = await this.dependencies.provider.execute(input.call, {
        onProviderTaskAccepted: async (providerTaskId) => {
          const stored = await this.dependencies.client.query(
            `UPDATE provider_batch_requests
                SET provider_task_id=$2
              WHERE id=$1 AND status='running'
              RETURNING id`,
            [batchRequestId, providerTaskId],
          );
          if (stored.rows[0] === undefined) {
            throw new Error("DATAFORSEO_PROVIDER_TASK_PERSISTENCE_FAILED");
          }
        },
      });
      return this.persistSuccessfulRequest({
        request: input,
        requestFingerprint,
        batchRequestId,
        leaseOwnerRequestId: input.context.requestId,
        expectedStatus: "running",
        response,
      });
    } catch (error) {
      const failedAt = this.dependencies.now();
      const failure = providerFailure(error);
      await this.dependencies.client.query("BEGIN");
      try {
        await this.dependencies.client.query(
          `UPDATE provider_batch_requests
              SET status=$2,failure_code=$3,failed_count=1,finished_at=$4
            WHERE id=$1 AND status='running'`,
          [batchRequestId, failure.status, failure.code, failedAt],
        );
        await budgets.fail({
          batchRequestId,
          status: failure.status,
          failedAt,
        });
        await leases.fail({
          artifactFingerprint: requestFingerprint,
          ownerRequestId: input.context.requestId,
          status: failure.status,
          failureCode: failure.code,
          failedAt,
        });
        await this.dependencies.client.query("COMMIT");
      } catch (failureError) {
        await this.dependencies.client.query("ROLLBACK");
        throw failureError;
      }
      throw error;
    }
  }
}
