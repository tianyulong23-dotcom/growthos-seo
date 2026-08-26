import { randomUUID } from "node:crypto";

import type {
  ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import {
  providerOperationBudgetMaximumCostMicros,
  replenishProviderBudgetLimit,
  resolveProviderOperationBudgetWindow,
  type ProviderOperationBudgetAuthorization,
} from "../../domain/recommendations/provider-operation-budget.js";
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

function utcDayPeriod(value: Date): Readonly<{
  periodStart: Date;
  periodEnd: Date;
}> {
  const periodStart = new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  ));
  return Object.freeze({
    periodStart,
    periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1_000),
  });
}

export async function ensureProviderBudgetCycle(
  client: ProviderArtifactQueryClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    provider: "dataforseo";
    limitMicros: number;
    createdBy: string;
    observedAt: Date;
  }>,
): Promise<void> {
  if (
    !Number.isSafeInteger(input.limitMicros)
    || input.limitMicros <= 0
  ) {
    throw new TypeError("Provider budget limit must be a positive integer");
  }
  const { periodStart, periodEnd } = utcDayPeriod(input.observedAt);
  await client.query(`
    INSERT INTO backlink_provider_budgets (
      id,organization_id,workspace_id,provider,period_start,period_end,
      limit_micros,created_by
    )
    SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8
    WHERE NOT EXISTS (
      SELECT 1
        FROM backlink_provider_budgets
       WHERE organization_id=$2::uuid
         AND workspace_id=$3::uuid
         AND provider=$4
         AND period_start<=$9
         AND period_end>$9
    )
    ON CONFLICT (
      organization_id,workspace_id,provider,period_start
    ) DO NOTHING
  `, [
    randomUUID(),
    input.organizationId,
    input.workspaceId,
    input.provider,
    periodStart,
    periodEnd,
    input.limitMicros,
    input.createdBy,
    input.observedAt,
  ]);
  await client.query(`
    UPDATE backlink_provider_budgets
       SET limit_micros=$5,version=version+1
     WHERE organization_id=$1::uuid
       AND workspace_id=$2::uuid
       AND provider=$3
       AND period_start<=$4
       AND period_end>$4
       AND limit_micros<$5
  `, [
    input.organizationId,
    input.workspaceId,
    input.provider,
    input.observedAt,
    input.limitMicros,
  ]);
}

export function createProviderBudgetRepository(
  client: ProviderArtifactQueryClient,
  now: () => Date = () => new Date(),
) {
  const reserveBudgetFor = async (
    input: ProviderBudgetReservationInput,
    budgetId?: string,
  ): Promise<"allow" | "deny"> => {
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
            AND ($10::uuid IS NULL OR id=$10::uuid)
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
        budgetId ?? null,
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
  };

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
      return reserveBudgetFor(input);
    },

    async reserveBudgetWithinPaidCallCeiling(
      input: ProviderBudgetReservationInput,
      maxPaidCalls: number,
      budgetLimitMicros: number,
    ): Promise<"allow" | "deny"> {
      const observedAt = now();
      await ensureProviderBudgetCycle(client, {
        organizationId: input.context.organizationId,
        workspaceId: input.context.workspaceId,
        provider: input.provider,
        limitMicros: budgetLimitMicros,
        createdBy: input.context.requestId,
        observedAt,
      });
      const budget = await client.query(`
        SELECT id,limit_micros AS "limitMicros"
        FROM backlink_provider_budgets
        WHERE organization_id=$1::uuid
          AND workspace_id=$2::uuid
          AND provider=$3
          AND period_start<=$4
          AND period_end>$4
        ORDER BY period_start DESC
        LIMIT 1
        FOR UPDATE
      `, [
        input.context.organizationId,
        input.context.workspaceId,
        input.provider,
        observedAt,
      ]);
      const budgetId = budget.rows[0]?.id;
      if (
        typeof budgetId !== "string"
        || Number(budget.rows[0]?.limitMicros) < budgetLimitMicros
      ) {
        return "deny";
      }

      const usage = await client.query(`
        SELECT count(*)::integer AS count,
          COALESCE(bool_or(reservation_key=$5),false) AS "alreadyReserved"
        FROM backlink_provider_usage_ledger
        WHERE organization_id=$1::uuid
          AND workspace_id=$2::uuid
          AND website_project_id=$3::uuid
          AND budget_id=$4::uuid
          AND provider=$6
          AND status IN ('reserved','settled')
      `, [
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        budgetId,
        input.reservationKey,
        input.provider,
      ]);
      const paidCallCount = Number(usage.rows[0]?.count ?? 0);
      if (
        usage.rows[0]?.alreadyReserved !== true &&
        paidCallCount >= maxPaidCalls
      ) {
        return "deny";
      }
      return reserveBudgetFor(input, budgetId);
    },

    async reserveBudgetWithinOperationCeiling(
      input: ProviderBudgetReservationInput,
      operationPrefix: string,
      maxPaidCalls: number,
      operationBudgetLimitMicros: number,
      dailyBudgetLimitMicros: number,
      headroom: Readonly<{
        requiredRemainingPaidCalls: number;
        requiredRemainingCostMicros: number;
        authorization?: ProviderOperationBudgetAuthorization;
      }> = {
        requiredRemainingPaidCalls: 0,
        requiredRemainingCostMicros: 0,
      },
    ): Promise<"allow" | "deny"> {
      const normalizedPrefix = operationPrefix.endsWith(":")
        ? operationPrefix
        : `${operationPrefix}:`;
      if (
        normalizedPrefix.length < 2
        || !input.reservationKey.startsWith(normalizedPrefix)
        || !Number.isSafeInteger(maxPaidCalls)
        || maxPaidCalls < 1
        || !Number.isSafeInteger(operationBudgetLimitMicros)
        || operationBudgetLimitMicros < 1
        || !Number.isSafeInteger(headroom.requiredRemainingPaidCalls)
        || headroom.requiredRemainingPaidCalls < 0
        || !Number.isSafeInteger(headroom.requiredRemainingCostMicros)
        || headroom.requiredRemainingCostMicros < 0
      ) {
        return "deny";
      }
      const observedAt = now();
      await ensureProviderBudgetCycle(client, {
        organizationId: input.context.organizationId,
        workspaceId: input.context.workspaceId,
        provider: input.provider,
        limitMicros: dailyBudgetLimitMicros,
        createdBy: input.context.requestId,
        observedAt,
      });
      const budget = await client.query(`
        SELECT id,limit_micros AS "limitMicros",
               spent_micros AS "spentMicros",
               reserved_micros AS "reservedMicros"
        FROM backlink_provider_budgets
        WHERE organization_id=$1::uuid
          AND workspace_id=$2::uuid
          AND provider=$3
          AND period_start<=$4
          AND period_end>$4
        ORDER BY period_start DESC
        LIMIT 1
        FOR UPDATE
      `, [
        input.context.organizationId,
        input.context.workspaceId,
        input.provider,
        observedAt,
      ]);
      const budgetId = budget.rows[0]?.id;
      if (
        typeof budgetId !== "string"
        || Number(budget.rows[0]?.limitMicros) < dailyBudgetLimitMicros
      ) {
        return "deny";
      }

      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [
          [
            input.context.organizationId,
            input.context.workspaceId,
            input.context.websiteProjectId,
            input.provider,
            normalizedPrefix,
          ].join(":"),
        ],
      );
      const usage = await client.query(`
        SELECT count(*) FILTER (
                 WHERE usage.status IN ('reserved','settled')
               )::integer AS count,
          COALESCE(bool_or(
            usage.status IN ('reserved','settled')
            AND usage.reservation_key=$5
          ),false) AS "keyExists",
          COALESCE(bool_or(
            usage.status IN ('reserved','settled')
            AND usage.reservation_key=$5
            AND usage.estimated_cost_micros=$7
            AND request.request_fingerprint=$8
            AND batch.normalized_request_hash=$8
            AND batch.request_id=$9
            AND batch.budget_reservation_id=$5
          ),false) AS "exactReplay",
          COALESCE(sum(
            CASE
              WHEN usage.status='settled'
                THEN COALESCE(
                  usage.actual_cost_micros,
                  usage.estimated_cost_micros
                )
              WHEN usage.status='reserved' THEN usage.estimated_cost_micros
              ELSE 0
            END
          ),0)::bigint AS "exposureMicros",
          count(*) FILTER (
            WHERE request.status='unknown_charge'
          )::integer AS "unknownChargeCount"
        FROM backlink_provider_usage_ledger AS usage
        JOIN backlink_provider_requests AS request
          ON (
            request.organization_id,request.workspace_id,
            request.website_project_id,request.id
          )=(
            usage.organization_id,usage.workspace_id,
            usage.website_project_id,usage.provider_request_id
          )
        JOIN provider_batch_requests AS batch
          ON (
            batch.organization_id,batch.workspace_id,
            batch.website_project_id,batch.id
          )=(
            usage.organization_id,usage.workspace_id,
            usage.website_project_id,usage.provider_request_id
          )
        WHERE (
          usage.organization_id,usage.workspace_id,
          usage.website_project_id
        )=($1::uuid,$2::uuid,$3::uuid)
          AND usage.provider=$4
          AND usage.reservation_key LIKE $6 || '%'
      `, [
        input.context.organizationId,
        input.context.workspaceId,
        input.context.websiteProjectId,
        input.provider,
        input.reservationKey,
        normalizedPrefix,
        input.estimatedCostMicros,
        input.requestFingerprint,
        input.context.requestId,
      ]);
      const paidCallCount = Number(usage.rows[0]?.count ?? 0);
      const exposureMicros = Number(usage.rows[0]?.exposureMicros ?? 0);
      if (Number(usage.rows[0]?.unknownChargeCount ?? 0) > 0) {
        return "deny";
      }
      if (usage.rows[0]?.keyExists === true) {
        return usage.rows[0]?.exactReplay === true ? "allow" : "deny";
      }
      const requiredPaidCalls =
        1 + headroom.requiredRemainingPaidCalls;
      const requiredCostMicros =
        input.estimatedCostMicros + headroom.requiredRemainingCostMicros;
      const operationWindow = headroom.authorization === undefined
        ? Object.freeze({
            maxPaidCalls,
            maxCostMicros: operationBudgetLimitMicros,
          })
        : resolveProviderOperationBudgetWindow({
            authorization: headroom.authorization,
            paidCallCount,
            exposureMicros,
            requiredPaidCalls,
            requiredCostMicros,
          });
      if (
        paidCallCount + requiredPaidCalls > operationWindow.maxPaidCalls
        || exposureMicros + requiredCostMicros
          > operationWindow.maxCostMicros
      ) {
        return "deny";
      }
      const dailyExposureMicros =
        Number(budget.rows[0]?.spentMicros ?? 0)
        + Number(budget.rows[0]?.reservedMicros ?? 0);
      const requiredDailyLimitMicros =
        dailyExposureMicros + requiredCostMicros;
      const currentDailyLimitMicros = Number(
        budget.rows[0]?.limitMicros ?? 0,
      );
      const effectiveDailyLimitMicros =
        headroom.authorization?.reasonCode
          === "user_authorized_persistent_discovery"
          ? replenishProviderBudgetLimit(
              Math.max(currentDailyLimitMicros, dailyBudgetLimitMicros),
              requiredDailyLimitMicros,
              providerOperationBudgetMaximumCostMicros,
            )
          : currentDailyLimitMicros;
      if (
        requiredDailyLimitMicros > effectiveDailyLimitMicros
        || effectiveDailyLimitMicros < dailyBudgetLimitMicros
      ) {
        return "deny";
      }
      if (effectiveDailyLimitMicros > currentDailyLimitMicros) {
        await ensureProviderBudgetCycle(client, {
          organizationId: input.context.organizationId,
          workspaceId: input.context.workspaceId,
          provider: input.provider,
          limitMicros: effectiveDailyLimitMicros,
          createdBy: input.context.requestId,
          observedAt,
        });
      }
      return reserveBudgetFor(input, budgetId);
    },

    async settle(input: Readonly<{
      batchRequestId: string;
      actualCostMicros: number;
      settledAt: Date;
      expectedRequestStatus?: "running" | "unknown_charge";
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
          AND request.status=$4
          AND EXISTS (SELECT 1 FROM budget)
        RETURNING request.id
      `, [
        input.batchRequestId,
        input.actualCostMicros,
        input.settledAt,
        input.expectedRequestStatus ?? "running",
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
