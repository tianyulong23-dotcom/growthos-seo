import { randomUUID } from "node:crypto";

import type {
  CommercialQualificationRequestStore,
} from "../../application/services/commercial-qualification-request.service.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../tenant-transaction.js";
import { createProviderBudgetRepository } from "./provider-budget.repository.js";

function cachedResponse(value: unknown) {
  if (!Array.isArray(value)) return null;
  const item = value[0];
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return null;
  }
  const record = item as Readonly<Record<string, unknown>>;
  if (
    (record.status !== "completed" && record.status !== "partial")
    || !Number.isSafeInteger(record.costMicros)
    || Number(record.costMicros) < 0
  ) {
    return null;
  }
  return Object.freeze({
    status: record.status,
    body: record.body ?? null,
    providerRequestId:
      typeof record.providerRequestId === "string"
        ? record.providerRequestId
        : null,
    costMicros: 0,
  } as const);
}

export function createCommercialQualificationRequestRepository(
  pool: BacklinkTenantPool,
  now: () => Date = () => new Date(),
): CommercialQualificationRequestStore {
  type AcquireInput = Parameters<
    CommercialQualificationRequestStore["acquire"]
  >[0];
  type CompleteInput = Parameters<
    CommercialQualificationRequestStore["complete"]
  >[0];
  type FailInput = Parameters<
    CommercialQualificationRequestStore["fail"]
  >[0];

  return Object.freeze({
    async acquire(input: AcquireInput) {
      const scope = {
        organizationId: input.context.organizationId,
        workspaceId: input.context.workspaceId,
        websiteProjectId: input.context.websiteProjectId,
      };
      return withBacklinkTenantTransaction(pool, scope, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [input.call.requestFingerprint],
        );
        const previous = await client.query(
          `SELECT id::text AS id, status,
                  result_summary AS "resultSummary"
             FROM backlinks.provider_batch_requests
            WHERE organization_id=$1::uuid
              AND workspace_id=$2::uuid
              AND website_project_id=$3::uuid
              AND provider='dataforseo'
              AND endpoint=$4
              AND normalized_request_hash=$5
            ORDER BY started_at DESC,id DESC
            LIMIT 1`,
          [
            input.context.organizationId,
            input.context.workspaceId,
            input.context.websiteProjectId,
            input.call.endpoint,
            input.call.requestFingerprint,
          ],
        );
        const row = previous.rows[0];
        if (row?.status === "unknown_charge") {
          return Object.freeze({
            state: "blocked",
            reason: "unknown_charge",
          } as const);
        }
        if (row?.status === "running") {
          return Object.freeze({
            state: "blocked",
            reason: "in_flight",
          } as const);
        }
        if (row?.status === "succeeded" || row?.status === "partial") {
          const response = cachedResponse(row.resultSummary);
          if (response !== null) {
            return Object.freeze({ state: "cached", response } as const);
          }
        }

        const batchRequestId = randomUUID();
        await client.query(
          `INSERT INTO backlinks.provider_batch_requests (
             id,organization_id,workspace_id,website_project_id,provider,
             endpoint,request_intent,refresh_mode,location_code,language_code,
             request_schema_version,response_schema_version,
             normalized_request_hash,request_count,estimated_cost_micros,
             status,started_at,request_id,budget_reservation_id,created_by
           ) VALUES (
             $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo',$5,
             'DEEP_ASSESSMENT','FORCE_LIVE',$6,$7,1,
             'commercial-qualification-bulk.v1',$8,$9,$10,'running',
             $11,$12,$13,$12
           )`,
          [
            batchRequestId,
            input.context.organizationId,
            input.context.workspaceId,
            input.context.websiteProjectId,
            input.call.endpoint,
            input.call.body[0]?.location_code ?? "global",
            input.call.body[0]?.language_code ?? "global",
            input.call.requestFingerprint,
            input.call.targets.length,
            input.estimatedCostMicros,
            input.startedAt,
            input.context.requestId,
            input.context.budgetReservationId,
          ],
        );
        await createProviderBudgetRepository(client, now).recordRequest({
          batchRequestId,
          context: input.context,
          endpoint: input.call.endpoint,
          requestFingerprint: input.call.requestFingerprint,
          requestSchemaVersion: 1,
          requestPayload: input.call.body,
          startedAt: input.startedAt,
        });
        return Object.freeze({
          state: "started",
          batchRequestId,
        } as const);
      });
    },

    async complete(input: CompleteInput) {
      await withBacklinkTenantTransaction(
        pool,
        {
          organizationId: input.context.organizationId,
          workspaceId: input.context.workspaceId,
          websiteProjectId: input.context.websiteProjectId,
        },
        async (client) => {
          const requestCount = input.call.targets.length;
          const updated = await client.query(
            `UPDATE backlinks.provider_batch_requests
                SET succeeded_count=$2,
                    actual_cost_micros=$3,
                    provider_task_id=$4,
                    result_summary=$5::jsonb,
                    status=$6,
                    finished_at=$7
              WHERE id=$1::uuid AND status='running'
              RETURNING id`,
            [
              input.batchRequestId,
              input.response.status === "completed" ? requestCount : 0,
              input.response.costMicros,
              input.response.providerRequestId,
              JSON.stringify([{
                status: input.response.status,
                body: input.response.body,
                providerRequestId: input.response.providerRequestId,
                costMicros: input.response.costMicros,
              }]),
              input.response.status === "completed"
                ? "succeeded"
                : "partial",
              input.completedAt,
            ],
          );
          if (updated.rows[0] === undefined) {
            throw new Error("DATAFORSEO_QUALIFICATION_BATCH_NOT_RUNNING");
          }
          await createProviderBudgetRepository(client, now).settle({
            batchRequestId: input.batchRequestId,
            actualCostMicros: input.response.costMicros,
            settledAt: input.completedAt,
          });
        },
      );
    },

    async fail(input: FailInput) {
      await withBacklinkTenantTransaction(
        pool,
        {
          organizationId: input.context.organizationId,
          workspaceId: input.context.workspaceId,
          websiteProjectId: input.context.websiteProjectId,
        },
        async (client) => {
          const updated = await client.query(
            `UPDATE backlinks.provider_batch_requests
                SET status=$2,failure_code=$3,
                    failed_count=request_count,finished_at=$4
              WHERE id=$1::uuid AND status='running'
              RETURNING id`,
            [
              input.batchRequestId,
              input.status,
              input.failureCode,
              input.failedAt,
            ],
          );
          if (updated.rows[0] === undefined) {
            throw new Error("DATAFORSEO_QUALIFICATION_BATCH_NOT_RUNNING");
          }
          await createProviderBudgetRepository(client, now).fail({
            batchRequestId: input.batchRequestId,
            status: input.status,
            failedAt: input.failedAt,
          });
        },
      );
    },
  });
}
