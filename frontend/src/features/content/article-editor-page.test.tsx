import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RouterProvider, createMemoryRouter } from "react-router"

import { ArticleEditorPage } from "@/features/content/article-editor-page"

const workspace = vi.hoisted(() => ({
  protection: {
    dirty: true,
    flush: vi.fn<() => Promise<boolean>>(),
    protectLocally: vi.fn<() => boolean>(),
  },
}))

vi.mock("@/features/content/article-workspace", () => ({
  ArticleWorkspace: ({
    onBack,
    onProtectionChange,
  }: {
    onBack: () => void
    onProtectionChange?: (value: typeof workspace.protection) => void
  }) => {
    onProtectionChange?.(workspace.protection)
    return (
      <button type="button" onClick={onBack}>
        Back to library
      </button>
    )
  },
}))

function renderPage({ leave = true }: { leave?: boolean } = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:projectId/content/articles/:articleId/edit",
        element: <ArticleEditorPage />,
      },
      {
        path: "/projects/:projectId/content/library",
        element: <p>Content library</p>,
      },
    ],
    { initialEntries: ["/projects/project-1/content/articles/article-1/edit"] }
  )
  render(<RouterProvider router={router} />)
  if (leave) {
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }))
  }
  return router
}

beforeEach(() => {
  vi.clearAllMocks()
  workspace.protection.dirty = true
  workspace.protection.flush.mockResolvedValue(false)
  workspace.protection.protectLocally.mockReturnValue(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ArticleEditorPage leave protection", () => {
  it("leaves without a prompt when the article has no unsaved changes", async () => {
    workspace.protection.dirty = false
    const router = renderPage()

    await screen.findByText("Content library")
    expect(router.state.location.pathname).toBe(
      "/projects/project-1/content/library"
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(workspace.protection.flush).not.toHaveBeenCalled()
  })

  it("leaves after the server autosave succeeds without requiring local storage", async () => {
    workspace.protection.flush.mockResolvedValue(true)
    const router = renderPage()

    fireEvent.click(
      await screen.findByRole("button", { name: "保存草稿并离开" })
    )

    await screen.findByText("Content library")
    expect(router.state.location.pathname).toBe(
      "/projects/project-1/content/library"
    )
    expect(workspace.protection.protectLocally).not.toHaveBeenCalled()
  })

  it("leaves after a failed server save only when local recovery succeeds", async () => {
    workspace.protection.protectLocally.mockReturnValue(true)
    renderPage()

    fireEvent.click(
      await screen.findByRole("button", { name: "保存草稿并离开" })
    )

    await screen.findByText("Content library")
    expect(workspace.protection.flush).toHaveBeenCalledTimes(1)
    expect(workspace.protection.protectLocally).toHaveBeenCalledTimes(1)
  })

  it("stays in the editor when both server and local protection fail", async () => {
    const router = renderPage()

    fireEvent.click(
      await screen.findByRole("button", { name: "保存草稿并离开" })
    )

    expect((await screen.findByRole("alert")).textContent).toBe(
      "草稿保存失败。为避免丢失修改，当前仍停留在编辑器。"
    )
    expect(router.state.location.pathname).toBe(
      "/projects/project-1/content/articles/article-1/edit"
    )
    expect(screen.getByRole("dialog")).toBeTruthy()
  })

  it("uses local recovery when the server save exceeds the leave timeout", async () => {
    workspace.protection.flush.mockReturnValue(new Promise(() => undefined))
    workspace.protection.protectLocally.mockReturnValue(true)
    renderPage()
    const leaveButton = await screen.findByRole("button", {
      name: "保存草稿并离开",
    })
    vi.useFakeTimers()

    fireEvent.click(leaveButton)
    await act(async () => vi.advanceTimersByTimeAsync(1_500))

    expect(screen.getByText("Content library")).toBeTruthy()
    expect(workspace.protection.protectLocally).toHaveBeenCalledTimes(1)
  })
})
