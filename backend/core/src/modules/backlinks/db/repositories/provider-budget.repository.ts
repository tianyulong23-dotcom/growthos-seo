import type {
  ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import type {
  ProviderArtifactQueryClient,
} from "./provider-artifact.repository.js";

export type ProviderBudgetReservationInput = Readonly<{
  context: ProviderRequestContext;
  provider: "dataforseo";
  requestFingerprint: string;
  reservationKey: string;
  estimatedCostMicros: number;
}>;

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

export function createProviderBudgetRepository(
  client: ProviderArtifactQueryClient,
  now: () => Date = () => new Date(),
) {
  return {
    async recordRequest(input: Readonly<{
      batchRequestId: string;
      context: ProviderRequestContext;
      endpoint: string;
      requestFingerprint: string;
      requestSchemaVersion: number;
      requestPayload: unknown;
      startedAt: Date;
    }>): Promise<void> {
      await client.query(`
        INSERT INTO backlink_provider_requests (
          id,organization_id,workspace_id,website_project_id,provider,endpoint,
          request_fingerprint,active_request_bucket,request_schema_version,
          request_payload,status,started_at,created_by
        ) VALUES (
          $1::uuid,$2::uuid,$3::uuid,$4::uuid,'dataforseo',$5,$6,$1::text,$7,
          $8::jsonb,'running',$9,$10
        )
      `, [
        input.batchRequestId,
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        input.endpoint,
        input.requestFingerprint,
        input.requestSchemaVersion,
        JSON.stringify(input.requestPayload),
        input.startedAt,
        input.context.requestId,
      ]);
    },

    async reserveBudget(
      input: ProviderBudgetReservationInput,
    ): Promise<"allow" | "deny"> {
      try {
        const result = await client.query(`
          WITH batch AS MATERIALIZED (
            SELECT id
            FROM provider_batch_requests
            WHERE organization_id=$1::uuid
              AND workspace_id=$2::uuid
              AND website_project_id=$3::uuid
              AND provider=$4
              AND normalized_request_hash=$5
              AND request_id=$6
              AND budget_reservation_id=$7
              AND status='running'
            ORDER BY started_at DESC
            LIMIT 1
          ), budget AS MATERIALIZED (
            SELECT id
            FROM backlink_provider_budgets
            WHERE organization_id=$1::uuid
              AND workspace_id=$2::uuid
              AND provider=$4
              AND period_start<=$9
              AND period_end>$9
            ORDER BY period_start DESC
            LIMIT 1
          )
          SELECT backlink_reserve_provider_cost(
            batch.id,budget.id,$1::uuid,$2::uuid,$3::uuid,batch.id,$4,$7,$8,
            $6
          )
          FROM batch CROSS JOIN budget
        `, [
          input.context.organizationId,
          input.context.workspaceId,
          input.context.websiteProjectId,
          input.provider,
          input.requestFingerprint,
          input.context.requestId,
          input.reservationKey,
          input.estimatedCostMicros,
          now(),
        ]);
        return result.rows[0] === undefined ? "deny" : "allow";
      } catch (error) {
        if (
          errorCode(error) === "P0001" &&
          error instanceof Error &&
          error.message === "BACKLINK_PROVIDER_BUDGET_EXCEEDED"
        ) {
          return "deny";
        }
        throw error;
      }
    },

    async settle(input: Readonly<{
      batchRequestId: string;
      actualCostMicros: number;
      settledAt: Date;
    }>): Promise<void> {
      const result = await client.query(`
        WITH ledger AS (
          UPDATE backlink_provider_usage_ledger
          SET status='settled',actual_cost_micros=$2,settled_at=$3
          WHERE provider_request_id=$1::uuid AND status='reserved'
          RETURNING budget_id,estimated_cost_micros
        ), budget AS (
          UPDATE backlink_provider_budgets b
          SET reserved_micros=b.reserved_micros-ledger.estimated_cost_micros,
            spent_micros=b.spent_micros+$2,version=b.version+1
          FROM ledger
          WHERE b.id=ledger.budget_id
          RETURNING b.id
        )
        UPDATE backlink_provider_requests request
        SET status='succeeded',finished_at=$3
        WHERE request.id=$1::uuid
          AND request.status='running'
          AND EXISTS (SELECT 1 FROM budget)
        RETURNING request.id
      `, [
        input.batchRequestId,
        input.actualCostMicros,
        input.settledAt,
      ]);
      if (result.rows[0] === undefined) {
        throw new Error("DATAFORSEO_PROVIDER_BUDGET_RESERVATION_MISSING");
      }
    },

    async fail(input: Readonly<{
      batchRequestId: string;
      status: "failed" | "unknown_charge";
      failedAt: Date;
    }>): Promise<void> {
      await client.query(`
        WITH ledger AS (
          UPDATE backlink_provider_usage_ledger
          SET status='released',released_at=$3
          WHERE provider_request_id=$1::uuid
            AND status='reserved'
            AND $2='failed'
          RETURNING budget_id,estimated_cost_micros
        ), budget AS (
          UPDATE backlink_provider_budgets b
          SET reserved_micros=b.reserved_micros-ledger.estimated_cost_micros,
            version=b.version+1
          FROM ledger
          WHERE b.id=ledger.budget_id
        )
        UPDATE backlink_provider_requests
        SET status=$2,finished_at=$3
        WHERE id=$1::uuid AND status='running'
      `, [
        input.batchRequestId,
        input.status,
        input.failedAt,
      ]);
    },
  };
}
