import type { AssetType, ContentAsset } from "@/api/assets"

export type ArticleUploadSource =
  "picker" | "paste" | "drop" | "url" | "library" | "replace"

export type ArticleUploadStatus =
  | "queued"
  | "initializing"
  | "uploading"
  | "processing"
  | "ready"
  | "failed"
  | "cancelled"
  | "needs_file"

export type ArticleUploadFailureKind =
  | "network"
  | "type"
  | "size"
  | "decode"
  | "security"
  | "processing"
  | "placement"
  | "expired"
  | "unknown"

export type ArticleUploadReadyFailure = {
  failure: {
    code: string
    detail: string
  }
}

export type ArticleUploadReadyResult =
  string[] | ArticleUploadReadyFailure | void

export type ArticleImageProperties = {
  alt: string
  decorative: boolean
  caption?: string
  link?: string
  display?: "regular" | "wide" | "full"
}

export function isArticleUploadReadyFailure(
  result: ArticleUploadReadyResult
): result is ArticleUploadReadyFailure {
  return Boolean(result && !Array.isArray(result) && result.failure)
}

export type ArticleUploadIntent =
  | {
      kind: "insert"
      nodeType: "image" | "file" | "audio" | "video"
      position: number
      anchorNodeId?: string
      alt?: string
      decorative?: boolean
      caption?: string
      link?: string
      display?: "regular" | "wide" | "full"
      imagePropertiesConfirmed?: boolean
    }
  | {
      kind: "gallery"
      galleryNodeId: string
      batchId?: string
      itemId: string
      position: number
      order: number
      totalItems: number
      alt?: string
      decorative?: boolean
      caption?: string
      link?: string
      imagePropertiesConfirmed?: boolean
    }
  | {
      kind: "gallery_add"
      galleryNodeId: string
      batchId?: string
      itemId: string
      order: number
      totalItems: number
      alt?: string
      decorative?: boolean
      caption?: string
      link?: string
      imagePropertiesConfirmed?: boolean
    }
  | {
      kind: "replace"
      nodeId: string
      nodeType: "image" | "gallery" | "file" | "audio" | "video"
      itemId?: string
    }
  | {
      kind: "poster"
      nodeId: string
    }

export type ArticleUploadTask = {
  uploadId: string
  idempotencyKey: string
  projectId: string
  articleId: string
  source: ArticleUploadSource
  assetType: AssetType
  intent: ArticleUploadIntent
  status: ArticleUploadStatus
  assetId: string | null
  filename: string
  mimeType: string
  byteSize: number
  lastModified: number
  sourceUrl: string | null
  previewUrl: string | null
  uploadedBytes: number
  progress: number
  failureKind: ArticleUploadFailureKind | null
  failureCode: string | null
  failureDetail: string | null
  asset: ContentAsset | null
  createdAt: string
  updatedAt: string
}

export function articleGalleryUploadGroupKey(
  intent: ArticleUploadIntent
): string | null {
  if (intent.kind !== "gallery" && intent.kind !== "gallery_add") return null
  return `${intent.kind}:${intent.galleryNodeId}:${intent.batchId ?? "legacy"}`
}

export type PersistedArticleUploadTask = Omit<
  ArticleUploadTask,
  "previewUrl" | "asset"
> & { previewUrl?: never; asset?: never }

export type ArticleUploadAction =
  | { type: "enqueue"; task: ArticleUploadTask }
  | { type: "initializing"; uploadId: string; at: string }
  | {
      type: "session_started"
      uploadId: string
      assetId: string
      at: string
    }
  | {
      type: "progress"
      uploadId: string
      uploadedBytes: number
      totalBytes: number
      at: string
    }
  | { type: "processing"; uploadId: string; asset: ContentAsset; at: string }
  | { type: "ready"; uploadId: string; asset: ContentAsset; at: string }
  | {
      type: "failed"
      uploadId: string
      code: string
      detail: string
      at: string
    }
  | { type: "cancelled"; uploadId: string; at: string }
  | { type: "retry"; uploadId: string; fileAvailable: boolean; at: string }
  | { type: "remove"; uploadId: string }
  | { type: "restore"; tasks: PersistedArticleUploadTask[]; at: string }

export function createArticleUploadTask(input: {
  projectId: string
  articleId: string
  source: ArticleUploadSource
  assetType: AssetType
  file: File
  previewUrl?: string | null
  now?: string
  uploadId?: string
  intent?: ArticleUploadIntent
}): ArticleUploadTask {
  const uploadId = input.uploadId ?? `upl_client_${crypto.randomUUID()}`
  const now = input.now ?? new Date().toISOString()
  return {
    uploadId,
    idempotencyKey: `article-upload:${input.articleId}:${uploadId}`,
    projectId: input.projectId,
    articleId: input.articleId,
    source: input.source,
    assetType: input.assetType,
    intent: input.intent ?? {
      kind: "insert",
      nodeType: input.assetType === "image" ? "image" : input.assetType,
      position: 0,
    },
    status: "queued",
    assetId: null,
    filename: input.file.name,
    mimeType: input.file.type || "application/octet-stream",
    byteSize: input.file.size,
    lastModified: input.file.lastModified,
    sourceUrl: null,
    previewUrl: input.previewUrl ?? null,
    uploadedBytes: 0,
    progress: 0,
    failureKind: null,
    failureCode: null,
    failureDetail: null,
    asset: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function createArticleUrlUploadTask(input: {
  projectId: string
  articleId: string
  sourceUrl: string
  assetType: AssetType
  filename?: string
  now?: string
  uploadId?: string
  intent?: ArticleUploadIntent
}): ArticleUploadTask {
  const uploadId = input.uploadId ?? `upl_client_${crypto.randomUUID()}`
  const now = input.now ?? new Date().toISOString()
  let filename = input.filename?.trim() || "远程资源"
  try {
    filename = decodeURIComponent(
      new URL(input.sourceUrl).pathname.split("/").pop() || filename
    )
  } catch {
    // The server returns the authoritative URL validation error.
  }
  return {
    uploadId,
    idempotencyKey: `article-upload:${input.articleId}:${uploadId}`,
    projectId: input.projectId,
    articleId: input.articleId,
    source: "url",
    assetType: input.assetType,
    intent: input.intent ?? {
      kind: "insert",
      nodeType: input.assetType === "image" ? "image" : input.assetType,
      position: 0,
    },
    status: "queued",
    assetId: null,
    filename,
    mimeType: "application/octet-stream",
    byteSize: 0,
    lastModified: 0,
    sourceUrl: input.sourceUrl,
    previewUrl: null,
    uploadedBytes: 0,
    progress: 0,
    failureKind: null,
    failureCode: null,
    failureDetail: null,
    asset: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function createArticleLibraryTask(input: {
  projectId: string
  articleId: string
  asset: ContentAsset
  now?: string
  uploadId?: string
  intent?: ArticleUploadIntent
}): ArticleUploadTask {
  const uploadId = input.uploadId ?? `upl_client_${crypto.randomUUID()}`
  const now = input.now ?? new Date().toISOString()
  return {
    uploadId,
    idempotencyKey: `article-upload:${input.articleId}:${uploadId}`,
    projectId: input.projectId,
    articleId: input.articleId,
    source: "library",
    assetType: input.asset.asset_type,
    intent: input.intent ?? {
      kind: "insert",
      nodeType:
        input.asset.asset_type === "image" ? "image" : input.asset.asset_type,
      position: 0,
    },
    status: "ready",
    assetId: input.asset.canonical_asset_id ?? input.asset.asset_id,
    filename: input.asset.original_filename,
    mimeType:
      input.asset.detected_mime_type ||
      input.asset.mime_type ||
      "application/octet-stream",
    byteSize: input.asset.byte_size ?? 0,
    lastModified: 0,
    sourceUrl: null,
    previewUrl: null,
    uploadedBytes: input.asset.byte_size ?? 0,
    progress: 100,
    failureKind: null,
    failureCode: null,
    failureDetail: null,
    asset: input.asset,
    createdAt: now,
    updatedAt: now,
  }
}

export function articleUploadFailureKind(
  code: string
): ArticleUploadFailureKind {
  if (code.includes("network") || code.includes("unavailable")) return "network"
  if (code.includes("type") || code.includes("mime")) return "type"
  if (code.includes("large") || code.includes("size")) return "size"
  if (code.includes("decode") || code.includes("dimension")) return "decode"
  if (
    code.includes("malware") ||
    code.includes("ssrf") ||
    code.includes("quarant") ||
    code.includes("security")
  ) {
    return "security"
  }
  if (code.includes("processing") || code.includes("transcod")) {
    return "processing"
  }
  if (code.includes("anchor") || code.includes("placement")) return "placement"
  if (code.includes("expired")) return "expired"
  return "unknown"
}

function updateTask(
  tasks: ArticleUploadTask[],
  uploadId: string,
  update: (task: ArticleUploadTask) => ArticleUploadTask
) {
  return tasks.map((task) => (task.uploadId === uploadId ? update(task) : task))
}

export function articleUploadReducer(
  tasks: ArticleUploadTask[],
  action: ArticleUploadAction
): ArticleUploadTask[] {
  switch (action.type) {
    case "enqueue":
      return tasks.some((task) => task.uploadId === action.task.uploadId)
        ? tasks
        : [...tasks, action.task]
    case "initializing":
      return updateTask(tasks, action.uploadId, (task) => ({
        ...task,
        status: "initializing",
        updatedAt: action.at,
      }))
    case "session_started":
      return updateTask(tasks, action.uploadId, (task) => ({
        ...task,
        assetId: action.assetId,
        status: "uploading",
        updatedAt: action.at,
      }))
    case "progress":
      return updateTask(tasks, action.uploadId, (task) => {
        const uploadedBytes = Math.max(task.uploadedBytes, action.uploadedBytes)
        return {
          ...task,
          status: "uploading",
          uploadedBytes,
          progress:
            action.totalBytes > 0
              ? Math.min(100, (uploadedBytes / action.totalBytes) * 100)
              : 0,
          updatedAt: action.at,
        }
      })
    case "processing":
      return updateTask(tasks, action.uploadId, (task) => ({
        ...task,
        status: "processing",
        assetId: action.asset.asset_id,
        uploadedBytes: task.byteSize,
        progress: 100,
        asset: action.asset,
        updatedAt: action.at,
      }))
    case "ready":
      return updateTask(tasks, action.uploadId, (task) => ({
        ...task,
        status: "ready",
        assetId: action.asset.canonical_asset_id ?? action.asset.asset_id,
        uploadedBytes: task.byteSize,
        progress: 100,
        asset: action.asset,
        failureKind: null,
        failureCode: null,
        failureDetail: null,
        updatedAt: action.at,
      }))
    case "failed":
      return updateTask(tasks, action.uploadId, (task) => ({
        ...task,
        status: "failed",
        failureKind: articleUploadFailureKind(action.code),
        failureCode: action.code,
        failureDetail: action.detail,
        updatedAt: action.at,
      }))
    case "cancelled":
      return updateTask(tasks, action.uploadId, (task) => ({
        ...task,
        status: "cancelled",
        previewUrl: null,
        updatedAt: action.at,
      }))
    case "retry":
      return updateTask(tasks, action.uploadId, (task) => ({
        ...task,
        status:
          task.assetId && task.failureKind === "processing"
            ? "processing"
            : action.fileAvailable
              ? "queued"
              : "needs_file",
        uploadedBytes:
          task.assetId && task.failureKind === "processing" ? task.byteSize : 0,
        progress: task.assetId && task.failureKind === "processing" ? 100 : 0,
        failureKind:
          task.assetId && task.failureKind === "processing"
            ? "processing"
            : null,
        failureCode: null,
        failureDetail: null,
        updatedAt: action.at,
      }))
    case "remove":
      return tasks.filter((task) => task.uploadId !== action.uploadId)
    case "restore": {
      const known = new Set(tasks.map((task) => task.uploadId))
      return [
        ...tasks,
        ...action.tasks
          .filter((task) => !known.has(task.uploadId))
          .map((task): ArticleUploadTask => ({
            ...task,
            status:
              task.status === "failed" &&
              task.failureKind === "processing" &&
              task.assetId
                ? "failed"
                : ["processing", "ready"].includes(task.status) && task.assetId
                  ? "processing"
                  : task.source === "url" && task.sourceUrl
                    ? "queued"
                    : "needs_file",
            previewUrl: null,
            asset: null,
            updatedAt: action.at,
          })),
      ]
    }
  }
}

export function serializeArticleUploadTasks(tasks: ArticleUploadTask[]) {
  return JSON.stringify(
    tasks
      .filter((task) => task.status !== "cancelled")
      .map((task): PersistedArticleUploadTask => {
        const persisted: Partial<ArticleUploadTask> = { ...task }
        delete persisted.previewUrl
        delete persisted.asset
        return persisted as PersistedArticleUploadTask
      })
  )
}

export function parseArticleUploadTasks(
  value: string | null,
  projectId: string,
  articleId: string
): PersistedArticleUploadTask[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is PersistedArticleUploadTask => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false
      const task = item as Partial<PersistedArticleUploadTask>
      return (
        task.projectId === projectId &&
        task.articleId === articleId &&
        typeof task.uploadId === "string" &&
        typeof task.idempotencyKey === "string" &&
        typeof task.filename === "string" &&
        typeof task.byteSize === "number" &&
        Boolean(task.intent && typeof task.intent === "object") &&
        (task.sourceUrl === null || typeof task.sourceUrl === "string")
      )
    })
  } catch {
    return []
  }
}

export function articleUploadStorageKey(projectId: string, articleId: string) {
  return `seo:article-upload:v1:${projectId}:${articleId}`
}

export function fileMatchesUploadTask(file: File, task: ArticleUploadTask) {
  return (
    file.name === task.filename &&
    file.size === task.byteSize &&
    file.lastModified === task.lastModified
  )
}
