import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleDetail,
  ArticleDocumentCapabilities,
  ArticleReviewSnapshot,
  ArticleReviewTask,
} from "@/api/articles"
import { ApiError } from "@/api/client"
import { ArticleReviewWorkflow } from "@/features/content/article-review-workflow"

const articleApi = vi.hoisted(() => ({
  addArticleReviewComment: vi.fn(),
  cancelArticleReviewTask: vi.fn(),
  claimArticleReviewTask: vi.fn(),
  decideArticleReviewTask: vi.fn(),
  getArticleReviewSnapshot: vi.fn(),
  listArticleReviewInbox: vi.fn(),
  listArticleReviewTasks: vi.fn(),
  submitArticleReview: vi.fn(),
}))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

vi.mock("@/features/content/article-editor", () => ({
  ArticleEditor: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="review-snapshot-editor">
      {readOnly ? "只读版本正文" : "可编辑版本正文"}
    </div>
  ),
}))

vi.mock("@/features/content/article-typed-diff", () => ({
  ArticleTypedDiff: ({ diff }: { diff: { algorithm_version: string } }) => (
    <div data-testid="review-typed-diff">{diff.algorithm_version}</div>
  ),
}))

vi.mock("@/features/content/article-publication-panel", () => ({
  ArticlePublicationPanel: ({
    article,
    autosaveId,
  }: {
    article: ArticleDetail
    autosaveId: string | null
  }) => (
    <div data-testid="publication-panel">
      发布批准版本 {article.approved_version_number ?? "-"} · 自动保存 {autosaveId ?? "-"}
    </div>
  ),
}))

const task = {
  id: "task-1",
  article_id: "article-1",
  project_id: "project-1",
  version_number: 3,
  status: "pending",
  assigned_to: "reviewer-1",
  assigned_group: "legal-review",
  submitted_by: "author-1",
  submitted_at: "2026-08-10T00:00:00Z",
  claimed_by: null,
  claimed_at: null,
  decided_by: null,
  decided_at: null,
  decision_comment: null,
  policy_version: "article-review-policy.v1",
  comments: [],
} satisfies ArticleReviewTask

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
  review_status: "pending_review",
  review_version: 3,
  document_schema_version: 2,
  current_content_hash: "hash-3",
  current_version_number: 3,
  approved_version_number: null,
  publication_blocked_reason: "awaiting_review",
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

const capabilities = {
  schema_version: 2,
  writable: true,
  recovery_scope: "review-test",
  nodes: ["doc", "paragraph", "text"],
  marks: ["link"],
  heading_levels: [2, 3],
  asset_types: ["image"],
  media_upload_enabled: true,
  can_manage_seo_advanced: false,
  limits: {},
} satisfies ArticleDocumentCapabilities

function snapshot(overrides: Partial<ArticleReviewSnapshot> = {}): ArticleReviewSnapshot {
  return {
    task: { ...task, status: "in_review", claimed_by: "reviewer-1" },
    version: {
      id: "version-3",
      run_id: "run-1",
      version_number: 3,
      version_type: "review",
      review_version: 3,
      created_by: "author-1",
      restored_from_version_id: null,
      restorable: true,
      created_at: "2026-08-10T00:00:00Z",
      title: "Solar storage",
      slug: "solar-storage",
      meta_title: "Solar storage",
      meta_description: "Storage guide",
      focus_keyword: "solar storage",
      secondary_keywords: [],
      canonical_url: null,
      indexing: "index/follow",
      field_states: {},
      publication_status: "publish_ready",
      outline: {},
      quality: {},
      document: {
        type: "doc",
        schema_version: 2,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Reviewed" }] }],
      },
      markdown: "Reviewed",
      html: "<p>Reviewed</p>",
    },
    baseline_version_number: 2,
    diff: {
      from_version: {
        id: "version-2",
        run_id: "run-1",
        version_number: 2,
        version_type: "manual",
        review_version: 2,
        created_by: "author-1",
        restored_from_version_id: null,
        restorable: true,
        created_at: "2026-08-09T00:00:00Z",
      },
      to_version: {
        id: "version-3",
        run_id: "run-1",
        version_number: 3,
        version_type: "review",
        review_version: 3,
        created_by: "author-1",
        restored_from_version_id: null,
        restorable: true,
        created_at: "2026-08-10T00:00:00Z",
      },
      algorithm_version: "article-typed-diff.v1",
      summary: {
        blocks_added: 0,
        blocks_removed: 0,
        blocks_moved: 1,
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
      metadata_changes: [],
      lines: [],
    },
    current_draft_version_number: 4,
    approved_version_number: 2,
    ...overrides,
  }
}

function renderWorkflow(input: {
  article?: ArticleDetail
  dirty?: boolean
  autosaveId?: string | null
} = {}) {
  return render(
    <ArticleReviewWorkflow
      projectId="project-1"
      article={input.article ?? article}
      capabilities={capabilities}
      dirty={input.dirty ?? false}
      parentWorking={false}
      autosaveId={input.autosaveId ?? null}
      onRefreshArticle={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  articleApi.listArticleReviewTasks.mockResolvedValue({ items: [] })
  articleApi.listArticleReviewInbox.mockResolvedValue({ items: [] })
  articleApi.submitArticleReview.mockResolvedValue(task)
  articleApi.claimArticleReviewTask.mockResolvedValue({
    ...task,
    status: "in_review",
    claimed_by: "reviewer-1",
  })
  articleApi.addArticleReviewComment.mockResolvedValue({
    id: "comment-1",
    task_id: task.id,
    author_id: "reviewer-1",
    body: "Please verify the source.",
    node_id: null,
    position: null,
    created_at: "2026-08-10T00:01:00Z",
  })
  articleApi.decideArticleReviewTask.mockResolvedValue({
    ...task,
    status: "needs_changes",
  })
  articleApi.cancelArticleReviewTask.mockResolvedValue({
    ...task,
    status: "cancelled",
  })
  articleApi.getArticleReviewSnapshot.mockResolvedValue(snapshot())
})

afterEach(cleanup)

describe("ArticleReviewWorkflow", () => {
  it("submits the current durable version with an optional reviewer and group", async () => {
    renderWorkflow()
    await screen.findByText("暂无审核任务")

    fireEvent.change(screen.getByLabelText("指定审核人"), {
      target: { value: "reviewer-2" },
    })
    fireEvent.change(screen.getByLabelText("指定审核组"), {
      target: { value: "editorial-board" },
    })
    fireEvent.click(screen.getByRole("button", { name: "提交版本 3 审核" }))

    await waitFor(() => {
      expect(articleApi.submitArticleReview).toHaveBeenCalledWith(
        "project-1",
        "article-1",
        {
          version_number: 3,
          assigned_to: "reviewer-2",
          assigned_group: "editorial-board",
        },
        expect.any(String)
      )
    })
    expect(await screen.findByText("版本 3 已提交审核。")).toBeTruthy()
  })

  it("blocks dirty submission and explains a revoked review permission", async () => {
    articleApi.listArticleReviewInbox.mockRejectedValue(
      new ApiError(403, "forbidden", { code: "forbidden" })
    )
    renderWorkflow({ dirty: true })

    expect(await screen.findByText("当前账号没有审核收件箱权限。")).toBeTruthy()
    expect(screen.getByText("保存当前修改后才能提交审核。")).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "提交版本 3 审核" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(articleApi.submitArticleReview).not.toHaveBeenCalled()
  })

  it("claims a task, reviews its immutable snapshot, comments, and requires a return reason", async () => {
    articleApi.listArticleReviewTasks.mockResolvedValue({ items: [task] })
    articleApi.listArticleReviewInbox.mockResolvedValue({ items: [task] })
    renderWorkflow()

    fireEvent.click((await screen.findAllByRole("button", { name: "领取" }))[0])
    await waitFor(() => {
      expect(articleApi.claimArticleReviewTask).toHaveBeenCalledWith(
        "project-1",
        "task-1"
      )
    })

    fireEvent.click(screen.getAllByRole("button", { name: "快照" })[0])
    expect(await screen.findByText("不可变审核快照")).toBeTruthy()
    expect(screen.getByTestId("review-snapshot-editor").textContent).toBe("只读版本正文")
    expect(screen.getByTestId("review-typed-diff").textContent).toBe(
      "article-typed-diff.v1"
    )
    expect(screen.getByText(/正在审核版本 3；当前草稿已经是版本 4/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText("审核评论"), {
      target: { value: "Please verify the source." },
    })
    fireEvent.click(screen.getByRole("button", { name: "添加评论" }))
    await waitFor(() => {
      expect(articleApi.addArticleReviewComment).toHaveBeenCalledWith(
        "project-1",
        "task-1",
        { body: "Please verify the source." }
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "退回修改" }))
    expect(
      await screen.findByText("退回审核必须填写具体修改意见。", {
        selector: '[role="alert"]',
      })
    ).toBeTruthy()
    expect(articleApi.decideArticleReviewTask).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("审核决定意见"), {
      target: { value: "补充一手来源后重提" },
    })
    fireEvent.click(screen.getByRole("button", { name: "退回修改" }))
    await waitFor(() => {
      expect(articleApi.decideArticleReviewTask).toHaveBeenCalledWith(
        "project-1",
        "task-1",
        { decision: "needs_changes", comment: "补充一手来源后重提" },
        expect.any(String)
      )
    })
  })

  it("warns about draft drift and passes the approved version to the complete publication panel", async () => {
    renderWorkflow({
      article: {
        ...article,
        current_version_number: 4,
        approved_version_number: 3,
        review_status: "approved",
        publication_blocked_reason: null,
      },
      autosaveId: "autosave-4",
    })

    expect(
      await screen.findByText(/发布将严格使用批准版本，不会发布当前未批准草稿/)
    ).toBeTruthy()
    expect(screen.getByTestId("publication-panel").textContent).toContain(
      "发布批准版本 3 · 自动保存 autosave-4"
    )
  })
})
