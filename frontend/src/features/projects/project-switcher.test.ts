import { describe, expect, it } from "vitest"

import { projectRouteForSwitch } from "@/features/projects/project-route"

describe("projectRouteForSwitch", () => {
  it("keeps the current module view while replacing only the project ID", () => {
    expect(
      projectRouteForSwitch(
        "/projects/project-1/backlinks/opportunities",
        "project-1",
        "project-2"
      )
    ).toBe("/projects/project-2/backlinks/opportunities")
  })

  it("uses the project overview when the current route has no module suffix", () => {
    expect(
      projectRouteForSwitch("/projects/project-1", "project-1", "project-2")
    ).toBe("/projects/project-2/audit/overview")
  })

  it("does not carry a project-scoped draft into another project", () => {
    expect(
      projectRouteForSwitch(
        "/projects/project-1/backlinks/drafts/draft-1",
        "project-1",
        "project-2"
      )
    ).toBe("/projects/project-2/backlinks/email")
  })
})
