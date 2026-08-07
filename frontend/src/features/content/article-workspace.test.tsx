import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ArticleDetail } from "@/api/articles"
import { ArticleWorkspace } from "@/features/content/article-workspace"

const articleApi = vi.hoisted(() => ({
  getArticle: vi.fn(),
  getArticleRun: vi.fn(),
  cancelArticle: vi.fn(),
}))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

const completedArticle = {
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
  run: {
    id: "run-1",
    article_id: "article-1",
    status: "completed_with_warnings",
    stage: "completed",
    progress: 100,
    warnings: [
      {
        code: "internal_sources_unavailable",
        message: "未取得可用站内页面，本次不插入内链",
      },
    ],
    started_at: "2026-07-29T00:00:00Z",
    soft_deadline_at: null,
    hard_deadline_at: null,
    finished_at: "2026-07-29T00:05:00Z",
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:05:00Z",
  },
  created_at: "2026-07-29T00:00:00Z",
  updated_at: "2026-07-29T00:05:00Z",
  outline: {
    sections: [
      {
        section_id: "section-1",
        heading: "test-heading",
        objective: "test-objective",
      },
    ],
  },
  markdown: "# test-title\n\ntest-body",
  html: "<h1>test-title</h1><p>test-body</p>",
  external_sources: [
    {
      source_type: "authority",
      url: "https://example.test/source",
      title: "test-source",
      domain: "example.test",
    },
  ],
  internal_links: [],
} satisfies ArticleDetail

beforeEach(() => {
  vi.clearAllMocks()
  articleApi.getArticle.mockResolvedValue(completedArticle)
})

afterEach(cleanup)

describe("ArticleWorkspace", () => {
  it("treats completed_with_warnings as complete and keeps the final article", async () => {
    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getAllByText("完整草稿").length).toBeGreaterThan(0)
    })

    expect(screen.queryByText("完成稿")).toBeNull()
    expect(screen.getByText("test-body")).toBeTruthy()
    expect(screen.getByText("test-heading")).toBeTruthy()
    expect(screen.getByText("test-source")).toBeTruthy()
    expect(
      screen.getByText("未取得可用站内页面，本次不插入内链")
    ).toBeTruthy()
    expect(screen.queryByText("取消生成")).toBeNull()
  })

  it("shows inserted internal links in the completed article", async () => {
    articleApi.getArticle.mockResolvedValue({
      ...completedArticle,
      internal_links: [
        {
          source_type: "internal",
          url: "https://example.test/internal",
          title: "test-internal-source",
          domain: "example.test",
        },
      ],
    })

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    expect(await screen.findByText("test-internal-source")).toBeTruthy()
  })

  it("restores a running article from the API after mounting", async () => {
    articleApi.getArticle.mockResolvedValue({
      ...completedArticle,
      status: "running",
      warning_count: 0,
      run: {
        ...completedArticle.run,
        status: "running",
        stage: "writing",
        progress: 65,
        warnings: [],
        finished_at: null,
      },
    })

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    expect(await screen.findByText("撰写正文")).toBeTruthy()
    expect(screen.getByText("65%")).toBeTruthy()
    expect(screen.getByText("取消生成")).toBeTruthy()
  })
})
