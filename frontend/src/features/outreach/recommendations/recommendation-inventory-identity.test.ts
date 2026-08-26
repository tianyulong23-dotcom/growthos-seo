import { describe, expect, it } from "vitest"

import {
  isStaleRecommendationInventoryIdentity,
  type RecommendationInventoryIdentity,
} from "./recommendation-inventory-identity"

const accepted: RecommendationInventoryIdentity = {
  websiteProjectId: "project-a",
  contractKind: "corrected_visibility_v1",
  recommendationContextVersionId: "context-a",
  visiblePoolGeneration: 2,
  serverUpdatedAt: "2026-08-17T12:00:00.000Z",
}

describe("recommendation inventory identity", () => {
  it.each([
    [
      "another project",
      { ...accepted, websiteProjectId: "project-b" },
    ],
    [
      "another contract",
      { ...accepted, contractKind: "unknown_contract" as const },
    ],
    [
      "another established context",
      { ...accepted, recommendationContextVersionId: "context-b" },
    ],
    [
      "an older generation",
      { ...accepted, visiblePoolGeneration: 1 },
    ],
    [
      "an older same-generation update",
      { ...accepted, serverUpdatedAt: "2026-08-17T11:59:59.000Z" },
    ],
  ])("rejects %s", (_label, incoming) => {
    expect(
      isStaleRecommendationInventoryIdentity(
        "project-a",
        accepted,
        incoming
      )
    ).toBe(true)
  })

  it("accepts the first response for the current project", () => {
    expect(
      isStaleRecommendationInventoryIdentity("project-a", null, accepted)
    ).toBe(false)
  })

  it("accepts a newly established context and a later generation", () => {
    expect(
      isStaleRecommendationInventoryIdentity(
        "project-a",
        {
          ...accepted,
          recommendationContextVersionId: null,
          visiblePoolGeneration: 1,
        },
        accepted
      )
    ).toBe(false)
    expect(
      isStaleRecommendationInventoryIdentity("project-a", accepted, {
        ...accepted,
        visiblePoolGeneration: 3,
        serverUpdatedAt: "2026-08-17T12:01:00.000Z",
      })
    ).toBe(false)
  })
})
