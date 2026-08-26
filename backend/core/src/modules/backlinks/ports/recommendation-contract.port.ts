export const CORRECTED_QUALIFICATION_CONTRACT_VERSION =
  "recommendation-qualification.v1" as const;
export const CORRECTED_VISIBILITY_CONTRACT_VERSION =
  "recommendation-visibility.v1" as const;
export const CORRECTED_SCORE_MODEL_VERSION =
  "recommendation-commercial-fit.v4" as const;

export type RecommendationContractJson = Readonly<Record<string, unknown>>;

export type RecommendationContractScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  recommendationContextVersionId: string;
}>;

export type CreateCorrectedGenerationInput = RecommendationContractScope &
  Readonly<{
    generationContractId: string;
    inputPinId: string;
    visiblePoolGeneration: number;
    metricScope: "TARGET_MARKET" | "GLOBAL";
    market: string;
    location: string;
    language: string;
    trafficLocationCode: number | null;
    trafficLanguageCode: string | null;
    requestFingerprints: RecommendationContractJson;
    workerContractVersion: string;
    operation: Readonly<{
      factId: string;
      operationId: string;
      state: "requested" | "running" | "succeeded" | "failed" | "frozen";
      attempt: number;
      reasonCode: string;
      evidence: RecommendationContractJson;
      observedAt: Date;
    }>;
    createdBy: string;
  }>;

export type AssertCorrectedGenerationAvailableInput =
  RecommendationContractScope &
  Readonly<{
    generationContractId: string;
    visiblePoolGeneration: number;
    workerContractVersion: string;
  }>;

export type WriteCorrectedRecommendationInput =
  RecommendationContractScope &
  Readonly<{
    generationContractId: string;
    visiblePoolGeneration: number;
    workerContractVersion: string;
    prospectId: string;
    recommendationId: string;
    scoreId: string;
    inventoryId: string;
    canonicalDomain: string;
    normalizationVersion: string;
    totalScore: number;
    scoreComponents: readonly RecommendationContractJson[];
    scoreWeights: RecommendationContractJson;
    scoreEvidence: RecommendationContractJson;
    qualification: Readonly<{
      factId: string;
      metricScope: "TARGET_MARKET" | "GLOBAL";
      trafficOrganicEtv: number | null;
      spamScore: number | null;
      authorityRank: number | null;
      accessibilityDecision:
        | "accessible"
        | "inaccessible"
        | "insufficient_data";
      semanticScore: number | null;
      attempt: number;
      decision:
        | "eligible"
        | "ineligible"
        | "insufficient_data"
        | "manual_review";
      decisionReasonCode: string;
      modelVersion: string | null;
      promptVersion: string | null;
      ruleVersion: string;
      requestFingerprints: RecommendationContractJson;
      evidence: RecommendationContractJson;
    }>;
    visibility: Readonly<{
      factId: string;
      decision: "hidden" | "visible";
      decisionReasonCode: string;
      attempt: number;
      ruleVersion: string;
      evidence: RecommendationContractJson;
    }>;
    contact: Readonly<{
      factId: string;
      decision: "pending" | "eligible" | "ineligible" | "manual_review";
      decisionReasonCode: string;
      attempt: number;
      evidence: RecommendationContractJson;
    }>;
    cooperationPath: Readonly<{
      factId: string;
      decision: "pending" | "verified" | "unavailable" | "manual_review";
      decisionReasonCode: string;
      pathType: string | null;
      attempt: number;
      evidence: RecommendationContractJson;
    }>;
    observedAt: Date;
    createdBy: string;
  }>;

export type WriteQualificationFactInput =
  RecommendationContractScope &
  Readonly<{
    generationContractId: string;
    workerContractVersion: string;
    candidateId: string;
    canonicalDomain: string;
    qualification: WriteCorrectedRecommendationInput["qualification"];
    observedAt: Date;
    createdBy: string;
  }>;

export type ReadRecommendationContractInput = RecommendationContractScope &
  Readonly<{ recommendationId: string }>;

export type CorrectedRecommendationContractRecord = Readonly<{
  contractKind: "corrected-v1";
  recommendationId: string;
  prospectId: string;
  canonicalDomain: string;
  visiblePoolGeneration: number;
  totalScore: number;
  qualificationDecision: string;
  qualificationReasonCode: string;
  visibilityDecision: string | null;
  contactDecision: string | null;
  cooperationPathDecision: string | null;
}>;

export type LegacyRecommendationContractRecord = Readonly<{
  contractKind: "legacy-v3";
  recommendationId: string;
  prospectId: string;
  canonicalDomain: string;
  visiblePoolGeneration: number;
  totalScore: number;
  publicationStatus: string;
  fitDecision: string;
  contactDecision: string;
}>;

export type RecommendationContractRecord =
  | CorrectedRecommendationContractRecord
  | LegacyRecommendationContractRecord;

export interface RecommendationContractPort {
  assertCorrectedGenerationAvailable(
    input: AssertCorrectedGenerationAvailableInput,
  ): Promise<void>;
  createCorrectedGeneration(input: CreateCorrectedGenerationInput): Promise<void>;
  writeCorrectedRecommendation(
    input: WriteCorrectedRecommendationInput,
  ): Promise<void>;
  writeQualificationFact(
    input: WriteQualificationFactInput,
  ): Promise<void>;
  readRecommendation(
    input: ReadRecommendationContractInput,
  ): Promise<RecommendationContractRecord | null>;
}

export class RecommendationContractVersionMismatchError extends Error {
  constructor(actualVersion: string) {
    super(
      `Worker contract ${actualVersion} does not match `
      + `${CORRECTED_QUALIFICATION_CONTRACT_VERSION}.`,
    );
    this.name = "RecommendationContractVersionMismatchError";
  }
}
