import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleAutosaveResponse,
  ArticleDocument,
  ArticleLockCredential,
  ArticleMetadataSnapshot,
} from "@/api/articles"
import { ApiError } from "@/api/client"
import { articleSnapshotHash } from "@/features/content/article-document"
import { useArticleReliableSave } from "@/features/content/use-article-reliable-save"

const articleApi = vi.hoisted(() => ({
  saveArticleAutosave: vi.fn(),
}))

vi.mock("@/api/articles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/articles")>()),
  ...articleApi,
}))

vi.mock("@/features/content/article-document", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/content/article-document")
  >()),
  articleSnapshotHash: vi.fn(
    async (document: ArticleDocument, metadata: ArticleMetadataSnapshot) =>
      JSON.stringify({ document, metadata })
  ),
}))

const metadata = {
  title: "Article",
  slug: "article",
  meta_title: null,
  meta_description: null,
  focus_keyword: null,
  secondary_keywords: [],
  canonical_url: null,
  indexing: "index/follow",
  field_states: {},
  publication_status: "complete_draft",
} satisfies ArticleMetadataSnapshot

const lockCredential = {
  lockId: "lock-1",
  token: "a".repeat(32),
  fence: 7,
} satisfies ArticleLockCredential

function documentWith(text: string): ArticleDocument {
  return {
    type: "doc",
    schema_version: 2,
    content: [
      {
        type: "paragraph",
        attrs: { node_id: "p-1" },
        content: [{ type: "text", text }],
      },
    ],
  }
}

function documentWithDefaultTableAttrs(): ArticleDocument {
  return {
    type: "doc",
    schema_version: 2,
    content: [
      {
        type: "table",
        attrs: { node_id: "table-1" },
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: {
                  colspan: 1,
                  rowspan: 1,
                  colwidth: null,
                  textAlign: null,
                  verticalAlign: null,
                },
                content: [
                  {
                    type: "paragraph",
                    attrs: { node_id: "cell-paragraph-1" },
                    content: [{ type: "text", text: "Cell" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

function response(
  input: Parameters<typeof articleApi.saveArticleAutosave>[2]
): ArticleAutosaveResponse {
  return {
    id: `autosave-${input.sequence}`,
    article_id: "article-1",
    client_id: input.client_id,
    sequence: input.sequence,
    accepted_sequence: input.sequence,
    base_version_number: input.base_version_number,
    base_review_version: input.base_review_version,
    schema_version: 2,
    document: input.document,
    metadata: input.metadata,
    content_hash: input.content_hash,
    created_at: "2026-08-08T00:00:00Z",
    expires_at: "2026-08-22T00:00:00Z",
    promoted_version_number: null,
    server_time: "2026-08-08T00:00:00Z",
  }
}

async function renderReliableSave() {
  const baselineDocument = documentWith("Base")
  const baselineHash = await articleSnapshotHash(baselineDocument, metadata)
  const hook = renderHook(
    ({ document }: { document: ArticleDocument }) =>
      useArticleReliableSave({
        projectId: "project-1",
        articleId: "article-1",
        recoveryScope: "user-scope-1",
        document,
        metadata,
        baselineHash,
        baseVersionNumber: 1,
        baseReviewVersion: 1,
        lockCredential,
        enabled: true,
      }),
    { initialProps: { document: baselineDocument } }
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  return { ...hook, baselineHash }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  articleApi.saveArticleAutosave.mockImplementation(
    async (_projectId, _articleId, input) => response(input)
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useArticleReliableSave", () => {
  it("keeps the flush callback stable when the lock-loss handler changes", async () => {
    const baselineDocument = documentWith("Base")
    const baselineHash = await articleSnapshotHash(baselineDocument, metadata)
    const hook = renderHook(
      ({ onLockLost }: { onLockLost: (error: ApiError) => void }) =>
        useArticleReliableSave({
          projectId: "project-1",
          articleId: "article-1",
          recoveryScope: "user-scope-1",
          document: baselineDocument,
          metadata,
          baselineHash,
          baseVersionNumber: 1,
          baseReviewVersion: 1,
          lockCredential,
          enabled: true,
          onLockLost,
        }),
      { initialProps: { onLockLost: vi.fn() } }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const initialFlush = hook.result.current.flushAutosave

    hook.rerender({ onLockLost: vi.fn() })

    expect(hook.result.current.flushAutosave).toBe(initialFlush)
  })

  it("protects locally at one second and autosaves once after three seconds", async () => {
    const { result, rerender } = await renderReliableSave()
    rerender({ document: documentWith("Draft") })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999)
    })
    expect(result.current.state.localProtected).toBe(false)
    expect(articleApi.saveArticleAutosave).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(result.current.state.localProtected).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(1)
    expect(articleApi.saveArticleAutosave.mock.calls[0][3]).toEqual(
      lockCredential
    )
    expect(result.current.state.status).toBe("autosaved")
  })

  it("debounces rapid edits and sends only the newest snapshot", async () => {
    const { result, rerender } = await renderReliableSave()
    for (const text of ["D", "Dr", "Dra", "Draft"]) {
      rerender({ document: documentWith(text) })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
    }
    expect(articleApi.saveArticleAutosave).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(1)
    const input = articleApi.saveArticleAutosave.mock.calls[0][2]
    expect(input.document.content[0].content[0].text).toBe("Draft")
    expect(result.current.state.status).toBe("autosaved")
  })

  it("canonicalizes the document before hashing and autosaving", async () => {
    const { rerender } = await renderReliableSave()
    rerender({ document: documentWithDefaultTableAttrs() })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(1)
    const input = articleApi.saveArticleAutosave.mock.calls[0][2]
    expect(input.document.content[0].content[0].content[0].attrs).toEqual({})
    expect(input.content_hash).toBe(
      JSON.stringify({ document: input.document, metadata: input.metadata })
    )
  })

  it("forces an autosave after thirty seconds of continuous editing", async () => {
    const { rerender } = await renderReliableSave()
    rerender({ document: documentWith("Draft 0") })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    for (let index = 1; index <= 14; index += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
        rerender({ document: documentWith(`Draft ${index}`) })
        await vi.advanceTimersByTimeAsync(0)
      })
    }
    expect(articleApi.saveArticleAutosave).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(1)
  })

  it("retries network failures with bounded backoff", async () => {
    articleApi.saveArticleAutosave
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(async (_projectId, _articleId, input) =>
        response(input)
      )
    const { result, rerender } = await renderReliableSave()
    rerender({ document: documentWith("Draft") })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(2)
    expect(result.current.state.status).toBe("autosaved")
  })

  it("pauses retries on 401 and reports a 409 conflict", async () => {
    articleApi.saveArticleAutosave.mockRejectedValueOnce(
      new ApiError(401, "expired")
    )
    const first = await renderReliableSave()
    first.rerender({ document: documentWith("Unauthorized") })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(1)
    expect(first.result.current.state).toMatchObject({
      status: "local_only",
      error: "登录状态已失效，自动保存已暂停",
    })
    first.unmount()

    articleApi.saveArticleAutosave.mockReset()
    articleApi.saveArticleAutosave.mockRejectedValueOnce(
      new ApiError(409, "conflict")
    )
    const second = await renderReliableSave()
    second.rerender({ document: documentWith("Conflict") })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(second.result.current.state.status).toBe("conflict")
  })

  it("resynchronizes a reset client sequence after a page reload", async () => {
    articleApi.saveArticleAutosave
      .mockRejectedValueOnce(
        new ApiError(409, "autosave_stale", {
          code: "autosave_stale",
          acceptedSequence: 2,
        })
      )
      .mockImplementationOnce(async (_projectId, _articleId, input) =>
        response(input)
      )
    const { result, rerender } = await renderReliableSave()
    rerender({ document: documentWith("Draft after reload") })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })

    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(2)
    expect(articleApi.saveArticleAutosave.mock.calls[0][2].sequence).toBe(1)
    expect(articleApi.saveArticleAutosave.mock.calls[1][2].sequence).toBe(3)
    expect(result.current.state.status).toBe("autosaved")
  })

  it("protects locally and stops retries when a released edit lock is missing", async () => {
    const onLockLost = vi.fn()
    articleApi.saveArticleAutosave.mockRejectedValueOnce(
      new ApiError(409, "missing", { code: "article_edit_lock_not_found" })
    )
    const baselineDocument = documentWith("Base")
    const baselineHash = await articleSnapshotHash(baselineDocument, metadata)
    const hook = renderHook(
      ({ document }: { document: ArticleDocument }) =>
        useArticleReliableSave({
          projectId: "project-1",
          articleId: "article-1",
          recoveryScope: "user-scope-1",
          document,
          metadata,
          baselineHash,
          baseVersionNumber: 1,
          baseReviewVersion: 1,
          lockCredential,
          enabled: true,
          onLockLost,
        }),
      { initialProps: { document: baselineDocument } }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    hook.rerender({ document: documentWith("Unsaved") })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(1)
    expect(onLockLost).toHaveBeenCalledTimes(1)
    expect(hook.result.current.state).toMatchObject({
      status: "conflict",
      localProtected: true,
    })
  })

  it("ignores an old in-flight response after a newer edit starts", async () => {
    let resolveFirst: ((value: ArticleAutosaveResponse) => void) | undefined
    articleApi.saveArticleAutosave
      .mockImplementationOnce(
        (_projectId, _articleId, input) =>
          new Promise<ArticleAutosaveResponse>((resolve) => {
            resolveFirst = () => resolve(response(input))
          })
      )
      .mockImplementationOnce(async (_projectId, _articleId, input) =>
        response(input)
      )
    const { result, rerender } = await renderReliableSave()
    rerender({ document: documentWith("Older") })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(result.current.state.status).toBe("autosaving")

    rerender({ document: documentWith("Newer") })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      resolveFirst?.(undefined as never)
      await Promise.resolve()
    })
    expect(result.current.state.status).toBe("autosave_pending")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(articleApi.saveArticleAutosave).toHaveBeenCalledTimes(2)
    expect(result.current.state).toMatchObject({
      status: "autosaved",
      autosaveId: "autosave-2",
    })
  })
})
