import { describe, expect, it } from "vitest";
import {
  createDraft,
  createDraftEvidence,
  draftEvidenceSourceKinds,
  draftEvidenceStatuses,
  draftEvidenceVisibilities,
  draftStatuses,
  draftStatusTransitions,
  InvalidDraftError,
  InvalidDraftEvidenceError,
  InvalidDraftTransitionError,
  transitionDraft,
} from "../../src/modules/backlinks/domain/drafts/draft.js";

const draft = createDraft({
  id: "draft-1",
  opportunityId: "opportunity-1",
  status: "generating",
  version: 1,
  currentVersionId: null,
  approvedVersionId: null,
  lastSuccessfulVersionId: null,
});

const evidence = {
  id: "profile:1",
  status: "ACTIVE",
  visibility: "VISIBLE",
  confidence: 0.9,
  sourceKind: "PROFILE",
  value: "GrowthOS publishes technical SEO research.",
  observedAt: "2026-07-27T08:00:00.000Z",
  dataVersion: "profile.v1",
  contentHash: "a".repeat(64),
} as const;

describe("BL-AI-087 Draft state machine", () => {
  it("defines the complete provider-neutral Draft and Evidence vocabulary", () => {
    expect(draftStatuses).toEqual([
      "generating",
      "draft",
      "approved",
      "rejected",
      "sent",
    ]);
    expect(draftEvidenceStatuses).toEqual([
      "ACTIVE",
      "STALE",
      "CONTRADICTED",
    ]);
    expect(draftEvidenceVisibilities).toEqual(["VISIBLE", "HIDDEN"]);
    expect(draftEvidenceSourceKinds).toEqual([
      "PROFILE",
      "PROMOTION_TARGET",
      "OPPORTUNITY",
      "CONTACT",
      "ASSESSMENT",
      "USER_INPUT",
      "AI_SUMMARY",
      "AI_INFERENCE",
    ]);
  });

  it("accepts every declared transition and preserves immutable history pointers", () => {
    for (const from of draftStatuses) {
      for (const to of draftStatusTransitions[from]) {
        const current = createDraft({ ...draft, status: from, version: 7 });
        const next = transitionDraft(current, to);

        expect(next).toEqual({ ...current, status: to, version: 8 });
        expect(next).not.toBe(current);
        expect(Object.isFrozen(next)).toBe(true);
      }
    }
  });

  it("rejects every undeclared transition with a stable error", () => {
    for (const from of draftStatuses) {
      const allowed = draftStatusTransitions[from];
      for (const to of draftStatuses) {
        if (allowed.includes(to)) continue;

        expect(() => transitionDraft({ ...draft, status: from }, to))
          .toThrowError(InvalidDraftTransitionError);
        try {
          transitionDraft({ ...draft, status: from }, to);
        } catch (error) {
          expect(error).toMatchObject({
            code: "INVALID_DRAFT_TRANSITION",
            from,
            to,
          });
        }
      }
    }
  });

  it("rejects malformed Draft identity, status, and version", () => {
    for (const invalid of [
      { ...draft, id: "" },
      { ...draft, opportunityId: " " },
      { ...draft, status: "queued" },
      { ...draft, version: 0 },
      { ...draft, version: 1.5 },
    ]) {
      expect(() => createDraft(invalid as never))
        .toThrowError(InvalidDraftError);
    }
  });

  it("creates an immutable Evidence domain object", () => {
    const result = createDraftEvidence(evidence);
    expect(result).toEqual(evidence);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["blank ID", { id: "" }],
    ["invalid status", { status: "DELETED" }],
    ["invalid visibility", { visibility: "PRIVATE" }],
    ["invalid source", { sourceKind: "PROVIDER_RESPONSE" }],
    ["negative confidence", { confidence: -0.1 }],
    ["excess confidence", { confidence: 1.1 }],
    ["non-finite confidence", { confidence: Number.NaN }],
    ["blank value", { value: " " }],
    ["invalid observed time", { observedAt: "not-a-date" }],
    ["blank data version", { dataVersion: "" }],
    ["invalid content hash", { contentHash: "not-sha256" }],
  ])("rejects Evidence with %s", (_name, overrides) => {
    expect(() => createDraftEvidence({ ...evidence, ...overrides } as never))
      .toThrowError(InvalidDraftEvidenceError);
  });
});
