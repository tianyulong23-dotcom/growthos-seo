import { describe, expectTypeOf, it } from "vitest"

import type {
  BacklinksOperationId,
  BacklinksRequest,
} from "@/api/generated/backlinks"

const recommendationFeedOperationIds = [
  "backlinksListRecommendationFeedV2",
  "backlinksGetRecommendationFeedStatusV2",
  "backlinksGetMoreRecommendationFeedV2",
  "backlinksArchiveRecommendationFeedItemV2",
  "backlinksUnarchiveRecommendationFeedItemV2",
  "backlinksExportRecommendationFeedV2",
  "backlinksGenerateRecommendationSeedsV2",
  "backlinksValidateRecommendationSeedsV2",
] as const satisfies readonly BacklinksOperationId[]

describe("Recommendation Pool V2 generated contract", () => {
  it("includes every V2 feed and seed operation", () => {
    expectTypeOf(recommendationFeedOperationIds).toMatchTypeOf<
      readonly BacklinksOperationId[]
    >()
  })

  it("keeps V1 and V2 Opportunity creation bodies mutually exclusive", () => {
    type Request = BacklinksRequest<"backlinksCreateOpportunityV1">
    type Body = Request["body"]

    expectTypeOf<{
      recommendationFeedItemId: string
    }>().toMatchTypeOf<Body>()
    expectTypeOf<{
      recommendationId: string
      contactCandidateId: null
      expectedVersion: number
    }>().toMatchTypeOf<Body>()

    // @ts-expect-error Recommendation sources cannot be mixed.
    const invalid: Body = {
      recommendationFeedItemId: "018f0000-0000-7000-8000-000000000081",
      recommendationId: "018f0000-0000-7000-8000-000000000082",
      expectedVersion: 1,
    }
    void invalid
  })
})
