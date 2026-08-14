import { randomUUID } from "node:crypto";

import {
  backlinkProviderSnapshotSchema,
  type BacklinkProviderSnapshot,
} from "../../ports/dataforseo.port.js";
import type {
  DataForSeoRequestStart,
} from "../../application/services/dataforseo-request.service.js";
import type {
  ProviderArtifactFreshnessWindow,
} from "../../application/policies/provider-freshness.policy.js";
import {
  createProviderBudgetRepository,
} from "./provider-budget.repository.js";

export type ProviderArtifactQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<
    Readonly<{ rows: readonly Record<string, unknown>[] }>
  >;
}>;

export type StoredProviderArtifact = Readonly<{
  artifactId: string;
  snapshot: BacklinkProviderSnapshot;
  qualityStatus: "complete" | "negative";
  freshUntil: Date;
  staleUntil: Date;
}>;

export function createProviderArtifactRepository(
  client: ProviderArtifactQueryClient,
) {
  const budgets = createProviderBudgetRepository(client);

  async function recordUsage(input: Readonly<{
    start: DataForSeoRequestStart;
    artifactId: string;
    batchRequestId: string | null;
    servedFrom:
      | "provider_live"
      | "provider_bulk"
      | "fresh_cache"
      | "stale_cache"
      | "single_flight"
      | "negative_cache";
    allocatedCostMicros: number;
    usedAt: Date;
  }>): Promise<void> {
    await client.query(`
      WITH request_context AS MATERIALIZED (
        SELECT
          set_config(
            'app.current_organization_id',
            $2::text,
            true
          ),
          set_config(
            'app.current_workspace_id',
            $3::text,
            true
          ),
          set_config(
            'app.current_website_project_id',
            $4::text,
            true
          )
      ), projection AS (
        INSERT INTO workspace_evidence_projections (
          id,organization_id,workspace_id,website_project_id,artifact_id,
          project_context_version,usage_purpose,first_served_at,last_served_at,
          created_at,updated_at
        )
        SELECT
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$8,$8,$8
        FROM request_context
        ON CONFLICT (
          organization_id,workspace_id,website_project_id,artifact_id,
          project_context_version,usage_purpose
        ) DO UPDATE SET last_served_at=EXCLUDED.last_served_at,
          version=workspace_evidence_projections.version+1,
          updated_at=EXCLUDED.updated_at
        RETURNING id
      )
      INSERT INTO provider_artifact_usages (
        id,organization_id,workspace_id,website_project_id,artifact_id,
        batch_request_id,request_intent,refresh_mode,served_from,
        allocated_cost_micros,used_at,usage_purpose
      )
      SELECT
        $9::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$10::uuid,
        $11,$12,$13,$14,$8,$7
      FROM request_context
    `, [
      randomUUID(),
      input.start.context.organizationId,
      input.start.context.workspaceId,
      input.start.context.websiteProjectId,
      input.artifactId,
      input.start.projectContextVersion,
      input.start.usagePurpose,
      input.usedAt,
      randomUUID(),
      input.batchRequestId,
      input.start.intent,
      input.start.refreshMode,
      input.servedFrom,
      input.allocatedCostMicros,
    ]);
  }

  return {
    async findByFingerprint(
      artifactFingerprint: string,
    ): Promise<StoredProviderArtifact | null> {
      const result = await client.query(`
        SELECT id AS "artifactId",normalized_payload AS snapshot,
          quality_status AS "qualityStatus",
          fresh_until AS "freshUntil",stale_until AS "staleUntil"
        FROM provider_artifacts WHERE artifact_fingerprint=$1
      `, [artifactFingerprint]);
      const row = result.rows[0];
      return row === undefined ? null : {
        artifactId: String(row.artifactId),
        snapshot: backlinkProviderSnapshotSchema.parse(row.snapshot),
        qualityStatus: row.qualityStatus === "negative"
          ? "negative"
          : "complete",
        freshUntil: new Date(String(row.freshUntil)),
        staleUntil: new Date(String(row.staleUntil)),
      };
    },

    async startBatch(start: DataForSeoRequestStart): Promise<string> {
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
            $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$15,
            'running',$14,$16,$17,$16
          )
        `, [
          batchRequestId,
          start.context.organizationId,
          start.context.workspaceId,
          start.context.websiteProjectId,
          start.key.provider,
          start.key.endpoint,
          start.intent,
          start.refreshMode,
          start.locationCode,
          start.languageCode,
          start.key.requestSchemaVersion,
          start.responseSchemaVersion,
          start.key.requestFingerprint,
          start.now,
          start.estimatedCostMicros,
          start.context.requestId,
          start.context.budgetReservationId,
        ]);
        await budgets.recordRequest({
          batchRequestId,
          context: start.context,
          endpoint: start.key.endpoint,
          requestFingerprint: start.key.requestFingerprint,
          requestSchemaVersion: start.key.requestSchemaVersion,
          requestPayload: start.request,
          startedAt: start.now,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      return batchRequestId;
    },

    recordUsage,

    async complete(input: Readonly<{
      start: DataForSeoRequestStart;
      batchRequestId: string;
      snapshot: BacklinkProviderSnapshot;
      freshness: ProviderArtifactFreshnessWindow;
      completedAt: Date;
    }>): Promise<void> {
      const artifactId = randomUUID();
      await client.query("BEGIN");
      try {
        const result = await client.query(`
          WITH batch AS (
            UPDATE provider_batch_requests SET status='succeeded',
              succeeded_count=CASE WHEN $18='complete' THEN 1 ELSE 0 END,
              negative_count=CASE WHEN $18='negative' THEN 1 ELSE 0 END,
              actual_cost_micros=$17,raw_payload_hash=$13,
              result_summary=$20::jsonb,finished_at=$16
            WHERE id=$1 AND status='running'
            RETURNING id
          ), artifact AS (
            INSERT INTO provider_artifacts (
              id,artifact_fingerprint,provider,endpoint,subject_type,subject_key,
              location_code,language_code,request_schema_version,
              response_schema_version,normalized_payload,payload_hash,
              quality_status,observed_at,fresh_until,stale_until,
              source_batch_id,created_at,updated_at
            ) SELECT $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$18,$14,$15,
                $19,id,$16,$16
            FROM batch
            ON CONFLICT (artifact_fingerprint) DO UPDATE SET
              normalized_payload=EXCLUDED.normalized_payload,
              payload_hash=EXCLUDED.payload_hash,
              quality_status=EXCLUDED.quality_status,
              observed_at=EXCLUDED.observed_at,
              fresh_until=EXCLUDED.fresh_until,
              stale_until=EXCLUDED.stale_until,
              source_batch_id=EXCLUDED.source_batch_id,
              updated_at=EXCLUDED.updated_at
            RETURNING id
          )
          SELECT id AS "artifactId" FROM artifact
        `, [
          input.batchRequestId,
          artifactId,
          input.start.key.requestFingerprint,
          input.start.key.provider,
          input.start.key.endpoint,
          input.start.request.targetType,
          input.start.request.target,
          input.start.locationCode,
          input.start.languageCode,
          input.start.key.requestSchemaVersion,
          input.start.responseSchemaVersion,
          JSON.stringify(input.snapshot),
          input.snapshot.payloadHash,
          input.snapshot.completedAt,
          input.freshness.freshUntil,
          input.completedAt,
          input.snapshot.costMicros,
          input.freshness.qualityStatus,
          input.freshness.staleUntil,
          JSON.stringify([{
            itemKey: input.start.request.target,
            requestFingerprint: input.start.key.requestFingerprint,
            status: input.freshness.qualityStatus === "negative"
              ? "empty"
              : "success",
            allocatedCostMicros: input.snapshot.costMicros,
          }]),
        ]);
        const storedArtifactId = result.rows[0]?.artifactId;
        if (storedArtifactId === undefined) {
          throw new Error("DATAFORSEO_PROVIDER_BATCH_NOT_RUNNING");
        }
        await recordUsage({
          start: input.start,
          artifactId: String(storedArtifactId),
          batchRequestId: input.batchRequestId,
          servedFrom: "provider_live",
          allocatedCostMicros: input.snapshot.costMicros,
          usedAt: input.completedAt,
        });
        await budgets.settle({
          batchRequestId: input.batchRequestId,
          actualCostMicros: input.snapshot.costMicros,
          settledAt: input.completedAt,
        });
        const lease = await client.query(`
          UPDATE provider_fetch_leases SET status='completed',
            heartbeat_at=$3,lease_expires_at=$3,updated_at=$3
          WHERE artifact_fingerprint=$1 AND owner_request_id=$2
            AND status='acquired'
          RETURNING artifact_fingerprint
        `, [
          input.start.key.requestFingerprint,
          input.start.context.requestId,
          input.completedAt,
        ]);
        if (lease.rows[0] === undefined) {
          throw new Error("DATAFORSEO_FETCH_LEASE_LOST");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },

    async failBatch(input: Readonly<{
      start: DataForSeoRequestStart;
      batchRequestId: string;
      status: "failed" | "unknown_charge";
      failureCode: string;
      failedAt: Date;
    }>): Promise<void> {
      await client.query("BEGIN");
      try {
        const batch = await client.query(`
          UPDATE provider_batch_requests SET status=$2,failure_code=$3,
            failed_count=1,finished_at=$4
          WHERE id=$1 AND status='running'
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
        const lease = await client.query(`
          UPDATE provider_fetch_leases SET status=$3,failure_code=$4,
            heartbeat_at=$5,lease_expires_at=$5,updated_at=$5
          WHERE artifact_fingerprint=$1 AND owner_request_id=$2
            AND status='acquired'
          RETURNING artifact_fingerprint
        `, [
          input.start.key.requestFingerprint,
          input.start.context.requestId,
          input.status,
          input.failureCode,
          input.failedAt,
        ]);
        if (lease.rows[0] === undefined) {
          throw new Error("DATAFORSEO_FETCH_LEASE_LOST");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
}
