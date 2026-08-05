import { z } from "zod";

import {
  backlinkProviderSnapshotSchema,
  backlinkSnapshotRequestSchema,
  dataForSeoRefreshModeSchema,
  dataForSeoRequestIntentSchema,
  providerRequestContextSchema,
  type BacklinkProviderSnapshot,
  type BacklinkSnapshotRequest,
  type DataForSeoRefreshMode,
  type DataForSeoRequestIntent,
  type DataForSeoPort,
  type ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import {
  createProviderArtifactFreshnessWindow,
  type ProviderArtifactFreshness,
  type ProviderArtifactFreshnessWindow,
} from "../policies/provider-freshness.policy.js";
import {
  assertDataForSeoRequestIntent,
} from "../policies/provider-request-intent.policy.js";
import type {
  DataForSeoCallGate,
} from "../policies/dataforseo-call.policy.js";
import {
  createProviderArtifactFingerprint,
} from "./provider-artifact.service.js";
const provider = "dataforseo";
const endpoint = "/v3/backlinks/referring_domains/live";
const requestSchemaVersion = 1;
const positiveSafeIntegerSchema =
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const serviceInputSchema = z.object({
  context: providerRequestContextSchema,
  request: backlinkSnapshotRequestSchema,
  intent: dataForSeoRequestIntentSchema,
  refreshMode: dataForSeoRefreshModeSchema,
  execution: z.enum(["BACKGROUND", "INTERACTIVE"]),
  locationCode: z.string().trim().min(1).max(64),
  languageCode: z.string().trim().min(1).max(32),
  responseSchemaVersion: z.string().trim().min(1).max(64),
  usagePurpose: z.string().trim().min(1).max(128),
  projectContextVersion: positiveSafeIntegerSchema,
  cacheSchemaVersion: positiveSafeIntegerSchema,
  estimatedCostMicros: positiveSafeIntegerSchema,
  opportunityId: z.string().trim().min(1).optional(),
  explicitDetailRequested: z.boolean().optional(),
  explicitAssessmentTaskId: z.string().trim().min(1).optional(),
  linkValidatorPrimary: z.boolean().optional(),
  forceLiveAuthorized: z.boolean().optional(),
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
  request: BacklinkSnapshotRequest;
  intent: DataForSeoRequestIntent;
  refreshMode: DataForSeoRefreshMode;
  locationCode: string;
  languageCode: string;
  responseSchemaVersion: string;
  usagePurpose: string;
  projectContextVersion: number;
  estimatedCostMicros: number;
  now: Date;
  freshUntil: Date;
  staleUntil: Date;
}>;
export type DataForSeoRequestDecision =
  | Readonly<{
      kind: "cache";
      snapshot: BacklinkProviderSnapshot;
      freshness?: Exclude<ProviderArtifactFreshness, "expired">;
    }>
  | Readonly<{
      kind: "follower";
      snapshot: Promise<BacklinkProviderSnapshot | null>;
    }>
  | Readonly<{
      kind: "leader"; fail(error: unknown): Promise<void>;
      heartbeat?(): Promise<void>;
      complete(
        snapshot: BacklinkProviderSnapshot,
        freshness: ProviderArtifactFreshnessWindow,
      ): Promise<void>;
    }>;
export interface DataForSeoRequestCoordinator {
  begin(start: DataForSeoRequestStart): Promise<DataForSeoRequestDecision>;
}
export type DataForSeoRequestResult =
  | Readonly<{
      source: "cache" | "stale-cache" | "single-flight" | "provider";
      freshness: Exclude<ProviderArtifactFreshness, "expired">;
      requestFingerprint: string;
      snapshot: BacklinkProviderSnapshot;
    }>
  | Readonly<{
      source: "refresh-pending";
      freshness: "expired";
      requestFingerprint: string;
    }>;
function result(
  source: "cache" | "stale-cache" | "single-flight" | "provider",
  freshness: Exclude<ProviderArtifactFreshness, "expired">,
  requestFingerprint: string,
  snapshot: unknown,
): DataForSeoRequestResult {
  return { source, freshness, requestFingerprint,
    snapshot: backlinkProviderSnapshotSchema.parse(snapshot) };
}
export class DataForSeoRequestService {
  constructor(private readonly dependencies: Readonly<{
    coordinator: DataForSeoRequestCoordinator; provider: DataForSeoPort;
    gate: DataForSeoCallGate;
    scheduleBackgroundRefresh?(input: DataForSeoRequestStart): Promise<void>;
    heartbeatIntervalMs?: number;
    now(): Date;
  }>) {}

  async execute(rawInput: DataForSeoRequestServiceInput)
  : Promise<DataForSeoRequestResult> {
    const input = serviceInputSchema.parse(rawInput);
    assertDataForSeoRequestIntent(input);
    const now = this.dependencies.now();
    const initialFreshness = createProviderArtifactFreshnessWindow({
      intent: input.intent,
      observedAt: now,
      negative: false,
    });
    const requestFingerprint = createProviderArtifactFingerprint({
      provider,
      endpoint,
      requestSchemaVersion,
      responseSchemaVersion: input.responseSchemaVersion,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      request: input.request,
    });
    const context = input.context;
    const start: DataForSeoRequestStart = {
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
      context,
      request: input.request,
      intent: input.intent,
      refreshMode: input.refreshMode,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      responseSchemaVersion: input.responseSchemaVersion,
      usagePurpose: input.usagePurpose,
      projectContextVersion: input.projectContextVersion,
      estimatedCostMicros: input.estimatedCostMicros,
      now,
      freshUntil: initialFreshness.freshUntil,
      staleUntil: initialFreshness.staleUntil,
    };
    const decision = await this.dependencies.coordinator.begin(start);
    if (decision.kind === "cache") {
      if (input.refreshMode === "FORCE_LIVE") {
        throw new Error("DATAFORSEO_FORCE_LIVE_COORDINATOR_CACHE_VIOLATION");
      }
      const freshness = decision.freshness ?? "fresh";
      if (freshness === "stale") {
        await this.dependencies.scheduleBackgroundRefresh?.({
          ...start,
          refreshMode: "BACKGROUND_REFRESH",
        });
      }
      return result(
        freshness === "fresh" ? "cache" : "stale-cache",
        freshness,
        requestFingerprint,
        decision.snapshot,
      );
    }
    if (decision.kind === "follower") {
      const snapshot = await decision.snapshot;
      if (snapshot === null) {
        return {
          source: "refresh-pending",
          freshness: "expired",
          requestFingerprint,
        };
      }
      return result(
        "single-flight",
        "fresh",
        requestFingerprint,
        snapshot,
      );
    }
    let heartbeatFailure: unknown;
    const heartbeatIntervalMs = this.dependencies.heartbeatIntervalMs ?? 15_000;
    const heartbeat = decision.heartbeat;
    const timer = heartbeat === undefined ? undefined : setInterval(() => {
      void heartbeat().catch((error: unknown) => {
        heartbeatFailure = error;
      });
    }, heartbeatIntervalMs);
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
      if (timer !== undefined) {
        clearInterval(timer);
      }
      if (heartbeatFailure !== undefined) {
        throw heartbeatFailure;
      }
      const completedAt = new Date(snapshot.completedAt);
      const freshness = createProviderArtifactFreshnessWindow({
        intent: input.intent,
        observedAt: completedAt,
        negative: snapshot.referringDomains.length === 0,
      });
      await decision.complete(snapshot, freshness);
      return result("provider", "fresh", requestFingerprint, snapshot);
    } catch (error) {
      await decision.fail(error);
      throw error;
    } finally {
      if (timer !== undefined) {
        clearInterval(timer);
      }
    }
  }
}
