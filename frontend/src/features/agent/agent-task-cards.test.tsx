import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, expect, it, vi } from "vitest"
import { ApiError } from "@/api/client"
import { AgentTaskCards } from "./agent-task-cards"

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock("@/api/client", async (original) => ({
  ...await original<typeof import("@/api/client")>(), apiRequest: mocks.api,
}))
const reference = { kind: "article", task_id: "run", related_id: "article", title: "Article job", status: "queued" }
const live = { ...reference, id: "run", status: "running", progress: 42, stage: null, updated_at: null }
afterEach(() => { cleanup(); vi.resetAllMocks() })

it("deduplicates durable receipts, reads actual progress and links to the result", async () => {
  mocks.api.mockResolvedValue(live)
  render(<MemoryRouter><AgentTaskCards projectId="p" references={[reference, reference]} /></MemoryRouter>)
  await screen.findByText("42%")
  expect(screen.getAllByText("Article job")).toHaveLength(1)
  expect(screen.getByRole("link").getAttribute("href")).toBe("/projects/p/content/articles/article/edit")
  expect(mocks.api).toHaveBeenCalledWith("/api/v1/projects/p/tasks/article/run", expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

it("marks stale progress and clears its display when task access is revoked", async () => {
  mocks.api.mockResolvedValueOnce(live).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new ApiError(403, "denied"))
  render(<MemoryRouter><AgentTaskCards projectId="p" references={[reference]} /></MemoryRouter>)
  await screen.findByText("42%")
  fireEvent.click(screen.getByRole("button", { name: "刷新任务状态" }))
  await screen.findByText("状态待更新")
  fireEvent.click(screen.getByRole("button", { name: "刷新任务状态" }))
  await screen.findByText("任务不可访问")
  expect(screen.queryByText("42%")).toBeNull()
})

it("ignores project A's late response after switching to project B", async () => {
  let resolveOld!: (task: unknown) => void
  mocks.api.mockImplementation((path) => path.includes("/a/")
    ? new Promise(resolve => { resolveOld = resolve })
    : Promise.resolve({ ...live, progress: 80 }))
  const { rerender } = render(<MemoryRouter><AgentTaskCards projectId="a" references={[reference]} /></MemoryRouter>)
  rerender(<MemoryRouter><AgentTaskCards projectId="b" references={[reference]} /></MemoryRouter>)
  await screen.findByText("80%")
  resolveOld(live)
  await waitFor(() => expect(screen.queryByText("42%")).toBeNull())
  expect(screen.getByRole("link").getAttribute("href")).toContain("/projects/b/")
})
