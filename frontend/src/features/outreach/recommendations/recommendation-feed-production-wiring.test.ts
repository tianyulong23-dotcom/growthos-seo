import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const source = readFileSync(
  resolve(process.cwd(), "src/features/outreach/outreach-workspace.tsx"),
  "utf8"
)

describe("Recommendation feed production wiring", () => {
  it("switches only the Recommendations branch to the V2 workspace", () => {
    expect(source).toContain(
      'import { RecommendationFeedWorkspace } from "@/features/outreach/recommendations/recommendation-feed-workspace"'
    )
    expect(source).toContain(
      "<RecommendationFeedWorkspace project={readyProject} />"
    )
    expect(source).toContain("<RecommendationProjectGate")
    expect(source).toContain("key={`${project.id}:${project.contextVersion}`}")
    expect(source).not.toContain(
      "@/features/outreach/recommendations/recommendations-workspace"
    )

    expect(source).toContain("<OpportunitiesWorkspace")
    expect(source).toContain("<MailSyncStatusPanel")
    expect(source).toContain("<LinksWorkspace")
    expect(source).toContain("<BacklinkReportsRouteWorkspace")
  })
})
