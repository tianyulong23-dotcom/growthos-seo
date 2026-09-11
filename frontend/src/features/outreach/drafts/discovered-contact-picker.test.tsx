import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const api = vi.hoisted(() => ({
  getOpportunity: vi.fn(),
  listContactCandidates: vi.fn(),
  confirmContactCandidate: vi.fn(),
}))
vi.mock("@/features/outreach/opportunities/api", () => ({
  getOpportunity: api.getOpportunity,
}))
vi.mock("./api", () => api)
import { DiscoveredContactPicker } from "./discovered-contact-picker"

const candidate = (id: string, overrides = {}) => ({
  id,
  prospectId: "prospect-a",
  recommendationContextVersionId: "context-a",
  normalizedEmail: `${id}@publisher.com`,
  inferredPurpose: "editorial",
  domainRelation: "same_registrable_domain",
  guessed: false,
  version: 3,
  evidence: [
    {
      sourceUrl: "https://publisher.com/contact",
      extractionMethod: "mailto",
      expiresAt: "2099-01-01T00:00:00Z",
    },
  ],
  ...overrides,
})
const onConfirmed = vi.fn().mockResolvedValue(undefined)
beforeEach(() => {
  vi.clearAllMocks()
  api.getOpportunity.mockResolvedValue({
    item: {
      prospectId: "prospect-a",
      recommendationContextVersionId: "context-a",
    },
  })
  api.listContactCandidates.mockResolvedValue({
    items: [candidate("editor"), candidate("press")],
  })
  api.confirmContactCandidate.mockResolvedValue({})
})
afterEach(cleanup)

describe("discovered contacts in draft generation", () => {
  it("shows saved email choices and evidence, confirming the selected existing candidate only", async () => {
    render(
      <DiscoveredContactPicker
        projectId="project-a"
        opportunityId="opportunity-a"
        onConfirmed={onConfirmed}
      />
    )
    const select = await screen.findByLabelText("已发现邮箱")
    expect(screen.getByText("查看邮箱来源").closest("details")?.open).toBe(false)
    fireEvent.click(screen.getByText("查看邮箱来源"))
    expect(screen.getByRole("option", { name: "editor@publisher.com · 编辑" })).toBeTruthy()
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://publisher.com/contact"
    )
    expect(api.confirmContactCandidate).not.toHaveBeenCalled()
    fireEvent.change(select, { target: { value: "press" } })
    fireEvent.click(screen.getByRole("button", { name: "确认使用此邮箱" }))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce())
    expect(api.confirmContactCandidate).toHaveBeenCalledWith(
      "project-a",
      "press",
      expect.objectContaining({ expectedVersion: 3, contactRole: "editorial" })
    )
  })
  it("does not present other-context, guessed, or expired evidence as usable candidates", async () => {
    api.listContactCandidates.mockResolvedValue({
      items: [
        candidate("other", { recommendationContextVersionId: "other" }),
        candidate("guessed", { guessed: true }),
        candidate("expired", {
          evidence: [{ extractionMethod: "mailto", expiresAt: "2000-01-01" }],
        }),
      ],
    })
    render(
      <DiscoveredContactPicker
        projectId="project-a"
        opportunityId="opportunity-a"
        onConfirmed={onConfirmed}
      />
    )
    await screen.findByText("暂无带有效网页证据的待确认邮箱。")
    expect(screen.queryByRole("combobox")).toBeNull()
  })
  it("discards responses after switching projects", async () => {
    let resolveOld!: (value: unknown) => void
    api.listContactCandidates.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    const view = render(
      <DiscoveredContactPicker
        projectId="project-a"
        opportunityId="opportunity-a"
        onConfirmed={onConfirmed}
      />
    )
    await waitFor(() =>
      expect(api.listContactCandidates).toHaveBeenCalledOnce()
    )
    view.rerender(
      <DiscoveredContactPicker
        projectId="project-b"
        opportunityId="opportunity-b"
        onConfirmed={onConfirmed}
      />
    )
    await screen.findByLabelText("已发现邮箱")
    resolveOld({ items: [candidate("stale")] })
    await waitFor(() =>
      expect(screen.queryByText(/stale@publisher/)).toBeNull()
    )
  })
  it("keeps the confirmation failure visible without pretending the contact is ready", async () => {
    api.confirmContactCandidate.mockRejectedValue(new Error("conflict"))
    render(
      <DiscoveredContactPicker
        projectId="project-a"
        opportunityId="opportunity-a"
        onConfirmed={onConfirmed}
      />
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "确认使用此邮箱" })
    )
    await screen.findByRole("alert")
    expect(onConfirmed).not.toHaveBeenCalled()
  })
})
