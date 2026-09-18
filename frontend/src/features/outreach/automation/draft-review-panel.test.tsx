import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { DraftReviewPanel } from "./draft-review-panel"

const { read, approve, ai } = vi.hoisted(() => ({ read: vi.fn(), approve: vi.fn(), ai: vi.fn() }))
vi.mock("./api", () => ({ readDraftReview: read, approveDraftReview: approve, aiReviewDrafts: ai }))
const item = { draft_id: "draft", version_id: "version", expected_version: 1,
  subject: "Subject", body: "Reviewed body", approved: false, reviewable: true }
beforeEach(() => {
  read.mockReset().mockResolvedValue({ items: [item] })
  approve.mockReset().mockResolvedValue({ sent: false })
  ai.mockReset().mockResolvedValue({ sent: false })
})
afterEach(cleanup)
async function mount() {
  render(<DraftReviewPanel project="project" consent="consent" />)
  await screen.findByText("Reviewed body")
  await waitFor(() => expect(screen.getByLabelText("审核 Subject").hasAttribute("disabled")).toBe(false))
}
function select() {
  fireEvent.click(screen.getByLabelText("审核 Subject"))
  fireEvent.click(screen.getByLabelText("我已审核所选邮件内容"))
}
it("only approves explicitly reviewed pinned versions; never sends", async () => {
  await mount()
  expect(approve).not.toHaveBeenCalled()
  select()
  fireEvent.click(screen.getByRole("button", { name: "批准所选草稿" }))
  await waitFor(() => expect(approve).toHaveBeenCalledWith("project", "consent", expect.any(String), [item]))
})
it("refreshing content clears selection and confirmation", async () => {
  await mount()
  select()
  read.mockResolvedValue({ items: [{ ...item, version_id: "new", body: "Changed body" }] })
  fireEvent.click(screen.getByLabelText("刷新草稿审核"))
  await screen.findByText("Changed body")
  expect((screen.getByLabelText("我已审核所选邮件内容") as HTMLInputElement).checked).toBe(false)
  expect(screen.getByRole("button", { name: "批准所选草稿" }).hasAttribute("disabled")).toBe(true)
})
it("uncertain approval retries the exact request and freezes refresh", async () => {
  approve.mockRejectedValueOnce(new Error("Unknown result"))
  await mount()
  select()
  fireEvent.click(screen.getByRole("button", { name: "批准所选草稿" }))
  await screen.findByText("Unknown result")
  expect(screen.getByLabelText("刷新草稿审核").hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "重试原审核请求" }))
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(2))
  expect(approve.mock.calls[1]).toEqual(approve.mock.calls[0])
})
it("AI review is explicit, shows blocked reasons, and never invokes manual approval or sending", async () => {
  await mount()
  expect(ai).not.toHaveBeenCalled()
  read.mockResolvedValue({ items: [{ ...item, quality: {
    state: "BLOCKED", reasons: ["项目域名与草稿不一致"], version_id: "version",
  } }] })
  fireEvent.click(screen.getByRole("button", { name: "AI 审核并批准合格草稿" }))
  await screen.findByText("项目域名与草稿不一致")
  expect(ai).toHaveBeenCalledWith("project", "consent", expect.any(String))
  expect(approve).not.toHaveBeenCalled()
  expect(screen.getByText("AI 审核拦截")).toBeTruthy()
})
it("retains an AI request error after refreshing the saved drafts", async () => {
  ai.mockRejectedValue(new Error("审核请求失败"))
  await mount()
  fireEvent.click(screen.getByRole("button", { name: "AI 审核并批准合格草稿" }))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(await screen.findByText("审核请求失败")).toBeTruthy()
  expect(approve).not.toHaveBeenCalled()
})
it("shows repair progress without enabling approval", async () => {
  read.mockResolvedValue({ items: [{ ...item, quality: {
    state: "REPAIRING", reasons: ["自动修正无依据描述"], version_id: "version",
  } }] })
  render(<DraftReviewPanel project="project" consent="consent" />)
  expect(await screen.findByText("AI 修正中")).toBeTruthy()
  expect(screen.getByLabelText("审核 Subject").hasAttribute("disabled")).toBe(true)
  expect(approve).not.toHaveBeenCalled()
})
