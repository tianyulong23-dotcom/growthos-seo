import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
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
      focus_keyword: "test-keyword",
      secondary_keywords: [],
      canonical_url: null,
      indexing: "index/follow",
      field_states: {},
      status: "completed_with_warnings",
      publication_status: "complete_draft",
      review_status: "pending_review",
      review_version: 1,
      document_schema_version: 2,
      current_content_hash: "content-hash-1",
      current_version_number: 1,
      approved_version_number: null,
      publication_blocked_reason: "quality_not_ready",
      wordpress_post_id: null,
      wordpress_url: null,
      cms_publication_status: null,
      cms_publication_error: null,
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
    expect(articleApi.listArticles).toHaveBeenCalledWith("project-1", {
      page: 1,
      pageSize: 20,
      search: "",
      status: undefined,
    })
    expect(screen.getByText("完整草稿")).toBeTruthy()
    expect(screen.getByRole("combobox").textContent).toContain("全部状态")

    fireEvent.change(screen.getByPlaceholderText("搜索标题或关键词"), {
      target: { value: "missing" },
    })

    await waitFor(() => {
      expect(articleApi.listArticles).toHaveBeenLastCalledWith("project-1", {
        page: 1,
        pageSize: 20,
        search: "missing",
        status: undefined,
      })
    })
  })
})
