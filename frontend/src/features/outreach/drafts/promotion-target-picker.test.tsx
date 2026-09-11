import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { OutreachProject } from "@/features/outreach/project"

const api = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProjectOutreachReadiness: vi.fn(),
  confirmPromotionTarget: vi.fn(),
}))
vi.mock("@/api/projects", () => api)
import { PromotionTargetPicker } from "./promotion-target-picker"

const project: OutreachProject = {
  id: "project-a", domain: "aiper.com", targetUrls: ["https://aiper.com/us"],
  name: "Aiper", language: "en", contextVersion: 7, profileVersion: 1,
  suggestedTopics: [], suggestedTargetUrls: [], inputRequired: [],
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  api.getProject.mockResolvedValue({
    contextVersion: 7,
    siteProfile: { keyPages: [{ url: "https://aiper.com/us" }], contentTopics: ["pools"] },
  })
  api.getProjectOutreachReadiness.mockResolvedValue({ siteProfileVersionId: "profile-7" })
  api.confirmPromotionTarget.mockImplementation(async (_id, input) => ({
    targetUrls: input.confirmedTargetUrls,
  }))
})

it("persists multiple editable pages through the project authority API", async () => {
  const onChange = vi.fn()
  render(<PromotionTargetPicker project={project} value={project.targetUrls[0]} onChange={onChange} disabled={false} />)
  fireEvent.click(screen.getByText("管理页面"))
  fireEvent.change(screen.getByLabelText("推广页面 1"), { target: { value: "https://aiper.com/" } })
  fireEvent.click(screen.getByText("新增页面"))
  fireEvent.change(screen.getByLabelText("推广页面 2"), { target: { value: "https://aiper.com/us" } })
  fireEvent.click(screen.getByText("保存"))
  await waitFor(() => expect(api.confirmPromotionTarget).toHaveBeenCalledWith("project-a", {
    confirmedTopics: ["pools"],
    confirmedTargetUrls: ["https://aiper.com/", "https://aiper.com/us"],
    expectedProjectContextVersion: 7,
    expectedSiteProfileVersionId: "profile-7",
  }))
  await waitFor(() => expect(screen.queryByText("保存")).toBeNull())
  expect(screen.getByRole("option", { name: "https://aiper.com/" })).toBeTruthy()
})

it("rejects unrelated domains without making a save request", () => {
  render(<PromotionTargetPicker project={project} value={project.targetUrls[0]} onChange={vi.fn()} disabled={false} />)
  fireEvent.click(screen.getByText("管理页面"))
  fireEvent.change(screen.getByLabelText("推广页面 1"), { target: { value: "https://aiper.com.evil.test/" } })
  fireEvent.click(screen.getByText("保存"))
  expect(screen.getByRole("alert").textContent).toContain("当前项目域名")
  expect(api.confirmPromotionTarget).not.toHaveBeenCalled()
})

it("does not overwrite concurrently edited project pages", async () => {
  api.getProject.mockResolvedValue({
    siteProfile: { keyPages: [{ url: "https://aiper.com/new" }] },
  })
  render(<PromotionTargetPicker project={project} value={project.targetUrls[0]} onChange={vi.fn()} disabled={false} />)
  fireEvent.click(screen.getByText("管理页面"))
  fireEvent.click(screen.getByText("保存"))
  expect((await screen.findByRole("alert")).textContent).toContain("已在其他位置更新")
  expect(api.confirmPromotionTarget).not.toHaveBeenCalled()
})
