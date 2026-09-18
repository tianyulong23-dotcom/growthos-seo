import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ArticleRun } from "@/api/articles"
import { useArticleRunPolling } from "@/features/content/use-article-run-polling"

const runningRun = {
  id: "run-1",
  article_id: "article-1",
  status: "running",
  stage: "writing",
  progress: 65,
  warnings: [],
  error_code: null,
  error_detail: null,
  failed_stage: null,
  retryable: null,
  trigger_type: "initial",
  parent_run_id: null,
  started_at: "2026-07-29T00:00:00Z",
  soft_deadline_at: null,
  hard_deadline_at: null,
  finished_at: null,
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:00:00Z",
} satisfies ArticleRun

afterEach(() => {
  vi.useRealTimers()
})

describe("useArticleRunPolling", () => {
  it("keeps separate projects independent and does not overlap slow reads", async () => {
    vi.useFakeTimers()
    const slowRead = new Promise<ArticleRun>(() => {})
    const fetchRun = vi.fn((projectId: string) =>
      projectId === "project-1"
        ? slowRead
        : Promise.resolve({ ...runningRun, status: "completed" } as ArticleRun)
    )
    const firstChange = vi.fn()
    const secondChange = vi.fn()
    const onError = vi.fn()
    const onTerminal = vi.fn()
    const hook = renderHook(() => {
      useArticleRunPolling({
        projectId: "project-1",
        articleId: "article-1",
        run: runningRun,
        fetchRun,
        onRunChange: firstChange,
        onTerminal,
        onError,
        intervalMs: 10,
      })
      useArticleRunPolling({
        projectId: "project-2",
        articleId: "article-2",
        run: runningRun,
        fetchRun,
        onRunChange: secondChange,
        onTerminal,
        onError,
        intervalMs: 10,
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(fetchRun).toHaveBeenCalledTimes(2)
    expect(firstChange).not.toHaveBeenCalled()
    expect(secondChange).toHaveBeenCalledOnce()
    hook.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(fetchRun).toHaveBeenCalledTimes(2)
  })

  it("reads the current server result after leaving and returning", async () => {
    vi.useFakeTimers()
    const onRunChange = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()
    const fetchRun = vi.fn().mockResolvedValue(runningRun)
    const options = {
      projectId: "project-1",
      articleId: "article-1",
      run: runningRun,
      fetchRun,
      onRunChange,
      onTerminal,
      onError,
      intervalMs: 10,
    }
    const first = renderHook(() => useArticleRunPolling(options))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    first.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(fetchRun).toHaveBeenCalledOnce()
    const completed = { ...runningRun, status: "completed" } as ArticleRun
    fetchRun.mockResolvedValue(completed)
    renderHook(() => useArticleRunPolling(options))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(onRunChange).toHaveBeenLastCalledWith(completed)
    expect(onTerminal).toHaveBeenCalledWith(completed)
  })

  it("recovers from a temporary read failure without restarting the task", async () => {
    vi.useFakeTimers()
    const completed = {
      ...runningRun,
      status: "completed",
    } satisfies ArticleRun
    const fetchRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(completed)
    const onRunChange = vi.fn()
    const onTerminal = vi.fn()
    const onError = vi.fn()
    renderHook(() =>
      useArticleRunPolling({
        projectId: "project-1",
        articleId: "article-1",
        run: runningRun,
        fetchRun,
        onRunChange,
        onTerminal,
        onError,
        intervalMs: 10,
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(onError).toHaveBeenCalledWith("offline")
    expect(onRunChange).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(onRunChange).toHaveBeenCalledWith(completed)
    expect(onTerminal).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(fetchRun).toHaveBeenCalledTimes(2)
  })

  it("publishes completed_with_warnings as a terminal result", async () => {
    vi.useFakeTimers()
    const completed = {
      ...runningRun,
      status: "completed_with_warnings",
      stage: "completed",
      progress: 100,
      warnings: [{ code: "research_unavailable", message: "联网资料暂不可用" }],
    } satisfies ArticleRun
    const onRunChange = vi.fn()
    const onTerminal = vi.fn()

    renderHook(() =>
      useArticleRunPolling({
        projectId: "project-1",
        articleId: "article-1",
        run: runningRun,
        onRunChange,
        onError: vi.fn(),
        onTerminal,
        fetchRun: vi.fn().mockResolvedValue(completed),
        intervalMs: 10,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(onRunChange).toHaveBeenCalledWith(completed)
    expect(onTerminal).toHaveBeenCalledWith(completed)
  })

  it("ignores an in-flight response after the project changes", async () => {
    vi.useFakeTimers()
    let resolvePoll: ((run: ArticleRun) => void) | undefined
    const fetchRun = vi.fn(
      () =>
        new Promise<ArticleRun>((resolve) => {
          resolvePoll = resolve
        })
    )
    const onRunChange = vi.fn()
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useArticleRunPolling({
          projectId,
          articleId: "article-1",
          run: runningRun,
          onRunChange,
          onError: vi.fn(),
          onTerminal: vi.fn(),
          fetchRun,
          intervalMs: 10,
        }),
      { initialProps: { projectId: "project-1" } }
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    rerender({ projectId: "project-2" })

    await act(async () => {
      resolvePoll?.({ ...runningRun, status: "completed" })
      await Promise.resolve()
    })

    expect(onRunChange).not.toHaveBeenCalled()
  })
})
