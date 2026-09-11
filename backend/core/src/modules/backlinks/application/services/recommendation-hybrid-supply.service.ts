import { createHash } from "node:crypto";
import {
  ProjectDomainRatingError,
  type ProjectDomainRating,
} from "../../adapters/ahrefs/project-domain-rating.adapter.js";
import type { CommercialDiscoveryArtifact } from "../../domain/recommendations/commercial-discovery-source.js";
import {
  ResourceLibraryError,
  type ResourceLibraryPort,
  type ResourceLibraryPublisher,
} from "../../ports/resource-library.port.js";
import type { RecommendationPoolV2CandidateAdmissionResult } from "./recommendation-pool-v2-candidate-admission.service.js";

export type RecommendationHybridSupplyFacts = Readonly<{
  finalized: boolean;
  projectDomain: string;
  language: string;
  topics: readonly string[];
  excludedDomains: readonly string[];
  admittedCount: number;
  dataForSeoCount: number;
  discoveryStarted?: boolean;
}>;

export type RecommendationHybridSupplyOutcome = Readonly<{
  status: "ALREADY_FINALIZED" | "NOT_NEEDED" | "MATCHED" | "EXHAUSTED" | "BLOCKED";
  admittedCount: number;
  reason?: string;
}>;

export function resourceSupplyDeficits(facts: RecommendationHybridSupplyFacts): readonly number[] {
  if (facts.finalized) return [];
  if (!Number.isSafeInteger(facts.admittedCount) || facts.admittedCount < 0 || facts.admittedCount > 1_000
    || !Number.isSafeInteger(facts.dataForSeoCount) || facts.dataForSeoCount < 0
    || facts.dataForSeoCount > facts.admittedCount) throw new TypeError("Hybrid supply counts are invalid");
  if (facts.admittedCount === 1_000) return [];
  const dfs = facts.dataForSeoCount;
  return dfs < 200
    ? [100 - Math.ceil(dfs / 2), 100 - Math.floor(dfs / 2)].filter((value) => value > 0)
    : [(100 - dfs % 100) % 100].filter((value) => value > 0);
}

export function createRecommendationHybridSupplyService(options: Readonly<{
  getRating(projectDomain: string): Promise<ProjectDomainRating>;
  library: ResourceLibraryPort;
  ingest(artifact: CommercialDiscoveryArtifact): Promise<RecommendationPoolV2CandidateAdmissionResult>;
  now?: () => Date;
}>) {
  return Object.freeze({
    async prepare(facts: RecommendationHybridSupplyFacts): Promise<RecommendationHybridSupplyOutcome> {
      if (facts.finalized) return { status: "ALREADY_FINALIZED", admittedCount: 0 };
      // Supply requirements only. Canonical batch selection remains the finalizer's job.
      const deficits = resourceSupplyDeficits(facts);
      let capacity = 1_000 - facts.admittedCount;
      if (capacity === 0 || deficits.every((value) => value === 0)) {
        return { status: "NOT_NEEDED", admittedCount: 0 };
      }
      let selected: (ResourceLibraryPublisher & { releaseBatchOrdinal: number })[] = [];
      try {
        const rating = await options.getRating(facts.projectDomain);
        for (const [index, deficit] of deficits.entries()) {
          const limit = Math.min(deficit, capacity);
          if (limit === 0) continue;
          const matches = await options.library.match({
            projectDomain: facts.projectDomain,
            projectDr: rating.value,
            language: facts.language,
            topics: facts.topics,
            excludedDomains: [...facts.excludedDomains, ...selected.map((row) => row.canonicalDomain)],
            limit,
          });
          const releaseBatchOrdinal = facts.dataForSeoCount < 200
            ? index + (Math.ceil(facts.dataForSeoCount / 2) === 100 ? 2 : 1)
            : Math.ceil(facts.dataForSeoCount / 100);
          selected = [...selected, ...matches.map((publisher) => ({
            ...publisher, releaseBatchOrdinal,
          }))];
          capacity -= matches.length;
        }
      } catch (error) {
        if (!(error instanceof ProjectDomainRatingError) && !(error instanceof ResourceLibraryError)) throw error;
        // Existing DataForSEO supply remains usable. Zero supply must not masquerade as exhaustion.
        if (facts.admittedCount === 0) throw error;
        return { status: "BLOCKED", admittedCount: 0, reason: error.code };
      }
      if (selected.length === 0) return { status: "EXHAUSTED", admittedCount: 0 };
      const collectedAt = (options.now ?? (() => new Date()))().toISOString();
      const fingerprint = createHash("sha256").update(JSON.stringify(selected)).digest("hex");
      const result = await options.ingest({
        sourceType: "CURATED_RESOURCE_LIBRARY",
        endpoint: null,
        requestFingerprint: fingerprint,
        responseSchemaVersion: "resource-library.sqlite.v1",
        collectedAt,
        costMicros: 0,
        providerTaskIds: [],
        candidates: selected.map((publisher) => ({
          canonicalDomain: publisher.canonicalDomain,
          discoveryUrls: [publisher.websiteUrl],
          backlinkPageEvidence: [],
          rank: null, traffic: null, backlinkCount: null,
          referringDomainCount: null, spamScore: null, countryCode: null,
          evidenceRefs: [`resource-library:${fingerprint}:${publisher.canonicalDomain}`],
          resourceLibrary: {
            releaseBatchOrdinal: publisher.releaseBatchOrdinal,
            ahrefsDr: publisher.ahrefsDr,
            monthlyTraffic: publisher.monthlyTraffic,
            language: publisher.language,
            categories: publisher.categories,
            categoryMatch: publisher.categoryMatch,
          },
        })),
      });
      return { status: result.admittedCount === 0 ? "EXHAUSTED" : "MATCHED", admittedCount: result.admittedCount };
    },
  });
}
