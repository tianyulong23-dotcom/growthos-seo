import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SendBatchPanel } from "./send-batch-panel"
import type { SendBatch } from "./api"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("@/api/client", async (original) => ({
  ...(await original<typeof import("@/api/client")>()),
  apiRequest: request,
}))
let items: SendBatch[]
const sample = (): SendBatch => ({
  id: "batch-1", run_id: null, state: "preview", reason: null,
  manifest_hash: "a".repeat(64), expires_at: "2099-01-01T00:00:00Z",
  confirmed_at: null, revoked_at: null,
  items: [{
    target: { draftId: "draft-1", approvedDraftVersionId: "version-1", gmailConnectionId: "account-1" },
    preview: { sender: "sender@example.test", recipient: "seller@example.test", subject: "Partnership", body: "Exact approved body" },
    state: "PENDING",
  }],
})
const posts = () => request.mock.calls.filter(([, init]) => init?.method === "POST")
async function mount() {
  render(<MemoryRouter><SendBatchPanel project="p1" consent="c1" draftIds={["draft-1"]} gmailConnectionId="account-1" /></MemoryRouter>)
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新发送批次" }).hasAttribute("disabled")).toBe(false))
}
beforeEach(() => {
  items = []
  request.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/draft-review")) return { items: [] }
    if (url.endsWith("/mail-monitoring")) return { items: [], connections: {}, partial: false }
    if (init?.method !== "POST") return { items }
    if (url.endsWith("/preview")) items = [sample()]
    else if (url.endsWith("/confirm")) items = [{ ...items[0], state: "queued", run_id: "run-1" }]
    else if (url.endsWith("/revoke")) items = [{ ...items[0], state: "revoked", revoked_at: new Date().toISOString() }]
    return items[0]
  })
})
afterEach(cleanup)

it("shows provider evidence and sync uncertainty without claiming delivery or an empty inbox", async () => {
  const batch = sample()
  batch.state = "completed"
  batch.items[0].sendIntentId = "intent"
  items = [batch]
  const original = request.getMockImplementation()!
  request.mockImplementation((url, init) => url.endsWith("/mail-monitoring") ? Promise.resolve({
    items: [{ draft_id: "draft-1", state: "PROVIDER_ACCEPTED", reply_state: "NOT_OBSERVED" }],
    connections: { "account-1": { state: "POLLING", killSwitchOpen: true } }, partial: true,
  }) : original(url, init))
  await mount()
  expect(await screen.findByText("发送核验：服务商已接受")).toBeTruthy()
  expect(screen.getByText("回复状态待核实，邮箱同步未就绪")).toBeTruthy()
  expect(screen.getByText("仅展示近期邮件，结果不完整")).toBeTruthy()
  expect(posts()).toHaveLength(0)
})

it("summarizes actual item receipts rather than treating a completed workflow as sent", async () => {
  const batch = sample()
  batch.state = "completed"
  batch.items = ["PROVIDER_ACCEPTED", "READY", "DELIVERY_UNKNOWN"].map((state, index) => ({
    ...sample().items[0],
    target: { ...sample().items[0].target, draftId: `draft-${index}` },
    state,
  }))
  items = [batch]
  await mount()
  for (const label of ["已发送 · 服务商已接受", "等待或正在发送", "需要核查"]) {
    expect(screen.getByText(label).parentElement?.querySelector("strong")?.textContent).toBe("1")
  }
  expect(screen.getByText("手动选择草稿并提交发送").closest("details")?.open).toBe(false)
  expect(posts()).toHaveLength(0)
})

it("never writes on mount and confirms only the explicit exact preview", async () => {
  await mount()
  expect(posts()).toHaveLength(0)
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: "预检并预览本批" }))
  await screen.findByText("Exact approved body")
  const send = screen.getByRole("button", { name: "确认并提交本批" })
  expect(send.hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("checkbox", { name: /我已核对/ }))
  await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false))
  fireEvent.click(send)
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(JSON.parse(posts()[1][1].body)).toEqual({ confirmed: true, manifest_hash: "a".repeat(64) })
  expect(posts()[1][0]).toMatch(/batch-1\/confirm$/)
})

it("retains uncertain preview request identity and permits abandoning only the preview", async () => {
  await mount()
  const original = request.getMockImplementation()!
  request.mockImplementation((url, init) => init?.method === "POST" ? Promise.reject(new Error("Preview failed")) : original(url, init))
  fireEvent.click(screen.getByRole("checkbox"))
  fireEvent.click(screen.getByRole("button", { name: "预检并预览本批" }))
  await screen.findByText("Preview failed")
  const retry = screen.getByRole("button", { name: "重试原预览请求" })
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false))
  fireEvent.click(retry)
  await waitFor(() => expect(posts()).toHaveLength(2))
  expect(posts()[0][1].body).toEqual(posts()[1][1].body)
  await waitFor(() => expect(screen.getByRole("button", { name: "放弃本次预览" }).hasAttribute("disabled")).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "放弃本次预览" }))
  await waitFor(() => expect(screen.getByRole("checkbox").closest("fieldset")?.disabled).toBe(false))
  expect(posts().every(([url]) => url.endsWith("/preview"))).toBe(true)
})

it("blocks expired confirmation without sending a request", async () => {
  items = [{ ...sample(), expires_at: "2000-01-01T00:00:00Z" }]
  await mount()
  fireEvent.click(screen.getByRole("checkbox", { name: /我已核对/ }))
  fireEvent.click(screen.getByRole("button", { name: "确认并提交本批" }))
  expect(await screen.findByText("本批预检已过期，请重新预览。")).toBeTruthy()
  expect(posts()).toHaveLength(0)
})

it("requires a separate explicit revocation and distinguishes provider acceptance", async () => {
  items = [{ ...sample(), state: "running", run_id: "run-1" }]
  await mount()
  expect(screen.getByRole("button", { name: "撤销本批授权" }).hasAttribute("disabled")).toBe(true)
  fireEvent.click(screen.getByRole("checkbox", { name: /停止后续提交/ }))
  fireEvent.click(screen.getByRole("button", { name: "撤销本批授权" }))
  await screen.findByText("授权已撤销；已经入队的邮件仍可能发送。")
  items = [{ ...sample(), state: "completed", items: [{ ...sample().items[0], state: "PROVIDER_ACCEPTED" }] }]
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新发送批次" }).hasAttribute("disabled")).toBe(false))
  fireEvent.click(screen.getByRole("button", { name: "刷新发送批次" }))
  expect(await screen.findByText("服务商已接受")).toBeTruthy()
  expect(posts()).toHaveLength(1)
})
