import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ProjectFavicon } from "@/features/projects/project-favicon"
import type { Project } from "@/features/projects/types"

const project: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  competitorDomain: null,
  understandingRunId: null,
  understandingStatus: null,
  understandingStage: null,
  understandingMessage: "",
  understandingProgress: 0,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: null,
  createdAt: "2026-07-22",
}

describe("ProjectFavicon", () => {
  it("does not request or display a favicon before site understanding finishes", () => {
    const { container } = render(<ProjectFavicon project={project} />)

    expect(container.querySelector("img")).toBeNull()
    expect(container.firstChild).toBeNull()
  })

  it("displays only the favicon URL saved by the crawler", () => {
    const { container } = render(
      <ProjectFavicon
        project={{
          ...project,
          siteProfile: {
            profileVersion: 2,
            extractionMethod: "page_content",
            sourcePageCount: 1,
            faviconUrl: "https://example.com/icon.png",
            businessName: "Example",
            businessType: "",
            businessSummary: "",
            productsServices: [],
            targetAudiences: [],
            valuePropositions: [],
            useCases: [],
            targetMarkets: [],
            languages: [],
            contentTopics: [],
            conversionActions: [],
            keyPages: [],
            evidence: [],
            userOverriddenFields: [],
            confidence: 0,
            aiContentRules: "",
            confirmedAt: null,
          },
        }}
      />
    )

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/icon.png"
    )
  })

  it("does not discard a valid favicon on an arbitrary timer", () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout")

    render(
      <ProjectFavicon
        project={{
          ...project,
          siteProfile: {
            profileVersion: 2,
            extractionMethod: "page_content",
            sourcePageCount: 1,
            faviconUrl: "https://example.com/icon.png",
            businessName: "Example",
            businessType: "",
            businessSummary: "",
            productsServices: [],
            targetAudiences: [],
            valuePropositions: [],
            useCases: [],
            targetMarkets: [],
            languages: [],
            contentTopics: [],
            conversionActions: [],
            keyPages: [],
            evidence: [],
            userOverriddenFields: [],
            confidence: 0,
            aiContentRules: "",
            confirmedAt: null,
          },
        }}
      />
    )

    expect(timeoutSpy).not.toHaveBeenCalled()
    timeoutSpy.mockRestore()
  })

  it("displays a globe after understanding finishes without an icon", () => {
    const { container } = render(
      <ProjectFavicon
        project={{
          ...project,
          siteProfile: {
            profileVersion: 2,
            extractionMethod: "page_content",
            sourcePageCount: 1,
            faviconUrl: "",
            businessName: "Example",
            businessType: "",
            businessSummary: "",
            productsServices: [],
            targetAudiences: [],
            valuePropositions: [],
            useCases: [],
            targetMarkets: [],
            languages: [],
            contentTopics: [],
            conversionActions: [],
            keyPages: [],
            evidence: [],
            userOverriddenFields: [],
            confidence: 0,
            aiContentRules: "",
            confirmedAt: null,
          },
        }}
      />
    )

    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("replaces a favicon that fails to load with a globe", () => {
    const { container } = render(
      <ProjectFavicon
        project={{
          ...project,
          siteProfile: {
            profileVersion: 2,
            extractionMethod: "page_content",
            sourcePageCount: 1,
            faviconUrl: "https://example.com/missing.png",
            businessName: "Example",
            businessType: "",
            businessSummary: "",
            productsServices: [],
            targetAudiences: [],
            valuePropositions: [],
            useCases: [],
            targetMarkets: [],
            languages: [],
            contentTopics: [],
            conversionActions: [],
            keyPages: [],
            evidence: [],
            userOverriddenFields: [],
            confidence: 0,
            aiContentRules: "",
            confirmedAt: null,
          },
        }}
      />
    )

    const image = container.querySelector("img")
    expect(image).not.toBeNull()
    fireEvent.error(image!)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
