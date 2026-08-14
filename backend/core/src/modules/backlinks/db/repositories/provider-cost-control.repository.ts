import {
  classifyProviderArtifactFreshness,
} from "../../application/policies/provider-freshness.policy.js";
import type {
  DataForSeoRequestCoordinator,
  DataForSeoRequestStart,
} from "../../application/services/dataforseo-request.service.js";
import {
  createProviderArtifactRepository,
  type ProviderArtifactQueryClient,
} from "./provider-artifact.repository.js";
import {
  createProviderFetchLeaseRepository,
} from "./provider-fetch-lease.repository.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const failure = (error: unknown): Readonly<{
  status: "failed" | "unknown_charge";
  code: string;
}> => {
  if (
    error instanceof Error &&
    error.name === "DataForSeoCallBlockedError"
  ) {
    return { status: "failed", code: error.message };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "providerRequestStatus" in error &&
    error.providerRequestStatus === "failed"
  ) {
    return {
      status: "failed",
      code: "DATAFORSEO_PROVIDER_FAILED_BEFORE_DISPATCH",
    };
  }
  return {
    status: "unknown_charge",
    code: error instanceof Error ? error.message : "DATAFORSEO_RESULT_UNKNOWN",
  };
};

export function createProviderCostControlCoordinator(
  client: ProviderArtifactQueryClient,
  options: Readonly<{
    now(): Date;
    leaseDurationMs?: number;
    followerWaitMs?: number;
    followerPollMs?: number;
  }>,
): DataForSeoRequestCoordinator {
  const artifacts = createProviderArtifactRepository(client);
  const leases = createProviderFetchLeaseRepository(client);
  const leaseDurationMs = options.leaseDurationMs ?? 60_000;
  const followerWaitMs = options.followerWaitMs ?? 5_000;
  const followerPollMs = options.followerPollMs ?? 100;

  return {
    async begin(start: DataForSeoRequestStart) {
      const existing = await artifacts.findByFingerprint(
        start.key.requestFingerprint,
      );
      if (existing !== null && start.refreshMode !== "FORCE_LIVE") {
        const freshness = classifyProviderArtifactFreshness({
          now: start.now,
          freshUntil: existing.freshUntil,
          staleUntil: existing.staleUntil,
        });
        if (
          freshness === "fresh" ||
          (
            freshness === "stale" &&
            start.refreshMode === "CACHE_PREFERRED"
          )
        ) {
          await artifacts.recordUsage({
            start,
            artifactId: existing.artifactId,
            batchRequestId: null,
            servedFrom: existing.qualityStatus === "negative"
              ? "negative_cache"
              : freshness === "fresh"
                ? "fresh_cache"
                : "stale_cache",
            allocatedCostMicros: 0,
            usedAt: start.now,
          });
          return {
            kind: "cache",
            snapshot: existing.snapshot,
            freshness,
          };
        }
      }

      const leaseExpiresAt = new Date(start.now.getTime() + leaseDurationMs);
      const lease = await leases.acquire({
        artifactFingerprint: start.key.requestFingerprint,
        ownerRequestId: start.context.requestId,
        acquiredAt: start.now,
        leaseExpiresAt,
      });
      if (lease.status === "unknown_charge") {
        throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
      }
      if (!lease.acquired) {
        return {
          kind: "follower",
          snapshot: (async () => {
            const deadline = options.now().getTime() + followerWaitMs;
            while (options.now().getTime() < deadline) {
              await sleep(followerPollMs);
              const artifact = await artifacts.findByFingerprint(
                start.key.requestFingerprint,
              );
              if (artifact !== null) {
                await artifacts.recordUsage({
                  start,
                  artifactId: artifact.artifactId,
                  batchRequestId: null,
                  servedFrom: "single_flight",
                  allocatedCostMicros: 0,
                  usedAt: options.now(),
                });
                return artifact.snapshot;
              }
              const currentLease = await leases.read(
                start.key.requestFingerprint,
              );
              if (currentLease?.status === "unknown_charge") {
                throw new Error(
                  "BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED",
                );
              }
              if (currentLease?.status === "failed") {
                return null;
              }
            }
            return null;
          })(),
        };
      }

      const batchRequestId = await artifacts.startBatch(start);
      return {
        kind: "leader",
        heartbeat: async () => {
          const heartbeatAt = options.now();
          const extended = new Date(heartbeatAt.getTime() + leaseDurationMs);
          const updated = await leases.heartbeat({
            artifactFingerprint: start.key.requestFingerprint,
            ownerRequestId: start.context.requestId,
            heartbeatAt,
            leaseExpiresAt: extended,
          });
          if (!updated) {
            throw new Error("DATAFORSEO_FETCH_LEASE_LOST");
          }
        },
        complete: async (snapshot, freshness) => {
          await artifacts.complete({
            start,
            batchRequestId,
            snapshot,
            freshness,
            completedAt: options.now(),
          });
        },
        fail: async (error) => {
          const failed = failure(error);
          await artifacts.failBatch({
            start,
            batchRequestId,
            failureCode: failed.code,
            failedAt: options.now(),
            status: failed.status,
          });
        },
      };
    },
  };
}
