import { createHash } from "node:crypto";

export type RecommendationSeedKind = "KEYWORD" | "CATEGORY" | "SEO_COMPETITOR";
export type RecommendationSeedSource =
  | "USER_INPUT"
  | "USER_TRIGGERED_GENERATION"
  | "SYSTEM_FALLBACK"
  | "SYSTEM_SUPPLEMENT";
export type RecommendationSeedValidationStatus =
  "PENDING" | "VERIFIED" | "RETAINED_LOW_CONFIDENCE" | "REJECTED";
export type RecommendationSeedConfidenceBand =
  "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export type RecommendationSeedEvidenceRef = Readonly<{
  evidenceType:
    | "USER_INPUT"
    | "PROJECT_CONTEXT"
    | "SITE_PROFILE"
    | "OUTREACH_PROFILE"
    | "PROVIDER_VALIDATION"
    | "FAKE_AI_CANDIDATE";
  recordId: string;
  field: string;
  fingerprint?: string;
}>;

export type RecommendationSeedSnapshot = Readonly<{
  projectContextSnapshotId: string;
  projectContextSnapshotVersion: number;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  siteProfileVersionId: string;
  outreachProfileVersionId: string;
  outreachProfileFingerprint: string;
  promotionTargetVersionId: string;
  market: string;
  location: string;
  language: string;
  keywords: readonly string[];
  categories: readonly string[];
  products: readonly string[];
  targetAudiences: readonly string[];
  seoCompetitors: readonly string[];
}>;

export type RecommendationUserSeedInput = Readonly<{
  kind: RecommendationSeedKind;
  value: string;
  supersedesSeedId?: string | undefined;
}>;

export type RecommendationSystemSeedCandidate = Readonly<{
  kind: RecommendationSeedKind;
  value: string;
  source: "SYSTEM_FALLBACK" | "SYSTEM_SUPPLEMENT";
  evidenceRefs: readonly RecommendationSeedEvidenceRef[];
  confidenceBand: RecommendationSeedConfidenceBand;
  supersedesSeedId?: string | undefined;
}>;

export type PreparedRecommendationSeed = Readonly<{
  kind: RecommendationSeedKind;
  rawValue: string;
  normalizedValue: string;
  source: RecommendationSeedSource;
  validationStatus: RecommendationSeedValidationStatus;
  validationReasonCodes: readonly string[];
  evidenceRefs: readonly RecommendationSeedEvidenceRef[];
  confidenceBand: RecommendationSeedConfidenceBand;
  seedFingerprint: string;
  supersedesSeedId: string | null;
}>;

export type RecommendationSeedBlueprintReference = Readonly<{
  seedFingerprint: string;
  seedOrdinal: number;
}>;

export type RecommendationSeedPreparationV2Result = Readonly<{
  state: "READY" | "INPUT_REQUIRED";
  seeds: readonly PreparedRecommendationSeed[];
  blueprintSeedReferences: readonly RecommendationSeedBlueprintReference[];
  reasonCodes: readonly string[];
}>;

export type RecommendationSeedProjectFacts = Readonly<{
  canonicalDomain: string | null;
  keywords: readonly string[];
  products: readonly string[];
  targetAudiences: readonly string[];
}>;

export type LegacyRecommendationSeedInput = Readonly<{
  kind: "KEYWORD" | "COMPETITOR_DOMAIN" | "CATEGORY";
  value: string;
  source: "USER" | "PROJECT_FACT" | "SYSTEM_FALLBACK";
}>;

export type RecommendationSeedEvidence = Readonly<{
  kind: LegacyRecommendationSeedInput["kind"];
  value: string;
  source: LegacyRecommendationSeedInput["source"];
  evidence:
    "USER_INPUT" | "PROJECT_KEYWORD" | "PROJECT_PRODUCT" | "PROJECT_AUDIENCE";
}>;

export type RecommendationSeedPreparationResult = Readonly<{
  state: "READY" | "INPUT_REQUIRED";
  seeds: readonly RecommendationSeedEvidence[];
  reasonCodes: readonly string[];
}>;

type V2PreparationInput = Readonly<{
  generationContractId: string;
  snapshot: RecommendationSeedSnapshot;
  userSeeds: readonly RecommendationUserSeedInput[];
  systemCandidates: readonly RecommendationSystemSeedCandidate[];
  maximumSeeds?: number;
}>;

type LegacyPreparationInput = Readonly<{
  userSeeds: readonly LegacyRecommendationSeedInput[];
  project: RecommendationSeedProjectFacts;
  maximumSeeds?: number;
}>;

type MutablePreparedSeed = {
  kind: RecommendationSeedKind;
  rawValue: string;
  normalizedValue: string;
  source: RecommendationSeedSource;
  validationStatus: RecommendationSeedValidationStatus;
  validationReasonCodes: string[];
  evidenceRefs: RecommendationSeedEvidenceRef[];
  confidenceBand: RecommendationSeedConfidenceBand;
  seedFingerprint: string;
  supersedesSeedId: string | null;
};

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
        ? trimmed
        : `https://${trimmed}`,
    );
    const hostname = url.hostname.replace(/^www\./u, "");
    return hostname.includes(".") ? hostname : null;
  } catch {
    return null;
  }
}

function normalizedValue(kind: RecommendationSeedKind, value: string) {
  return kind === "SEO_COMPETITOR"
    ? normalizeDomain(value)
    : normalizeText(value).toLowerCase();
}

function evidenceKey(evidence: RecommendationSeedEvidenceRef): string {
  return [
    evidence.evidenceType,
    evidence.recordId,
    evidence.field,
    evidence.fingerprint ?? "",
  ].join(":");
}

function mergeEvidence(
  target: RecommendationSeedEvidenceRef[],
  incoming: readonly RecommendationSeedEvidenceRef[],
): void {
  const keys = new Set(target.map(evidenceKey));
  for (const evidence of incoming) {
    const key = evidenceKey(evidence);
    if (keys.has(key)) continue;
    keys.add(key);
    target.push(Object.freeze({ ...evidence }));
  }
}

function seedFingerprint(
  generationContractId: string,
  kind: RecommendationSeedKind,
  canonicalValue: string,
): string {
  return digest({
    contract: "recommendation-seed.v2",
    generationContractId,
    kind,
    canonicalValue,
  });
}

function prepareV2(
  input: V2PreparationInput,
): RecommendationSeedPreparationV2Result {
  const maximumSeeds = input.maximumSeeds ?? 50;
  if (!Number.isSafeInteger(maximumSeeds) || maximumSeeds < 1) {
    throw new TypeError("Recommendation seed maximum is invalid");
  }

  const output: MutablePreparedSeed[] = [];
  const byCanonicalValue = new Map<string, MutablePreparedSeed>();
  const add = (candidate: Omit<MutablePreparedSeed, "seedFingerprint">) => {
    const canonicalValue = normalizedValue(candidate.kind, candidate.rawValue);
    if (canonicalValue === null || canonicalValue.length < 2) {
      if (candidate.source !== "USER_INPUT") return;
      const rejectedValue = normalizeText(candidate.rawValue).toLowerCase();
      if (rejectedValue.length === 0) return;
      const rejected: MutablePreparedSeed = {
        ...candidate,
        normalizedValue: rejectedValue,
        validationStatus: "REJECTED",
        validationReasonCodes: ["INVALID_SEED_VALUE"],
        confidenceBand: "UNKNOWN",
        seedFingerprint: seedFingerprint(
          input.generationContractId,
          candidate.kind,
          rejectedValue,
        ),
      };
      output.push(rejected);
      return;
    }
    const key = `${candidate.kind}:${canonicalValue}`;
    const existing = byCanonicalValue.get(key);
    if (existing !== undefined) {
      mergeEvidence(existing.evidenceRefs, candidate.evidenceRefs);
      return;
    }
    if (output.length >= maximumSeeds) return;
    const prepared: MutablePreparedSeed = {
      ...candidate,
      normalizedValue: canonicalValue,
      seedFingerprint: seedFingerprint(
        input.generationContractId,
        candidate.kind,
        canonicalValue,
      ),
    };
    byCanonicalValue.set(key, prepared);
    output.push(prepared);
  };

  for (const seed of input.userSeeds) {
    add({
      kind: seed.kind,
      rawValue: normalizeText(seed.value),
      normalizedValue: "",
      source: "USER_INPUT",
      validationStatus: "VERIFIED",
      validationReasonCodes: [],
      evidenceRefs: [
        {
          evidenceType: "USER_INPUT",
          recordId: input.snapshot.projectContextSnapshotId,
          field:
            seed.kind === "KEYWORD"
              ? "keywords"
              : seed.kind === "CATEGORY"
                ? "categories"
                : "seoCompetitors",
        },
      ],
      confidenceBand: "HIGH",
      supersedesSeedId: seed.supersedesSeedId ?? null,
    });
  }

  const snapshotFacts = [
    ...input.snapshot.keywords.map((value) => ({
      kind: "KEYWORD" as const,
      value,
      field: "keywords",
      recordId: input.snapshot.outreachProfileVersionId,
    })),
    ...input.snapshot.categories.map((value) => ({
      kind: "CATEGORY" as const,
      value,
      field: "partnershipGoals",
      recordId: input.snapshot.outreachProfileVersionId,
    })),
    ...input.snapshot.seoCompetitors.map((value) => ({
      kind: "SEO_COMPETITOR" as const,
      value,
      field: "seoCompetitors",
      recordId: input.snapshot.projectContextSnapshotId,
    })),
  ];
  for (const fact of snapshotFacts) {
    add({
      kind: fact.kind,
      rawValue: normalizeText(fact.value),
      normalizedValue: "",
      source: "USER_TRIGGERED_GENERATION",
      validationStatus: "VERIFIED",
      validationReasonCodes: [],
      evidenceRefs: [
        {
          evidenceType: "OUTREACH_PROFILE",
          recordId: fact.recordId,
          field: fact.field,
          fingerprint: input.snapshot.outreachProfileFingerprint,
        },
      ],
      confidenceBand: "HIGH",
      supersedesSeedId: null,
    });
  }

  for (const product of input.snapshot.products) {
    add({
      kind: "KEYWORD",
      rawValue: normalizeText(product),
      normalizedValue: "",
      source: "SYSTEM_FALLBACK",
      validationStatus: "VERIFIED",
      validationReasonCodes: ["PROJECT_PRODUCT_FALLBACK"],
      evidenceRefs: [
        {
          evidenceType: "PROJECT_CONTEXT",
          recordId: input.snapshot.projectContextSnapshotId,
          field: "products",
        },
      ],
      confidenceBand: "MEDIUM",
      supersedesSeedId: null,
    });
  }
  for (const audience of input.snapshot.targetAudiences) {
    add({
      kind: "CATEGORY",
      rawValue: normalizeText(audience),
      normalizedValue: "",
      source: "SYSTEM_FALLBACK",
      validationStatus: "RETAINED_LOW_CONFIDENCE",
      validationReasonCodes: ["PROJECT_AUDIENCE_FALLBACK"],
      evidenceRefs: [
        {
          evidenceType: "PROJECT_CONTEXT",
          recordId: input.snapshot.projectContextSnapshotId,
          field: "targetAudiences",
        },
      ],
      confidenceBand: "LOW",
      supersedesSeedId: null,
    });
  }

  for (const candidate of input.systemCandidates) {
    const hasValidationEvidence = candidate.evidenceRefs.some(
      (evidence) => evidence.evidenceType !== "FAKE_AI_CANDIDATE",
    );
    add({
      kind: candidate.kind,
      rawValue: normalizeText(candidate.value),
      normalizedValue: "",
      source: candidate.source,
      validationStatus: hasValidationEvidence ? "VERIFIED" : "PENDING",
      validationReasonCodes: hasValidationEvidence
        ? []
        : ["SYSTEM_CANDIDATE_REQUIRES_VALIDATION"],
      evidenceRefs: [...candidate.evidenceRefs],
      confidenceBand: hasValidationEvidence
        ? candidate.confidenceBand
        : "UNKNOWN",
      supersedesSeedId: candidate.supersedesSeedId ?? null,
    });
  }

  const seeds = Object.freeze(
    output.map((seed) =>
      Object.freeze({
        ...seed,
        validationReasonCodes: Object.freeze([...seed.validationReasonCodes]),
        evidenceRefs: Object.freeze([...seed.evidenceRefs]),
      }),
    ),
  );
  const eligible = seeds.filter(
    (seed) =>
      seed.validationStatus === "VERIFIED" ||
      seed.validationStatus === "RETAINED_LOW_CONFIDENCE",
  );
  return Object.freeze({
    state: eligible.length === 0 ? "INPUT_REQUIRED" : "READY",
    seeds,
    blueprintSeedReferences: Object.freeze(
      eligible.map((seed, index) =>
        Object.freeze({
          seedFingerprint: seed.seedFingerprint,
          seedOrdinal: index + 1,
        }),
      ),
    ),
    reasonCodes: Object.freeze(
      eligible.length === 0 ? ["DISCOVERY_SEEDS_REQUIRED"] : [],
    ),
  });
}

function prepareLegacy(
  input: LegacyPreparationInput,
): RecommendationSeedPreparationResult {
  const maximumSeeds = input.maximumSeeds ?? 50;
  if (!Number.isSafeInteger(maximumSeeds) || maximumSeeds < 1) {
    throw new TypeError("Recommendation seed maximum is invalid");
  }
  const output: RecommendationSeedEvidence[] = [];
  const seen = new Set<string>();
  const append = (seed: RecommendationSeedEvidence) => {
    const value =
      seed.kind === "COMPETITOR_DOMAIN"
        ? normalizeDomain(seed.value)
        : normalizeText(seed.value);
    if (value === null || value.length === 0) return;
    const key = `${seed.kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push(Object.freeze({ ...seed, value }));
  };
  for (const seed of input.userSeeds) {
    append({ ...seed, source: "USER", evidence: "USER_INPUT" });
  }
  for (const keyword of input.project.keywords) {
    append({
      kind: "KEYWORD",
      value: keyword,
      source: "PROJECT_FACT",
      evidence: "PROJECT_KEYWORD",
    });
  }
  for (const product of input.project.products) {
    append({
      kind: "KEYWORD",
      value: product,
      source: "PROJECT_FACT",
      evidence: "PROJECT_PRODUCT",
    });
  }
  for (const audience of input.project.targetAudiences) {
    append({
      kind: "CATEGORY",
      value: audience,
      source: "SYSTEM_FALLBACK",
      evidence: "PROJECT_AUDIENCE",
    });
  }
  const seeds = Object.freeze(output.slice(0, maximumSeeds));
  return Object.freeze({
    state: seeds.length === 0 ? "INPUT_REQUIRED" : "READY",
    seeds,
    reasonCodes: Object.freeze(
      seeds.length === 0 ? ["DISCOVERY_SEEDS_REQUIRED"] : [],
    ),
  });
}

export function prepareRecommendationSeeds(
  input: V2PreparationInput,
): RecommendationSeedPreparationV2Result;
export function prepareRecommendationSeeds(
  input: LegacyPreparationInput,
): RecommendationSeedPreparationResult;
export function prepareRecommendationSeeds(
  input: V2PreparationInput | LegacyPreparationInput,
): RecommendationSeedPreparationV2Result | RecommendationSeedPreparationResult {
  return "snapshot" in input ? prepareV2(input) : prepareLegacy(input);
}

export function validateRecommendationSeeds(
  seeds: readonly LegacyRecommendationSeedInput[],
): readonly Readonly<{
  seed: LegacyRecommendationSeedInput;
  valid: boolean;
  reason: string | null;
}>[] {
  return Object.freeze(
    seeds.map((seed) => {
      const normalized =
        seed.kind === "COMPETITOR_DOMAIN"
          ? normalizeDomain(seed.value)
          : normalizeText(seed.value);
      const valid = normalized !== null && normalized.length >= 2;
      return Object.freeze({
        seed: Object.freeze({
          ...seed,
          value: normalized ?? normalizeText(seed.value),
        }),
        valid,
        reason: valid ? null : "INVALID_SEED_VALUE",
      });
    }),
  );
}
