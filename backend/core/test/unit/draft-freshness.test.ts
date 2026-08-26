import { describe, expect, it } from "vitest";

import {
  deriveDraftFreshness,
} from "../../src/modules/backlinks/application/read-models/draft-freshness.js";

const current = {
  snapshotProfileVersionId: "profile-v2",
  currentProfileVersionId: "profile-v2",
  snapshotPromotionTargetVersionId: "target-v3",
  currentPromotionTargetVersionId: "target-v3",
  snapshotOpportunityVersion: 4,
  currentOpportunityVersion: 4,
  snapshotContactId: "contact-1",
  snapshotContactVersion: 2,
  currentContactId: "contact-1",
  currentContactVersion: 2,
  currentContactUsable: true,
} as const;

describe("Draft freshness", () => {
  it("is fresh only while all immutable bindings still match", () => {
    expect(deriveDraftFreshness(current)).toEqual({
      state: "FRESH",
      staleReasons: [],
      unknownReason: null,
      regenerateRequired: false,
      manualEditsPreserved: true,
    });
  });

  it("reports every changed binding and requires regeneration", () => {
    expect(deriveDraftFreshness({
      ...current,
      currentProfileVersionId: "profile-v3",
      currentOpportunityVersion: 5,
      currentContactVersion: 3,
    })).toEqual({
      state: "STALE",
      staleReasons: [
        "PROJECT_CONTEXT_CHANGED",
        "OPPORTUNITY_CHANGED",
        "CONTACT_CHANGED",
      ],
      unknownReason: null,
      regenerateRequired: true,
      manualEditsPreserved: true,
    });
  });

  it("does not claim freshness for legacy snapshots without version facts", () => {
    expect(deriveDraftFreshness({
      ...current,
      snapshotOpportunityVersion: null,
    })).toEqual({
      state: "UNKNOWN",
      staleReasons: [],
      unknownReason: "SNAPSHOT_CONTEXT_INCOMPLETE",
      regenerateRequired: false,
      manualEditsPreserved: true,
    });
  });
});
