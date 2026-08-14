import { createHash } from "node:crypto";

import { z } from "zod";

import {
  backlinkProviderSnapshotSchema,
  backlinkSnapshotRequestSchema,
  type BacklinkProviderSnapshot,
  type BacklinkSnapshotRequest,
  type DataForSeoRequestIntent,
  type ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import type {
  DataForSeoCallGate,
} from "../policies/dataforseo-call.policy.js";
import {
  createProviderArtifactFingerprint,
} from "./provider-artifact.service.js";

const bulkItemSchema = z.object({
  itemKey: z.string().trim().min(1).max(255),
  request: backlinkSnapshotRequestSchema,
}).strict();
const bulkInputSchema = z.object({
  context: z.object({
    organizationId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    websiteProjectId: z.string().trim().min(1),
    requestId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
    budgetReservationId: z.string().trim().min(1),
  }).strict(),
  intent: z.literal("CARD_ENRICHMENT"),
  refreshMode: z.enum(["CACHE_PREFERRED", "BACKGROUND_REFRESH"]),
  endpoint: z.literal("/v3/backlinks/referring_domains/live"),
  locationCode: z.string().trim().min(1),
  languageCode: z.string().trim().min(1),
  requestSchemaVersion: z.number().int().positive(),
  responseSchemaVersion: z.string().trim().min(1),
  usagePurpose: z.string().trim().min(1).max(128),
  projectContextVersion: z.number().int().positive(),
  estimatedCostMicros: z.number().int().nonnegative().max(
    Number.MAX_SAFE_INTEGER,
  ),
  items: z.array(bulkItemSchema).min(1).max(1_000),
}).strict();

export type DataForSeoBulkRequest =
  Readonly<z.output<typeof bulkInputSchema>>;

export type DataForSeoBulkProviderResult =
  | Readonly<{
      itemKey: string;
      status: "success";
      snapshot: BacklinkProviderSnapshot;
    }>
  | Readonly<{
      itemKey: string;
      status: "empty";
      snapshot: BacklinkProviderSnapshot;
    }>
  | Readonly<{
      itemKey: string;
      status: "retryable_error" | "permanent_error";
      code: string;
    }>;

export interface DataForSeoBulkPort {
  fetchBatch(input: Readonly<{
    context: ProviderRequestContext;
    intent: DataForSeoRequestIntent;
    refreshMode: "CACHE_PREFERRED" | "BACKGROUND_REFRESH";
    endpoint: "/v3/backlinks/referring_domains/live";
    locationCode: string;
    languageCode: string;
    requestSchemaVersion: number;
    responseSchemaVersion: string;
    usagePurpose: string;
    projectContextVersion: number;
    estimatedCostMicros: number;
    items: readonly Readonly<{
      itemKey: string;
      request: BacklinkSnapshotRequest;
    }>[];
  }>): Promise<Readonly<{
    actualCostMicros: number;
    rawPayloadHash: string;
    providerTaskId?: string;
    results: readonly DataForSeoBulkProviderResult[];
  }>>;
}

export type DataForSeoBulkOutcomeResult = Readonly<{
  itemKey: string;
  requestFingerprint: string;
  status: DataForSeoBulkProviderResult["status"];
  allocatedCostMicros: number;
  snapshot?: BacklinkProviderSnapshot;
  code?: string;
}>;

export type DataForSeoBulkOutcome = Readonly<{
  actualCostMicros: number;
  rawPayloadHash: string;
  providerTaskId?: string;
  results: readonly DataForSeoBulkOutcomeResult[];
  negativeCacheItemKeys: readonly string[];
  retryItemKeys: readonly string[];
}>;

export interface DataForSeoBulkBatchStore {
  start(input: Readonly<{
    request: DataForSeoBulkRequest;
    batchFingerprint: string;
    startedAt: Date;
  }>): Promise<string>;
  complete(input: Readonly<{
    batchRequestId: string;
    request: DataForSeoBulkRequest;
    outcome: DataForSeoBulkOutcome;
    completedAt: Date;
  }>): Promise<void>;
  fail(input: Readonly<{
    batchRequestId: string;
    status: "failed" | "unknown_charge";
    failureCode: string;
    failedAt: Date;
  }>): Promise<void>;
}

const failure = (
  error: unknown,
  providerAttempted: boolean,
): Readonly<{
  status: "failed" | "unknown_charge";
  code: string;
}> => {
  if (
    !providerAttempted ||
    (
      typeof error === "object" &&
      error !== null &&
      "providerRequestStatus" in error &&
      error.providerRequestStatus === "failed"
    )
  ) {
    return {
      status: "failed",
      code: error instanceof Error ? error.message : "DATAFORSEO_BULK_FAILED",
    };
  }
  return {
    status: "unknown_charge",
    code: error instanceof Error ? error.message : "DATAFORSEO_BULK_UNKNOWN",
  };
};

export class ProviderBulkRequestService {
  private readonly maxBatchSize: number;

  constructor(
    private readonly dependencies: Readonly<{
      provider: DataForSeoBulkPort;
      gate: DataForSeoCallGate;
      store: DataForSeoBulkBatchStore;
      now(): Date;
    }>,
    options: Readonly<{ maxBatchSize?: number }> = {},
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 100;
    if (
      !Number.isSafeInteger(this.maxBatchSize) ||
      this.maxBatchSize < 1 ||
      this.maxBatchSize > 1_000
    ) {
      throw new TypeError(
        "DataForSEO bulk maxBatchSize must be an integer between 1 and 1000",
      );
    }
  }

  async execute(rawInput: z.input<typeof bulkInputSchema>)
  : Promise<DataForSeoBulkOutcome> {
    const input = bulkInputSchema.parse(rawInput);
    if (input.items.length > this.maxBatchSize) {
      throw new Error("DATAFORSEO_BULK_BATCH_SIZE_EXCEEDED");
    }
    const seen = new Set<string>();
    for (const item of input.items) {
      const key = `${item.request.targetType}:${item.request.target
        .trim().toLowerCase()}`;
      if (seen.has(key)) {
        throw new Error("DATAFORSEO_BULK_DUPLICATE_PUBLIC_SUBJECT");
      }
      seen.add(key);
    }

    const fingerprints = new Map(input.items.map((item) => [
      item.itemKey,
      createProviderArtifactFingerprint({
        provider: "dataforseo",
        endpoint: input.endpoint,
        requestSchemaVersion: input.requestSchemaVersion,
        responseSchemaVersion: input.responseSchemaVersion,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        request: item.request,
      }),
    ]));
    const batchFingerprint = createHash("sha256").update(JSON.stringify({
      itemFingerprints: [...fingerprints.values()].sort(),
    })).digest("hex");
    const batchRequestId = await this.dependencies.store.start({
      request: input,
      batchFingerprint,
      startedAt: this.dependencies.now(),
    });
    let providerAttempted = false;
    try {
      await this.dependencies.gate.authorize({
        context: input.context,
        requestFingerprint: batchFingerprint,
        estimatedCostMicros: input.estimatedCostMicros,
      });
      providerAttempted = true;
      const response = await this.dependencies.provider.fetchBatch(input);
      if (
        !Number.isSafeInteger(response.actualCostMicros) ||
        response.actualCostMicros < 0
      ) {
        throw new TypeError("DataForSEO bulk cost must be a safe integer");
      }
      if (!/^[a-f0-9]{64}$/.test(response.rawPayloadHash)) {
        throw new TypeError("DataForSEO bulk raw payload hash is invalid");
      }
      if (response.results.length !== input.items.length) {
        throw new Error("DATAFORSEO_BULK_RESULT_CARDINALITY_MISMATCH");
      }
      const expectedKeys = new Set(input.items.map(({ itemKey }) => itemKey));
      const sorted = [...response.results].sort((left, right) =>
        left.itemKey.localeCompare(right.itemKey));
      if (
        new Set(sorted.map(({ itemKey }) => itemKey)).size !== sorted.length ||
        sorted.some(({ itemKey }) => !expectedKeys.has(itemKey))
      ) {
        throw new Error("DATAFORSEO_BULK_RESULT_IDENTITY_MISMATCH");
      }
      const base = Math.floor(response.actualCostMicros / sorted.length);
      let remainder = response.actualCostMicros % sorted.length;
      const results = sorted.map((item): DataForSeoBulkOutcomeResult => {
        const allocatedCostMicros = base + (remainder-- > 0 ? 1 : 0);
        const requestFingerprint = fingerprints.get(item.itemKey);
        if (requestFingerprint === undefined) {
          throw new Error("DATAFORSEO_BULK_RESULT_IDENTITY_MISMATCH");
        }
        if (item.status === "success" || item.status === "empty") {
          const normalized = backlinkProviderSnapshotSchema.parse(
            item.snapshot,
          );
          if (
            item.status === "empty" &&
            normalized.referringDomains.length !== 0
          ) {
            throw new Error("DATAFORSEO_BULK_EMPTY_RESULT_HAS_EVIDENCE");
          }
          return {
            itemKey: item.itemKey,
            requestFingerprint,
            status: item.status,
            allocatedCostMicros,
            snapshot: normalized,
          };
        }
        return {
          itemKey: item.itemKey,
          requestFingerprint,
          status: item.status,
          allocatedCostMicros,
          code: item.code,
        };
      });
      const outcome: DataForSeoBulkOutcome = {
        actualCostMicros: response.actualCostMicros,
        rawPayloadHash: response.rawPayloadHash,
        ...(response.providerTaskId === undefined
          ? {}
          : { providerTaskId: response.providerTaskId }),
        results,
        negativeCacheItemKeys: results
          .filter(({ status }) => status === "empty")
          .map(({ itemKey }) => itemKey),
        retryItemKeys: results
          .filter(({ status }) => status === "retryable_error")
          .map(({ itemKey }) => itemKey),
      };
      await this.dependencies.store.complete({
        batchRequestId,
        request: input,
        outcome,
        completedAt: this.dependencies.now(),
      });
      return outcome;
    } catch (error) {
      const failed = failure(error, providerAttempted);
      await this.dependencies.store.fail({
        batchRequestId,
        failureCode: failed.code,
        failedAt: this.dependencies.now(),
        status: failed.status,
      });
      throw error;
    }
  }
}
