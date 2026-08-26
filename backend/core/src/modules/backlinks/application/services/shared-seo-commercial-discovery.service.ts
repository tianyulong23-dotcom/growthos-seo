import { isDeepStrictEqual } from "node:util";

import {
  commercialDiscoveryArtifactSchema,
  commercialDiscoveryCallSchema,
  fingerprintCommercialDiscoveryCall,
  type CommercialDiscoveryArtifact,
  type CommercialDiscoveryCall,
} from "../../domain/recommendations/commercial-discovery-source.js";
import {
  isReusableSharedSeoEvidence,
  type SharedSeoEvidenceArtifactPort,
  type SharedSeoEvidenceRequest,
} from "../../ports/shared-seo-evidence.port.js";

export interface CommercialDiscoveryEvidenceReusePort {
  readReusable(
    call: CommercialDiscoveryCall,
  ): Promise<CommercialDiscoveryArtifact | null>;
}

export type CommercialDiscoveryEvidenceRequestFactory = (
  call: CommercialDiscoveryCall,
) => SharedSeoEvidenceRequest | null;

export class SharedSeoCommercialDiscoveryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedSeoCommercialDiscoveryIntegrityError";
  }
}

export function createSharedSeoCommercialDiscoveryReuseAdapter(
  input: Readonly<{
    evidence: SharedSeoEvidenceArtifactPort;
    requestFor: CommercialDiscoveryEvidenceRequestFactory;
  }>,
): CommercialDiscoveryEvidenceReusePort {
  return {
    async readReusable(rawCall) {
      const call = commercialDiscoveryCallSchema.parse(rawCall);
      const expectedFingerprint = fingerprintCommercialDiscoveryCall(call);
      const request = input.requestFor(call);
      if (request === null) {
        return null;
      }
      if (
        request.provider !== "dataforseo" ||
        request.endpoint !== call.endpoint ||
        request.requestFingerprint !== expectedFingerprint
      ) {
        throw new SharedSeoCommercialDiscoveryIntegrityError(
          "Shared SEO evidence request does not match the discovery call.",
        );
      }
      const resolved = await input.evidence.readReusable(request);
      if (resolved === null) {
        return null;
      }
      if (!isReusableSharedSeoEvidence(resolved.snapshot, request)) {
        throw new SharedSeoCommercialDiscoveryIntegrityError(
          "Resolved shared SEO evidence does not match the reusable request.",
        );
      }
      if (
        !isDeepStrictEqual(resolved.snapshot.normalizedParameters, call.request)
      ) {
        throw new SharedSeoCommercialDiscoveryIntegrityError(
          "Shared SEO evidence parameters do not match the discovery call.",
        );
      }

      let artifact: CommercialDiscoveryArtifact;
      try {
        artifact = commercialDiscoveryArtifactSchema.parse(resolved.payload);
      } catch {
        throw new SharedSeoCommercialDiscoveryIntegrityError(
          "Shared SEO evidence payload is not a commercial discovery artifact.",
        );
      }
      if (
        artifact.endpoint !== call.endpoint ||
        artifact.sourceType !== call.sourceType ||
        artifact.requestFingerprint !== expectedFingerprint ||
        artifact.responseSchemaVersion !== call.responseSchemaVersion
      ) {
        throw new SharedSeoCommercialDiscoveryIntegrityError(
          "Shared SEO evidence artifact does not match the discovery call.",
        );
      }
      if (
        resolved.snapshot.costMicros !== null &&
        resolved.snapshot.costMicros !== artifact.costMicros
      ) {
        throw new SharedSeoCommercialDiscoveryIntegrityError(
          "Shared SEO evidence artifact cost does not match its snapshot.",
        );
      }
      if (
        resolved.snapshot.providerTaskId !== null &&
        !artifact.providerTaskIds.includes(resolved.snapshot.providerTaskId)
      ) {
        throw new SharedSeoCommercialDiscoveryIntegrityError(
          "Shared SEO evidence artifact task does not match its snapshot.",
        );
      }
      return artifact;
    },
  };
}
