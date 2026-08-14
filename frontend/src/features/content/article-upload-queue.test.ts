import { describe, expect, it } from "vitest"

import {
  articleUploadFailureKind,
  articleUploadReducer,
  createArticleLibraryTask,
  createArticleUploadTask,
  fileMatchesUploadTask,
  parseArticleUploadTasks,
  serializeArticleUploadTasks,
} from "@/features/content/article-upload-queue"

const now = "2026-08-09T12:00:00.000Z"
const file = new File(["image"], "proof.png", {
  type: "image/png",
  lastModified: 100,
})

const readyAsset = {
  asset_id: "asset-1",
  canonical_asset_id: null,
  asset_type: "image" as const,
  status: "ready" as const,
  original_filename: "proof.png",
  title: null,
  default_alt_text: null,
  caption: null,
  description: null,
  mime_type: "image/png",
  detected_mime_type: "image/png",
  byte_size: 5,
  content_hash: "abc",
  width: 1200,
  height: 800,
  duration_ms: null,
  source_type: "upload",
  source_url: null,
  final_source_url: null,
  failure_code: null,
  failure_detail: null,
  created_at: now,
  updated_at: now,
  ready_at: now,
  active_reference_count: 0,
  variants: [],
  actions: [],
}

function task() {
  return createArticleUploadTask({
    projectId: "project-1",
    articleId: "article-1",
    source: "paste",
    assetType: "image",
    file,
    previewUrl: "blob:preview",
    now,
    uploadId: "client-upload-1",
  })
}

describe("article upload queue", () => {
  it("keeps one stable upload and idempotency identity across retry", () => {
    const initial = articleUploadReducer([], { type: "enqueue", task: task() })
    const failed = articleUploadReducer(initial, {
      type: "failed",
      uploadId: "client-upload-1",
      code: "asset_upload_network_error",
      detail: "offline",
      at: now,
    })
    const retried = articleUploadReducer(failed, {
      type: "retry",
      uploadId: "client-upload-1",
      fileAvailable: true,
      at: now,
    })

    expect(retried[0].uploadId).toBe("client-upload-1")
    expect(retried[0].idempotencyKey).toBe(
      "article-upload:article-1:client-upload-1"
    )
    expect(retried[0].status).toBe("queued")
  })

  it("uses byte progress monotonically and separates processing from upload", () => {
    let state = [task()]
    state = articleUploadReducer(state, {
      type: "session_started",
      uploadId: "client-upload-1",
      assetId: "asset-1",
      at: now,
    })
    state = articleUploadReducer(state, {
      type: "progress",
      uploadId: "client-upload-1",
      uploadedBytes: 4,
      totalBytes: 10,
      at: now,
    })
    state = articleUploadReducer(state, {
      type: "progress",
      uploadId: "client-upload-1",
      uploadedBytes: 2,
      totalBytes: 10,
      at: now,
    })
    expect(state[0]).toMatchObject({
      status: "uploading",
      uploadedBytes: 4,
      progress: 40,
    })

    state = articleUploadReducer(state, {
      type: "processing",
      uploadId: "client-upload-1",
      asset: {
        asset_id: "asset-1",
        canonical_asset_id: null,
        asset_type: "image",
        status: "processing",
        original_filename: "proof.png",
        title: null,
        default_alt_text: null,
        caption: null,
        description: null,
        mime_type: "image/png",
        detected_mime_type: null,
        byte_size: 10,
        content_hash: null,
        width: null,
        height: null,
        duration_ms: null,
        source_type: "paste",
        source_url: null,
        final_source_url: null,
        failure_code: null,
        failure_detail: null,
        created_at: now,
        updated_at: now,
        ready_at: null,
        active_reference_count: 0,
        variants: [],
        actions: ["cancel"],
      },
      at: now,
    })
    expect(state[0]).toMatchObject({ status: "processing", progress: 100 })
  })

  it("never persists object URLs and restores file-backed work explicitly", () => {
    const serialized = serializeArticleUploadTasks([task()])
    expect(serialized).not.toContain("blob:")
    const restored = parseArticleUploadTasks(
      serialized,
      "project-1",
      "article-1"
    )
    const state = articleUploadReducer([], {
      type: "restore",
      tasks: restored,
      at: now,
    })
    expect(state[0]).toMatchObject({ status: "needs_file", previewUrl: null })
  })

  it("restores a failed server-side processing job without asking for the file again", () => {
    let state = articleUploadReducer([task()], {
      type: "session_started",
      uploadId: "client-upload-1",
      assetId: "asset-processing-failed",
      at: now,
    })
    state = articleUploadReducer(state, {
      type: "failed",
      uploadId: "client-upload-1",
      code: "asset_processing_failed",
      detail: "The image could not be processed.",
      at: now,
    })

    const restored = articleUploadReducer([], {
      type: "restore",
      tasks: parseArticleUploadTasks(
        serializeArticleUploadTasks(state),
        "project-1",
        "article-1"
      ),
      at: now,
    })

    expect(restored[0]).toMatchObject({
      status: "failed",
      assetId: "asset-processing-failed",
      failureKind: "processing",
      failureCode: "asset_processing_failed",
      previewUrl: null,
    })
  })

  it("classifies failures and matches only the original file identity", () => {
    expect(articleUploadFailureKind("asset_import_ssrf_blocked")).toBe(
      "security"
    )
    expect(articleUploadFailureKind("asset_mime_mismatch")).toBe("type")
    expect(articleUploadFailureKind("asset_too_large")).toBe("size")
    expect(fileMatchesUploadTask(file, task())).toBe(true)
    expect(
      fileMatchesUploadTask(
        new File(["image"], "proof.png", {
          type: "image/png",
          lastModified: 101,
        }),
        task()
      )
    ).toBe(false)
  })

  it("persists placement intent and rechecks a ready task after reload", () => {
    const libraryTask = createArticleLibraryTask({
      projectId: "project-1",
      articleId: "article-1",
      asset: readyAsset,
      uploadId: "client-library-1",
      now,
      intent: {
        kind: "replace",
        nodeId: "image-1",
        nodeType: "image",
      },
    })

    const restored = articleUploadReducer([], {
      type: "restore",
      tasks: parseArticleUploadTasks(
        serializeArticleUploadTasks([libraryTask]),
        "project-1",
        "article-1"
      ),
      at: now,
    })

    expect(restored[0]).toMatchObject({
      status: "processing",
      assetId: "asset-1",
      intent: {
        kind: "replace",
        nodeId: "image-1",
        nodeType: "image",
      },
    })
  })
})
