import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ArticleSummary } from "@/api/articles"
import { CreateArticleDialog } from "@/features/content/create-article-dialog"

const articleApi = vi.hoisted(() => ({ createArticle: vi.fn() }))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

const queuedArticle = {
  id: "article-1",
  project_id: "project-1",
  primary_keyword: "test-keyword",
  title: null,
  slug: null,
  meta_title: null,
  meta_description: null,
  status: "queued",
  publication_status: "complete_draft",
  warning_count: 0,
  run: null,
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:00:00Z",
} satisfies ArticleSummary

beforeEach(() => {
  vi.clearAllMocks()
  articleApi.createArticle.mockResolvedValue(queuedArticle)
})

afterEach(cleanup)

describe("CreateArticleDialog", () => {
  it("submits only the keyword with a client UUID", async () => {
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    const uuid = "00000000-0000-4000-8000-000000000001"
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid)

    render(
      <CreateArticleDialog
        projectId="project-1"
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    )

    expect(screen.getAllByRole("textbox")).toHaveLength(1)

    fireEvent.change(screen.getByLabelText("主关键词"), {
      target: { value: "  test-keyword  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "生成" }))

    await waitFor(() => {
      expect(articleApi.createArticle).toHaveBeenCalledWith(
        "project-1",
        "test-keyword",
        uuid
      )
      expect(onCreated).toHaveBeenCalledWith(queuedArticle)
    })
  })

  it("ignores rapid duplicate submissions while the first request is pending", async () => {
    let resolveCreate: ((article: ArticleSummary) => void) | undefined
    articleApi.createArticle.mockReturnValue(
      new Promise<ArticleSummary>((resolve) => {
        resolveCreate = resolve
      })
    )

    render(
      <CreateArticleDialog
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText("主关键词"), {
      target: { value: "test-keyword" },
    })
    const form = screen.getByRole("button", { name: "生成" }).closest("form")
    expect(form).not.toBeNull()
    fireEvent.submit(form!)
    fireEvent.submit(form!)

    expect(articleApi.createArticle).toHaveBeenCalledTimes(1)

    resolveCreate?.(queuedArticle)
    await waitFor(() => {
      expect(articleApi.createArticle).toHaveBeenCalledTimes(1)
    })
  })

  it("reuses the idempotency key when retrying the same keyword", async () => {
    const uuid = "00000000-0000-4000-8000-000000000002"
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid)
    articleApi.createArticle
      .mockRejectedValueOnce(new Error("网络连接失败"))
      .mockResolvedValueOnce(queuedArticle)

    render(
      <CreateArticleDialog
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText("主关键词"), {
      target: { value: "test-keyword" },
    })
    fireEvent.click(screen.getByRole("button", { name: "生成" }))

    await screen.findByText("网络连接失败")
    fireEvent.click(screen.getByRole("button", { name: "生成" }))

    await waitFor(() => {
      expect(articleApi.createArticle).toHaveBeenCalledTimes(2)
    })
    expect(articleApi.createArticle).toHaveBeenNthCalledWith(
      1,
      "project-1",
      "test-keyword",
      uuid
    )
    expect(articleApi.createArticle).toHaveBeenNthCalledWith(
      2,
      "project-1",
      "test-keyword",
      uuid
    )
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })
})
