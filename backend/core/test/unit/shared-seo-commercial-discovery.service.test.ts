import { describe, expect, it, vi } from "vitest";

import {
  createSharedSeoCommercialDiscoveryReuseAdapter,
  SharedSeoCommercialDiscoveryIntegrityError,
} from "../../src/modules/backlinks/application/services/shared-seo-commercial-discovery.service.js";
import {
  fingerprintCommercialDiscoveryCall,
  type CommercialDiscoveryArtifact,
  type CommercialDiscoveryCall,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";
import type {
  ResolvedSharedSeoEvidenceArtifact,
  SharedSeoEvidenceRequest,
  SharedSeoEvidenceSnapshot,
} from "../../src/modules/backlinks/ports/shared-seo-evidence.port.js";

const call: CommercialDiscoveryCall = {
  endpoint: "/v3/dataforseo_labs/google/competitors_domain/live",
  intent: "DISCOVERY",
  sourceType: "VERIFIED_COMPETITOR_BACKLINK_GAP",
  request: {
    target: "aiper.com",
    location_code: 2840,
    language_code: "en",
    limit: 100,
  },
  responseSchemaVersion: "dataforseo.labs-competitors-domain.v1",
  estimatedCostMicros: 1_000,
};
const requestFingerprint = fingerprintCommercialDiscoveryCall(call);
const request: SharedSeoEvidenceRequest = {
  organizationId: "org-1",
  websiteProjectId: "project-1",
  evidenceType: "commercial-discovery",
  sourceModule: "competitor-serp",
  provider: "dataforseo",
  endpoint: call.endpoint,
  requestFingerprint,
  market: "US",
  location: "2840",
  language: "en",
  now: "2026-08-15T03:00:00.000Z",
};
const snapshot: SharedSeoEvidenceSnapshot = {
  organizationId: request.organizationId,
  websiteProjectId: request.websiteProjectId,
  evidenceType: request.evidenceType,
  sourceModule: request.sourceModule,
  sourceRecordId: "competitor-run-1",
  sourceVersion: "competitor-serp.v1",
  provider: request.provider,
  endpoint: request.endpoint,
  normalizedParameters: call.request,
  requestFingerprint,
  market: request.market,
  location: request.location,
  language: request.language,
  fetchedAt: "2026-08-15T02:00:00.000Z",
  expiresAt: "2026-08-16T03:00:00.000Z",
  providerRequestId: "provider-request-1",
  providerTaskId: "provider-task-1",
  costMicros: 1_000,
  artifactRef: "artifact://competitor-serp/run-1",
  status: "ready",
};
const artifact: CommercialDiscoveryArtifact = {
  sourceType: call.sourceType,
  endpoint: call.endpoint,
  requestFingerprint,
  responseSchemaVersion: call.responseSchemaVersion,
  collectedAt: snapshot.fetchedAt,
  costMicros: 1_000,
  providerTaskIds: ["provider-task-1"],
  candidates: [],
};

function resolved(
  input: Readonly<{
    snapshot?: SharedSeoEvidenceSnapshot;
    payload?: Readonly<Record<string, unknown>>;
  }> = {},
): ResolvedSharedSeoEvidenceArtifact {
  return {
    snapshot: input.snapshot ?? snapshot,
    payload: input.payload ?? artifact,
  };
}

describe("shared SEO commercial discovery reuse adapter", () => {
  it("returns an exact fresh pinned commercial discovery artifact", async () => {
    const readReusable = vi.fn(async () => resolved());
    const adapter = createSharedSeoCommercialDiscoveryReuseAdapter({
      evidence: { readReusable },
      requestFor: () => request,
    });

    await expect(adapter.readReusable(call)).resolves.toEqual(artifact);
    expect(readReusable).toHaveBeenCalledWith(request);
  });

  it("returns null when no source mapping or reusable artifact exists", async () => {
    const readReusable = vi.fn(async () => null);
    const unmapped = createSharedSeoCommercialDiscoveryReuseAdapter({
      evidence: { readReusable },
      requestFor: () => null,
    });
    const unavailable = createSharedSeoCommercialDiscoveryReuseAdapter({
      evidence: { readReusable },
      requestFor: () => request,
    });

    await expect(unmapped.readReusable(call)).resolves.toBeNull();
    expect(readReusable).not.toHaveBeenCalled();
    await expect(unavailable.readReusable(call)).resolves.toBeNull();
    expect(readReusable).toHaveBeenCalledOnce();
  });

  it("rejects a request mapping that does not match the planned call", async () => {
    const readReusable = vi.fn(async () => resolved());
    const adapter = createSharedSeoCommercialDiscoveryReuseAdapter({
      evidence: { readReusable },
      requestFor: () => ({
        ...request,
        requestFingerprint: "different-fingerprint",
      }),
    });

    await expect(adapter.readReusable(call)).rejects.toBeInstanceOf(
      SharedSeoCommercialDiscoveryIntegrityError,
    );
    expect(readReusable).not.toHaveBeenCalled();
  });

  it("rejects stale or parameter-mismatched snapshot metadata", async () => {
    const stale = createSharedSeoCommercialDiscoveryReuseAdapter({
      evidence: {
        readReusable: async () => resolved({
          snapshot: {
            ...snapshot,
            expiresAt: request.now,
          },
        }),
      },
      requestFor: () => request,
    });
    const parameterMismatch = createSharedSeoCommercialDiscoveryReuseAdapter({
      evidence: {
        readReusable: async () => resolved({
          snapshot: {
            ...snapshot,
            normalizedParameters: {
              ...snapshot.normalizedParameters,
              limit: 50,
            },
          },
        }),
      },
      requestFor: () => request,
    });

    await expect(stale.readReusable(call)).rejects.toBeInstanceOf(
      SharedSeoCommercialDiscoveryIntegrityError,
    );
    await expect(parameterMismatch.readReusable(call)).rejects.toBeInstanceOf(
      SharedSeoCommercialDiscoveryIntegrityError,
    );
  });

  it("rejects an incompatible payload", async () => {
    const incompatible = createSharedSeoCommercialDiscoveryReuseAdapter({
      evidence: {
        readReusable: async () => resolved({
          payload: {
            ...artifact,
            sourceType: "USER_REFERRING_DOMAINS",
          },
        }),
      },
      requestFor: () => request,
    });

    await expect(incompatible.readReusable(call)).rejects.toBeInstanceOf(
      SharedSeoCommercialDiscoveryIntegrityError,
    );
  });
});
