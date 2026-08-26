import {
  DataForSeoCallBlockedError,
  type DataForSeoCallGate,
} from "../policies/dataforseo-call.policy.js";
import type { ProviderRequestContext } from "../../ports/dataforseo.port.js";
import type {
  CommercialQualificationBulkCall,
  CommercialQualificationBulkResponse,
  CommercialQualificationBulkRuntime,
} from "./commercial-qualification-bulk.service.js";

export type CommercialQualificationRequestAcquireResult =
  | Readonly<{
      state: "started";
      batchRequestId: string;
    }>
  | Readonly<{
      state: "cached";
      response: CommercialQualificationBulkResponse;
    }>
  | Readonly<{
      state: "blocked";
      reason: "in_flight" | "unknown_charge";
    }>;

export interface CommercialQualificationRequestStore {
  acquire(input: Readonly<{
    context: ProviderRequestContext;
    call: CommercialQualificationBulkCall;
    estimatedCostMicros: number;
    startedAt: Date;
  }>): Promise<CommercialQualificationRequestAcquireResult>;
  complete(input: Readonly<{
    context: ProviderRequestContext;
    batchRequestId: string;
    call: CommercialQualificationBulkCall;
    response: CommercialQualificationBulkResponse;
    completedAt: Date;
  }>): Promise<void>;
  fail(input: Readonly<{
    context: ProviderRequestContext;
    batchRequestId: string;
    status: "failed" | "unknown_charge";
    failureCode: string;
    failedAt: Date;
  }>): Promise<void>;
}

function requestContext(
  base: Omit<
    ProviderRequestContext,
    "requestId" | "idempotencyKey" | "budgetReservationId"
  >,
  operationId: string,
  budgetReservationPrefix: string,
  call: CommercialQualificationBulkCall,
): ProviderRequestContext {
  const requestKey = [
    "commercial-qualification-v4",
    operationId,
    call.kind,
    call.requestFingerprint,
  ].join(":");
  return Object.freeze({
    ...base,
    requestId: requestKey,
    idempotencyKey: requestKey,
    budgetReservationId: [
      budgetReservationPrefix,
      "qualification",
      call.kind,
      call.requestFingerprint,
    ].join(":"),
  });
}

export function createGovernedCommercialQualificationRuntime(
  input: Readonly<{
    context: Omit<
      ProviderRequestContext,
      "requestId" | "idempotencyKey" | "budgetReservationId"
    >;
    operationId: string;
    budgetReservationPrefix: string;
    estimatedCostMicros: number;
    provider: CommercialQualificationBulkRuntime;
    gate: DataForSeoCallGate;
    store: CommercialQualificationRequestStore;
    now?: () => Date;
  }>,
): CommercialQualificationBulkRuntime {
  const now = input.now ?? (() => new Date());
  const budgetReservationPrefix = input.budgetReservationPrefix
    .trim()
    .replace(/:+$/u, "");
  if (input.operationId.trim().length === 0) {
    throw new TypeError("Commercial qualification operation is required.");
  }
  if (budgetReservationPrefix.length === 0) {
    throw new TypeError(
      "Commercial qualification budget reservation prefix is required.",
    );
  }
  if (
    !Number.isSafeInteger(input.estimatedCostMicros)
    || input.estimatedCostMicros <= 0
  ) {
    throw new TypeError(
      "Commercial qualification estimated cost must be positive.",
    );
  }

  return Object.freeze({
    async execute(
      call: CommercialQualificationBulkCall,
    ): Promise<CommercialQualificationBulkResponse> {
      const context = requestContext(
        input.context,
        input.operationId,
        budgetReservationPrefix,
        call,
      );
      try {
        await input.gate.preflight({
          context,
          requestFingerprint: call.requestFingerprint,
          estimatedCostMicros: input.estimatedCostMicros,
        });
      } catch (error) {
        if (error instanceof DataForSeoCallBlockedError) {
          return Object.freeze({
            status: "unavailable",
            body: null,
            providerRequestId: null,
            costMicros: 0,
          });
        }
        throw error;
      }
      const acquired = await input.store.acquire({
        context,
        call,
        estimatedCostMicros: input.estimatedCostMicros,
        startedAt: now(),
      });
      if (acquired.state === "cached") return acquired.response;
      if (acquired.state === "blocked") {
        return Object.freeze({
          status: acquired.reason === "unknown_charge"
            ? "unknown_charge"
            : "unavailable",
          body: null,
          providerRequestId: null,
          costMicros: 0,
        });
      }

      try {
        await input.gate.authorize({
          context,
          requestFingerprint: call.requestFingerprint,
          estimatedCostMicros: input.estimatedCostMicros,
        });
        const response = await input.provider.execute(call);
        if (response.status === "unknown_charge") {
          await input.store.fail({
            context,
            batchRequestId: acquired.batchRequestId,
            status: "unknown_charge",
            failureCode: "DATAFORSEO_QUALIFICATION_UNKNOWN_CHARGE",
            failedAt: now(),
          });
          return response;
        }
        if (response.status === "unavailable") {
          await input.store.fail({
            context,
            batchRequestId: acquired.batchRequestId,
            status: "failed",
            failureCode: "DATAFORSEO_QUALIFICATION_UNAVAILABLE",
            failedAt: now(),
          });
          return response;
        }
        await input.store.complete({
          context,
          batchRequestId: acquired.batchRequestId,
          call,
          response,
          completedAt: now(),
        });
        return response;
      } catch (error) {
        await input.store.fail({
          context,
          batchRequestId: acquired.batchRequestId,
          status: "failed",
          failureCode: error instanceof Error
            ? error.message
            : "DATAFORSEO_QUALIFICATION_FAILED",
          failedAt: now(),
        });
        if (error instanceof DataForSeoCallBlockedError) {
          return Object.freeze({
            status: "unavailable",
            body: null,
            providerRequestId: null,
            costMicros: 0,
          });
        }
        throw error;
      }
    },
  });
}
