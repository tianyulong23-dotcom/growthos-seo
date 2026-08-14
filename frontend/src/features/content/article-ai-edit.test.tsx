import { Editor } from "@tiptap/core"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleAIEditAcceptMode,
  ArticleAIEditCommand,
  ArticleAIEditOperation,
  ArticleAIEditScope,
  ArticleMetadataSnapshot,
  ArticleSeoFieldKey,
  CreateArticleAIEditResponse,
} from "@/api/articles"
import { ApiError } from "@/api/client"
import { useArticleAIEditController } from "@/features/content/article-ai-edit"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"

const articleApi = vi.hoisted(() => ({
  acceptArticleAIEdit: vi.fn(),
  cancelArticleAIEdit: vi.fn(),
  createArticleAIEdit: vi.fn(),
  getArticleAIEdit: vi.fn(),
  rejectArticleAIEdit: vi.fn(),
  retryArticleAIEdit: vi.fn(),
  subscribeArticleAIEdit: vi.fn(),
}))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

const metadata = {
  title: "Article",
  slug: "article",
  meta_title: null,
  meta_description: null,
  focus_keyword: "AI editing",
  secondary_keywords: [],
  canonical_url: null,
  indexing: "index/follow",
  field_states: {},
  publication_status: "complete_draft",
} satisfies ArticleMetadataSnapshot

type StreamHandlers = {
  onOperation: (operation: ArticleAIEditOperation) => void
  onError: (error: Error) => void
}

function operation(
  status: ArticleAIEditOperation["status"],
  overrides: Partial<ArticleAIEditOperation> = {}
): ArticleAIEditOperation {
  return {
    id: "operation-p6",
    article_id: "article-p6",
    parent_operation_id: null,
    command: "rewrite",
    scope: "selection",
    status,
    base_review_version: 1,
    document_hash: "a".repeat(64),
    selection: {
      anchor_node_id: "paragraph-p6",
      from: 0,
      to: 8,
      selected_text_hash: "b".repeat(64),
    },
    prompt_version: "article-ai-edit.v1",
    provider: status === "queued" ? null : "deterministic_fake",
    model: status === "queued" ? null : "article-ai-edit-fixture-v1",
    candidate: {
      kind: "text",
      text: status === "ready" || status === "accepted" ? "Rewritten" : null,
      metadata: null,
      slice: null,
    },
    allowed_modes: ["replace"],
    error_code: null,
    error_detail: null,
    input_tokens: status === "ready" ? 12 : 0,
    output_tokens: status === "ready" ? 3 : 0,
    latency_ms: status === "ready" ? 25 : null,
    stream_revision: status === "queued" ? 0 : 2,
    created_at: "2026-08-10T00:00:00Z",
    started_at: status === "queued" ? null : "2026-08-10T00:00:01Z",
    completed_at: status === "ready" ? "2026-08-10T00:00:02Z" : null,
    decided_at: null,
    accepted_mode: null,
    accepted_result: null,
    ...overrides,
  }
}

function created(value: ArticleAIEditOperation): CreateArticleAIEditResponse {
  return {
    operation: value,
    stream_endpoint: `/ai-edits/${value.id}/stream`,
    stream_token: `stream-token-${value.id}`,
    stream_expires_at: "2026-08-10T00:10:00Z",
  }
}

function editor() {
  const value = new Editor({
    extensions: articleEditorExtensions,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "paragraph-p6" },
          content: [{ type: "text", text: "Original text" }],
        },
      ],
    },
  })
  value.commands.setTextSelection({ from: 1, to: 9 })
  return value
}

type HarnessProps = {
  editor: Editor
  command?: ArticleAIEditCommand
  scope?: ArticleAIEditScope
  onBeforeDocumentAccept?: () => void
  onMetadataAccept?: (field: ArticleSeoFieldKey, value: string) => void
}

function Harness({
  editor,
  command = "rewrite",
  scope = "selection",
  onBeforeDocumentAccept = () => undefined,
  onMetadataAccept = () => undefined,
}: HarnessProps) {
  const controller = useArticleAIEditController({
    editor,
    projectId: "project-p6",
    articleId: "article-p6",
    reviewVersion: 1,
    metadata,
    onBeforeDocumentAccept,
    onMetadataAccept,
  })
  return (
    <>
      <button
        type="button"
        onClick={() => void controller.start(command, scope)}
      >
        Start AI
      </button>
      {controller.panel}
    </>
  )
}

async function startAndReady(
  currentEditor: Editor,
  readyOperation: ArticleAIEditOperation = operation("ready"),
  options: { fromStream?: boolean } = {}
) {
  fireEvent.click(screen.getByRole("button", { name: "Start AI" }))
  await waitFor(() =>
    expect(articleApi.createArticleAIEdit).toHaveBeenCalledTimes(1)
  )
  if (options.fromStream !== false) {
    await waitFor(() =>
      expect(articleApi.subscribeArticleAIEdit).toHaveBeenCalledTimes(1)
    )
    const handlers = articleApi.subscribeArticleAIEdit.mock
      .calls[0][1] as StreamHandlers
    await act(async () => handlers.onOperation(readyOperation))
  }
  await screen.findByText("待处理")
  expect(currentEditor.getText()).toBe("Original text")
}

beforeEach(() => {
  vi.clearAllMocks()
  articleApi.createArticleAIEdit.mockResolvedValue(created(operation("queued")))
  articleApi.subscribeArticleAIEdit.mockImplementation(() => vi.fn())
})

afterEach(cleanup)

describe("article AI edit controller", () => {
  it("keeps queued, streaming, ready, and rejected candidates outside the document", async () => {
    const currentEditor = editor()
    const updates = vi.fn()
    currentEditor.on("update", updates)
    articleApi.rejectArticleAIEdit.mockResolvedValue(operation("rejected"))
    render(<Harness editor={currentEditor} />)

    fireEvent.click(screen.getByRole("button", { name: "Start AI" }))
    await waitFor(() =>
      expect(articleApi.subscribeArticleAIEdit).toHaveBeenCalledTimes(1)
    )
    const handlers = articleApi.subscribeArticleAIEdit.mock
      .calls[0][1] as StreamHandlers
    await act(async () => handlers.onOperation(operation("streaming")))
    await act(async () => handlers.onOperation(operation("ready")))

    expect(currentEditor.getText()).toBe("Original text")
    expect(updates).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }))
    await screen.findByText("已拒绝")
    expect(currentEditor.getText()).toBe("Original text")
    expect(updates).not.toHaveBeenCalled()
    currentEditor.destroy()
  })

  it("waits for accept confirmation, applies replace once, and undoes in one step", async () => {
    const currentEditor = editor()
    const before = currentEditor.getJSON()
    const updates = vi.fn()
    const onBeforeDocumentAccept = vi.fn()
    let resolveAccept!: (value: unknown) => void
    articleApi.acceptArticleAIEdit.mockImplementation(
      () => new Promise((resolve) => (resolveAccept = resolve))
    )
    currentEditor.on("update", updates)
    render(
      <Harness
        editor={currentEditor}
        onBeforeDocumentAccept={onBeforeDocumentAccept}
      />
    )
    await startAndReady(currentEditor)

    fireEvent.click(screen.getByRole("button", { name: "接受替换" }))
    await waitFor(() =>
      expect(articleApi.acceptArticleAIEdit).toHaveBeenCalledTimes(1)
    )
    expect(currentEditor.getText()).toBe("Original text")
    expect(onBeforeDocumentAccept).not.toHaveBeenCalled()
    expect(updates).not.toHaveBeenCalled()

    await act(async () =>
      resolveAccept({
        operation: operation("accepted", {
          accepted_mode: "replace",
          accepted_result: { kind: "text", text: "Rewritten" },
        }),
        canonical_slice: null,
        canonical_metadata: null,
        anchor_node_id: "paragraph-p6",
        from: 0,
        to: 8,
      })
    )
    await waitFor(() => expect(currentEditor.getText()).toBe("Rewritten text"))
    expect(onBeforeDocumentAccept).toHaveBeenCalledTimes(1)
    expect(updates).toHaveBeenCalledTimes(1)
    expect(currentEditor.commands.undo()).toBe(true)
    expect(currentEditor.getJSON()).toEqual(before)
    currentEditor.destroy()
  })

  it.each([
    ["insert_after", "OriginalRewritten text"],
    ["replace", "Rewritten text"],
  ] satisfies Array<[ArticleAIEditAcceptMode, string]>)(
    "applies %s as one undoable transaction",
    async (mode, expected) => {
      const currentEditor = editor()
      const before = currentEditor.getJSON()
      const updates = vi.fn()
      const ready = operation("ready", { allowed_modes: [mode] })
      articleApi.createArticleAIEdit.mockResolvedValue(created(ready))
      articleApi.acceptArticleAIEdit.mockResolvedValue({
        operation: operation("accepted", {
          allowed_modes: [mode],
          accepted_mode: mode,
          accepted_result: { kind: "text", text: "Rewritten" },
        }),
        canonical_slice: null,
        canonical_metadata: null,
        anchor_node_id: "paragraph-p6",
        from: 0,
        to: 8,
      })
      currentEditor.on("update", updates)
      render(<Harness editor={currentEditor} />)
      await startAndReady(currentEditor, ready, { fromStream: false })

      fireEvent.click(
        screen.getByRole("button", {
          name: mode === "replace" ? "接受替换" : "接受插入",
        })
      )
      await waitFor(() => expect(currentEditor.getText()).toBe(expected))
      expect(updates).toHaveBeenCalledTimes(1)
      expect(currentEditor.commands.undo()).toBe(true)
      expect(currentEditor.getJSON()).toEqual(before)
      currentEditor.destroy()
    }
  )

  it("inserts a canonical FAQ slice in one undoable transaction", async () => {
    const currentEditor = editor()
    currentEditor.commands.setTextSelection(2)
    const before = currentEditor.getJSON()
    const updates = vi.fn()
    const ready = operation("ready", {
      command: "faq",
      scope: "block",
      selection: {
        anchor_node_id: "paragraph-p6",
        from: 0,
        to: 13,
        selected_text_hash: "c".repeat(64),
      },
      candidate: {
        kind: "slice",
        text: null,
        metadata: null,
        slice: { type: "slice", content: [] },
      },
      allowed_modes: ["insert_after"],
    })
    articleApi.createArticleAIEdit.mockResolvedValue(
      created(operation("queued", ready))
    )
    articleApi.acceptArticleAIEdit.mockResolvedValue({
      operation: operation("accepted", {
        ...ready,
        status: "accepted",
        accepted_mode: "insert_after",
      }),
      canonical_slice: {
        type: "slice",
        content: [
          {
            type: "heading",
            attrs: { node_id: "ai-faq-heading", level: 2 },
            content: [{ type: "text", text: "FAQ" }],
          },
          {
            type: "details",
            attrs: {
              node_id: "ai-faq-details",
              summary: "How?",
              open_by_default: false,
            },
            content: [
              {
                type: "detailsContent",
                content: [
                  {
                    type: "paragraph",
                    attrs: { node_id: "ai-faq-answer" },
                    content: [{ type: "text", text: "Carefully." }],
                  },
                ],
              },
            ],
          },
        ],
      },
      canonical_metadata: null,
      anchor_node_id: "paragraph-p6",
      from: 0,
      to: 13,
    })
    currentEditor.on("update", updates)
    render(<Harness editor={currentEditor} command="faq" scope="block" />)
    await startAndReady(currentEditor, ready, { fromStream: false })

    fireEvent.click(screen.getByRole("button", { name: "接受插入" }))
    await waitFor(() => expect(currentEditor.getText()).toContain("FAQ"))
    expect(updates).toHaveBeenCalledTimes(1)
    expect(currentEditor.commands.undo()).toBe(true)
    expect(currentEditor.getJSON()).toEqual(before)
    currentEditor.destroy()
  })

  it("replaces the server-confirmed range with a canonical slice in one undoable transaction", async () => {
    const currentEditor = editor()
    const before = currentEditor.getJSON()
    const updates = vi.fn()
    const ready = operation("ready", {
      command: "faq",
      scope: "block",
      selection: {
        anchor_node_id: "paragraph-p6",
        from: 0,
        to: 13,
        selected_text_hash: "c".repeat(64),
      },
      candidate: {
        kind: "slice",
        text: null,
        metadata: null,
        slice: { type: "slice", content: [] },
      },
      allowed_modes: ["replace"],
    })
    articleApi.createArticleAIEdit.mockResolvedValue(created(ready))
    articleApi.acceptArticleAIEdit.mockResolvedValue({
      operation: operation("accepted", {
        ...ready,
        status: "accepted",
        accepted_mode: "replace",
      }),
      canonical_slice: {
        type: "slice",
        content: [
          {
            type: "heading",
            attrs: { node_id: "ai-replacement", level: 2 },
            content: [{ type: "text", text: "Replacement FAQ" }],
          },
        ],
      },
      canonical_metadata: null,
      anchor_node_id: "paragraph-p6",
      from: 0,
      to: 13,
    })
    currentEditor.on("update", updates)
    render(<Harness editor={currentEditor} command="faq" scope="block" />)
    await startAndReady(currentEditor, ready, { fromStream: false })

    fireEvent.click(screen.getByRole("button", { name: "接受替换" }))
    await waitFor(() =>
      expect(currentEditor.getText()).toBe("Replacement FAQ")
    )
    expect(currentEditor.getJSON().content?.[0]).toMatchObject({
      type: "heading",
      attrs: { node_id: "ai-replacement", level: 2 },
    })
    expect(updates).toHaveBeenCalledTimes(1)
    expect(currentEditor.commands.undo()).toBe(true)
    expect(currentEditor.getJSON()).toEqual(before)
    currentEditor.destroy()
  })

  it("can retry local application after the server accepted successfully", async () => {
    const currentEditor = editor()
    const ready = operation("ready", {
      command: "faq",
      scope: "block",
      selection: {
        anchor_node_id: "paragraph-p6",
        from: 0,
        to: 13,
        selected_text_hash: "c".repeat(64),
      },
      candidate: {
        kind: "slice",
        text: null,
        metadata: null,
        slice: { type: "slice", content: [] },
      },
      allowed_modes: ["insert_after"],
    })
    const accepted = operation("accepted", {
      ...ready,
      status: "accepted",
      accepted_mode: "insert_after",
    })
    articleApi.createArticleAIEdit.mockResolvedValue(created(ready))
    articleApi.acceptArticleAIEdit
      .mockResolvedValueOnce({
        operation: accepted,
        canonical_slice: {
          type: "slice",
          content: [{ type: "unsupported_server_node" }],
        },
        canonical_metadata: null,
        anchor_node_id: "paragraph-p6",
        from: 0,
        to: 13,
      })
      .mockResolvedValueOnce({
        operation: accepted,
        canonical_slice: {
          type: "slice",
          content: [
            {
              type: "heading",
              attrs: { node_id: "ai-retry", level: 2 },
              content: [{ type: "text", text: "Recovered candidate" }],
            },
          ],
        },
        canonical_metadata: null,
        anchor_node_id: "paragraph-p6",
        from: 0,
        to: 13,
      })
    render(<Harness editor={currentEditor} command="faq" scope="block" />)
    await startAndReady(currentEditor, ready, { fromStream: false })

    fireEvent.click(screen.getByRole("button", { name: "接受插入" }))
    await screen.findByText(/Unknown node type/)
    expect(currentEditor.getText()).toBe("Original text")

    fireEvent.click(screen.getByRole("button", { name: "接受插入" }))
    await waitFor(() =>
      expect(currentEditor.getText()).toContain("Recovered candidate")
    )
    expect(articleApi.acceptArticleAIEdit).toHaveBeenCalledTimes(2)
    expect(articleApi.acceptArticleAIEdit.mock.calls[0][4]).toBe(
      articleApi.acceptArticleAIEdit.mock.calls[1][4]
    )
    currentEditor.destroy()
  })

  it("applies metadata only after confirmation and exactly once", async () => {
    const currentEditor = editor()
    const onMetadataAccept = vi.fn()
    const ready = operation("ready", {
      command: "meta_title",
      scope: "metadata",
      selection: null,
      candidate: {
        kind: "metadata",
        text: null,
        metadata: {
          field: "meta_title",
          candidates: ["Candidate A", "Candidate B"],
        },
        slice: null,
      },
      allowed_modes: ["apply_metadata"],
    })
    articleApi.createArticleAIEdit.mockResolvedValue(
      created(operation("queued", ready))
    )
    let resolveAccept!: (value: unknown) => void
    articleApi.acceptArticleAIEdit.mockImplementation(
      () => new Promise((resolve) => (resolveAccept = resolve))
    )
    render(
      <Harness
        editor={currentEditor}
        command="meta_title"
        scope="metadata"
        onMetadataAccept={onMetadataAccept}
      />
    )
    await startAndReady(currentEditor, ready, { fromStream: false })

    fireEvent.click(screen.getByRole("button", { name: "应用字段" }))
    await waitFor(() =>
      expect(articleApi.acceptArticleAIEdit).toHaveBeenCalledTimes(1)
    )
    expect(onMetadataAccept).not.toHaveBeenCalled()
    await act(async () =>
      resolveAccept({
        operation: operation("accepted", {
          ...ready,
          status: "accepted",
          accepted_mode: "apply_metadata",
        }),
        canonical_slice: null,
        canonical_metadata: { field: "meta_title", value: "Candidate A" },
        anchor_node_id: null,
        from: null,
        to: null,
      })
    )
    await waitFor(() =>
      expect(onMetadataAccept).toHaveBeenCalledWith("meta_title", "Candidate A")
    )
    expect(onMetadataAccept).toHaveBeenCalledTimes(1)
    expect(currentEditor.getText()).toBe("Original text")
    currentEditor.destroy()
  })

  it("refreshes a stale operation and never overwrites the changed document", async () => {
    const currentEditor = editor()
    articleApi.acceptArticleAIEdit.mockRejectedValue(
      new ApiError(409, "stale", { code: "ai_edit_stale" })
    )
    articleApi.getArticleAIEdit.mockResolvedValue(
      operation("stale", { error_code: "ai_edit_stale" })
    )
    render(<Harness editor={currentEditor} />)
    await startAndReady(currentEditor)

    currentEditor.commands.insertContentAt(9, " changed")
    const changed = currentEditor.getJSON()
    fireEvent.click(screen.getByRole("button", { name: "接受替换" }))
    await screen.findByText("已过期")

    expect(articleApi.getArticleAIEdit).toHaveBeenCalledWith(
      "project-p6",
      "article-p6",
      "operation-p6",
      undefined
    )
    expect(currentEditor.getJSON()).toEqual(changed)
    expect(currentEditor.getText()).toBe("Original changed text")
    currentEditor.destroy()
  })

  it("applies duplicate accept responses only once", async () => {
    const currentEditor = editor()
    const updates = vi.fn()
    const ready = operation("ready")
    articleApi.createArticleAIEdit.mockResolvedValue(created(ready))
    articleApi.acceptArticleAIEdit.mockResolvedValue({
      operation: operation("accepted", {
        accepted_mode: "replace",
        accepted_result: { kind: "text", text: "Rewritten" },
      }),
      canonical_slice: null,
      canonical_metadata: null,
      anchor_node_id: "paragraph-p6",
      from: 0,
      to: 8,
    })
    currentEditor.on("update", updates)
    render(<Harness editor={currentEditor} />)
    await startAndReady(currentEditor, ready, { fromStream: false })

    const accept = screen.getByRole("button", { name: "接受替换" })
    fireEvent.click(accept)
    fireEvent.click(accept)
    await waitFor(() => expect(currentEditor.getText()).toBe("Rewritten text"))

    expect(updates).toHaveBeenCalledTimes(1)
    expect(currentEditor.getText()).not.toContain("RewrittenRewritten")
    currentEditor.destroy()
  })

  it("keeps ordinary editing available after an AI failure", async () => {
    const currentEditor = editor()
    articleApi.createArticleAIEdit.mockResolvedValue(
      created(
        operation("failed", {
          error_code: "ai_edit_provider_timeout",
          error_detail: "AI provider timed out",
        })
      )
    )
    render(<Harness editor={currentEditor} />)

    fireEvent.click(screen.getByRole("button", { name: "Start AI" }))
    await screen.findByText("失败")
    expect(currentEditor.commands.insertContentAt(9, " still editable")).toBe(
      true
    )
    expect(currentEditor.getText()).toBe("Original still editable text")
    currentEditor.destroy()
  })

  it("retries as a child operation and reconnects an interrupted stream", async () => {
    const currentEditor = editor()
    const failed = operation("failed", {
      error_code: "ai_edit_provider_timeout",
      error_detail: "AI provider timed out",
    })
    articleApi.createArticleAIEdit.mockResolvedValue(created(failed))
    const child = operation("queued", {
      id: "operation-p6-retry",
      parent_operation_id: "operation-p6",
    })
    articleApi.retryArticleAIEdit.mockResolvedValue(created(child))
    render(<Harness editor={currentEditor} />)

    fireEvent.click(screen.getByRole("button", { name: "Start AI" }))
    await screen.findByText("失败")
    fireEvent.click(screen.getByRole("button", { name: "基于当前正文重试" }))
    await waitFor(() =>
      expect(articleApi.retryArticleAIEdit).toHaveBeenCalledTimes(1)
    )
    expect(articleApi.retryArticleAIEdit.mock.calls[0][2]).toBe("operation-p6")
    await waitFor(() =>
      expect(articleApi.subscribeArticleAIEdit).toHaveBeenCalledTimes(1)
    )

    const handlers = articleApi.subscribeArticleAIEdit.mock
      .calls[0][1] as StreamHandlers
    await act(async () => handlers.onError(new Error("stream interrupted")))
    fireEvent.click(screen.getByRole("button", { name: "重新连接" }))
    await waitFor(() =>
      expect(articleApi.subscribeArticleAIEdit).toHaveBeenCalledTimes(2)
    )
    expect(currentEditor.getText()).toBe("Original text")
    currentEditor.destroy()
  })
})
