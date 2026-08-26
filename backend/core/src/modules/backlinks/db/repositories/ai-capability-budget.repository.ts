import { randomUUID } from "node:crypto";

import type {
  BacklinkTenantContext,
  BacklinkTransactionClient,
} from "../tenant-transaction.js";

export const aiCapabilities = Object.freeze([
  "AI_DISCOVERY",
  "AI_OUTREACH_DRAFT",
] as const);
export type AiCapability = (typeof aiCapabilities)[number];

export const aiCapabilityReadinessStates = Object.freeze([
  "READY",
  "MISCONFIGURED",
  "BUDGET_EXCEEDED",
  "MALFORMED_OUTPUT",
  "POLICY_VIOLATION",
  "PROVIDER_UNAVAILABLE",
  "RETRYABLE_FAILURE",
] as const);
export type AiCapabilityReadinessState =
  (typeof aiCapabilityReadinessStates)[number];

export type AiCapabilityPolicy = Readonly<{
  maxCalls: number;
  absoluteBudgetUsd: number;
  windowSeconds: number;
  maxConcurrency: number;
  maxWorkItemsPerGeneration: number;
  maxProviderCallsPerGeneration: number;
  reservationUsd: number;
  providerRef: string;
  modelId: string;
}>;

type OperationInput = BacklinkTenantContext & Readonly<{
  capability: AiCapability;
  operationKey: string;
}>;

type ReservationInput = OperationInput & Readonly<{
  actorId: string;
  workItemCount: number;
  policy: AiCapabilityPolicy;
}>;

type WindowRow = Readonly<{
  id: string;
  windowExpiresAt: Date;
  callLimit: number;
  budgetLimitUsd: number | string;
  reservedCalls: number;
  settledCalls: number;
  reservedCostUsd: number | string;
  spentCostUsd: number | string;
  concurrencyLimit: number;
  activeReservations: number;
}>;

type LedgerRow = Readonly<{
  id: string;
  windowId: string;
  reservationAttempt: number;
  status: "RESERVED" | "SETTLED" | "RELEASED";
  maxProviderCalls: number;
  providerCallCount: number;
  reservedCostUsd: number | string;
  actualCostUsd: number | string | null;
}>;

export type AiCapabilityReservation = Readonly<{
  reservationId: string;
  windowId: string;
  reservationAttempt: number;
  status: "RESERVED" | "SETTLED";
}>;

export type AiCapabilityReadiness = Readonly<{
  capability: AiCapability;
  state: AiCapabilityReadinessState;
  windowId: string;
  windowExpiresAt: Date;
  remainingCalls: number;
  remainingBudgetUsd: number;
  availableConcurrency: number;
}>;

export class AiCapabilityBudgetError extends Error {
  readonly reason:
    | "BUDGET_EXCEEDED"
    | "CONCURRENCY_EXHAUSTED"
    | "WORK_LIMIT_EXCEEDED"
    | "PROVIDER_CALL_LIMIT_EXCEEDED"
    | "RESERVATION_MISSING";

  constructor(
    reason: AiCapabilityBudgetError["reason"],
    message: string,
  ) {
    super(message);
    this.name = "AiCapabilityBudgetError";
    this.reason = reason;
  }
}

const scopeValues = (input: BacklinkTenantContext) => [
  input.organizationId,
  input.workspaceId,
  input.websiteProjectId,
] as const;

const asNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundUsd = (value: number): number => Number(value.toFixed(6));

async function lockCapability(
  client: BacklinkTransactionClient,
  input: OperationInput,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       $1||':'||$2||':'||$3||':'||$4,0
     ))`,
    [...scopeValues(input), input.capability],
  );
}

async function loadLatestOperation(
  client: BacklinkTransactionClient,
  input: OperationInput,
): Promise<LedgerRow | undefined> {
  const result = await client.query(
    `SELECT id,window_id AS "windowId",
            reservation_attempt AS "reservationAttempt",status,
            max_provider_calls AS "maxProviderCalls",
            provider_call_count AS "providerCallCount",
            reserved_cost_usd AS "reservedCostUsd",
            actual_cost_usd AS "actualCostUsd"
       FROM backlinks.backlink_ai_capability_usage_ledger
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3
        AND capability=$4
        AND operation_key=$5
      ORDER BY reservation_attempt DESC
      LIMIT 1
      FOR UPDATE`,
    [...scopeValues(input), input.capability, input.operationKey],
  );
  return result.rows[0] as LedgerRow | undefined;
}

async function ensureActiveWindow(
  client: BacklinkTransactionClient,
  input: ReservationInput,
  now: Date,
): Promise<WindowRow> {
  const current = await client.query(
    `SELECT id,window_expires_at AS "windowExpiresAt",
            call_limit AS "callLimit",
            budget_limit_usd AS "budgetLimitUsd",
            reserved_calls AS "reservedCalls",
            settled_calls AS "settledCalls",
            reserved_cost_usd AS "reservedCostUsd",
            spent_cost_usd AS "spentCostUsd",
            concurrency_limit AS "concurrencyLimit",
            active_reservations AS "activeReservations"
       FROM backlinks.backlink_ai_capability_windows
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3
        AND capability=$4
      ORDER BY window_started_at DESC
      LIMIT 1
      FOR UPDATE`,
    [...scopeValues(input), input.capability],
  );
  const row = current.rows[0] as WindowRow | undefined;
  if (row !== undefined && new Date(row.windowExpiresAt).getTime() > now.getTime()) {
    return row;
  }

  const windowId = randomUUID();
  const windowExpiresAt = new Date(
    now.getTime() + input.policy.windowSeconds * 1_000,
  );
  const inserted = await client.query(
    `INSERT INTO backlinks.backlink_ai_capability_windows (
       id,organization_id,workspace_id,website_project_id,capability,
       window_started_at,window_expires_at,call_limit,budget_limit_usd,
       concurrency_limit,created_at,updated_at,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$6,$6,$11,$11
     )
     RETURNING id,window_expires_at AS "windowExpiresAt",
       call_limit AS "callLimit",budget_limit_usd AS "budgetLimitUsd",
       reserved_calls AS "reservedCalls",settled_calls AS "settledCalls",
       reserved_cost_usd AS "reservedCostUsd",
       spent_cost_usd AS "spentCostUsd",
       concurrency_limit AS "concurrencyLimit",
       active_reservations AS "activeReservations"`,
    [
      windowId,
      ...scopeValues(input),
      input.capability,
      now,
      windowExpiresAt,
      input.policy.maxCalls,
      input.policy.absoluteBudgetUsd,
      input.policy.maxConcurrency,
      input.actorId,
    ],
  );
  return inserted.rows[0] as WindowRow;
}

function readinessFor(
  capability: AiCapability,
  window: WindowRow,
  policy: AiCapabilityPolicy,
): AiCapabilityReadiness {
  const remainingCalls = Math.max(
    0,
    window.callLimit - window.reservedCalls - window.settledCalls,
  );
  const remainingBudgetUsd = Math.max(
    0,
    roundUsd(
      asNumber(window.budgetLimitUsd)
      - asNumber(window.reservedCostUsd)
      - asNumber(window.spentCostUsd),
    ),
  );
  const availableConcurrency = Math.max(
    0,
    window.concurrencyLimit - window.activeReservations,
  );
  const state = remainingCalls < policy.maxProviderCallsPerGeneration
    || remainingBudgetUsd + 0.0000005 < policy.reservationUsd
    ? "BUDGET_EXCEEDED"
    : availableConcurrency === 0
      ? "RETRYABLE_FAILURE"
      : "READY";
  return Object.freeze({
    capability,
    state,
    windowId: window.id,
    windowExpiresAt: new Date(window.windowExpiresAt),
    remainingCalls,
    remainingBudgetUsd,
    availableConcurrency,
  });
}

export function createAiCapabilityBudgetRepository(
  client: BacklinkTransactionClient,
  now: () => Date = () => new Date(),
) {
  return Object.freeze({
    async readiness(input: ReservationInput): Promise<AiCapabilityReadiness> {
      await lockCapability(client, input);
      return readinessFor(
        input.capability,
        await ensureActiveWindow(client, input, now()),
        input.policy,
      );
    },

    async reserve(
      input: ReservationInput,
    ): Promise<AiCapabilityReservation> {
      if (
        input.workItemCount <= 0
        || input.workItemCount > input.policy.maxWorkItemsPerGeneration
      ) {
        throw new AiCapabilityBudgetError(
          "WORK_LIMIT_EXCEEDED",
          `${input.capability} work-item limit is exceeded.`,
        );
      }
      await lockCapability(client, input);
      const prior = await loadLatestOperation(client, input);
      if (prior?.status === "RESERVED" || prior?.status === "SETTLED") {
        return Object.freeze({
          reservationId: prior.id,
          windowId: prior.windowId,
          reservationAttempt: prior.reservationAttempt,
          status: prior.status,
        });
      }

      const window = await ensureActiveWindow(client, input, now());
      const readiness = readinessFor(input.capability, window, input.policy);
      if (readiness.state === "BUDGET_EXCEEDED") {
        throw new AiCapabilityBudgetError(
          "BUDGET_EXCEEDED",
          `${input.capability} budget or call limit is exhausted.`,
        );
      }
      if (readiness.state === "RETRYABLE_FAILURE") {
        throw new AiCapabilityBudgetError(
          "CONCURRENCY_EXHAUSTED",
          `${input.capability} concurrency limit is exhausted.`,
        );
      }

      const reservationId = randomUUID();
      const reservationAttempt = (prior?.reservationAttempt ?? 0) + 1;
      const reservedAt = now();
      await client.query(
        `INSERT INTO backlinks.backlink_ai_capability_usage_ledger (
           id,organization_id,workspace_id,website_project_id,window_id,
           capability,operation_key,reservation_attempt,status,
           work_item_count,max_provider_calls,reserved_cost_usd,
           provider_ref,model_id,reserved_at,created_at,updated_at,
           created_by,updated_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,'RESERVED',$9,$10,$11,$12,$13,
           $14,$14,$14,$15,$15
         )`,
        [
          reservationId,
          ...scopeValues(input),
          window.id,
          input.capability,
          input.operationKey,
          reservationAttempt,
          input.workItemCount,
          input.policy.maxProviderCallsPerGeneration,
          input.policy.reservationUsd,
          input.policy.providerRef,
          input.policy.modelId,
          reservedAt,
          input.actorId,
        ],
      );
      await client.query(
        `UPDATE backlinks.backlink_ai_capability_windows
            SET reserved_calls=reserved_calls+$6,
                reserved_cost_usd=reserved_cost_usd+$7,
                active_reservations=active_reservations+1,
                updated_at=$8,
                updated_by=$9
          WHERE organization_id=$1
            AND workspace_id=$2
            AND website_project_id=$3
            AND id=$4
            AND capability=$5`,
        [
          ...scopeValues(input),
          window.id,
          input.capability,
          input.policy.maxProviderCallsPerGeneration,
          input.policy.reservationUsd,
          reservedAt,
          input.actorId,
        ],
      );
      return Object.freeze({
        reservationId,
        windowId: window.id,
        reservationAttempt,
        status: "RESERVED" as const,
      });
    },

    async markProviderCallStarted(
      input: OperationInput & Readonly<{ actorId: string }>,
    ): Promise<void> {
      await lockCapability(client, input);
      const reservation = await loadLatestOperation(client, input);
      if (reservation?.status !== "RESERVED") {
        throw new AiCapabilityBudgetError(
          "RESERVATION_MISSING",
          `${input.capability} reservation is missing.`,
        );
      }
      if (reservation.providerCallCount >= reservation.maxProviderCalls) {
        throw new AiCapabilityBudgetError(
          "PROVIDER_CALL_LIMIT_EXCEEDED",
          `${input.capability} provider-call limit is exceeded.`,
        );
      }
      await client.query(
        `UPDATE backlinks.backlink_ai_capability_usage_ledger
            SET provider_call_count=provider_call_count+1,
                updated_at=$6,
                updated_by=$7
          WHERE organization_id=$1
            AND workspace_id=$2
            AND website_project_id=$3
            AND capability=$4
            AND id=$5`,
        [
          ...scopeValues(input),
          input.capability,
          reservation.id,
          now(),
          input.actorId,
        ],
      );
    },

    async settle(
      input: OperationInput & Readonly<{
        actualCostUsd: number;
        actorId: string;
      }>,
    ): Promise<void> {
      await lockCapability(client, input);
      const reservation = await loadLatestOperation(client, input);
      if (reservation?.status === "SETTLED") return;
      if (reservation?.status !== "RESERVED") {
        throw new AiCapabilityBudgetError(
          "RESERVATION_MISSING",
          `${input.capability} reservation is missing.`,
        );
      }
      const settledAt = now();
      const actualCostUsd = roundUsd(Math.max(0, input.actualCostUsd));
      const reservedCostUsd = asNumber(reservation.reservedCostUsd);
      if (actualCostUsd > reservedCostUsd + 0.0000005) {
        throw new AiCapabilityBudgetError(
          "BUDGET_EXCEEDED",
          `${input.capability} actual cost exceeds its reservation.`,
        );
      }
      await client.query(
        `UPDATE backlinks.backlink_ai_capability_usage_ledger
            SET status='SETTLED',actual_cost_usd=$6,settled_at=$7,
                updated_at=$7,updated_by=$8
          WHERE organization_id=$1
            AND workspace_id=$2
            AND website_project_id=$3
            AND capability=$4
            AND id=$5
            AND status='RESERVED'`,
        [
          ...scopeValues(input),
          input.capability,
          reservation.id,
          actualCostUsd,
          settledAt,
          input.actorId,
        ],
      );
      await client.query(
        `UPDATE backlinks.backlink_ai_capability_windows
            SET reserved_calls=reserved_calls-$6,
                settled_calls=settled_calls+$7,
                reserved_cost_usd=reserved_cost_usd-$8,
                spent_cost_usd=spent_cost_usd+$9,
                active_reservations=active_reservations-1,
                updated_at=$10,
                updated_by=$11
          WHERE organization_id=$1
            AND workspace_id=$2
            AND website_project_id=$3
            AND id=$4
            AND capability=$5`,
        [
          ...scopeValues(input),
          reservation.windowId,
          input.capability,
          reservation.maxProviderCalls,
          reservation.providerCallCount,
          reservedCostUsd,
          actualCostUsd,
          settledAt,
          input.actorId,
        ],
      );
    },

    async finalizeFailure(
      input: OperationInput & Readonly<{ actorId: string }>,
    ): Promise<"released" | "settled" | "unchanged"> {
      await lockCapability(client, input);
      const reservation = await loadLatestOperation(client, input);
      if (reservation?.status !== "RESERVED") return "unchanged";
      const finalizedAt = now();
      const reservedCostUsd = asNumber(reservation.reservedCostUsd);
      if (reservation.providerCallCount > 0) {
        await client.query(
          `UPDATE backlinks.backlink_ai_capability_usage_ledger
              SET status='SETTLED',actual_cost_usd=$6,settled_at=$7,
                  updated_at=$7,updated_by=$8
            WHERE organization_id=$1
              AND workspace_id=$2
              AND website_project_id=$3
              AND capability=$4
              AND id=$5
              AND status='RESERVED'`,
          [
            ...scopeValues(input),
            input.capability,
            reservation.id,
            reservedCostUsd,
            finalizedAt,
            input.actorId,
          ],
        );
        await client.query(
          `UPDATE backlinks.backlink_ai_capability_windows
              SET reserved_calls=reserved_calls-$6,
                  settled_calls=settled_calls+$7,
                  reserved_cost_usd=reserved_cost_usd-$8,
                  spent_cost_usd=spent_cost_usd+$8,
                  active_reservations=active_reservations-1,
                  updated_at=$9,
                  updated_by=$10
            WHERE organization_id=$1
              AND workspace_id=$2
              AND website_project_id=$3
              AND id=$4
              AND capability=$5`,
          [
            ...scopeValues(input),
            reservation.windowId,
            input.capability,
            reservation.maxProviderCalls,
            reservation.providerCallCount,
            reservedCostUsd,
            finalizedAt,
            input.actorId,
          ],
        );
        return "settled";
      }

      await client.query(
        `UPDATE backlinks.backlink_ai_capability_usage_ledger
            SET status='RELEASED',released_at=$6,updated_at=$6,updated_by=$7
          WHERE organization_id=$1
            AND workspace_id=$2
            AND website_project_id=$3
            AND capability=$4
            AND id=$5
            AND status='RESERVED'`,
        [
          ...scopeValues(input),
          input.capability,
          reservation.id,
          finalizedAt,
          input.actorId,
        ],
      );
      await client.query(
        `UPDATE backlinks.backlink_ai_capability_windows
            SET reserved_calls=reserved_calls-$6,
                reserved_cost_usd=reserved_cost_usd-$7,
                active_reservations=active_reservations-1,
                updated_at=$8,
                updated_by=$9
          WHERE organization_id=$1
            AND workspace_id=$2
            AND website_project_id=$3
            AND id=$4
            AND capability=$5`,
        [
          ...scopeValues(input),
          reservation.windowId,
          input.capability,
          reservation.maxProviderCalls,
          reservedCostUsd,
          finalizedAt,
          input.actorId,
        ],
      );
      return "released";
    },
  });
}
