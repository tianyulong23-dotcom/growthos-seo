import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ArticleLock } from "@/api/articles"
import { ApiError } from "@/api/client"
import { useArticleEditLock } from "@/features/content/use-article-edit-lock"

const articleApi = vi.hoisted(() => ({
  acquireArticleLock: vi.fn(),
  forceReleaseArticleLock: vi.fn(),
  getActiveArticleLock: vi.fn(),
  releaseArticleLock: vi.fn(),
  renewArticleLock: vi.fn(),
}))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

function lock(overrides: Partial<ArticleLock> = {}): ArticleLock {
  return {
    id: "lock-1",
    article_id: "article-1",
    lock_type: "edit_lock",
    version_number: null,
    owner_id: "editor-1",
    reason: "article_editor",
    fence: 3,
    acquired_at: "2026-08-10T00:00:00Z",
    renewed_at: "2026-08-10T00:00:00Z",
    expires_at: "2026-08-10T00:01:30Z",
    released_at: null,
    token: "t".repeat(48),
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-08-10T00:00:00Z"))
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  articleApi.acquireArticleLock.mockResolvedValue(lock())
  articleApi.renewArticleLock.mockResolvedValue(
    lock({ renewed_at: "2026-08-10T00:00:30Z", expires_at: "2026-08-10T00:02:00Z" })
  )
  articleApi.releaseArticleLock.mockResolvedValue(
    lock({ released_at: "2026-08-10T00:00:10Z", token: null })
  )
  articleApi.forceReleaseArticleLock.mockResolvedValue(
    lock({ released_at: "2026-08-10T00:00:10Z", token: null })
  )
  articleApi.getActiveArticleLock.mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useArticleEditLock", () => {
  it("acquires a 90 second in-memory lease, renews every 30 seconds, and releases on close", async () => {
    const onLost = vi.fn()
    const hook = renderHook(() =>
      useArticleEditLock({
        projectId: "project-1",
        articleId: "article-1",
        enabled: true,
        onLost,
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hook.result.current.status).toBe("held")
    expect(articleApi.acquireArticleLock).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      {
        lock_type: "edit_lock",
        reason: "article_editor",
        lease_seconds: 90,
      }
    )
    expect(hook.result.current.credential).toEqual({
      lockId: "lock-1",
      token: "t".repeat(48),
      fence: 3,
    })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(articleApi.renewArticleLock).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      { lockId: "lock-1", token: "t".repeat(48), fence: 3 },
      90
    )

    hook.unmount()
    expect(articleApi.releaseArticleLock).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      { lockId: "lock-1", token: "t".repeat(48), fence: 3 },
      "editor_closed",
      { keepalive: true }
    )
    expect(onLost).not.toHaveBeenCalled()
  })

  it("releases with keepalive when the page is hidden for reload or close", async () => {
    const hook = renderHook(() =>
      useArticleEditLock({
        projectId: "project-1",
        articleId: "article-1",
        enabled: true,
        onLost: vi.fn(),
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))

    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))

    expect(articleApi.releaseArticleLock).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      { lockId: "lock-1", token: "t".repeat(48), fence: 3 },
      "editor_closed",
      { keepalive: true }
    )
    hook.unmount()
    expect(articleApi.releaseArticleLock).toHaveBeenCalledTimes(1)
  })

  it("shows the active holder when acquisition conflicts", async () => {
    articleApi.acquireArticleLock.mockRejectedValue(
      new ApiError(409, "held", { code: "article_lock_already_held" })
    )
    articleApi.getActiveArticleLock.mockResolvedValue(
      lock({ owner_id: "other-editor", token: null })
    )
    const hook = renderHook(() =>
      useArticleEditLock({
        projectId: "project-1",
        articleId: "article-1",
        enabled: true,
        onLost: vi.fn(),
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(hook.result.current.status).toBe("blocked")
    expect(hook.result.current.lock?.owner_id).toBe("other-editor")
    expect(hook.result.current.credential).toBeNull()
    expect(hook.result.current.error).toBe("文章正在被其他成员编辑。")
  })

  it("drops credentials and invokes protection when renewal loses the lease", async () => {
    const onLost = vi.fn()
    articleApi.renewArticleLock.mockRejectedValue(
      new ApiError(409, "expired", { code: "article_lock_expired" })
    )
    const hook = renderHook(() =>
      useArticleEditLock({
        projectId: "project-1",
        articleId: "article-1",
        enabled: true,
        onLost,
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(hook.result.current.status).toBe("lost")
    expect(hook.result.current.credential).toBeNull()
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it("keeps the lease after a transient renewal failure recovers", async () => {
    const onLost = vi.fn()
    articleApi.renewArticleLock
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        lock({
          renewed_at: "2026-08-10T00:00:31Z",
          expires_at: "2026-08-10T00:02:01Z",
        })
      )
    const hook = renderHook(() =>
      useArticleEditLock({
        projectId: "project-1",
        articleId: "article-1",
        enabled: true,
        onLost,
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))
    await act(async () => vi.advanceTimersByTimeAsync(30_000))

    expect(hook.result.current.status).toBe("held")
    expect(articleApi.renewArticleLock).toHaveBeenCalledTimes(1)

    await act(async () => vi.advanceTimersByTimeAsync(1_000))
    expect(articleApi.renewArticleLock).toHaveBeenCalledTimes(2)
    expect(hook.result.current.status).toBe("held")
    expect(hook.result.current.lock?.expires_at).toBe(
      "2026-08-10T00:02:01Z"
    )
    expect(onLost).not.toHaveBeenCalled()
  })

  it("retries transient failures only until the authoritative lease expires", async () => {
    const onLost = vi.fn()
    articleApi.renewArticleLock.mockRejectedValue(
      new ApiError(503, "temporarily unavailable", { retryable: true })
    )
    const hook = renderHook(() =>
      useArticleEditLock({
        projectId: "project-1",
        articleId: "article-1",
        enabled: true,
        onLost,
      })
    )
    await act(async () => vi.advanceTimersByTimeAsync(0))
    await act(async () => vi.advanceTimersByTimeAsync(89_999))

    expect(hook.result.current.status).toBe("held")
    expect(articleApi.renewArticleLock.mock.calls.length).toBeGreaterThan(1)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(hook.result.current.status).toBe("lost")
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it.each([
    [401, "unauthorized", undefined],
    [403, "forbidden", undefined],
    [409, "stale fence", "article_lock_stale_fence"],
  ])(
    "does not retry an immediate %s renewal failure",
    async (status, message, code) => {
      const onLost = vi.fn()
      articleApi.renewArticleLock.mockRejectedValue(
        new ApiError(status, message, code ? { code } : undefined)
      )
      const hook = renderHook(() =>
        useArticleEditLock({
          projectId: "project-1",
          articleId: "article-1",
          enabled: true,
          onLost,
        })
      )
      await act(async () => vi.advanceTimersByTimeAsync(0))
      await act(async () => vi.advanceTimersByTimeAsync(30_000))
      await act(async () => vi.advanceTimersByTimeAsync(10_000))

      expect(articleApi.renewArticleLock).toHaveBeenCalledTimes(1)
      expect(hook.result.current.status).toBe("lost")
      expect(onLost).toHaveBeenCalledTimes(1)
    }
  )

  it("force releases a blocking lock with its reason and reacquires", async () => {
    articleApi.acquireArticleLock
      .mockRejectedValueOnce(
        new ApiError(409, "held", { code: "article_lock_already_held" })
      )
      .mockResolvedValueOnce(lock({ id: "lock-2", fence: 4 }))
    articleApi.getActiveArticleLock.mockResolvedValue(
      lock({ owner_id: "other-editor", token: null })
    )
    const hook = renderHook(() =>
      useArticleEditLock({
        projectId: "project-1",
        articleId: "article-1",
        enabled: true,
        onLost: vi.fn(),
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      expect(await hook.result.current.forceRelease("原会话异常退出")).toBe(true)
    })

    expect(articleApi.forceReleaseArticleLock).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      "lock-1",
      "原会话异常退出"
    )
    expect(hook.result.current.status).toBe("held")
    expect(hook.result.current.credential?.lockId).toBe("lock-2")
  })
})
