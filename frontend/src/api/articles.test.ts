import { afterEach, describe, expect, it, vi } from "vitest"

import {
  acquireArticleLock,
  cancelArticlePublication,
  createArticlePreview,
  createArticlePublication,
  getArticlePublication,
  getArticlePublicationSnapshot,
  getInternalLinkCandidates,
  listArticlePublications,
  listPublicationTargets,
  publishArticle,
  reconcileArticlePublication,
  retryArticlePublication,
  revokeArticlePreview,
  renewArticleLock,
  saveArticleDocument,
  submitArticleReview,
  type ArticleDocument,
  type ArticleMetadataSnapshot,
} from "@/api/articles"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("article API paths", () => {
  it("requests internal link candidates from the project-level contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ items: [], next_cursor: null })
    )
    vi.stubGlobal("fetch", fetchMock)

    await getInternalLinkCandidates("project/a", "article 1", {
      query: "solar battery",
      limit: 12,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost")
    expect(url.pathname).toBe(
      "/api/v1/projects/project%2Fa/internal-link-candidates"
    )
    expect(url.searchParams).toEqual(
      new URLSearchParams({
        article_id: "article 1",
        query: "solar battery",
        limit: "12",
      })
    )
  })

  it("sends edit lock credentials on durable document writes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "article-1" }))
    vi.stubGlobal("fetch", fetchMock)
    const document = {
      type: "doc",
      schema_version: 2,
      content: [],
    } satisfies ArticleDocument
    const metadata = {
      title: "Title",
      slug: "title",
      meta_title: null,
      meta_description: null,
      focus_keyword: null,
      secondary_keywords: [],
      canonical_url: null,
      indexing: "index/follow",
      field_states: {},
      publication_status: "complete_draft",
    } satisfies ArticleMetadataSnapshot

    await saveArticleDocument(
      "project-1",
      "article-1",
      {
        document,
        metadata,
        content_hash: "hash",
        base_review_version: 1,
        base_version_number: 1,
      },
      { lockId: "lock-1", token: "t".repeat(32), fence: 9 }
    )

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get("X-Article-Lock-Token")).toBe("t".repeat(32))
    expect(headers.get("X-Article-Lock-Fence")).toBe("9")
  })

  it("uses immutable version contracts for review submission and publication", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(Response.json({ id: "task-1" }))
    )
    vi.stubGlobal("fetch", fetchMock)

    await submitArticleReview(
      "project-1",
      "article-1",
      { version_number: 4, assigned_group: "reviewers" },
      "submit-key"
    )
    await publishArticle("project-1", "article-1", 3, "publish-key")

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      version_number: 4,
      assigned_group: "reviewers",
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      version_number: 3,
    })
  })

  it("acquires and renews an in-memory edit lock lease", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(Response.json({ id: "lock-1" }))
    )
    vi.stubGlobal("fetch", fetchMock)

    await acquireArticleLock("project-1", "article-1", {
      lock_type: "edit_lock",
      lease_seconds: 90,
    })
    await renewArticleLock(
      "project-1",
      "article-1",
      { lockId: "lock-1", token: "z".repeat(32), fence: 5 },
      90
    )

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      lock_type: "edit_lock",
      lease_seconds: 90,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      lock_type: "edit_lock",
      token: "z".repeat(32),
      fence: 5,
      lease_seconds: 90,
    })
  })

  it("uses the P5 preview and publication orchestration contracts", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(Response.json({ id: "resource-1", items: [] }))
    )
    vi.stubGlobal("fetch", fetchMock)

    await listPublicationTargets("project/1")
    await createArticlePreview("project/1", "article 1", {
      source_type: "autosave",
      autosave_id: "autosave-1",
      target_id: "target-1",
    })
    await revokeArticlePreview("project/1", "article 1", "preview/1")
    await createArticlePublication(
      "project/1",
      "article 1",
      {
        version_number: 7,
        target_id: "target-1",
        mode: "scheduled",
        schedule_at: "2099-01-01T10:00:00+08:00",
        source_timezone: "Asia/Shanghai",
      },
      "publication-key"
    )
    await listArticlePublications("project/1", "article 1")
    await getArticlePublication("project/1", "publication/1")
    await getArticlePublicationSnapshot("project/1", "publication/1")
    await cancelArticlePublication("project/1", "publication/1", "计划调整")
    await retryArticlePublication("project/1", "publication/1", "retry-key")
    await reconcileArticlePublication("project/1", "publication/1")

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      path: new URL(String(url), "http://localhost").pathname,
      init: init as RequestInit | undefined,
    }))
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/projects/project%2F1/publication-targets",
      "/api/v1/projects/project%2F1/articles/article%201/previews",
      "/api/v1/projects/project%2F1/articles/article%201/previews/preview%2F1",
      "/api/v1/projects/project%2F1/articles/article%201/publications",
      "/api/v1/projects/project%2F1/articles/article%201/publications",
      "/api/v1/projects/project%2F1/publications/publication%2F1",
      "/api/v1/projects/project%2F1/publications/publication%2F1/snapshot",
      "/api/v1/projects/project%2F1/publications/publication%2F1/cancel",
      "/api/v1/projects/project%2F1/publications/publication%2F1/retry",
      "/api/v1/projects/project%2F1/publications/publication%2F1/reconcile",
    ])
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      source_type: "autosave",
      autosave_id: "autosave-1",
      target_id: "target-1",
    })
    expect(new Headers(calls[3].init?.headers).get("Idempotency-Key")).toBe(
      "publication-key"
    )
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      version_number: 7,
      target_id: "target-1",
      mode: "scheduled",
      schedule_at: "2099-01-01T10:00:00+08:00",
      source_timezone: "Asia/Shanghai",
    })
    expect(JSON.parse(String(calls[7].init?.body))).toEqual({ reason: "计划调整" })
    expect(new Headers(calls[8].init?.headers).get("Idempotency-Key")).toBe(
      "retry-key"
    )
    expect(JSON.parse(String(calls[8].init?.body))).toEqual({
      expected_status: "failed",
    })
  })
})
