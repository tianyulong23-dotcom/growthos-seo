import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Project } from "@/features/projects/types"

const projectContext = vi.hoisted(() => ({
  getProject: vi.fn(),
  refreshProject: vi.fn(),
}))

vi.mock("@/features/projects/project-context", () => ({
  useProjects: () => projectContext,
}))

vi.mock("@/features/outreach/drafts/draft-generation", () => ({
  DraftGeneration: ({
    project,
  }: {
    project: { targetUrls: readonly string[] }
  }) => (
    <div data-testid="draft-generation">
      {project.targetUrls.join(",")}
    </div>
  ),
}))

import { FreshDraftGeneration } from "./draft-page"

const projectWithTarget = (id: string): Project => ({
  id,
  name: "EveryCine",
  domain: "everycine.com",
  country: "BR",
  language: "pt-BR",
  competitorDomain: null,
  understandingRunId: null,
  understandingStatus: "completed",
  understandingStage: null,
  understandingMessage: "",
  understandingProgress: 100,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: {
    profileVersion: 1,
    extractionMethod: "test",
    sourcePageCount: 1,
    faviconUrl: "",
    businessName: "EveryCine",
    businessType: "media",
    businessSummary: "Movies and series.",
    productsServices: ["streaming"],
    targetAudiences: ["movie fans"],
    valuePropositions: ["discover content"],
    useCases: ["watch movies"],
    targetMarkets: ["BR"],
    languages: ["pt-BR"],
    contentTopics: ["streaming"],
    conversionActions: [],
    partnershipGoals: ["editorial"],
    inputRequired: [],
    keyPages: [
      {
        url: "https://everycine.com/",
        title: "EveryCine",
        description: "Published promotion target.",
      },
    ],
    evidence: [],
    userOverriddenFields: [],
    confidence: 1,
    aiContentRules: "",
    confirmedAt: "2026-08-27T00:00:00.000Z",
  },
  createdAt: "2026-08-27T00:00:00.000Z",
})

beforeEach(() => {
  projectContext.getProject.mockReset()
  projectContext.refreshProject.mockReset()
})

afterEach(cleanup)

describe("FreshDraftGeneration", () => {
  it("refreshes the selected project before rendering draft inputs", async () => {
    projectContext.refreshProject.mockResolvedValue(
      projectWithTarget("project-new")
    )

    render(<FreshDraftGeneration projectId="project-new" />)

    expect(screen.queryByTestId("draft-generation")).toBeNull()
    await waitFor(() =>
      expect(projectContext.refreshProject).toHaveBeenCalledWith("project-new")
    )
    expect(
      (await screen.findByTestId("draft-generation")).textContent
    ).toContain("https://everycine.com/")
  })

  it("does not render a previous project's data while switching projects", async () => {
    let resolveProject: ((project: Project) => void) | undefined
    projectContext.refreshProject.mockImplementation(
      () =>
        new Promise<Project>((resolve) => {
          resolveProject = resolve
        })
    )

    const view = render(<FreshDraftGeneration projectId="project-a" />)
    view.rerender(<FreshDraftGeneration projectId="project-b" />)

    expect(screen.queryByTestId("draft-generation")).toBeNull()
    resolveProject?.(projectWithTarget("project-b"))
    expect(
      (await screen.findByTestId("draft-generation")).textContent
    ).toContain("https://everycine.com/")
  })
})
