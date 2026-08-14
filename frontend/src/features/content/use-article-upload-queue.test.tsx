import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  articleUploadReducer,
  articleUploadStorageKey,
  createArticleUploadTask,
  serializeArticleUploadTasks,
} from "@/features/content/article-upload-queue"
import { useArticleUploadQueue } from "@/features/content/use-article-upload-queue"
import type { ContentAsset } from "@/api/assets"
import type { ArticleUploadTask } from "@/features/content/article-upload-queue"

const assetApi = vi.hoisted(() => ({
  cancelAsset: vi.fn(),
}))

const uploadExecutor = vi.hoisted(() => ({
  executeArticleFileUpload: vi.fn(() => new Promise(() => undefined)),
  executeArticleUrlImport: vi.fn(() => new Promise(() => undefined)),
  resumeArticleAssetProcessing: vi.fn(() => new Promise(() => undefined)),
  uploadErrorDetails: vi.fn(() => ({
    code: "asset_upload_failed",
    detail: "Upload failed.",
  })),
}))

vi.mock("@/api/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/assets")>()),
  ...assetApi,
}))

vi.mock("@/features/content/article-upload-executor", () => uploadExecutor)

const originalFile = new File(["original"], "gallery-one.png", {
  type: "image/png",
  lastModified: 100,
})

const galleryIntent = {
  kind: "gallery" as const,
  galleryNodeId: "gallery-1",
  batchId: "batch-1",
  itemId: "item-2",
  position: 8,
  order: 1,
  totalItems: 5,
}

const readyAsset = {
  asset_id: "asset-ready",
  canonical_asset_id: null,
  asset_type: "image",
  status: "ready",
  original_filename: "ready.png",
  title: null,
  default_alt_text: null,
  caption: null,
  description: null,
  mime_type: "image/png",
  detected_mime_type: "image/png",
  byte_size: 5,
  content_hash: "hash-ready",
  width: 1200,
  height: 800,
  duration_ms: null,
  source_type: "import",
  source_url: "https://example.com/ready.png",
  final_source_url: "https://example.com/ready.png",
  failure_code: null,
  failure_detail: null,
  created_at: "2026-08-09T12:00:00.000Z",
  updated_at: "2026-08-09T12:00:01.000Z",
  ready_at: "2026-08-09T12:00:01.000Z",
  active_reference_count: 0,
  variants: [],
  actions: [],
} satisfies ContentAsset

function persistedTask(status: "needs_file" | "failed") {
  const queued = createArticleUploadTask({
    projectId: "project-1",
    articleId: "article-1",
    source: "picker",
    assetType: "image",
    file: originalFile,
    uploadId: "upload-original",
    intent: galleryIntent,
    now: "2026-08-09T12:00:00.000Z",
  })
  const failed = articleUploadReducer([queued], {
    type: "failed",
    uploadId: queued.uploadId,
    code: "asset_decode_failed",
    detail: "The image cannot be decoded.",
    at: "2026-08-09T12:01:00.000Z",
  })[0]
  return {
    ...(status === "failed" ? failed : queued),
    status,
    assetId: status === "failed" ? "asset-failed" : null,
  }
}

function persistedProcessingTask() {
  const failed = persistedTask("failed")
  return {
    ...failed,
    status: "processing" as const,
    assetId: "asset-processing-failed",
    failureKind: null,
    failureCode: null,
    failureDetail: null,
  }
}

function renderQueue(status: "needs_file" | "failed") {
  localStorage.setItem(
    articleUploadStorageKey("project-1", "article-1"),
    serializeArticleUploadTasks([persistedTask(status)])
  )
  return renderHook(() =>
    useArticleUploadQueue({
      projectId: "project-1",
      articleId: "article-1",
      onReady: vi.fn(),
    })
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  assetApi.cancelAsset.mockResolvedValue(undefined)
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:replacement"),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("useArticleUploadQueue", () => {
  it("reattaches only the original file to the same task identity", async () => {
    const hook = renderQueue("needs_file")
    await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1))

    const wrongFile = new File(["different"], "gallery-one.png", {
      type: "image/png",
      lastModified: 101,
    })
    act(() => {
      expect(hook.result.current.attachFile("upload-original", wrongFile)).toBe(
        false
      )
    })
    expect(hook.result.current.tasks[0].status).toBe("needs_file")

    act(() => {
      expect(
        hook.result.current.attachFile("upload-original", originalFile)
      ).toBe(true)
    })
    await waitFor(() =>
      expect(hook.result.current.tasks[0].status).toBe("initializing")
    )
    expect(hook.result.current.tasks[0]).toMatchObject({
      uploadId: "upload-original",
      idempotencyKey: "article-upload:article-1:upload-original",
      intent: galleryIntent,
    })
  })

  it("replaces a failed file with a new identity at the same gallery position", async () => {
    const hook = renderQueue("failed")
    await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1))
    const replacementFile = new File(["replacement"], "gallery-new.png", {
      type: "image/png",
      lastModified: 200,
    })

    const replacement: { current: ArticleUploadTask | null } = { current: null }
    act(() => {
      replacement.current = hook.result.current.replaceFile(
        "upload-original",
        replacementFile
      )
    })

    expect(replacement.current).not.toBeNull()
    if (!replacement.current)
      throw new Error("Replacement task was not created")
    const replacementTask = replacement.current
    expect(replacementTask.uploadId).not.toBe("upload-original")
    expect(replacementTask.idempotencyKey).toBe(
      `article-upload:article-1:${replacementTask.uploadId}`
    )
    expect(replacementTask).toMatchObject({
      source: "replace",
      intent: galleryIntent,
    })
    expect(assetApi.cancelAsset).toHaveBeenCalledWith(
      "project-1",
      "asset-failed",
      undefined
    )
    await waitFor(() =>
      expect(
        hook.result.current.tasks.some(
          (task) => task.uploadId === "upload-original"
        )
      ).toBe(false)
    )
  })

  it("keeps a ready asset on placement conflict and retries without uploading again", async () => {
    uploadExecutor.executeArticleUrlImport.mockResolvedValueOnce(readyAsset)
    const onReady = vi
      .fn()
      .mockReturnValueOnce({
        failure: {
          code: "article_upload_anchor_edited",
          detail: "The original upload position was edited.",
        },
      })
      .mockImplementationOnce((task) => [task.uploadId])
    const hook = renderHook(() =>
      useArticleUploadQueue({
        projectId: "project-1",
        articleId: "article-1",
        onReady,
      })
    )

    let uploadId = ""
    act(() => {
      uploadId = hook.result.current.enqueueUrl(
        "https://example.com/ready.png",
        "image",
        {
          kind: "insert",
          nodeType: "image",
          position: 8,
          anchorNodeId: "paste-anchor-edited",
        }
      ).uploadId
    })

    await waitFor(() =>
      expect(hook.result.current.tasks[0]).toMatchObject({
        uploadId,
        status: "failed",
        asset: readyAsset,
        failureKind: "placement",
        failureCode: "article_upload_anchor_edited",
      })
    )
    expect(uploadExecutor.executeArticleUrlImport).toHaveBeenCalledTimes(1)

    act(() => hook.result.current.retry(uploadId))

    await waitFor(() => expect(hook.result.current.tasks).toHaveLength(0))
    expect(onReady).toHaveBeenCalledTimes(2)
    expect(uploadExecutor.executeArticleUrlImport).toHaveBeenCalledTimes(1)
  })

  it("retries a failed server-side processing job before polling it again", async () => {
    uploadExecutor.resumeArticleAssetProcessing
      .mockRejectedValueOnce(new Error("processing failed"))
      .mockImplementationOnce(() => new Promise(() => undefined))
    uploadExecutor.uploadErrorDetails.mockReturnValueOnce({
      code: "asset_processing_failed",
      detail: "The asset could not be processed.",
    })
    localStorage.setItem(
      articleUploadStorageKey("project-1", "article-1"),
      serializeArticleUploadTasks([persistedProcessingTask()])
    )
    const hook = renderHook(() =>
      useArticleUploadQueue({
        projectId: "project-1",
        articleId: "article-1",
        onReady: vi.fn(),
      })
    )
    await waitFor(() =>
      expect(hook.result.current.tasks[0]).toMatchObject({
        status: "failed",
        failureKind: "processing",
      })
    )

    act(() => hook.result.current.retry("upload-original"))

    await waitFor(() =>
      expect(
        uploadExecutor.resumeArticleAssetProcessing
      ).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          assetId: "asset-processing-failed",
          status: "processing",
          failureKind: "processing",
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    )
  })
})
