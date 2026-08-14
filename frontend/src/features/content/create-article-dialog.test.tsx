import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
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
  focus_keyword: "test-keyword",
  secondary_keywords: [],
  canonical_url: null,
  indexing: "index/follow",
  field_states: {},
  status: "queued",
  publication_status: "complete_draft",
  review_status: null,
  review_version: 0,
  document_schema_version: 2,
  current_content_hash: "",
  current_version_number: 0,
  approved_version_number: null,
  publication_blocked_reason: null,
  wordpress_post_id: null,
  wordpress_url: null,
  cms_publication_status: null,
  cms_publication_error: null,
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
  it("inherits the project language and submits only the creation fields", async () => {
    const onCreated = vi.fn()
    const onOpenChange = vi.fn()
    const uuid = "00000000-0000-4000-8000-000000000001"
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid)

    render(
      <CreateArticleDialog
        projectId="project-1"
        projectLanguage="pt-BR"
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    )

    expect(
      screen.getByRole("heading", { name: "创建文章生成任务" })
    ).toBeTruthy()
    expect(screen.queryByText("文章类型")).toBeNull()
    expect(screen.queryByText("次关键词")).toBeNull()
    expect(screen.queryByText("写作方向（可选）")).toBeNull()
    expect(
      screen.getByRole("combobox", { name: "选择文章语言" }).textContent
    ).toContain("葡萄牙语（巴西）")

    fireEvent.change(screen.getByLabelText("关键词"), {
      target: { value: "  test-keyword  " },
    })
    fireEvent.change(screen.getByLabelText("标题（可选）"), {
      target: { value: "  Test title  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }))

    await waitFor(() => {
      expect(articleApi.createArticle).toHaveBeenCalledWith(
        "project-1",
        {
          primary_keyword: "test-keyword",
          title: "Test title",
          language: "pt-BR",
        },
        uuid
      )
      expect(onCreated).toHaveBeenCalledWith(queuedArticle)
    })
  })

  it("allows the inherited project language to be changed", async () => {
    render(
      <CreateArticleDialog
        projectId="project-1"
        projectLanguage="pt-BR"
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("combobox", { name: "选择文章语言" }))
    fireEvent.click(await screen.findByText("英语"))
    fireEvent.change(screen.getByLabelText("关键词"), {
      target: { value: "test-keyword" },
    })
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }))

    await waitFor(() => {
      expect(articleApi.createArticle).toHaveBeenCalledWith(
        "project-1",
        {
          primary_keyword: "test-keyword",
          title: null,
          language: "en",
        },
        expect.any(String)
      )
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
        projectLanguage="en"
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText("关键词"), {
      target: { value: "test-keyword" },
    })
    const form = screen
      .getByRole("button", { name: "开始生成" })
      .closest("form")
    expect(form).not.toBeNull()
    fireEvent.submit(form!)
    fireEvent.submit(form!)

    expect(articleApi.createArticle).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("status").textContent).toContain("正在创建文章任务")

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
        projectLanguage="en"
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />
    )

    fireEvent.change(screen.getByLabelText("关键词"), {
      target: { value: "test-keyword" },
    })
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }))

    await screen.findByText("网络连接失败")
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }))

    await waitFor(() => {
      expect(articleApi.createArticle).toHaveBeenCalledTimes(2)
    })
    expect(articleApi.createArticle).toHaveBeenNthCalledWith(
      1,
      "project-1",
      {
        primary_keyword: "test-keyword",
        title: null,
        language: "en",
      },
      uuid
    )
    expect(articleApi.createArticle).toHaveBeenNthCalledWith(
      2,
      "project-1",
      {
        primary_keyword: "test-keyword",
        title: null,
        language: "en",
      },
      uuid
    )
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })
})
