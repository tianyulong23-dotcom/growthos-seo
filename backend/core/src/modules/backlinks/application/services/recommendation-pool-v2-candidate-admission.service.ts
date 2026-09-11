import {
  type CommercialDiscoveryArtifact,
  type CommercialDiscoveryCandidate,
  type CommercialDiscoverySourceType,
} from "../../domain/recommendations/commercial-discovery-source.js";
import { createRecommendationDomainKey } from "../../domain/recommendations/domain-key.js";
import {
  evaluateRecommendationPoolV2CandidateAdmission,
  type RecommendationPoolV2AdmissionDecision,
} from "../../domain/recommendations/recommendation-pool-v2-admission.js";
import type {
  RecommendationPositiveEvidence,
  RecommendationRelevanceEvidence,
} from "../../domain/recommendations/recommendation-marker-policy.js";
import type {
  RecommendationPoolV2CandidateLineage,
  RecommendationPoolV2CandidateSourceOutcome,
  createRecommendationPoolV2CandidateRepository,
} from "../../db/repositories/recommendation-pool-v2-candidate.repository.js";

type CandidateRepository = Pick<
  ReturnType<typeof createRecommendationPoolV2CandidateRepository>,
  | "findCandidate"
  | "recordCandidate"
  | "appendSource"
  | "appendMetric"
  | "materializeCandidate"
>;

export type RecommendationPoolV2CandidateTimingObserver = Readonly<{
  record(
    input: Readonly<{
      eventType:
        | "CANDIDATE_NORMALIZATION_STARTED"
        | "CANDIDATE_NORMALIZATION_COMPLETED"
        | "CANDIDATE_ADMISSION_STARTED"
        | "CANDIDATE_ADMISSION_COMPLETED"
        | "METRIC_ENRICHMENT_STARTED"
        | "METRIC_ENRICHMENT_COMPLETED";
      requestIntentId?: string;
      generationCandidateId?: string;
      details?: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void>;
}>;

export type RecommendationPoolV2ArtifactObservation = Readonly<{
  requestIntentId: string;
  providerOutcome: RecommendationPoolV2CandidateSourceOutcome;
  artifact: CommercialDiscoveryArtifact;
}>;

export type RecommendationPoolV2CandidateAdmissionResult = Readonly<{
  rawCandidateCount: number;
  canonicalCandidateCount: number;
  newUniqueCount: number;
  duplicateCount: number;
  admittedCount: number;
  hardExcludedCount: number;
  materializedCount: number;
}>;

function sourceEvidence(sourceType: CommercialDiscoverySourceType): Readonly<{
  relevanceEvidence: readonly RecommendationRelevanceEvidence[];
  positiveEvidence: readonly RecommendationPositiveEvidence[];
}> {
  switch (sourceType) {
    case "VERIFIED_COMPETITOR_REFERRING_DOMAINS":
    case "VERIFIED_COMPETITOR_BACKLINK_GAP":
      return Object.freeze({
        relevanceEvidence: Object.freeze([
          "COMPETITOR_BACKLINK_SOURCE",
        ] satisfies readonly RecommendationRelevanceEvidence[]),
        positiveEvidence: Object.freeze([
          "VERIFIED_SOURCE_RELATION",
        ] satisfies readonly RecommendationPositiveEvidence[]),
      });
    case "BLUEPRINT_SERP_STANDARD_QUEUE":
      return Object.freeze({
        relevanceEvidence: Object.freeze([
          "TARGET_MARKET_SEARCH_TOPIC",
        ] satisfies readonly RecommendationRelevanceEvidence[]),
        positiveEvidence: Object.freeze([
          "VERIFIED_SOURCE_RELATION",
        ] satisfies readonly RecommendationPositiveEvidence[]),
      });
    case "CURATED_RESOURCE_LIBRARY":
      return Object.freeze({
        relevanceEvidence: Object.freeze([]),
        positiveEvidence: Object.freeze([]),
      });
    case "EXISTING_HISTORY":
    case "USER_REFERRING_DOMAINS":
      return Object.freeze({
        relevanceEvidence: Object.freeze([
          "PRODUCT_TOPIC_OVERLAP",
        ] satisfies readonly RecommendationRelevanceEvidence[]),
        positiveEvidence: Object.freeze([
          "VERIFIED_SOURCE_RELATION",
        ] satisfies readonly RecommendationPositiveEvidence[]),
      });
  }
}

function decisionFor(
  projectDomain: string,
  sourceType: CommercialDiscoverySourceType,
  candidate: CommercialDiscoveryCandidate,
): RecommendationPoolV2AdmissionDecision {
  const evidence = sourceEvidence(sourceType);
  const library = sourceType === "CURATED_RESOURCE_LIBRARY";
  const libraryEvidence = library ? candidate.resourceLibrary : undefined;
  const positiveEvidence = [
    ...evidence.positiveEvidence,
    ...(library || candidate.countryCode === null
      ? []
      : (["MARKET_LANGUAGE_MATCH"] as const)),
    ...(library ? (libraryEvidence?.ahrefsDr == null ? [] : (["RELIABLE_METRIC"] as const))
      : candidate.rank === null &&
    candidate.traffic === null &&
    candidate.spamScore === null
      ? []
      : (["RELIABLE_METRIC"] as const)),
    ...(library || candidate.backlinkPageEvidence.length === 0
      ? []
      : (["COOPERATION_PATH"] as const)),
  ];
  return evaluateRecommendationPoolV2CandidateAdmission({
    canonicalDomain: candidate.canonicalDomain,
    projectDomain,
    relevanceEvidence: libraryEvidence?.categoryMatch === "RELATED"
      ? ["PRODUCT_TOPIC_OVERLAP"] : evidence.relevanceEvidence,
    positiveEvidence,
    metrics: {
      targetMarketOrganicTraffic: library ? null : candidate.traffic,
      dataForSeoRank: library ? null : candidate.rank,
      spamScore: library ? null : candidate.spamScore,
    },
    contact: { email: null, contactPage: null },
    hardExclusionSignals: [],
  });
}

function discoveredUrl(candidate: CommercialDiscoveryCandidate): Readonly<{
  value: string;
  observed: boolean;
}> {
  const observed =
    candidate.discoveryUrls[0] ??
    candidate.backlinkPageEvidence[0]?.sourceUrl;
  if (observed !== undefined) {
    return Object.freeze({ value: observed, observed: true });
  }
  const canonicalDomain =
    createRecommendationDomainKey(candidate.canonicalDomain).registrableDomain;
  return Object.freeze({
    value: `https://${canonicalDomain}/`,
    observed: false,
  });
}

export function createRecommendationPoolV2CandidateAdmissionService(
  repository: CandidateRepository,
  timing?: RecommendationPoolV2CandidateTimingObserver,
) {
  return Object.freeze({
    async ingestArtifacts(
      input: RecommendationPoolV2CandidateLineage &
        Readonly<{
          projectDomain: string;
          market: string;
          location: string;
          language: string;
          observations: readonly RecommendationPoolV2ArtifactObservation[];
          createdBy: string;
        }>,
    ): Promise<RecommendationPoolV2CandidateAdmissionResult> {
      const authorities = new Map<
        string,
        Awaited<ReturnType<CandidateRepository["recordCandidate"]>>
      >();
      const normalizedCandidates: Array<
        Readonly<{
          observation: RecommendationPoolV2ArtifactObservation;
          candidate: CommercialDiscoveryCandidate;
          candidateIndex: number;
          canonicalDomain: string;
        }>
      > = [];
      const firstRequestIntentId = input.observations[0]?.requestIntentId;
      await timing?.record({
        eventType: "CANDIDATE_NORMALIZATION_STARTED",
        ...(firstRequestIntentId === undefined
          ? {}
          : { requestIntentId: firstRequestIntentId }),
        details: { observationCount: input.observations.length },
      });
      for (const observation of input.observations) {
        for (
          let candidateIndex = 0;
          candidateIndex < observation.artifact.candidates.length;
          candidateIndex += 1
        ) {
          const candidate = observation.artifact.candidates[candidateIndex];
          if (candidate === undefined) continue;
          normalizedCandidates.push(
            Object.freeze({
              observation,
              candidate,
              candidateIndex,
              canonicalDomain:
                createRecommendationDomainKey(
                  candidate.canonicalDomain,
                ).registrableDomain,
            }),
          );
        }
      }
      await timing?.record({
        eventType: "CANDIDATE_NORMALIZATION_COMPLETED",
        ...(firstRequestIntentId === undefined
          ? {}
          : { requestIntentId: firstRequestIntentId }),
        details: { rawCandidateCount: normalizedCandidates.length },
      });

      const rawCandidateCount = normalizedCandidates.length;
      let newUniqueCount = 0;

      for (const {
        observation,
        candidate,
        candidateIndex,
        canonicalDomain,
      } of normalizedCandidates) {
          await timing?.record({
            eventType: "CANDIDATE_ADMISSION_STARTED",
            requestIntentId: observation.requestIntentId,
            details: { canonicalDomain },
          });
          let authority = authorities.get(canonicalDomain);
          if (authority === undefined) {
            const existingAuthority = await repository.findCandidate({
              ...input,
              canonicalDomain,
            });
            if (existingAuthority === null) {
              const decision = decisionFor(
                input.projectDomain,
                observation.artifact.sourceType,
                candidate,
              );
              authority = await repository.recordCandidate({
                ...input,
                canonicalDomain,
                admissionState: decision.admissionState,
                ...(decision.hardExclusionCode === null
                  ? {}
                  : {
                      exclusionReasonCode: decision.hardExclusionCode,
                      exclusionEvidence: decision.exclusionEvidence,
                    }),
                decisionEvidence: decision.decisionEvidence,
                firstSeenRequestIntent: observation.requestIntentId,
                recommended: decision.recommended,
                recommendationReasonCodes:
                  decision.recommendationReasonCodes,
                firstSeenAt: observation.artifact.collectedAt,
                decidedAt: observation.artifact.collectedAt,
                createdBy: input.createdBy,
              });
              newUniqueCount += 1;
            } else {
              authority = existingAuthority;
            }
            authorities.set(canonicalDomain, authority);
          }
          await timing?.record({
            eventType: "CANDIDATE_ADMISSION_COMPLETED",
            requestIntentId: observation.requestIntentId,
            generationCandidateId: authority.id,
            details: {
              canonicalDomain,
              admissionState: authority.admissionState,
            },
          });

          const sourceUrl = discoveredUrl(candidate);
          const sourceRef = [
            observation.artifact.requestFingerprint,
            canonicalDomain,
            candidateIndex,
          ].join(":");
          await repository.appendSource({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            websiteProjectId: input.websiteProjectId,
            generationCandidateId: authority.id,
            requestIntent: observation.requestIntentId,
            providerOutcome: observation.providerOutcome,
            sourceType: observation.artifact.sourceType,
            discoveredUrl: sourceUrl.value,
            sourceRef,
            evidencePayload: {
              contractVersion: "recommendation-pool-v2-source-evidence.v1",
              requestFingerprint: observation.artifact.requestFingerprint,
              responseSchemaVersion:
                observation.artifact.responseSchemaVersion,
              providerTaskIds: observation.artifact.providerTaskIds,
              discoveredUrlObserved: sourceUrl.observed,
              discoveryUrls: candidate.discoveryUrls,
              backlinkPageEvidence: candidate.backlinkPageEvidence,
              evidenceRefs: candidate.evidenceRefs,
              ...(observation.artifact.sourceType !== "CURATED_RESOURCE_LIBRARY"
                || candidate.resourceLibrary === undefined ? {}
                : { resourceLibrary: candidate.resourceLibrary }),
            },
            observedAt: observation.artifact.collectedAt,
            createdBy: input.createdBy,
          });

          await timing?.record({
            eventType: "METRIC_ENRICHMENT_STARTED",
            requestIntentId: observation.requestIntentId,
            generationCandidateId: authority.id,
            details: { canonicalDomain },
          });
          const library = observation.artifact.sourceType === "CURATED_RESOURCE_LIBRARY";
          const metrics = library ? [
            { metricType: "AHREFS_DR" as const, value: candidate.resourceLibrary?.ahrefsDr ?? null },
            { metricType: "LIBRARY_MONTHLY_TRAFFIC" as const, value: candidate.resourceLibrary?.monthlyTraffic ?? null },
          ] : [
            {
              metricType: "TRAFFIC_ORGANIC_ETV" as const,
              value: candidate.traffic,
            },
            {
              metricType: "AUTHORITY_RANK" as const,
              value: candidate.rank,
            },
            {
              metricType: "SPAM_SCORE" as const,
              value: candidate.spamScore,
            },
          ];
          for (const metric of metrics) {
            await repository.appendMetric({
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              websiteProjectId: input.websiteProjectId,
              generationCandidateId: authority.id,
              metricType: metric.metricType,
              provider: library ? "resource_library" : "dataforseo",
              endpoint:
                observation.artifact.endpoint ??
                observation.artifact.sourceType,
              market: library ? "GLOBAL" : input.market,
              location: library ? "GLOBAL" : input.location,
              language: library ? (candidate.resourceLibrary?.language ?? input.language) : input.language,
              requestIntent: observation.requestIntentId,
              valueState:
                metric.value === null ? "UNAVAILABLE" : "AVAILABLE",
              metricValue: metric.value,
              requestRef: observation.requestIntentId,
              artifactRef: observation.artifact.requestFingerprint,
              observedAt: observation.artifact.collectedAt,
              createdBy: input.createdBy,
            });
          }
          await timing?.record({
            eventType: "METRIC_ENRICHMENT_COMPLETED",
            requestIntentId: observation.requestIntentId,
            generationCandidateId: authority.id,
            details: { canonicalDomain, metricCount: metrics.length },
          });
      }

      let materializedCount = 0;
      for (const authority of authorities.values()) {
        if (authority.admissionState !== "ADMITTED") continue;
        await repository.materializeCandidate({
          ...input,
          generationCandidateId: authority.id,
          createdBy: input.createdBy,
        });
        materializedCount += 1;
      }
      const admittedCount = [...authorities.values()].filter(
        ({ admissionState }) => admissionState === "ADMITTED",
      ).length;
      const duplicateCount = authorities.size - newUniqueCount;

      return Object.freeze({
        rawCandidateCount,
        canonicalCandidateCount: authorities.size,
        newUniqueCount,
        duplicateCount,
        admittedCount,
        hardExcludedCount: authorities.size - admittedCount,
        materializedCount,
      });
    },
  });
}
