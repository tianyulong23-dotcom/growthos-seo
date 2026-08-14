import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleDetail,
  ArticleDocumentCapabilities,
  ArticleMetadataSnapshot,
} from "@/api/articles"
import { ApiError } from "@/api/client"
import {
  ArticleEditor,
  type ArticleEditorHandle,
} from "@/features/content/article-editor"
import { ArticleGovernancePanel } from "@/features/content/article-governance-panel"
import { saveLocalArticleBackup } from "@/features/content/article-recovery"
import { ArticleWorkspace } from "@/features/content/article-workspace"

const articleApi = vi.hoisted(() => ({
  getArticle: vi.fn(),
  getArticleRun: vi.fn(),
  cancelArticle: vi.fn(),
  retryArticle: vi.fn(),
  regenerateArticle: vi.fn(),
  getArticleDocumentCapabilities: vi.fn(),
  getLatestArticleAutosave: vi.fn(),
  saveArticleAutosave: vi.fn(),
  deleteArticleAutosave: vi.fn(),
  saveArticleDocument: vi.fn(),
  reviewArticle: vi.fn(),
  listArticleVersions: vi.fn(),
  getArticleVersion: vi.fn(),
  compareArticleVersions: vi.fn(),
  restoreArticleVersion: vi.fn(),
  getLatestArticleSeoAnalysis: vi.fn(),
  getLatestArticleLinkAnalysis: vi.fn(),
  analyzeArticleLinks: vi.fn(),
  getInternalLinkCandidates: vi.fn(),
  getFactSourceCandidates: vi.fn(),
  acquireArticleLock: vi.fn(),
  getActiveArticleLock: vi.fn(),
  renewArticleLock: vi.fn(),
  releaseArticleLock: vi.fn(),
  forceReleaseArticleLock: vi.fn(),
  listArticleReviewTasks: vi.fn(),
  listArticleReviewInbox: vi.fn(),
  submitArticleReview: vi.fn(),
  claimArticleReviewTask: vi.fn(),
  addArticleReviewComment: vi.fn(),
  decideArticleReviewTask: vi.fn(),
  cancelArticleReviewTask: vi.fn(),
  getArticleReviewSnapshot: vi.fn(),
}))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

vi.mock("@/features/content/article-publication-panel", () => ({
  ArticlePublicationPanel: () => <div data-testid="publication-panel" />,
}))

const completedArticle = {
  id: "article-1",
  project_id: "project-1",
  primary_keyword: "test-keyword",
  title: "test-title",
  slug: "test-title",
  meta_title: "test-title",
  meta_description: "test-description",
  focus_keyword: "test-keyword",
  secondary_keywords: ["secondary-keyword"],
  canonical_url: "https://example.test/test-title",
  indexing: "index/follow",
  field_states: {
    title: "confirmed",
    slug: "generated",
    focus_keyword: "confirmed",
    secondary_keywords: "modified",
    meta_title: "confirmed",
    meta_description: "modified",
    canonical_url: "confirmed",
    indexing: "confirmed",
  },
  status: "completed_with_warnings",
  publication_status: "complete_draft",
  review_status: "pending_review",
  review_version: 1,
  document_schema_version: 2,
  current_content_hash: "",
  current_version_number: 1,
  approved_version_number: null,
  publication_blocked_reason: "quality_not_ready",
  wordpress_post_id: null,
  wordpress_url: null,
  cms_publication_status: null,
  cms_publication_error: null,
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
    error_code: null,
    error_detail: null,
    failed_stage: null,
    retryable: null,
    trigger_type: "initial",
    parent_run_id: null,
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
  document: {
    type: "doc",
    schema_version: 2,
    content: [
      {
        type: "heading",
        attrs: { level: 2, node_id: "blk_test_heading" },
        content: [{ type: "text", text: "test-title" }],
      },
      {
        type: "paragraph",
        attrs: { node_id: "blk_test_paragraph" },
        content: [{ type: "text", text: "test-body" }],
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

const editLock = {
  id: "lock-1",
  article_id: "article-1",
  lock_type: "edit_lock" as const,
  version_number: 1,
  owner_id: "editor-1",
  reason: "article_editor",
  fence: 7,
  acquired_at: "2026-08-10T00:00:00Z",
  renewed_at: "2026-08-10T00:00:00Z",
  expires_at: "2026-08-10T00:01:30Z",
  released_at: null,
  token: "t".repeat(32),
}

const lockCredential = {
  lockId: editLock.id,
  token: editLock.token,
  fence: editLock.fence,
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  })
  localStorage.clear()
  sessionStorage.clear()
  articleApi.getArticle.mockResolvedValue(completedArticle)
  articleApi.getArticleDocumentCapabilities.mockResolvedValue({
    schema_version: 2,
    writable: true,
    recovery_scope: "scope-user-1",
    nodes: ["doc", "paragraph", "heading", "text"],
    marks: ["bold", "italic", "link"],
    heading_levels: [2, 3, 4, 5, 6],
    asset_types: ["image", "video", "audio", "file"],
    media_upload_enabled: false,
    can_manage_seo_advanced: false,
    limits: {},
  })
  articleApi.getLatestArticleAutosave.mockResolvedValue(null)
  articleApi.deleteArticleAutosave.mockResolvedValue(undefined)
  articleApi.listArticleVersions.mockResolvedValue({ items: [] })
  articleApi.getLatestArticleSeoAnalysis.mockResolvedValue(null)
  articleApi.getLatestArticleLinkAnalysis.mockResolvedValue(null)
  articleApi.analyzeArticleLinks.mockResolvedValue(null)
  articleApi.getInternalLinkCandidates.mockResolvedValue({ items: [] })
  articleApi.getFactSourceCandidates.mockResolvedValue({ items: [] })
  articleApi.acquireArticleLock.mockResolvedValue(editLock)
  articleApi.getActiveArticleLock.mockResolvedValue(null)
  articleApi.renewArticleLock.mockResolvedValue(editLock)
  articleApi.releaseArticleLock.mockResolvedValue({
    ...editLock,
    released_at: "2026-08-10T00:00:30Z",
    token: null,
  })
  articleApi.forceReleaseArticleLock.mockResolvedValue({
    ...editLock,
    released_at: "2026-08-10T00:00:30Z",
    token: null,
  })
  articleApi.listArticleReviewTasks.mockResolvedValue({ items: [] })
  articleApi.listArticleReviewInbox.mockResolvedValue({ items: [] })
})

afterEach(cleanup)

describe("ArticleWorkspace", () => {
  it("exposes a top-level publish action that opens the publication panel", async () => {
    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    await screen.findByText("test-body")
    const saveButton = screen.getByRole("button", { name: "保存" })
    const publishButton = screen.getByRole("button", { name: "发布" })
    const moreButton = screen.getByRole("button", { name: "更多文章操作" })

    expect(saveButton.className).toContain("border-border")
    expect(publishButton.className).toContain("bg-primary")
    expect(
      saveButton.compareDocumentPosition(publishButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      publishButton.compareDocumentPosition(moreButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    fireEvent.click(publishButton)

    expect(
      screen.getByRole("tab", { name: "发布" }).getAttribute("aria-selected")
    ).toBe("true")
    expect(await screen.findByTestId("publication-panel")).toBeTruthy()
  })

  it("clears the lock-loss alert after the editor reacquires the lease", async () => {
    articleApi.saveArticleDocument.mockRejectedValueOnce(
      new ApiError(409, "missing", { code: "article_edit_lock_not_found" })
    )
    articleApi.acquireArticleLock
      .mockResolvedValueOnce(editLock)
      .mockResolvedValueOnce({ ...editLock, id: "lock-2", fence: 8 })

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    await screen.findByText("test-body")
    const metaTitle = screen.getByLabelText("Meta 标题") as HTMLInputElement
    await waitFor(() => expect(metaTitle.disabled).toBe(false))
    fireEvent.change(metaTitle, {
      target: { value: "test-title with an unsaved change" },
    })
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    expect(
      await screen.findByText(
        "编辑锁已失效，当前修改已保护到本地，编辑器已转为只读。"
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "重新获取" }))

    await waitFor(() => {
      expect(articleApi.acquireArticleLock).toHaveBeenCalledTimes(2)
      expect(
        screen.queryByText(
          "编辑锁已失效，当前修改已保护到本地，编辑器已转为只读。"
        )
      ).toBeNull()
    })
  })

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
    expect(await screen.findByText("test-body")).toBeTruthy()
    expect(screen.getByLabelText("文章治理面板")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "打开文章治理" })).toBeNull()
    expect(screen.queryByRole("button", { name: "关闭文章治理" })).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "来源" }))
    expect(screen.getByText("test-source")).toBeTruthy()
    expect(screen.getByText("未取得可用站内页面，本次不插入内链")).toBeTruthy()
    expect(screen.queryByText("取消生成")).toBeNull()
    expect(
      screen.getByLabelText("文章编辑工作区").getAttribute("data-layout")
    ).toBe("fullscreen")
    expect(screen.getByLabelText("文章正文编辑区")).toBeTruthy()
    expect(screen.getByLabelText("文章治理面板")).toBeTruthy()
  })

  it("opens the shadcn article actions menu without crashing", async () => {
    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    expect(await screen.findByText("test-body")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "更多文章操作" }))

    expect(await screen.findByText("重新生成文章")).toBeTruthy()
    expect(screen.queryByText("页面暂时没有加载成功")).toBeNull()
  })

  it("keeps governance visible without collapse controls on mobile", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    })

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    expect(await screen.findByText("test-body")).toBeTruthy()
    const governancePanel = await screen.findByLabelText("文章治理面板")
    expect(governancePanel.className).toContain("h-[48rem]")
    const governanceContent = screen.getByRole("region", {
      name: "文章治理内容",
    })
    expect(governanceContent.className).toContain("overflow-y-auto")
    expect(governanceContent.parentElement?.className).toContain(
      "overflow-hidden"
    )
    expect(screen.queryByRole("button", { name: "打开文章治理" })).toBeNull()
    expect(screen.queryByRole("button", { name: "关闭文章治理" })).toBeNull()
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

    await screen.findByText("test-body")
    fireEvent.click(screen.getByRole("tab", { name: "来源" }))
    expect(await screen.findByText("test-internal-source")).toBeTruthy()
  })

  it("checks article links without making external requests", async () => {
    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    expect(await screen.findByText("test-body")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "链接" }))
    const checkButton = screen.getByRole("button", { name: "检查" })
    await waitFor(() =>
      expect((checkButton as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.click(checkButton)

    await waitFor(() => {
      expect(articleApi.analyzeArticleLinks).toHaveBeenCalledWith(
        "project-1",
        "article-1",
        expect.objectContaining({ check_external: false })
      )
    })
  })

  it("preserves the editor selection when applying a link candidate", async () => {
    articleApi.getInternalLinkCandidates.mockResolvedValue({
      items: [
        {
          title: "Solar installation guide",
          url: "https://example.test/solar-installation",
          suggested_anchor: "solar installation",
          target_section: "blk_test_heading",
          duplicate_status: "new",
          candidate_kind: "business_page",
          selection_reason: "标题和主题匹配",
        },
      ],
    })

    const capabilities: ArticleDocumentCapabilities = {
      schema_version: 2,
      writable: true,
      recovery_scope: "scope-user-1",
      nodes: ["doc", "paragraph", "heading", "text"],
      marks: ["link"],
      heading_levels: [2, 3, 4, 5, 6],
      asset_types: [],
      media_upload_enabled: false,
      can_manage_seo_advanced: false,
      limits: {},
    }
    const metadata: ArticleMetadataSnapshot = {
      title: completedArticle.title,
      slug: completedArticle.slug,
      focus_keyword: completedArticle.focus_keyword,
      secondary_keywords: completedArticle.secondary_keywords,
      meta_title: completedArticle.meta_title,
      meta_description: completedArticle.meta_description,
      canonical_url: completedArticle.canonical_url,
      indexing: "index/follow",
      field_states: completedArticle.field_states,
      publication_status: "complete_draft",
    }

    function CandidateHarness() {
      const editorRef = React.useRef<ArticleEditorHandle>(null)
      const [governanceTab, setGovernanceTab] = React.useState<
        "seo" | "links" | "versions" | "assets" | "review" | "sources"
      >("seo")
      return (
        <>
          <ArticleEditor
            ref={editorRef}
            projectId="project-1"
            articleId="article-1"
            document={completedArticle.document}
            capabilities={capabilities}
            readOnly={false}
            onChange={vi.fn()}
          />
          <ArticleGovernancePanel
            projectId="project-1"
            articleId="article-1"
            article={completedArticle as ArticleDetail}
            document={completedArticle.document}
            metadata={metadata}
            capabilities={capabilities}
            dirty={false}
            disabled={false}
            editorRef={editorRef}
            onMetadataChange={vi.fn()}
            versionContent={null}
            assetContent={null}
            reviewContent={null}
            sourceContent={null}
            value={governanceTab}
            onValueChange={setGovernanceTab}
          />
          <button
            type="button"
            onClick={() =>
              editorRef.current?.focusEvidence({
                nodeId: "blk_test_paragraph",
                start: 0,
                end: "test-body".length,
                expectedText: "test-body",
              })
            }
          >
            选择正文证据
          </button>
          <button
            type="button"
            onClick={() =>
              editorRef.current?.focusEvidence({
                nodeId: "blk_test_paragraph",
                start: 0,
                end: 0,
              })
            }
          >
            清空正文选区
          </button>
        </>
      )
    }

    render(<CandidateHarness />)

    expect(await screen.findByText("test-body")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "链接" }))
    fireEvent.click(screen.getByRole("button", { name: "搜索链接候选" }))

    expect(await screen.findByText("Solar installation guide")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "选择正文证据" }))

    const apply = screen.getByRole("button", { name: "应用" })
    expect(fireEvent.pointerDown(apply)).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "清空正文选区" }))
    expect(fireEvent.mouseDown(apply)).toBe(false)
    fireEvent.click(apply)

    const inserted = await screen.findByRole("link", {
      name: "solar installation",
    })
    expect(inserted.getAttribute("href")).toBe(
      "https://example.test/solar-installation"
    )
    expect(screen.queryByText("test-body")).toBeNull()
  })

  it("keeps a newer server autosave out of the editor until recovery is opened", async () => {
    articleApi.getLatestArticleAutosave.mockResolvedValue({
      id: "autosave-1",
      article_id: "article-1",
      client_id: "client-other-tab",
      sequence: 4,
      base_version_number: 1,
      base_review_version: 1,
      schema_version: 2,
      document: {
        type: "doc",
        schema_version: 2,
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "server-draft" },
            content: [{ type: "text", text: "server recovery body" }],
          },
        ],
      },
      metadata: {
        title: "server recovery title",
        slug: "server-recovery-title",
        meta_title: "server recovery SEO title",
        meta_description: "server recovery description",
        focus_keyword: "server recovery keyword",
        secondary_keywords: ["server secondary", "recovery secondary"],
        canonical_url: "https://example.test/server-recovery-title",
        indexing: "noindex/follow",
        field_states: {
          title: "modified",
          slug: "modified",
          focus_keyword: "confirmed",
          secondary_keywords: "modified",
          meta_title: "modified",
          meta_description: "confirmed",
          canonical_url: "modified",
          indexing: "modified",
        },
        publication_status: "complete_draft",
      },
      content_hash: "server-different-hash",
      created_at: "2026-08-08T00:10:00Z",
      expires_at: "2026-08-22T00:10:00Z",
      promoted_version_number: null,
    })

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    const moreActions = await screen.findByRole("button", {
      name: "更多文章操作",
    })
    expect(screen.queryByText("发现较新的服务器恢复副本")).toBeNull()
    expect(screen.queryByText("server recovery body")).toBeNull()
    fireEvent.click(moreActions)
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复未保存内容" }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("当前文章")).toBeTruthy()
    expect(screen.getByText("未保存内容")).toBeTruthy()
    expect(screen.getByText("server recovery body")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "恢复到编辑器" }))
    expect(
      await screen.findByText(
        "已载入恢复副本。确认内容后请手动保存为永久版本。"
      )
    ).toBeTruthy()
    expect(await screen.findByText("server recovery body")).toBeTruthy()
    expect((screen.getByLabelText("主关键词") as HTMLInputElement).value).toBe(
      "server recovery keyword"
    )
    expect((screen.getByLabelText("Meta 标题") as HTMLInputElement).value).toBe(
      "server recovery SEO title"
    )
    expect(
      (screen.getByLabelText("Canonical URL") as HTMLInputElement).value
    ).toBe("https://example.test/server-recovery-title")
    expect(screen.getByLabelText("索引设置").textContent).toContain(
      "禁止索引 / 跟踪链接"
    )
    expect(articleApi.saveArticleDocument).not.toHaveBeenCalled()
  })

  it("discards a server recovery candidate through the autosave API", async () => {
    articleApi.getLatestArticleAutosave.mockResolvedValue({
      id: "autosave-discard",
      article_id: "article-1",
      client_id: "client-1",
      sequence: 2,
      base_version_number: 1,
      base_review_version: 1,
      schema_version: 2,
      document: {
        type: "doc",
        schema_version: 2,
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "discard-p" },
            content: [{ type: "text", text: "discard me" }],
          },
        ],
      },
      metadata: {
        title: "Discard",
        slug: "discard",
        meta_title: null,
        meta_description: null,
        publication_status: "complete_draft",
      },
      content_hash: "discard-hash",
      created_at: "2026-08-08T00:10:00Z",
      expires_at: "2026-08-22T00:10:00Z",
      promoted_version_number: null,
    })

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    const moreActions = await screen.findByRole("button", {
      name: "更多文章操作",
    })
    expect(screen.queryByText("发现较新的服务器恢复副本")).toBeNull()
    fireEvent.click(moreActions)
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复未保存内容" }))
    fireEvent.click(screen.getByRole("button", { name: "丢弃副本" }))
    await waitFor(() => {
      expect(articleApi.deleteArticleAutosave).toHaveBeenCalledWith(
        "project-1",
        "article-1",
        "autosave-discard"
      )
    })
    expect(screen.queryByText("发现较新的服务器恢复副本")).toBeNull()
  })

  it("normalizes a user-scoped legacy recovery before autosave and manual save", async () => {
    articleApi.getArticleDocumentCapabilities.mockResolvedValue({
      schema_version: 2,
      writable: true,
      recovery_scope: "scope-user-1",
      nodes: [
        "doc",
        "paragraph",
        "heading",
        "text",
        "table",
        "tableRow",
        "tableCell",
      ],
      marks: ["bold", "italic", "link"],
      heading_levels: [2, 3, 4, 5, 6],
      asset_types: [],
      media_upload_enabled: false,
      can_manage_seo_advanced: false,
      limits: {},
    })
    saveLocalArticleBackup({
      id: "local-backup-1",
      environment: location.origin,
      projectId: "project-1",
      articleId: "article-1",
      recoveryScope: "scope-user-1",
      clientId: "client-1",
      sequence: 3,
      baseVersionNumber: 1,
      baseReviewVersion: 1,
      document: {
        type: "doc",
        schema_version: 2,
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "local-p" },
            content: [{ type: "text", text: "local recovery body" }],
          },
          {
            type: "table",
            attrs: { node_id: "local-table" },
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    attrs: {
                      colspan: 2,
                      rowspan: 1,
                      align: "center",
                      legacyCellStyle: "centered",
                    },
                    content: [{ type: "paragraph" }],
                  },
                  {
                    type: "tableCell",
                    attrs: {
                      colspan: 1,
                      rowspan: 1,
                      colwidth: null,
                      textAlign: null,
                      verticalAlign: null,
                    },
                    content: [{ type: "paragraph" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      metadata: {
        title: "Local",
        slug: "local",
        meta_title: null,
        meta_description: null,
        focus_keyword: null,
        secondary_keywords: [],
        canonical_url: null,
        indexing: "index/follow",
        field_states: {},
        publication_status: "complete_draft",
      },
      contentHash: "local-different-hash",
      createdAt: "2026-08-08T00:20:00Z",
    })
    articleApi.saveArticleAutosave.mockImplementation(
      async (_projectId, _articleId, input) => ({
        id: "autosave-normalized-recovery",
        article_id: "article-1",
        client_id: input.client_id,
        sequence: input.sequence,
        base_version_number: input.base_version_number,
        base_review_version: input.base_review_version,
        schema_version: input.document.schema_version,
        document: input.document,
        metadata: input.metadata,
        content_hash: input.content_hash,
        created_at: "2026-08-08T00:21:00Z",
        expires_at: "2026-08-22T00:21:00Z",
        promoted_version_number: null,
        accepted_sequence: input.sequence,
        server_time: "2026-08-08T00:21:00Z",
      })
    )
    articleApi.saveArticleDocument.mockImplementation(
      async (_projectId, _articleId, input) => ({
        ...completedArticle,
        document: input.document,
        current_content_hash: input.content_hash,
        current_version_number: 2,
        review_version: 2,
      })
    )
    let protection:
      { dirty: boolean; flush: () => Promise<boolean> } | undefined

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
        onProtectionChange={(next) => {
          protection = next
        }}
      />
    )

    const moreActions = await screen.findByRole("button", {
      name: "更多文章操作",
    })
    expect(screen.queryByText("发现较新的本地恢复副本")).toBeNull()
    fireEvent.click(moreActions)
    fireEvent.click(screen.getByRole("menuitem", { name: "恢复未保存内容" }))
    fireEvent.click(screen.getByRole("button", { name: "恢复到编辑器" }))
    expect(await screen.findByRole("heading", { name: "Local" })).toBeTruthy()
    await waitFor(() => expect(protection?.dirty).toBe(true))
    await act(async () => {
      await protection?.flush()
    })

    const savedDocument = articleApi.saveArticleAutosave.mock.calls.at(-1)![2]
      .document as ArticleDetail["document"]
    const table = savedDocument.content[1]
    const cells = (table.content as Array<Record<string, unknown>>)[0]
      .content as Array<Record<string, unknown>>
    const firstCell = cells[0]
    expect(firstCell.attrs).toEqual({ colspan: 2, textAlign: "center" })
    expect(cells[1].attrs).toEqual({})

    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => {
      expect(articleApi.saveArticleDocument).toHaveBeenCalledTimes(1)
    })
    const permanentDocument = articleApi.saveArticleDocument.mock.calls[0][2]
      .document as ArticleDetail["document"]
    const permanentCells = (
      permanentDocument.content[1].content as Array<Record<string, unknown>>
    )[0].content as Array<Record<string, unknown>>
    expect(permanentCells[0].attrs).toEqual({
      colspan: 2,
      textAlign: "center",
    })
    expect(permanentCells[1].attrs).toEqual({})
  })

  it("opens future document schemas read-only and prevents overwrite", async () => {
    articleApi.getArticle.mockResolvedValue({
      ...completedArticle,
      document_schema_version: 3,
      current_content_hash: "durable-schema-2-hash",
      document: {
        type: "doc",
        schema_version: 3,
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "future-p" },
            content: [{ type: "text", text: "future schema body" }],
          },
        ],
      },
    })
    articleApi.getArticleDocumentCapabilities.mockResolvedValue({
      schema_version: 2,
      writable: true,
      recovery_scope: "scope-user-1",
      nodes: ["doc", "paragraph", "text"],
      marks: [],
      heading_levels: [2, 3, 4, 5, 6],
      asset_types: [],
      media_upload_enabled: false,
      can_manage_seo_advanced: false,
      limits: {},
    })

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    expect(
      await screen.findByText(/已切换为只读，避免覆盖原始内容/)
    ).toBeTruthy()
    expect(screen.getByText("只读模式 · 永久版本 1")).toBeTruthy()
    expect(screen.queryByLabelText("粗体")).toBeNull()
    expect(
      (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(articleApi.saveArticleDocument).not.toHaveBeenCalled()
    expect(articleApi.saveArticleAutosave).not.toHaveBeenCalled()
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

  it("compares two durable article versions", async () => {
    articleApi.listArticleVersions.mockResolvedValue({
      items: [
        {
          id: "version-2",
          run_id: "run-1",
          version_number: 2,
          version_type: "manual_edit",
          review_version: 2,
          created_by: "editor-1",
          restored_from_version_id: null,
          restorable: true,
          created_at: "2026-07-29T00:06:00Z",
        },
        {
          id: "version-1",
          run_id: "run-1",
          version_number: 1,
          version_type: "final",
          review_version: 1,
          created_by: "system",
          restored_from_version_id: null,
          restorable: true,
          created_at: "2026-07-29T00:05:00Z",
        },
      ],
    })
    articleApi.compareArticleVersions.mockResolvedValue({
      from_version: {
        id: "version-1",
        run_id: "run-1",
        version_number: 1,
        version_type: "final",
        review_version: 1,
        created_by: "system",
        restored_from_version_id: null,
        restorable: true,
        created_at: "2026-07-29T00:05:00Z",
      },
      to_version: {
        id: "version-2",
        run_id: "run-1",
        version_number: 2,
        version_type: "manual_edit",
        review_version: 2,
        created_by: "editor-1",
        restored_from_version_id: null,
        restorable: true,
        created_at: "2026-07-29T00:06:00Z",
      },
      algorithm_version: "article-typed-diff.v1",
      summary: {
        blocks_added: 0,
        blocks_removed: 0,
        blocks_moved: 0,
        blocks_updated: 1,
        inline_changes: 1,
        media_changes: 0,
        table_changes: 0,
        metadata_changes: 1,
      },
      block_changes: [],
      inline_changes: [],
      media_changes: [],
      table_changes: [],
      added_lines: 1,
      removed_lines: 1,
      truncated: false,
      metadata_changes: [
        { field: "title", before: "Old title", after: "New title" },
      ],
      lines: [
        {
          kind: "removed",
          content: "Old body",
          old_line_number: 1,
          new_line_number: null,
        },
        {
          kind: "added",
          content: "New body",
          old_line_number: null,
          new_line_number: 1,
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

    await screen.findByLabelText("文章治理面板")
    fireEvent.click(await screen.findByRole("tab", { name: "版本" }))
    expect(await screen.findByText("手工编辑")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("选择版本 1"))
    fireEvent.click(screen.getByLabelText("选择版本 2"))
    fireEvent.click(screen.getByRole("button", { name: "比较所选版本" }))

    expect(await screen.findByText("版本 1 → 版本 2")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "兼容行差异（+1 / -1）" })
    )
    expect(screen.getByText("Old body")).toBeTruthy()
    expect(screen.getByText("New body")).toBeTruthy()
    expect(articleApi.compareArticleVersions).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      1,
      2
    )
  })

  it("restores a version only after confirmation and refreshes the workspace", async () => {
    articleApi.getArticle.mockResolvedValue({
      ...completedArticle,
      current_version_number: 2,
      review_version: 2,
    })
    articleApi.listArticleVersions.mockResolvedValue({
      items: [
        {
          id: "version-1",
          run_id: "run-1",
          version_number: 1,
          version_type: "final",
          review_version: 1,
          created_by: "system",
          restored_from_version_id: null,
          restorable: true,
          created_at: "2026-07-29T00:05:00Z",
        },
      ],
    })
    const restored = {
      ...completedArticle,
      title: "restored-title",
      current_version_number: 3,
      review_version: 3,
      review_status: "pending_review",
      publication_blocked_reason: "awaiting_review",
      document: {
        type: "doc" as const,
        schema_version: 2,
        content: [
          {
            type: "paragraph",
            attrs: { node_id: "blk_restored" },
            content: [{ type: "text", text: "restored-body" }],
          },
        ],
      },
      markdown: "restored-body\n",
      html: "<p>restored-body</p>",
    }
    articleApi.restoreArticleVersion.mockResolvedValue(restored)
    articleApi.compareArticleVersions.mockResolvedValue({
      from_version: {
        id: "version-1",
        run_id: "run-1",
        version_number: 1,
        version_type: "final",
        review_version: 1,
        created_by: "system",
        restored_from_version_id: null,
        restorable: true,
        created_at: "2026-07-29T00:05:00Z",
      },
      to_version: {
        id: "version-2",
        run_id: "run-1",
        version_number: 2,
        version_type: "manual_edit",
        review_version: 2,
        created_by: "editor-1",
        restored_from_version_id: null,
        restorable: true,
        created_at: "2026-07-29T00:06:00Z",
      },
      algorithm_version: "article-typed-diff.v1",
      summary: {
        blocks_added: 0,
        blocks_removed: 0,
        blocks_moved: 0,
        blocks_updated: 1,
        inline_changes: 1,
        media_changes: 0,
        table_changes: 0,
        metadata_changes: 0,
      },
      block_changes: [],
      inline_changes: [],
      media_changes: [],
      table_changes: [],
      added_lines: 1,
      removed_lines: 1,
      truncated: false,
      metadata_changes: [],
      lines: [
        {
          kind: "removed",
          content: "current-body",
          old_line_number: 1,
          new_line_number: null,
        },
        {
          kind: "added",
          content: "restored-body",
          old_line_number: null,
          new_line_number: 1,
        },
      ],
    })
    const confirm = vi.spyOn(window, "confirm")

    render(
      <ArticleWorkspace
        projectId="project-1"
        articleId="article-1"
        onBack={vi.fn()}
      />
    )

    await screen.findByLabelText("文章治理面板")
    fireEvent.click(await screen.findByRole("tab", { name: "版本" }))
    fireEvent.click(await screen.findByLabelText("恢复版本 1"))
    expect(await screen.findByText("恢复前版本差异")).toBeTruthy()
    expect(articleApi.compareArticleVersions).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      1,
      2
    )
    fireEvent.click(screen.getByRole("button", { name: "确认恢复版本 1" }))

    await waitFor(() => {
      expect(articleApi.restoreArticleVersion).toHaveBeenCalledWith(
        "project-1",
        "article-1",
        1,
        2,
        lockCredential
      )
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(await screen.findByText("restored-body")).toBeTruthy()
    expect(
      screen.getByText("已从版本 1 创建永久版本 3，需要重新提交审核。")
    ).toBeTruthy()
    expect(articleApi.listArticleVersions.mock.calls.length).toBeGreaterThan(1)
    confirm.mockRestore()
  })
})
