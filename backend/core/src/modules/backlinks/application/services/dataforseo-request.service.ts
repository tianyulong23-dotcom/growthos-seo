import { createHash } from "node:crypto";
import { z } from "zod";

import {
  backlinkProviderSnapshotSchema,
  backlinkSnapshotRequestSchema,
  providerRequestContextSchema,
  type BacklinkProviderSnapshot,
  type BacklinkSnapshotRequest,
  type DataForSeoPort,
  type ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import type {
  DataForSeoCallGate,
} from "../policies/dataforseo-call.policy.js";
const provider = "dataforseo";
const endpoint = "/v3/backlinks/referring_domains/live";
const requestSchemaVersion = 1;
const positiveSafeIntegerSchema =
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const serviceInputSchema = z.object({
  context: providerRequestContextSchema,
  request: backlinkSnapshotRequestSchema,
  projectContextVersion: positiveSafeIntegerSchema,
  cacheSchemaVersion: positiveSafeIntegerSchema,
  cacheTtlMs: positiveSafeIntegerSchema,
  estimatedCostMicros: positiveSafeIntegerSchema,
}).strict();

type DataForSeoRequestServiceInput =
  Readonly<z.output<typeof serviceInputSchema>>;
export type DataForSeoRequestKey = Readonly<{
  organizationId: string; workspaceId: string; websiteProjectId: string;
  provider: typeof provider; endpoint: typeof endpoint;
  requestFingerprint: string;
  requestSchemaVersion: number;
  cacheSchemaVersion: number;
}>;
export type DataForSeoRequestStart = Readonly<{
  key: DataForSeoRequestKey; context: ProviderRequestContext;
  request: BacklinkSnapshotRequest; now: Date; expiresAt: Date;
}>;
export type DataForSeoRequestDecision =
  | Readonly<{ kind: "cache"; snapshot: BacklinkProviderSnapshot }>
  | Readonly<{ kind: "follower"; snapshot: Promise<BacklinkProviderSnapshot> }>
  | Readonly<{
      kind: "leader"; fail(error: unknown): Promise<void>;
      complete(snapshot: BacklinkProviderSnapshot): Promise<void>;
    }>;
export interface DataForSeoRequestCoordinator {
  begin(start: DataForSeoRequestStart): Promise<DataForSeoRequestDecision>;
}
export type DataForSeoRequestResult = Readonly<{
  source: "cache" | "single-flight" | "provider";
  requestFingerprint: string; snapshot: BacklinkProviderSnapshot;
}>;
function fingerprint(input: DataForSeoRequestServiceInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      provider,
      endpoint,
      requestSchemaVersion,
      cacheSchemaVersion: input.cacheSchemaVersion,
      projectContextVersion: input.projectContextVersion,
      target: input.request.target,
      targetType: input.request.targetType,
      limit: input.request.limit,
    }))
    .digest("hex");
}
function result(
  source: DataForSeoRequestResult["source"],
  requestFingerprint: string,
  snapshot: unknown,
): DataForSeoRequestResult {
  return { source, requestFingerprint,
    snapshot: backlinkProviderSnapshotSchema.parse(snapshot) };
}
export class DataForSeoRequestService {
  constructor(private readonly dependencies: Readonly<{
    coordinator: DataForSeoRequestCoordinator; provider: DataForSeoPort;
    gate: DataForSeoCallGate;
    now(): Date;
  }>) {}

  async execute(rawInput: DataForSeoRequestServiceInput)
  : Promise<DataForSeoRequestResult> {
    const input = serviceInputSchema.parse(rawInput);
    const now = this.dependencies.now();
    const expiresAt = new Date(now.getTime() + input.cacheTtlMs);
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(expiresAt.getTime())) {
      throw new TypeError("DataForSEO request cache time is invalid");
    }
    const requestFingerprint = fingerprint(input);
    const context = input.context;
    const decision = await this.dependencies.coordinator.begin({
      key: {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        websiteProjectId: context.websiteProjectId,
        provider,
        endpoint,
        requestFingerprint,
        requestSchemaVersion,
        cacheSchemaVersion: input.cacheSchemaVersion,
      },
      context, request: input.request,
      now,
      expiresAt,
    });
    if (decision.kind === "cache") {
      return result("cache", requestFingerprint, decision.snapshot);
    }
    if (decision.kind === "follower") {
      return result("single-flight", requestFingerprint, await decision.snapshot);
    }
    try {
      await this.dependencies.gate.authorize({
        context,
        requestFingerprint,
        estimatedCostMicros: input.estimatedCostMicros,
      });
      const snapshot = backlinkProviderSnapshotSchema.parse(
        await this.dependencies.provider.fetchBacklinkSnapshot(
          context,
          input.request,
        ),
      );
      await decision.complete(snapshot);
      return result("provider", requestFingerprint, snapshot);
    } catch (error) {
      await decision.fail(error);
      throw error;
    }
  }
}
