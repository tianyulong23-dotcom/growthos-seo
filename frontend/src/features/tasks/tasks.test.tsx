import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/api/client"
import { isTaskActive, taskHref, taskReasonLabel, taskStatusLabel, type TaskItem } from "./task-api"
import { useTasks } from "./use-tasks"

const mocks = vi.hoisted(() => ({ api: vi.fn(), backlinks: vi.fn() }))
vi.mock("@/api/client", async (original) => ({
  ...await original<typeof import("@/api/client")>(), apiRequest: mocks.api,
}))
vi.mock("@/api/generated/backlinks", () => ({ requestBacklinks: mocks.backlinks }))

const task: TaskItem = {
  id: "r1", kind: "article", title: "Article", status: "running", progress: 30,
  stage: null, updated_at: null, related_id: "a1",
}
afterEach(() => { vi.resetAllMocks() })

describe("task status projection", () => {
  it("distinguishes worker, quota and failure without calling provider acceptance delivery", () => {
    expect(taskReasonLabel({ ...task, reason_code: "background_dispatch_disabled" })).toBe("后台调度未启用")
    expect(taskReasonLabel({ ...task, stage: "WAIT_FOR_WORKER" })).toBe("等待后台服务")
    expect(taskReasonLabel({ ...task, stage: "WAIT_FOR_SEND_QUOTA" })).toContain("等待额度")
    expect(taskReasonLabel({ ...task, status: "failed", stage: "QUOTA_EXCEEDED" })).toBe("额度或限流限制（quota_exceeded）")
    expect(taskStatusLabel({ ...task, status: "failed" })).toBe("失败")
    expect(taskStatusLabel({ ...task, status: "SUCCESS" })).toBe("已完成")
    expect(taskStatusLabel({ ...task, kind: "onboarding", reason_code: "onboarding_step_failed" })).toBe("需要处理")
    expect(taskReasonLabel({ ...task, kind: "onboarding", reason_code: "onboarding_step_failed" })).toContain("初始化步骤失败")
    expect(taskStatusLabel({ ...task, status: "PROVIDER_ACCEPTED" })).toBe("邮件服务已接收")
    expect(isTaskActive({ ...task, status: "RETRY_SCHEDULED" })).toBe(true)
  })
  it("links to the actual owning project and article or conversation", () => {
    expect(taskHref("p", task)).toBe("/projects/p/content/articles/a1/edit")
    expect(taskHref("p", { ...task, kind: "agent", related_id: "c" })).toContain("agentConversation=c")
    expect(taskHref("p", { ...task, kind: "project" })).toBe("/projects/p/settings/business")
  })
})

describe("independent task sources", () => {
  it("keeps successful sources visible when another source fails", async () => {
    mocks.api.mockResolvedValue({ items: [task], has_more: false })
    mocks.backlinks.mockImplementation(async (name) => {
      if (name === "backlinksListRecommendationFeedV2") throw new Error("offline")
      return { items: [], nextCursor: null }
    })
    const { result } = renderHook(() => useTasks(["p"], true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.snapshots.find(s => s.source === "platform")?.items).toEqual([task])
    expect(result.current.snapshots.find(s => s.source === "recommendation")?.error).toBe(true)
    expect(result.current.snapshots.find(s => s.source === "send")?.error).toBe(false)
  })
  it("retains stale results on transient errors but clears permission-denied data", async () => {
    mocks.api.mockResolvedValue({ items: [task], has_more: false })
    mocks.backlinks.mockResolvedValue({ items: [], latestGeneration: null })
    const { result } = renderHook(() => useTasks(["p"], false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    mocks.api.mockRejectedValueOnce(new Error("offline"))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.snapshots.find(s => s.source === "platform")?.error).toBe(true))
    expect(result.current.snapshots.find(s => s.source === "platform")?.items).toHaveLength(1)
    mocks.api.mockRejectedValueOnce(new ApiError(403, "denied"))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.snapshots.find(s => s.source === "platform")?.items).toHaveLength(0))
  })
  it("aborts reads on project changes and ignores late responses without cancelling work", async () => {
    let resolveOld!: (value: unknown) => void
    let oldSignal!: AbortSignal
    mocks.api.mockImplementation((path, options) => {
      if (path.includes("/old/")) {
        oldSignal = options.signal
        return new Promise(resolve => { resolveOld = resolve })
      }
      return Promise.resolve({ items: [{ ...task, id: "new-run" }], has_more: false })
    })
    mocks.backlinks.mockResolvedValue({ items: [], latestGeneration: null })
    const { result, rerender } = renderHook(({ id }) => useTasks([id], true), { initialProps: { id: "old" } })
    rerender({ id: "new" })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => resolveOld({ items: [task], has_more: false }))
    expect(oldSignal.aborted).toBe(true)
    expect(result.current.snapshots.every(s => s.projectId === "new")).toBe(true)
    expect(result.current.snapshots.find(s => s.source === "platform")?.items[0].id).toBe("new-run")
    expect(mocks.api.mock.calls.every(([, options]) => !options.method)).toBe(true)
  })
})
