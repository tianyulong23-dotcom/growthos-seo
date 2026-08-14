import { createSHA256 } from "hash-wasm"

import {
  completeAssetUpload,
  createAssetUpload,
  getAsset,
  importAsset,
  retryAsset,
  uploadAssetPart,
  type ContentAsset,
} from "@/api/assets"
import { ApiError } from "@/api/client"
import type { ArticleRequestOptions } from "@/api/articles"
import type { ArticleUploadTask } from "@/features/content/article-upload-queue"

const HASH_CHUNK_SIZE = 4 * 1024 * 1024
const DEFAULT_POLL_INTERVAL_MS = 1_500

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError")
}

export async function sha256Blob(
  blob: Blob,
  signal?: AbortSignal,
  chunkSize = HASH_CHUNK_SIZE
) {
  const hasher = await createSHA256()
  hasher.init()
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    throwIfAborted(signal)
    const chunk = blob.slice(offset, Math.min(blob.size, offset + chunkSize))
    hasher.update(new Uint8Array(await chunk.arrayBuffer()))
  }
  throwIfAborted(signal)
  return hasher.digest("hex")
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      reject(new DOMException("Upload aborted", "AbortError"))
    }
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function assetFailure(asset: ContentAsset) {
  const error = new Error(
    asset.failure_detail || asset.failure_code || "asset_processing_failed"
  )
  error.name = asset.failure_code || "asset_processing_failed"
  return error
}

export async function waitForReadyAsset(
  projectId: string,
  assetId: string,
  options: ArticleRequestOptions = {},
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
): Promise<ContentAsset> {
  let asset = await getAsset(projectId, assetId, options)
  while (
    !["ready", "failed", "quarantined", "pending_delete"].includes(asset.status)
  ) {
    await delay(pollIntervalMs, options.signal)
    asset = await getAsset(projectId, assetId, options)
  }
  if (asset.status !== "ready") throw assetFailure(asset)
  return asset
}

export type ArticleUploadExecutionCallbacks = {
  onSessionStarted: (assetId: string) => void
  onProgress: (uploadedBytes: number, totalBytes: number) => void
  onProcessing: (asset: ContentAsset) => void
}

export async function executeArticleFileUpload(
  task: ArticleUploadTask,
  file: File,
  callbacks: ArticleUploadExecutionCallbacks,
  options: ArticleRequestOptions = {}
) {
  if (file.size !== task.byteSize)
    throw new Error("asset_file_identity_mismatch")
  const sha256 = await sha256Blob(file, options.signal)
  const session = await createAssetUpload(
    task.projectId,
    {
      filename: file.name,
      byte_size: file.size,
      declared_mime_type: task.mimeType,
      asset_type: task.assetType,
      sha256,
      source_type: task.source === "paste" ? "paste" : "upload",
    },
    task.idempotencyKey,
    options
  )
  if (file.size > session.maximum_bytes) throw new Error("asset_file_too_large")
  callbacks.onSessionStarted(session.asset_id)

  const parts: Array<{ part_number: number; etag: string }> = []
  let completedBytes = 0
  let partNumber = 1
  for (let offset = 0; offset < file.size; offset += session.part_size) {
    throwIfAborted(options.signal)
    const part = file.slice(
      offset,
      Math.min(file.size, offset + session.part_size)
    )
    const result = await uploadAssetPart(
      task.projectId,
      session.asset_id,
      partNumber,
      part,
      {
        contentSha256: await sha256Blob(part, options.signal),
        completedBytes,
        totalBytes: file.size,
        onProgress: ({ totalUploadedBytes, totalBytes }) =>
          callbacks.onProgress(totalUploadedBytes, totalBytes),
      },
      options
    )
    completedBytes += part.size
    callbacks.onProgress(completedBytes, file.size)
    parts.push({ part_number: partNumber, etag: result.etag })
    partNumber += 1
  }

  const completed = await completeAssetUpload(
    task.projectId,
    session.asset_id,
    { parts, sha256 },
    options
  )
  if (completed.status === "ready") return completed
  if (["failed", "quarantined", "pending_delete"].includes(completed.status)) {
    throw assetFailure(completed)
  }
  callbacks.onProcessing(completed)
  return waitForReadyAsset(task.projectId, session.asset_id, options)
}

export async function resumeArticleAssetProcessing(
  task: ArticleUploadTask,
  options: ArticleRequestOptions = {}
) {
  if (!task.assetId) throw new Error("asset_id_missing")
  if (task.failureKind === "processing") {
    const retried = await retryAsset(task.projectId, task.assetId, options)
    if (retried.status === "ready") return retried
    if (["failed", "quarantined", "pending_delete"].includes(retried.status)) {
      throw assetFailure(retried)
    }
  }
  return waitForReadyAsset(task.projectId, task.assetId, options)
}

export async function executeArticleUrlImport(
  task: ArticleUploadTask,
  sourceUrl: string,
  callbacks: Pick<
    ArticleUploadExecutionCallbacks,
    "onSessionStarted" | "onProcessing"
  >,
  options: ArticleRequestOptions = {}
) {
  const asset = await importAsset(
    task.projectId,
    {
      source_url: sourceUrl,
      asset_type: task.assetType,
      filename: task.filename || null,
    },
    task.idempotencyKey,
    options
  )
  callbacks.onSessionStarted(asset.asset_id)
  if (asset.status === "ready") return asset
  if (["failed", "quarantined", "pending_delete"].includes(asset.status)) {
    throw assetFailure(asset)
  }
  callbacks.onProcessing(asset)
  return waitForReadyAsset(task.projectId, asset.asset_id, options)
}

export function uploadErrorDetails(error: unknown) {
  if (error instanceof ApiError) {
    return {
      code: error.code || `asset_upload_http_${error.status}`,
      detail: error.message,
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "asset_upload_cancelled", detail: "上传已取消" }
  }
  if (error instanceof Error) {
    return {
      code: error.name === "Error" ? error.message : error.name,
      detail: error.message,
    }
  }
  return { code: "asset_upload_unknown", detail: "上传失败" }
}
