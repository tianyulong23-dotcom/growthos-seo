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
    followerWaitMs?: number;
    followerPollMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }>) {}

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
    const payloadHash = hashPayload(artifact);
    const budgets = createProviderBudgetRepository(
      this.dependencies.client,
      this.dependencies.now,
    );

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
                provider_task_id=$5,
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
    return Object.freeze({ source: "provider", artifact });
  }

  async execute(input: Readonly<{
    context: ProviderRequestContext;
    projectContextVersionId: string;
    call: CommercialDiscoveryCall;
    locationCode: string;
    languageCode: string;
    refreshMode: "CACHE_PREFERRED" | "FORCE_LIVE";
    actorId: string;
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

    const recoverable = await this.dependencies.client.query(
      `SELECT id AS "batchRequestId",
              provider_task_id AS "providerTaskId",
              request_id AS "leaseOwnerRequestId"
         FROM provider_batch_requests
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND normalized_request_hash=$4
          AND endpoint=$5
          AND response_schema_version=$6
          AND status='unknown_charge'
          AND provider_task_id IS NOT NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      [
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        requestFingerprint,
        input.call.endpoint,
        input.call.responseSchemaVersion,
      ],
    );
    const recoverableRow = recoverable.rows[0];
    if (recoverableRow !== undefined) {
      const recoverAcceptedTask =
        this.dependencies.provider.recoverAcceptedTask;
      if (recoverAcceptedTask === undefined) {
        throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
      }
      const response = await recoverAcceptedTask(
        input.call,
        String(recoverableRow.providerTaskId),
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

    if (input.refreshMode === "CACHE_PREFERRED") {
      const reconciledWithoutResult = await this.dependencies.client.query(
        `SELECT id
           FROM provider_batch_requests
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3
            AND normalized_request_hash=$4
            AND endpoint=$5
            AND response_schema_version=$6
            AND request_id LIKE $7
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
                 AND unresolved.request_id LIKE $7
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
          `commercial-refill:${input.context.websiteProjectId}:`
            + `${input.projectContextVersionId}:%`,
        ],
      );
      if (reconciledWithoutResult.rows[0] !== undefined) {
        throw new ReconciledProviderRequestWithoutResultError();
      }
    }

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
        `${input.context.budgetReservationId}:${batchRequestId}`,
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
        requestPayload: input.call.request,
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
