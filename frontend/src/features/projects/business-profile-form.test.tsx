import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BusinessProfileForm } from "@/features/projects/business-profile-form"
import type { Project } from "@/features/projects/types"

const project: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  competitorDomain: null,
  understandingRunId: "understanding-1",
  understandingStatus: "completed",
  understandingStage: "completed",
  understandingMessage: "",
  understandingProgress: 100,
  understandingAttempt: 1,
  understandingStartedAt: "2026-07-23T08:00:00Z",
  understandingFinishedAt: "2026-07-23T08:00:12.34Z",
  understandingElapsedSeconds: 12.34,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: {
    profileVersion: 1,
    extractionMethod: "rules",
    sourcePageCount: 3,
    faviconUrl: "https://example.com/favicon.ico",
    businessName: "Example Inc.",
    businessType: "SaaS",
    businessSummary: "Original summary",
    productsServices: ["Analytics"],
    targetAudiences: ["Teams"],
    valuePropositions: ["Fast setup"],
    useCases: [],
    targetMarkets: [],
    languages: ["en"],
    contentTopics: [],
    conversionActions: [],
    keyPages: [],
    evidence: [],
    userOverriddenFields: [],
    confidence: 0.8,
    aiContentRules: "Use a concise tone.",
    confirmedAt: null,
  },
  createdAt: "2026-07-22",
}

afterEach(() => {
  cleanup()
})

describe("BusinessProfileForm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("submits all editable business fields", async () => {
    const onSave = vi.fn().mockResolvedValue(project)
    render(<BusinessProfileForm project={project} onSave={onSave} />)

    expect(screen.getByDisplayValue("Example Inc.")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("业务类型"), {
      target: { value: "Analytics SaaS" },
    })
    fireEvent.change(screen.getByLabelText("目标客户"), {
      target: { value: "Teams\nAgencies\nTeams" },
    })
    fireEvent.change(screen.getByLabelText("产品与服务"), {
      target: { value: "Analytics\nReporting" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        businessName: "Example Inc.",
        businessType: "Analytics SaaS",
        businessSummary: "Original summary",
        targetAudiences: ["Teams", "Agencies"],
        productsServices: ["Analytics", "Reporting"],
        valuePropositions: ["Fast setup"],
        aiContentRules: "Use a concise tone.",
      })
    })
  })

  it("shows only the editable business profile fields", () => {
    render(
      <BusinessProfileForm
        project={{
          ...project,
          siteProfile: {
            ...project.siteProfile!,
            userOverriddenFields: ["business_type"],
            evidence: [
              {
                field: "business_summary",
                value: "Example provides analytics.",
                sourceUrl: "https://example.com/about",
                quote: "Analytics for modern teams",
              },
              {
                field: "conversion_actions",
                value: "Start free",
                sourceUrl: "https://example.com/signup",
                quote: "Start free",
              },
            ],
          },
        }}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText("已修改")).toBeTruthy()
    expect(screen.queryByText("AI 识别")).toBeNull()
    expect(screen.queryByText("转化动作")).toBeNull()
    expect(screen.queryByText("conversion_actions")).toBeNull()
    expect(screen.queryByText("查看识别依据")).toBeNull()
    expect(screen.queryByText("Analytics for modern teams")).toBeNull()
    expect(screen.queryByText("内容要求")).toBeNull()
    expect(screen.queryByLabelText("内容要求")).toBeNull()
    expect(screen.queryByText("识别历史")).toBeNull()

    const targetAudienceField = screen
      .getByLabelText("目标客户")
      .closest('[data-slot="form-field"]')
    const productsServicesField = screen
      .getByLabelText("产品与服务")
      .closest('[data-slot="form-field"]')
    expect(targetAudienceField).toBeTruthy()
    expect(productsServicesField).toBeTruthy()
    expect(targetAudienceField).not.toBe(productsServicesField)
  })

  it("starts website business recognition without submitting the form", async () => {
    const onSave = vi.fn().mockResolvedValue(project)
    const onRefresh = vi.fn().mockResolvedValue(project)
    render(
      <BusinessProfileForm
        project={project}
        onSave={onSave}
        onRefresh={onRefresh}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "重新识别" }))

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1)
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows a partial status and the concrete reason for usable fallback data", () => {
    render(
      <BusinessProfileForm
        project={{
          ...project,
          understandingStatus: "partial",
          understandingMessage:
            "AI 整理失败，已使用规则生成业务资料：模型请求超时",
        }}
        onSave={vi.fn()}
      />
    )

    expect(
      screen.getByText("AI 已生成可用资料，建议检查后再使用。")
    ).toBeTruthy()
    expect(
      screen.getByText("AI 整理失败，已使用规则生成业务资料：模型请求超时")
    ).toBeTruthy()
  })

  it("replaces form values when a newer recognition run finishes", async () => {
    const rerunningProject = {
      ...project,
      understandingRunId: "understanding-2",
      understandingStatus: "running" as const,
      understandingStage: "extracting_pages",
      understandingProgress: 70,
    }
    const refreshedProject = {
      ...rerunningProject,
      name: "Updated Example",
      understandingStatus: "completed" as const,
      understandingStage: "completed",
      understandingProgress: 100,
      understandingFinishedAt: "2026-07-23T08:10:10Z",
      siteProfile: {
        ...project.siteProfile!,
        businessName: "Updated Example",
        businessSummary: "Updated summary",
        productsServices: ["Updated analytics"],
      },
    }
    const { rerender } = render(
      <BusinessProfileForm project={project} onSave={vi.fn()} />
    )

    fireEvent.change(screen.getByLabelText("公司简介"), {
      target: { value: "Unsaved local edit" },
    })
    rerender(
      <BusinessProfileForm project={rerunningProject} onSave={vi.fn()} />
    )
    expect(screen.getByDisplayValue("Unsaved local edit")).toBeTruthy()

    rerender(
      <BusinessProfileForm project={refreshedProject} onSave={vi.fn()} />
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue("Updated Example")).toBeTruthy()
      expect(screen.getByDisplayValue("Updated summary")).toBeTruthy()
      expect(screen.getByDisplayValue("Updated analytics")).toBeTruthy()
    })
  })
})
