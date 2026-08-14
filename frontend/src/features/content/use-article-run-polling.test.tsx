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
