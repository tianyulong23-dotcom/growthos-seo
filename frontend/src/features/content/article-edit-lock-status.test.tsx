import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ArticleLock } from "@/api/articles"
import { ArticleEditLockStatusBar } from "@/features/content/article-edit-lock-status"

const blockingLock: ArticleLock = {
  id: "lock-1",
  article_id: "article-1",
  lock_type: "edit_lock",
  version_number: 4,
  owner_id: "editor@example.com",
  reason: "editing",
  fence: 2,
  acquired_at: "2026-08-10T00:00:00Z",
  renewed_at: "2026-08-10T00:00:00Z",
  expires_at: "2026-08-10T00:01:30Z",
  released_at: null,
  token: null,
}

afterEach(cleanup)

describe("ArticleEditLockStatusBar", () => {
  it("shows the holder and requires an audited reason before force release", async () => {
    const onForceRelease = vi.fn().mockResolvedValue(true)
    render(
      <ArticleEditLockStatusBar
        status="blocked"
        lock={blockingLock}
        error="文章正在被其他成员编辑。"
        canForceRelease
        onAcquire={vi.fn().mockResolvedValue(false)}
        onForceRelease={onForceRelease}
      />
    )

    expect(screen.getByText(/持有人：editor@example.com/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "管理解锁" }))
    fireEvent.click(screen.getByRole("button", { name: "强制释放并获取" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "管理解锁必须填写原因。"
    )
    expect(onForceRelease).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("管理解锁原因"), {
      target: { value: "原编辑会话已异常退出" },
    })
    fireEvent.click(screen.getByRole("button", { name: "强制释放并获取" }))
    await waitFor(() => {
      expect(onForceRelease).toHaveBeenCalledWith("原编辑会话已异常退出")
    })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("hides administrative force release without lock management permission", () => {
    render(
      <ArticleEditLockStatusBar
        status="blocked"
        lock={blockingLock}
        error="文章正在被其他成员编辑。"
        canForceRelease={false}
        onAcquire={vi.fn().mockResolvedValue(false)}
        onForceRelease={vi.fn().mockResolvedValue(false)}
      />
    )

    expect(screen.queryByRole("button", { name: "管理解锁" })).toBeNull()
    expect(screen.getByRole("button", { name: "重新获取" })).toBeTruthy()
  })
})
