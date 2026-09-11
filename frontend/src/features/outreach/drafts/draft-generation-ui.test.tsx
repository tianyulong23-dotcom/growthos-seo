import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, expect, it, vi } from "vitest"
import type { OutreachProject } from "@/features/outreach/project"

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  listOpportunityContacts: vi.fn().mockResolvedValue({
    items: [],
    selection: { autoSelectedContactId: null },
  }),
}))
vi.mock("./discovered-contact-picker", () => ({
  DiscoveredContactPicker: () => <div>已发现邮箱</div>,
}))
import { DraftGeneration } from "./draft-generation"

afterEach(cleanup)

it("shows readable defaults and keeps optional settings collapsed without removing them", async () => {
  const project: OutreachProject = {
    id: "project-a",
    name: "Aiper",
    domain: "aiper.com",
    language: "en",
    contextVersion: 1,
    targetUrls: ["https://aiper.com/us"],
    suggestedTopics: [],
    suggestedTargetUrls: [],
    profileVersion: 1,
    inputRequired: [],
  }
  render(
    <MemoryRouter initialEntries={["/?opportunityId=opportunity-a"]}>
      <DraftGeneration project={project} />
    </MemoryRouter>
  )
  await screen.findByText("已发现邮箱")
  expect(screen.getByText("待填写")).toBeTruthy()
  expect(screen.getByText("通用合作")).toBeTruthy()
  expect(screen.queryByText("GENERAL_PARTNERSHIP")).toBeNull()
  const manual = screen.getByText("手动添加其他邮箱").closest("details")!
  const settings = screen.getByText("更多写作设置").closest("details")!
  expect(manual.open).toBe(false)
  expect(settings.open).toBe(false)
  fireEvent.click(screen.getByText("更多写作设置"))
  await waitFor(() => expect(settings.open).toBe(true))
  expect(screen.getByText("中性商务")).toBeTruthy()
  expect(screen.getByText("清晰直接")).toBeTruthy()
  expect(screen.getByRole("button", { name: "生成草稿" }).hasAttribute("disabled")).toBe(true)
})
