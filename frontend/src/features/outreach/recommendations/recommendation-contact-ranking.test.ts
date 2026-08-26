import { describe, expect, it } from "vitest"

import { sortRecommendationsByContactAndScore } from "./recommendation-contact-ranking"

function recommendation(
  hostname: string,
  score: number,
  options: Readonly<{
    contactStatus?: string
    contactPageUrl?: string | null
    cooperationPathUrl?: string | null
  }> = {}
) {
  return {
    hostname,
    score,
    contactStatus: options.contactStatus ?? "not_started",
    contactPageUrl: options.contactPageUrl ?? null,
    cooperationPath:
      options.cooperationPathUrl === undefined
        ? null
        : {
            decision: "verified",
            url: options.cooperationPathUrl,
          },
  }
}

describe("recommendation contact ranking", () => {
  it("prioritizes verified email, then contact paths, then score", () => {
    const result = sortRecommendationsByContactAndScore([
      recommendation("high-score.example", 90),
      recommendation("contact-page.example", 70, {
        contactPageUrl: "https://contact-page.example/contact",
      }),
      recommendation("email.example", 60, {
        contactStatus: "contactable",
      }),
      recommendation("manual-path.example", 80, {
        cooperationPathUrl: "https://manual-path.example/advertise",
      }),
    ])

    expect(result.map((item) => item.hostname)).toEqual([
      "email.example",
      "manual-path.example",
      "contact-page.example",
      "high-score.example",
    ])
  })
})
