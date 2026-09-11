import { describe, expect, it } from "vitest";

type AdmissionInput = Readonly<{
  canonicalDomain: string;
  projectDomain: string;
  relevance: "RELEVANT";
  metrics: Readonly<{
    targetMarketOrganicTraffic: number | null;
    dataForSeoRank: number | null;
    spamScore: number | null;
  }>;
  v1CommercialScore: number | null;
  contact: Readonly<{
    email: string | null;
    contactPage: string | null;
  }>;
  hardExclusionSignals: readonly string[];
}>;

type AdmissionDecision = Readonly<{
  admissionState: "ADMITTED" | "EXCLUDED";
  hardExclusionCode: string | null;
  contactPreparationState: "QUEUED" | "NOT_REQUIRED";
  admissionContractVersion: string;
}>;

type AdmissionModule = Readonly<{
  evaluateRecommendationPoolV2CandidateAdmission(
    input: AdmissionInput,
  ): AdmissionDecision | Promise<AdmissionDecision>;
}>;

const admissionModuleUrl = new URL(
  "../../src/modules/backlinks/domain/recommendations/recommendation-pool-v2-admission.js",
  import.meta.url,
).href;

async function loadAdmissionModule(): Promise<AdmissionModule> {
  try {
    return (await import(
      /* @vite-ignore */ admissionModuleUrl
    )) as AdmissionModule;
  } catch (error) {
    throw new Error(
      "Gate 1: the V2 candidate admission authority is not implemented.",
      { cause: error },
    );
  }
}

function candidate(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return Object.freeze({
    canonicalDomain: "publisher.example",
    projectDomain: "project.example",
    relevance: "RELEVANT",
    metrics: Object.freeze({
      targetMarketOrganicTraffic: null,
      dataForSeoRank: null,
      spamScore: null,
    }),
    v1CommercialScore: null,
    contact: Object.freeze({
      email: "editor@publisher.example",
      contactPage: "https://publisher.example/contact",
    }),
    hardExclusionSignals: Object.freeze([]),
    ...overrides,
  });
}

async function evaluate(input: AdmissionInput): Promise<AdmissionDecision> {
  const admission = await loadAdmissionModule();
  return admission.evaluateRecommendationPoolV2CandidateAdmission(input);
}

describe("recommendation pool V2 admission contract", () => {
  it.each(["amazon.com", "www.apple.com", "old.reddit.com", "amazon.co.uk",
    "android.com", "developer.android.com", "samsung.com", "aboutamazon.com"])(
    "excludes non-outreach target %s even with relevant evidence and contact details",
    async (canonicalDomain) => {
      await expect(evaluate(candidate({ canonicalDomain }))).resolves.toMatchObject({
        admissionState: "EXCLUDED",
        hardExclusionCode: "PERMANENTLY_EXCLUDED",
        contactPreparationState: "NOT_REQUIRED",
      });
    },
  );

  it("does not exclude a publisher merely because its authority or traffic is high", async () => {
    await expect(evaluate(candidate({
      metrics: { dataForSeoRank: 999, targetMarketOrganicTraffic: 100000000, spamScore: 0 },
    }))).resolves.toMatchObject({ admissionState: "ADMITTED", hardExclusionCode: null });
  });

  it("admits a relevant candidate when all SEO metrics are unknown", async () => {
    await expect(evaluate(candidate())).resolves.toMatchObject({
      admissionState: "ADMITTED",
      hardExclusionCode: null,
      admissionContractVersion: "recommendation-pool-admission.v2",
    });
  });

  it("does not use the historical V1 score threshold as an exclusion", async () => {
    await expect(
      evaluate(candidate({ v1CommercialScore: 30.47 })),
    ).resolves.toMatchObject({
      admissionState: "ADMITTED",
      hardExclusionCode: null,
    });
  });

  it("admits a relevant candidate without contact details and queues enrichment", async () => {
    await expect(
      evaluate(
        candidate({
          contact: Object.freeze({ email: null, contactPage: null }),
        }),
      ),
    ).resolves.toMatchObject({
      admissionState: "ADMITTED",
      hardExclusionCode: null,
      contactPreparationState: "QUEUED",
    });
  });

  it("rejects an exclusion signal outside the closed hard-exclusion set", async () => {
    await expect(
      evaluate(
        candidate({
          hardExclusionSignals: Object.freeze(["SCORE_BELOW_THRESHOLD"]),
        }),
      ),
    ).rejects.toThrow(/hard exclusion/i);
  });

  it("excludes only with an allowed project-domain ownership code", async () => {
    await expect(
      evaluate(
        candidate({
          hardExclusionSignals: Object.freeze(["ALREADY_RELEASED_TO_PROJECT"]),
        }),
      ),
    ).resolves.toMatchObject({
      admissionState: "EXCLUDED",
      hardExclusionCode: "ALREADY_RELEASED_TO_PROJECT",
    });
  });
});
