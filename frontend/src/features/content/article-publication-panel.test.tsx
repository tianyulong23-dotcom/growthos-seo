import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleDetail,
  ArticlePreview,
  ArticlePublication,
  ArticlePublicationSnapshot,
  PublicationTarget,
} from "@/api/articles"
import {
  ArticlePublicationPanel,
  scheduleCandidates,
} from "@/features/content/article-publication-panel"

const articleApi = vi.hoisted(() => ({
  cancelArticlePublication: vi.fn(),
  createArticlePreview: vi.fn(),
  createArticlePublication: vi.fn(),
  getArticlePublication: vi.fn(),
  getArticlePublicationSnapshot: vi.fn(),
  getArticleVersion: vi.fn(),
  listArticlePublications: vi.fn(),
  listPublicationTargets: vi.fn(),
  reconcileArticlePublication: vi.fn(),
  retryArticlePublication: vi.fn(),
  revokeArticlePreview: vi.fn(),
}))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

vi.mock("@/features/content/article-typed-diff", () => ({
  ArticleTypedDiff: ({ diff }: { diff: { algorithm_version: string } }) => (
    <div data-testid="published-draft-diff">{diff.algorithm_version}</div>
  ),
}))

const target = {
  id: "target-1",
  adapter_type: "wordpress",
  site_url: "https://wordpress.example",
  capabilities: {
    media_upload: true,
    media_lookup: true,
    post_create: true,
    post_update_by_remote_id: true,
    post_reconcile: true,
  },
  status: "verified",
  updated_at: "2026-08-10T00:00:00Z",
} satisfies PublicationTarget

const article = {
  id: "article-1",
  project_id: "project-1",
  primary_keyword: "solar storage",
  title: "Solar storage",
  slug: "solar-storage",
  meta_title: "Solar storage",
  meta_description: "Storage guide",
  focus_keyword: "solar storage",
  secondary_keywords: [],
  canonical_url: null,
  indexing: "index/follow",
  field_states: {},
  status: "completed",
  publication_status: "publish_ready",
  review_status: "approved",
  review_version: 3,
  document_schema_version: 2,
  current_content_hash: "hash-3",
  current_version_number: 3,
  approved_version_number: 3,
  publication_blocked_reason: null,
  wordpress_post_id: null,
  wordpress_url: null,
  cms_publication_status: null,
  cms_publication_error: null,
  warning_count: 0,
  run: null,
  created_at: "2026-08-10T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
  outline: {},
  document: { type: "doc", schema_version: 2, content: [] },
  markdown: null,
  html: null,
  external_sources: [],
  internal_links: [],
} satisfies ArticleDetail

function publication(
  status: ArticlePublication["status"],
  overrides: Partial<ArticlePublication> = {}
): ArticlePublication {
  return {
    id: `publication-${status}`,
    article_id: article.id,
    version_number: 3,
    target_id: target.id,
    parent_publication_id: null,
    operation: "create",
    mode: "immediate",
    schedule_at_utc: null,
    source_timezone: "Asia/Shanghai",
    status,
    payload_hash: "payload-hash",
    asset_manifest_hash: "asset-hash",
    remote_post_id: status === "published" ? 42 : null,
    remote_url: status === "published" ? "https://wordpress.example/post/42" : null,
    attempt_count: 1,
    last_error_code: status === "failed" ? "wordpress_http_error" : null,
    last_error_detail: null,
    created_by: "publisher-1",
    created_at: "2026-08-10T00:00:00Z",
    updated_at: "2026-08-10T00:01:00Z",
    published_at: status === "published" ? "2026-08-10T00:01:00Z" : null,
    cancelled_at: status === "cancelled" ? "2026-08-10T00:01:00Z" : null,
    media: [],
    allowed_actions:
      status === "failed"
        ? ["retry"]
        : status === "uncertain"
          ? ["reconcile"]
          : status === "queued" || status === "scheduled"
            ? ["cancel"]
            : [],
    ...overrides,
  }
}

function renderPanel(input: {
  publications?: ArticlePublication[]
  autosaveId?: string | null
  article?: ArticleDetail
} = {}) {
  articleApi.listArticlePublications.mockResolvedValue({
    items: input.publications ?? [],
  })
  return render(
    <ArticlePublicationPanel
      projectId="project-1"
      article={input.article ?? article}
      autosaveId={input.autosaveId === undefined ? "autosave-3" : input.autosaveId}
      dirty={false}
      parentWorking={false}
      onRefreshArticle={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  articleApi.listPublicationTargets.mockResolvedValue({ items: [target] })
  articleApi.listArticlePublications.mockResolvedValue({ items: [] })
  articleApi.getArticleVersion.mockResolvedValue({
    version_number: 3,
    document: article.document,
  })
  articleApi.getArticlePublicationSnapshot.mockResolvedValue({
    publication_id: "publication-published",
    published_version_number: 3,
    published_snapshot: {},
    current_draft_version_number: 3,
    current_draft_diff: null,
  })
  articleApi.revokeArticlePreview.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ArticlePublicationPanel", () => {
  it("opens a blank window synchronously, previews the autosave snapshot, and revokes it", async () => {
    let resolvePreview!: (value: ArticlePreview) => void
    const previewPromise = new Promise<ArticlePreview>((resolve) => {
      resolvePreview = resolve
    })
    articleApi.createArticlePreview.mockReturnValue(previewPromise)
    const previewWindow = {
      document: { title: "", body: { textContent: "" } },
      location: { href: "" },
    }
    const open = vi.spyOn(window, "open").mockReturnValue(
      previewWindow as unknown as Window
    )
    renderPanel()

    await screen.findByText("连接已验证")
    fireEvent.click(screen.getByRole("button", { name: "在新窗口生成预览" }))

    expect(open).toHaveBeenCalledWith("", "_blank")
    expect(articleApi.createArticlePreview).toHaveBeenCalledTimes(1)
    expect(previewWindow.document.body.textContent).toContain("正在生成")
    resolvePreview({
      id: "preview-1",
      article_id: article.id,
      source_type: "autosave",
      source_version_number: null,
      autosave_id: "autosave-3",
      target_id: target.id,
      preview_url: "/api/v1/article-previews/preview-1#token=secret",
      expires_at: "2099-08-10T01:00:00Z",
      revoked_at: null,
    })

    await waitFor(() => {
      expect(articleApi.createArticlePreview).toHaveBeenCalledWith(
        "project-1",
        article.id,
        {
          source_type: "autosave",
          autosave_id: "autosave-3",
          target_id: target.id,
        }
      )
      expect(previewWindow.location.href).toContain(
        "/api/v1/article-previews/preview-1#token=secret"
      )
    })
    fireEvent.click(screen.getByRole("button", { name: "撤销链接" }))
    await waitFor(() => {
      expect(articleApi.revokeArticlePreview).toHaveBeenCalledWith(
        "project-1",
        article.id,
        "preview-1"
      )
    })
    expect(await screen.findByText(/已撤销/)).toBeTruthy()
  })

  it("reports a blocked popup without creating a preview", async () => {
    vi.spyOn(window, "open").mockReturnValue(null)
    renderPanel()
    await screen.findByText("连接已验证")

    fireEvent.click(screen.getByRole("button", { name: "在新窗口生成预览" }))

    expect((await screen.findByRole("alert")).textContent).toContain(
      "浏览器阻止了预览窗口"
    )
    expect(articleApi.createArticlePreview).not.toHaveBeenCalled()
  })

  it("creates immediate and scheduled publications with approved version and timezone", async () => {
    articleApi.createArticlePublication
      .mockResolvedValueOnce(publication("queued"))
      .mockResolvedValueOnce(
        publication("scheduled", {
          id: "publication-scheduled",
          mode: "scheduled",
          schedule_at_utc: "2099-01-01T02:00:00Z",
        })
      )
    renderPanel()
    await screen.findByText("连接已验证")

    fireEvent.click(screen.getByRole("button", { name: "发布版本 3" }))
    await waitFor(() => {
      expect(articleApi.createArticlePublication).toHaveBeenNthCalledWith(
        1,
        "project-1",
        article.id,
        {
          version_number: 3,
          target_id: target.id,
          mode: "immediate",
          schedule_at: null,
          source_timezone: expect.any(String),
        },
        expect.any(String)
      )
    })

    cleanup()
    articleApi.listArticlePublications.mockResolvedValue({ items: [] })
    renderPanel()
    await screen.findByText("连接已验证")
    fireEvent.click(screen.getByRole("button", { name: "定时发布" }))
    fireEvent.change(screen.getByLabelText("当地日期和时间"), {
      target: { value: "2099-01-01T10:00" },
    })
    fireEvent.change(screen.getByLabelText("IANA 时区"), {
      target: { value: "Asia/Shanghai" },
    })
    fireEvent.click(screen.getByRole("button", { name: "定时发布版本 3" }))

    await waitFor(() => {
      expect(articleApi.createArticlePublication).toHaveBeenNthCalledWith(
        2,
        "project-1",
        article.id,
        {
          version_number: 3,
          target_id: target.id,
          mode: "scheduled",
          schedule_at: "2099-01-01T10:00:00+08:00",
          source_timezone: "Asia/Shanghai",
        },
        expect.any(String)
      )
    })
  })

  it("publishes the approved snapshot while a newer draft awaits review", async () => {
    const newerDraft = {
      ...article,
      current_content_hash: "hash-4",
      current_version_number: 4,
      review_status: "pending_review" as const,
      review_version: 4,
      approved_version_number: 3,
      publication_blocked_reason: "awaiting_review",
    }
    articleApi.createArticlePublication.mockResolvedValue(publication("queued"))
    renderPanel({ article: newerDraft })
    await screen.findByText("连接已验证")

    const publish = screen.getByRole("button", { name: "发布版本 3" })
    expect((publish as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(publish)

    await waitFor(() => {
      expect(articleApi.createArticlePublication).toHaveBeenCalledWith(
        "project-1",
        article.id,
        expect.objectContaining({ version_number: 3 }),
        expect.any(String)
      )
    })
  })

  it("blocks a first publication when WordPress cannot create or reconcile posts", async () => {
    articleApi.listPublicationTargets.mockResolvedValue({
      items: [{
        ...target,
        capabilities: { ...target.capabilities, post_create: false },
      }],
    })
    renderPanel()

    const publish = await screen.findByRole("button", { name: "发布版本 3" })
    expect((publish as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/缺少发布新文章权限/)).toBeTruthy()
    fireEvent.click(publish)
    expect(articleApi.createArticlePublication).not.toHaveBeenCalled()
  })

  it("blocks an update when WordPress cannot edit the published post", async () => {
    articleApi.listPublicationTargets.mockResolvedValue({
      items: [{
        ...target,
        capabilities: {
          ...target.capabilities,
          post_update_by_remote_id: false,
        },
      }],
    })
    renderPanel({ publications: [publication("published")] })

    const publish = await screen.findByRole("button", { name: "发布版本 3" })
    expect((publish as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/缺少更新已发布文章的权限/)).toBeTruthy()
  })

  it("blocks media publication without both upload and lookup permissions", async () => {
    articleApi.listPublicationTargets.mockResolvedValue({
      items: [{
        ...target,
        capabilities: {
          ...target.capabilities,
          media_lookup: false,
        },
      }],
    })
    articleApi.getArticleVersion.mockResolvedValue({
      version_number: 3,
      document: {
        type: "doc",
        schema_version: 2,
        content: [{
          type: "image",
          attrs: { node_id: "image-1", asset_id: "asset-1" },
        }],
      },
    })
    renderPanel()

    const publish = await screen.findByRole("button", { name: "发布版本 3" })
    expect((publish as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/缺少媒体查询权限/)).toBeTruthy()
  })

  it("rejects nonexistent DST time and exposes both offsets for an ambiguous time", () => {
    expect(scheduleCandidates("2026-03-08T02:30", "America/New_York")).toEqual([])
    expect(
      scheduleCandidates("2026-11-01T01:30", "America/New_York").map(
        (candidate) => candidate.offset
      )
    ).toEqual(["-04:00", "-05:00"])
  })

  it.each([
    ["queued", "取消发布任务", "从失败 checkpoint 续跑", "校准 WordPress 远端状态"],
    ["scheduled", "取消发布任务", "从失败 checkpoint 续跑", "校准 WordPress 远端状态"],
    ["failed", "从失败 checkpoint 续跑", "取消发布任务", "校准 WordPress 远端状态"],
    ["uncertain", "校准 WordPress 远端状态", "取消发布任务", "从失败 checkpoint 续跑"],
  ] as const)(
    "shows only the valid recovery action for %s",
    async (status, allowed, forbiddenOne, forbiddenTwo) => {
      renderPanel({ publications: [publication(status)] })

      expect(await screen.findByRole("button", { name: allowed })).toBeTruthy()
      expect(screen.queryByRole("button", { name: forbiddenOne })).toBeNull()
      expect(screen.queryByRole("button", { name: forbiddenTwo })).toBeNull()
      if (status === "uncertain") {
        expect(screen.getByText(/禁止直接重发/)).toBeTruthy()
      }
    }
  )

  it("renders media checkpoints and the typed diff from the immutable published snapshot", async () => {
    const published = publication("published", {
      media: [
        {
          asset_id: "asset-ready",
          node_id: "image-1",
          item_id: null,
          binding_role: "image",
          variant_hash: "hash-ready",
          status: "ready",
          remote_media_id: 101,
          remote_source_url: "https://wordpress.example/media/101.jpg",
          error_code: null,
        },
        {
          asset_id: "asset-failed",
          node_id: "gallery-1",
          item_id: "item-2",
          binding_role: "gallery_item",
          variant_hash: "hash-failed",
          status: "failed",
          remote_media_id: null,
          remote_source_url: null,
          error_code: "wordpress_media_upload_failed",
        },
      ],
    })
    articleApi.getArticlePublicationSnapshot.mockResolvedValue({
      publication_id: published.id,
      published_version_number: 3,
      published_snapshot: { version_number: 3 },
      current_draft_version_number: 4,
      current_draft_diff: {
        from_version: {
          id: "version-3",
          run_id: "run-1",
          version_number: 3,
          version_type: "manual_edit",
          review_version: 3,
          created_by: "editor-1",
          restored_from_version_id: null,
          restorable: true,
          created_at: "2026-08-10T08:00:00Z",
        },
        to_version: {
          id: "version-4",
          run_id: "run-1",
          version_number: 4,
          version_type: "manual_edit",
          review_version: 4,
          created_by: "editor-1",
          restored_from_version_id: null,
          restorable: true,
          created_at: "2026-08-10T09:00:00Z",
        },
        algorithm_version: "article-typed-diff.v1",
        summary: {
          blocks_added: 0,
          blocks_removed: 0,
          blocks_moved: 0,
          blocks_updated: 0,
          inline_changes: 0,
          media_changes: 0,
          table_changes: 0,
          metadata_changes: 0,
        },
        block_changes: [],
        inline_changes: [],
        media_changes: [],
        table_changes: [],
        added_lines: 0,
        removed_lines: 0,
        truncated: false,
        metadata_changes: [],
        lines: [],
      },
    } satisfies ArticlePublicationSnapshot)
    renderPanel({
      publications: [published],
      article: { ...article, current_version_number: 4 },
    })

    expect(await screen.findByText("1/2")).toBeTruthy()
    expect(screen.getByText(/WordPress #101/)).toBeTruthy()
    expect(screen.getByText("wordpress_media_upload_failed")).toBeTruthy()
    expect((await screen.findByTestId("published-draft-diff")).textContent).toBe(
      "article-typed-diff.v1"
    )
    expect(articleApi.getArticlePublicationSnapshot).toHaveBeenCalledWith(
      "project-1",
      published.id
    )
  })

  it("polls active attempts and refreshes the article when the state becomes terminal", async () => {
    const queued = publication("queued")
    const interval = vi.spyOn(window, "setInterval")
    const onRefreshArticle = vi.fn().mockResolvedValue(undefined)
    articleApi.listArticlePublications.mockResolvedValue({ items: [queued] })
    articleApi.getArticlePublication.mockResolvedValue(
      publication("published", { id: queued.id })
    )
    render(
      <ArticlePublicationPanel
        projectId="project-1"
        article={article}
        autosaveId={null}
        dirty={false}
        parentWorking={false}
        onRefreshArticle={onRefreshArticle}
      />
    )
    await screen.findByText("等待发布")
    await waitFor(() => expect(interval).toHaveBeenCalled())
    const pollingCall = interval.mock.calls.find((call) => call[1] === 2500)
    expect(pollingCall).toBeTruthy()
    const callback = pollingCall![0] as TimerHandler

    await act(async () => {
      if (typeof callback === "function") callback()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(articleApi.getArticlePublication).toHaveBeenCalledWith(
        "project-1",
        queued.id
      )
      expect(onRefreshArticle).toHaveBeenCalled()
    })
  })
})
