import { describe, expect, expectTypeOf, it } from "vitest";

import {
  assertGenerationInputPinsMatch,
  createPinnedSharedSeoEvidenceArtifactReadAdapter,
  createPinnedSharedSeoEvidenceSource,
  createSharedSeoEvidenceReadAdapter,
  isReusableSharedSeoEvidence,
  type GenerationInputBinding,
  type GenerationInputPins,
  type ProjectOutreachProfile,
  type SharedSeoEvidencePort,
  type SharedSeoEvidenceRequest,
  type SharedSeoEvidenceArtifactResolverPort,
  type SharedSeoEvidenceSourcePort,
  type SharedSeoEvidenceSnapshot,
} from "../../../src/modules/backlinks/ports/shared-seo-evidence.port.js";

const snapshot: SharedSeoEvidenceSnapshot = {
  organizationId: "org-1",
  websiteProjectId: "project-1",
  evidenceType: "keyword-serp",
  sourceModule: "keywords",
  sourceRecordId: "keyword-run-1",
  sourceVersion: "keyword-run-v1",
  provider: "dataforseo",
  endpoint: "serp/google/organic/live/advanced",
  normalizedParameters: {
    keyword: "seo platform",
    locationCode: 2840,
    languageCode: "en",
  },
  requestFingerprint: "sha256:request-1",
  market: "US",
  location: "United States",
  language: "en",
  fetchedAt: "2026-08-15T01:00:00.000Z",
  expiresAt: "2026-08-16T01:00:00.000Z",
  providerRequestId: "provider-request-1",
  providerTaskId: "provider-task-1",
  costMicros: 2000,
  artifactRef: "artifact://keyword-run-1",
  status: "ready",
};

const request: SharedSeoEvidenceRequest = {
  organizationId: "org-1",
  websiteProjectId: "project-1",
  evidenceType: "keyword-serp",
  sourceModule: "keywords",
  provider: "dataforseo",
  endpoint: "serp/google/organic/live/advanced",
  requestFingerprint: "sha256:request-1",
  market: "US",
  location: "United States",
  language: "en",
  now: "2026-08-15T02:00:00.000Z",
};

const pins: GenerationInputPins = {
  organizationId: "org-1",
  websiteProjectId: "project-1",
  projectContextVersion: 4,
  siteProfileVersionId: "site-profile-v4",
  outreachProfileVersionId: "outreach-profile-v2",
  promotionTargetVersionId: "promotion-target-v2",
  keywordEvidenceSnapshotIds: ["keyword-snapshot-1"],
  sharedEvidenceSnapshotIds: ["performance-snapshot-1"],
  market: "US",
  qualificationContractVersion: "qualification-v1",
};

const binding: GenerationInputBinding = {
  inputPinId: "pin-1",
  outreachProfileRecordId: "outreach-record-1",
  immutableFingerprint: "pin-fingerprint-1",
  pins: {
    ...pins,
    sharedEvidenceSnapshotIds: ["evidence-record-1"],
  },
  outreachProfile: {
    organizationId: "org-1",
    websiteProjectId: "project-1",
    profileVersionId: "outreach-profile-v2",
    promotionTargetVersionId: "promotion-target-v2",
    keywordsAndTopics: ["seo platform"],
    productsAndServices: ["seo audit"],
    targetUrls: ["https://example.test/audit"],
    targetAudiences: ["site owners"],
    partnershipGoals: ["editorial mention"],
    market: "US",
    location: "United States",
    language: "en",
    authorizedDiscoverySources: ["shared-seo-evidence"],
    immutableFingerprint: "outreach-fingerprint-1",
  },
  sharedEvidence: [{ recordId: "evidence-record-1", snapshot }],
};

describe("shared SEO evidence contracts", () => {
  it("keeps outreach intent immutable and separate from discovered SiteProfile facts", () => {
    expectTypeOf<ProjectOutreachProfile>().toMatchTypeOf<{
      readonly websiteProjectId: string;
      readonly profileVersionId: string;
      readonly promotionTargetVersionId: string;
      readonly immutableFingerprint: string;
    }>();
  });

  it("exposes a read-only evidence port", async () => {
    const sourceCalls: unknown[] = [];
    const source: SharedSeoEvidenceSourcePort = {
      listProjectEvidence: async (input) => {
        sourceCalls.push(input);
        return [
          {
            ...snapshot,
            sourceRecordId: "wrong-project",
            websiteProjectId: "project-2",
          },
          snapshot,
          {
            ...snapshot,
            sourceRecordId: "newest",
            fetchedAt: "2026-08-15T01:30:00.000Z",
          },
        ];
      },
    };
    const port: SharedSeoEvidencePort =
      createSharedSeoEvidenceReadAdapter(source);

    await expect(port.readReusable(request)).resolves.toMatchObject({
      sourceRecordId: "newest",
      websiteProjectId: "project-1",
    });
    expect(sourceCalls).toEqual([
      {
        organizationId: "org-1",
        websiteProjectId: "project-1",
        evidenceType: "keyword-serp",
        sourceModule: "keywords",
      },
    ]);
    expect(Object.keys(port)).toEqual(["readReusable"]);
  });

  it.each([
    ["project", { websiteProjectId: "project-2" }],
    ["endpoint", { endpoint: "labs/google/ranked_keywords/live" }],
    ["parameters", { requestFingerprint: "sha256:request-2" }],
    ["market", { market: "GB" }],
    ["language", { language: "de" }],
    ["source module", { sourceModule: "content" }],
    ["freshness", { now: "2026-08-17T01:00:00.000Z" }],
  ])("rejects evidence with a different %s", (_name, changes) => {
    expect(
      isReusableSharedSeoEvidence(snapshot, { ...request, ...changes }),
    ).toBe(false);
  });

  it("rejects SiteProfile and keyword evidence substitutions", () => {
    expect(() =>
      assertGenerationInputPinsMatch(pins, {
        ...pins,
        siteProfileVersionId: "site-profile-v5",
      }),
    ).toThrow("bound to different project facts");
    expect(() =>
      assertGenerationInputPinsMatch(pins, {
        ...pins,
        keywordEvidenceSnapshotIds: ["keyword-snapshot-2"],
      }),
    ).toThrow("bound to different project facts");
  });

  it("accepts an exact replay of the generation pins", () => {
    expect(() =>
      assertGenerationInputPinsMatch(pins, { ...pins }),
    ).not.toThrow();
  });

  it("exposes only evidence referenced by the immutable input pin", async () => {
    const source = createPinnedSharedSeoEvidenceSource(binding);

    await expect(
      source.listProjectEvidence({
        organizationId: "org-1",
        websiteProjectId: "project-1",
        evidenceType: "keyword-serp",
        sourceModule: "keywords",
      }),
    ).resolves.toEqual([snapshot]);
    await expect(
      source.listProjectEvidence({
        organizationId: "org-1",
        websiteProjectId: "project-2",
        evidenceType: "keyword-serp",
        sourceModule: "keywords",
      }),
    ).resolves.toEqual([]);
    await expect(
      source.listProjectEvidence({
        organizationId: "org-1",
        websiteProjectId: "project-1",
        evidenceType: "content-brief",
        sourceModule: "content",
      }),
    ).resolves.toEqual([]);
  });

  it("resolves an exact reusable artifact through its source module", async () => {
    const calls: SharedSeoEvidenceSnapshot[] = [];
    const resolver: SharedSeoEvidenceArtifactResolverPort = {
      resolveArtifact: async (input) => {
        calls.push(input);
        return {
          snapshot: input,
          payload: { candidates: [{ domain: "example.test" }] },
        };
      },
    };
    const port = createPinnedSharedSeoEvidenceArtifactReadAdapter(binding, {
      keywords: resolver,
    });

    await expect(port.readReusable(request)).resolves.toEqual({
      snapshot,
      payload: { candidates: [{ domain: "example.test" }] },
    });
    expect(calls).toEqual([snapshot]);
  });

  it("does not resolve when the source module has no bound resolver", async () => {
    const port = createPinnedSharedSeoEvidenceArtifactReadAdapter(binding, {});

    await expect(port.readReusable(request)).resolves.toBeNull();
  });

  it("does not call a resolver for stale or scope-mismatched evidence", async () => {
    let calls = 0;
    const port = createPinnedSharedSeoEvidenceArtifactReadAdapter(binding, {
      keywords: {
        resolveArtifact: async (input) => {
          calls += 1;
          return { snapshot: input, payload: {} };
        },
      },
    });

    await expect(
      port.readReusable({
        ...request,
        now: "2026-08-17T01:00:00.000Z",
      }),
    ).resolves.toBeNull();
    await expect(
      port.readReusable({
        ...request,
        websiteProjectId: "project-2",
      }),
    ).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it("rejects a resolver result for a different snapshot", async () => {
    const port = createPinnedSharedSeoEvidenceArtifactReadAdapter(binding, {
      keywords: {
        resolveArtifact: async (input) => ({
          snapshot: { ...input, sourceRecordId: "substituted-record" },
          payload: {},
        }),
      },
    });

    await expect(port.readReusable(request)).rejects.toThrow(
      "does not match the pinned snapshot",
    );
  });

  it("rejects a non-object resolver payload", async () => {
    const port = createPinnedSharedSeoEvidenceArtifactReadAdapter(binding, {
      keywords: {
        resolveArtifact: async (input) => ({
          snapshot: input,
          payload: [] as unknown as Readonly<Record<string, unknown>>,
        }),
      },
    });

    await expect(port.readReusable(request)).rejects.toThrow(
      "payload must be an object",
    );
  });

  it("rejects shared evidence that is not exactly bound by the input pin", () => {
    expect(() =>
      createPinnedSharedSeoEvidenceSource({
        ...binding,
        sharedEvidence: [
          { recordId: "not-the-pinned-record", snapshot },
        ],
      }),
    ).toThrow("does not match the immutable generation input pin");
  });
});
