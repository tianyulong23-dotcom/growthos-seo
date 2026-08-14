import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  refreshArticleBookmark,
  resolveArticleBookmark,
  resolveArticleEmbed,
  type BookmarkResolveResult,
  type EmbedResolveResult,
} from "@/api/articles"
import { ArticleEnhancedCardDialog } from "@/features/content/article-enhanced-card-dialog"

vi.mock("@/api/articles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/articles")>()
  return {
    ...actual,
    refreshArticleBookmark: vi.fn(),
    resolveArticleBookmark: vi.fn(),
    resolveArticleEmbed: vi.fn(),
  }
})

const bookmarkResult: BookmarkResolveResult = {
  kind: "bookmark",
  source_url: "https://example.com/source",
  final_url: "https://example.com/final",
  title: "Primary source",
  description: "Source description",
  publisher: "Example Research",
  icon_url: "https://example.com/icon.png",
  image_url: "https://example.com/cover.jpg",
  fetched_at: "2026-08-09T12:00:00Z",
  error_code: null,
  retryable: false,
}

const embedResult: EmbedResolveResult = {
  kind: "embed",
  source_url: "https://youtu.be/abc123",
  provider: "youtube",
  embed_id: "abc123",
  embed_url: "https://untrusted.example/arbitrary",
  error_code: null,
}

function callbacks() {
  return {
    onOpenChange: vi.fn(),
    onSubmit: vi.fn(),
    onFallback: vi.fn(),
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("article enhanced card dialog", () => {
  it("resolves and previews a bookmark before a second confirmation inserts it", async () => {
    vi.mocked(resolveArticleBookmark).mockResolvedValue(bookmarkResult)
    const handlers = callbacks()
    render(
      <ArticleEnhancedCardDialog
        projectId="project-1"
        articleId="article-1"
        type="bookmark"
        {...handlers}
      />
    )

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/source" },
    })
    fireEvent.click(screen.getByRole("button", { name: "解析并预览" }))

    await screen.findByRole("region", { name: "书签预览" })
    expect(resolveArticleBookmark).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      "https://example.com/source",
      undefined
    )
    expect(handlers.onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "确认插入" }))
    expect(handlers.onSubmit).toHaveBeenCalledWith({
      type: "bookmark",
      attributes: {
        url: "https://example.com/final",
        title: "Primary source",
        description: "Source description",
        publisher: "Example Research",
        icon_url: "https://example.com/icon.png",
        image_url: "https://example.com/cover.jpg",
        fetched_at: "2026-08-09T12:00:00Z",
      },
    })
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("refreshes existing bookmark metadata and preserves its node ID", async () => {
    vi.mocked(refreshArticleBookmark).mockResolvedValue({
      ...bookmarkResult,
      title: "Updated source",
    })
    const handlers = callbacks()
    render(
      <ArticleEnhancedCardDialog
        projectId="project-1"
        articleId="article-1"
        type="bookmark"
        initial={{ node_id: "bookmark-1", ...bookmarkResult, url: bookmarkResult.final_url }}
        {...handlers}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "刷新元数据" }))
    await screen.findByText("Updated source")
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    expect(refreshArticleBookmark).toHaveBeenCalledOnce()
    expect(handlers.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bookmark",
        attributes: expect.objectContaining({
          node_id: "bookmark-1",
          title: "Updated source",
        }),
      })
    )
  })

  it("supports timeout retry and explicit fallback to an ordinary link", async () => {
    vi.mocked(resolveArticleBookmark).mockResolvedValue({
      ...bookmarkResult,
      kind: "link",
      error_code: "asset_import_timeout",
      retryable: true,
    })
    vi.mocked(refreshArticleBookmark).mockRejectedValue(new Error("仍然超时"))
    const handlers = callbacks()
    render(
      <ArticleEnhancedCardDialog
        projectId="project-1"
        articleId="article-1"
        type="bookmark"
        {...handlers}
      />
    )

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://slow.example/source" },
    })
    fireEvent.click(screen.getByRole("button", { name: "解析并预览" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "来源网站响应超时"
    )

    fireEvent.click(screen.getByRole("button", { name: "重试抓取" }))
    expect((await screen.findByRole("alert")).textContent).toContain("仍然超时")
    fireEvent.click(screen.getByRole("button", { name: "改为普通链接" }))

    expect(handlers.onFallback).toHaveBeenCalledWith(
      "https://slow.example/source",
      "Primary source"
    )
    expect(handlers.onSubmit).not.toHaveBeenCalled()
  })

  it("previews only a resolved embed and preserves node ID on save", async () => {
    vi.mocked(resolveArticleEmbed).mockResolvedValue(embedResult)
    const handlers = callbacks()
    render(
      <ArticleEnhancedCardDialog
        projectId="project-1"
        articleId="article-1"
        type="embed"
        initial={{ node_id: "embed-1" }}
        {...handlers}
      />
    )

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://youtu.be/abc123" },
    })
    fireEvent.change(screen.getByLabelText("说明文字"), {
      target: { value: " Product demo " },
    })
    fireEvent.click(screen.getByRole("button", { name: "解析并预览" }))

    const preview = await screen.findByRole("region", { name: "嵌入预览" })
    expect(preview.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123"
    )
    expect(handlers.onSubmit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    expect(handlers.onSubmit).toHaveBeenCalledWith({
      type: "embed",
      attributes: {
        node_id: "embed-1",
        provider: "youtube",
        source_url: "https://youtu.be/abc123",
        embed_id: "abc123",
        caption: "Product demo",
      },
    })
  })

  it("offers ordinary-link fallback for an unsupported embed provider", async () => {
    vi.mocked(resolveArticleEmbed).mockResolvedValue({
      kind: "link",
      source_url: "https://video.example/watch/1",
      provider: null,
      embed_id: null,
      embed_url: null,
      error_code: "embed_provider_unsupported",
    })
    const handlers = callbacks()
    render(
      <ArticleEnhancedCardDialog
        projectId="project-1"
        articleId="article-1"
        type="embed"
        {...handlers}
      />
    )

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://video.example/watch/1" },
    })
    fireEvent.click(screen.getByRole("button", { name: "解析并预览" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "当前仅支持 YouTube、Vimeo 和 Spotify"
    )
    fireEvent.click(screen.getByRole("button", { name: "改为普通链接" }))

    expect(handlers.onFallback).toHaveBeenCalledWith(
      "https://video.example/watch/1",
      "https://video.example/watch/1"
    )
  })

  it("submits a discriminated safe CTA value with target, rel and style", () => {
    const handlers = callbacks()
    render(
      <ArticleEnhancedCardDialog
        projectId="project-1"
        articleId="article-1"
        type="button"
        initial={{ node_id: "button-1" }}
        {...handlers}
      />
    )

    fireEvent.change(screen.getByLabelText("按钮文字"), {
      target: { value: " Read report " },
    })
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/report" },
    })
    fireEvent.click(screen.getByRole("button", { name: "次要" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "在新窗口打开" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "nofollow" }))
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    expect(handlers.onSubmit).toHaveBeenCalledWith({
      type: "button",
      attributes: {
        node_id: "button-1",
        label: "Read report",
        href: "https://example.com/report",
        style: "secondary",
        target: "_blank",
        rel: "nofollow noopener noreferrer",
      },
    })
  })
})
