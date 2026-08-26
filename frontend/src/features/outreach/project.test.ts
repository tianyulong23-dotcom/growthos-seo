import { describe, expect, it } from "vitest"

import { toOutreachProject } from "@/features/outreach/project"
import type { Project } from "@/features/projects/types"

const project: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "ZA",
  language: "en",
  competitorDomain: null,
  understandingRunId: "understanding-1",
  understandingStatus: "failed",
  understandingStage: "failed",
  understandingMessage: "Unable to fetch HTML",
  understandingProgress: 0,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: {
    profileVersion: 1,
    extractionMethod: "project_context",
    sourcePageCount: 0,
    faviconUrl: "",
    businessName: "Example",
    businessType: "",
    businessSummary: "",
    productsServices: ["Streaming"],
    targetAudiences: ["South African viewers"],
    valuePropositions: [],
    useCases: [],
    targetMarkets: ["ZA"],
    languages: ["en"],
    contentTopics: ["streaming service"],
    conversionActions: [],
    partnershipGoals: ["Authoritative review sites"],
    inputRequired: [],
    keyPages: [
      {
        url: "https://example.com/",
        title: "Example",
        description: "",
      },
    ],
    evidence: [],
    userOverriddenFields: [],
    confidence: 1,
    aiContentRules: "",
    confirmedAt: null,
  },
  createdAt: "2026-08-18T00:00:00Z",
}

describe("toOutreachProject", () => {
  it("uses persisted project input status instead of treating crawl failure as missing data", () => {
    const outreachProject = toOutreachProject(project)

    expect(outreachProject.inputRequired).toEqual([])
    expect(outreachProject.targetUrls).toEqual(["https://example.com/"])
  })

  it("maps persisted missing input keys to user-facing labels", () => {
    const outreachProject = toOutreachProject({
      ...project,
      siteProfile: {
        ...project.siteProfile!,
        inputRequired: ["keywords", "partnership_goals"],
      },
    })

    expect(outreachProject.inputRequired).toEqual([
      "关键词/内容主题",
      "外链合作目标",
    ])
  })
})
