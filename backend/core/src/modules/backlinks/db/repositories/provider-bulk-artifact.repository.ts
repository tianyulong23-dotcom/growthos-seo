import { randomUUID } from "node:crypto";

import {
  createProviderArtifactFreshnessWindow,
} from "../../application/policies/provider-freshness.policy.js";
import type {
  DataForSeoRequestStart,
} from "../../application/services/dataforseo-request.service.js";
import type {
  DataForSeoBulkBatchStore,
} from "../../application/services/provider-bulk-request.service.js";
import {
  createProviderArtifactRepository,
  type ProviderArtifactQueryClient,
} from "./provider-artifact.repository.js";
import {
  createProviderBudgetRepository,
} from "./provider-budget.repository.js";

export function createProviderBulkArtifactRepository(
  client: ProviderArtifactQueryClient,
): DataForSeoBulkBatchStore {
  const artifacts = createProviderArtifactRepository(client);
  const budgets = createProviderBudgetRepository(client);

  return {
    async start(input): Promise<string> {
      const batchRequestId = randomUUID();
      await client.query("BEGIN");
      try {
        await client.query(`
          INSERT INTO provider_batch_requests (
            id,organization_id,workspace_id,website_project_id,provider,endpoint,
            request_intent,refresh_mode,location_code,language_code,
            request_schema_version,response_schema_version,
            normalized_request_hash,request_count,estimated_cost_micros,status,
            started_at,request_id,budget_reservation_id,created_by
          ) VALUES (
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo',$5,$6,$7,$8,$9,
            $10,$11,$12,$13,$14,'running',$15,$16,$17,$16
          )
        `, [
          batchRequestId,
          input.request.context.organizationId,
          input.request.context.workspaceId,
          input.request.context.websiteProjectId,
          input.request.endpoint,
          input.request.intent,
          input.request.refreshMode,
          input.request.locationCode,
          input.request.languageCode,
          input.request.requestSchemaVersion,
          input.request.responseSchemaVersion,
          input.batchFingerprint,
          input.request.items.length,
          input.request.estimatedCostMicros,
          input.startedAt,
          input.request.context.requestId,
          input.request.context.budgetReservationId,
        ]);
        await budgets.recordRequest({
          batchRequestId,
          context: input.request.context,
          endpoint: input.request.endpoint,
          requestFingerprint: input.batchFingerprint,
          requestSchemaVersion: input.request.requestSchemaVersion,
          requestPayload: input.request.items,
          startedAt: input.startedAt,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      return batchRequestId;
    },

    async complete(input): Promise<void> {
      const succeededCount = input.outcome.results.filter(
        ({ status }) => status === "success",
      ).length;
      const negativeCount = input.outcome.results.filter(
        ({ status }) => status === "empty",
      ).length;
      const failedCount = input.outcome.results.length -
        succeededCount -
        negativeCount;
      const status = failedCount === 0
        ? "succeeded"
        : succeededCount + negativeCount === 0
          ? "failed"
          : "partial";
      const itemByKey = new Map(input.request.items.map((item) => [
        item.itemKey,
        item,
      ]));

      await client.query("BEGIN");
      try {
        const batch = await client.query(`
          UPDATE provider_batch_requests SET
            succeeded_count=$2,negative_count=$3,failed_count=$4,
            actual_cost_micros=$5,raw_payload_hash=$6,provider_task_id=$7,
            result_summary=$8::jsonb,status=$9,finished_at=$10
          WHERE id=$1::uuid AND status='running'
          RETURNING id
        `, [
          input.batchRequestId,
          succeededCount,
          negativeCount,
          failedCount,
          input.outcome.actualCostMicros,
          input.outcome.rawPayloadHash,
          input.outcome.providerTaskId ?? null,
          JSON.stringify(input.outcome.results.map((result) => ({
            itemKey: result.itemKey,
            requestFingerprint: result.requestFingerprint,
            status: result.status,
            allocatedCostMicros: result.allocatedCostMicros,
            ...("code" in result ? { code: result.code } : {}),
          }))),
          status,
          input.completedAt,
        ]);
        if (batch.rows[0] === undefined) {
          throw new Error("DATAFORSEO_PROVIDER_BATCH_NOT_RUNNING");
        }

        for (const result of input.outcome.results) {
          if (result.snapshot === undefined) {
            continue;
          }
          const item = itemByKey.get(result.itemKey);
          if (item === undefined) {
            throw new Error("DATAFORSEO_BULK_RESULT_IDENTITY_MISMATCH");
          }
          const observedAt = new Date(result.snapshot.completedAt);
          const freshness = createProviderArtifactFreshnessWindow({
            intent: input.request.intent,
            observedAt,
            negative: result.status === "empty",
          });
          const inserted = await client.query(`
            INSERT INTO provider_artifacts (
              id,artifact_fingerprint,provider,endpoint,subject_type,
              subject_key,location_code,language_code,request_schema_version,
              response_schema_version,normalized_payload,payload_hash,
              quality_status,observed_at,fresh_until,stale_until,
              source_batch_id,created_at,updated_at
            ) VALUES (
              $1::uuid,$2,'dataforseo',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,
              $12,$13,$14,$15,$16::uuid,$17,$17
            )
            ON CONFLICT (artifact_fingerprint) DO UPDATE SET
              normalized_payload=EXCLUDED.normalized_payload,
              payload_hash=EXCLUDED.payload_hash,
              quality_status=EXCLUDED.quality_status,
              observed_at=EXCLUDED.observed_at,
              fresh_until=EXCLUDED.fresh_until,
              stale_until=EXCLUDED.stale_until,
              source_batch_id=EXCLUDED.source_batch_id,
              updated_at=EXCLUDED.updated_at
            WHERE provider_artifacts.observed_at<=EXCLUDED.observed_at
            RETURNING id
          `, [
            randomUUID(),
            result.requestFingerprint,
            input.request.endpoint,
            item.request.targetType,
            item.request.target,
            input.request.locationCode,
            input.request.languageCode,
            input.request.requestSchemaVersion,
            input.request.responseSchemaVersion,
            JSON.stringify(result.snapshot),
            result.snapshot.payloadHash,
            result.status === "empty" ? "negative" : "complete",
            observedAt,
            freshness.freshUntil,
            freshness.staleUntil,
            input.batchRequestId,
            input.completedAt,
          ]);
          const artifactId = inserted.rows[0]?.id ?? (await client.query(`
            SELECT id FROM provider_artifacts
            WHERE artifact_fingerprint=$1
          `, [result.requestFingerprint])).rows[0]?.id;
          if (artifactId === undefined) {
            throw new Error("DATAFORSEO_PROVIDER_ARTIFACT_MISSING");
          }
          const start: DataForSeoRequestStart = {
            key: {
              organizationId: input.request.context.organizationId,
              workspaceId: input.request.context.workspaceId,
              websiteProjectId: input.request.context.websiteProjectId,
              provider: "dataforseo",
              endpoint: input.request.endpoint,
              requestFingerprint: result.requestFingerprint,
              requestSchemaVersion: input.request.requestSchemaVersion,
              cacheSchemaVersion: 1,
            },
            context: input.request.context,
            request: item.request,
            intent: input.request.intent,
            refreshMode: input.request.refreshMode,
            locationCode: input.request.locationCode,
            languageCode: input.request.languageCode,
            responseSchemaVersion: input.request.responseSchemaVersion,
            usagePurpose: input.request.usagePurpose,
            projectContextVersion: input.request.projectContextVersion,
            estimatedCostMicros: result.allocatedCostMicros,
            now: input.completedAt,
            freshUntil: freshness.freshUntil,
            staleUntil: freshness.staleUntil,
          };
          await artifacts.recordUsage({
            start,
            artifactId: String(artifactId),
            batchRequestId: input.batchRequestId,
            servedFrom: "provider_bulk",
            allocatedCostMicros: result.allocatedCostMicros,
            usedAt: input.completedAt,
          });
        }
        await budgets.settle({
          batchRequestId: input.batchRequestId,
          actualCostMicros: input.outcome.actualCostMicros,
          settledAt: input.completedAt,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },

    async fail(input): Promise<void> {
      await client.query("BEGIN");
      try {
        const batch = await client.query(`
          UPDATE provider_batch_requests SET status=$2,failure_code=$3,
            failed_count=request_count,finished_at=$4
          WHERE id=$1::uuid AND status='running'
          RETURNING id
        `, [
          input.batchRequestId,
          input.status,
          input.failureCode,
          input.failedAt,
        ]);
        if (batch.rows[0] === undefined) {
          throw new Error("DATAFORSEO_PROVIDER_BATCH_NOT_RUNNING");
        }
        await budgets.fail({
          batchRequestId: input.batchRequestId,
          status: input.status,
          failedAt: input.failedAt,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
}
