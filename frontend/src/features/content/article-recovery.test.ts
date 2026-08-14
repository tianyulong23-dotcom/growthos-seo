import { beforeEach, describe, expect, it, vi } from "vitest"

import type { LocalArticleBackup } from "@/features/content/article-recovery"
import {
  discardLocalArticleBackup,
  loadLocalArticleBackups,
  saveLocalArticleBackup,
} from "@/features/content/article-recovery"

function backup(
  overrides: Partial<LocalArticleBackup> = {}
): LocalArticleBackup {
  return {
    id: "backup-1",
    environment: location.origin,
    projectId: "project-1",
    articleId: "article-1",
    recoveryScope: "user-scope-1",
    clientId: "client-1",
    sequence: 1,
    baseVersionNumber: 1,
    baseReviewVersion: 1,
    document: {
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "p-1" },
          content: [{ type: "text", text: "Draft" }],
        },
      ],
    },
    metadata: {
      title: "Draft",
      slug: "draft",
      meta_title: null,
      meta_description: null,
      focus_keyword: null,
      secondary_keywords: [],
      canonical_url: null,
      indexing: "index/follow",
      field_states: {},
      publication_status: "complete_draft",
    },
    contentHash: "hash-1",
    createdAt: "2026-08-08T00:00:01Z",
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe("article local recovery", () => {
  it("isolates backups by user scope, project and article", () => {
    saveLocalArticleBackup(backup())

    expect(
      loadLocalArticleBackups({
        projectId: "project-1",
        articleId: "article-1",
        recoveryScope: "user-scope-1",
      })
    ).toHaveLength(1)
    for (const scope of [
      {
        projectId: "project-2",
        articleId: "article-1",
        recoveryScope: "user-scope-1",
      },
      {
        projectId: "project-1",
        articleId: "article-2",
        recoveryScope: "user-scope-1",
      },
      {
        projectId: "project-1",
        articleId: "article-1",
        recoveryScope: "user-scope-2",
      },
    ]) {
      expect(loadLocalArticleBackups(scope)).toEqual([])
    }
  })

  it("retains the five newest distinct snapshots and discards one by ID", () => {
    for (let index = 1; index <= 7; index += 1) {
      saveLocalArticleBackup(
        backup({
          id: `backup-${index}`,
          sequence: index,
          contentHash: `hash-${index}`,
          createdAt: `2026-08-08T00:00:0${index}Z`,
        })
      )
    }
    const scope = {
      projectId: "project-1",
      articleId: "article-1",
      recoveryScope: "user-scope-1",
    }

    expect(loadLocalArticleBackups(scope).map((item) => item.id)).toEqual([
      "backup-7",
      "backup-6",
      "backup-5",
      "backup-4",
      "backup-3",
    ])

    discardLocalArticleBackup(scope, "backup-5")
    expect(loadLocalArticleBackups(scope).map((item) => item.id)).toEqual([
      "backup-7",
      "backup-6",
      "backup-4",
      "backup-3",
    ])
  })

  it("falls back to one snapshot when storage quota rejects history", () => {
    const original = Storage.prototype.setItem
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException("quota", "QuotaExceededError")
      })
      .mockImplementation(function (this: Storage, key: string, value: string) {
        return original.call(this, key, value)
      })

    expect(saveLocalArticleBackup(backup())).toBe(true)
    expect(setItem).toHaveBeenCalledTimes(2)
    expect(
      loadLocalArticleBackups({
        projectId: "project-1",
        articleId: "article-1",
        recoveryScope: "user-scope-1",
      })
    ).toHaveLength(1)
  })

  it("reports failure when even the single-snapshot fallback cannot be stored", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })

    expect(saveLocalArticleBackup(backup())).toBe(false)
  })
})
