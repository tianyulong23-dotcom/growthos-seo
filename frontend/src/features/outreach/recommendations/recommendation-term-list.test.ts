import { describe, expect, it } from "vitest"

import {
  normalizeRecommendationTermList,
  recommendationMatchTerms,
} from "./recommendation-term-list"

describe("recommendation term lists", () => {
  it("splits explicit separators while preserving multi-word phrases", () => {
    expect(
      normalizeRecommendationTermList([
        "finest mulberry silk, luxe pajamas；loungewear\nfinest mulberry silk",
      ])
    ).toEqual(["finest mulberry silk", "luxe pajamas", "loungewear"])
  })

  it("restores source boundaries erased by an older assessment", () => {
    expect(
      recommendationMatchTerms(
        ["finest mulberry silk luxe pajamas loungewear"],
        ["finest mulberry silk, luxe pajamas, loungewear"]
      )
    ).toEqual(["finest mulberry silk", "luxe pajamas", "loungewear"])
  })

  it("does not split an uncorroborated phrase on whitespace", () => {
    expect(
      recommendationMatchTerms(["home cinema projector"], ["projector reviews"])
    ).toEqual(["home cinema projector"])
  })
})
