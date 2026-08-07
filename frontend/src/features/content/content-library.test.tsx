import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ArticleCollection } from "@/api/articles"
import { ContentLibrary } from "@/features/content/content-library"

const articleApi = vi.hoisted(() => ({ listArticles: vi.fn() }))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

const collection = {
  total: 1,
  page: 1,
  page_size: 20,
  items: [
    {
      id: "article-1",
      project_id: "project-1",
      primary_keyword: "test-keyword",
      title: "test-title",
      slug: "test-title",
      meta_title: "test-title",
      meta_description: "test-description",
      status: "completed_with_warnings",
      publication_status: "complete_draft",
      warning_count: 1,
      run: null,
      created_at: "2026-07-29T00:00:00Z",
      updated_at: "2026-07-29T00:05:00Z",
    },
  ],
} satisfies ArticleCollection

beforeEach(() => {
  vi.clearAllMocks()
  articleApi.listArticles.mockResolvedValue(collection)
})

afterEach(cleanup)

describe("ContentLibrary", () => {
  it("loads the real list and filters by search text", async () => {
    render(<ContentLibrary projectId="project-1" onOpenArticle={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText("test-title")).toBeTruthy()
    })
    expect(articleApi.listArticles).toHaveBeenCalledWith("project-1")
    expect(screen.getByText("完整草稿")).toBeTruthy()
    expect(screen.getByRole("combobox").textContent).toContain("全部状态")

    fireEvent.change(screen.getByPlaceholderText("搜索标题或关键词"), {
      target: { value: "missing" },
    })

    expect(screen.getByText("没有符合条件的文章")).toBeTruthy()
  })
})
