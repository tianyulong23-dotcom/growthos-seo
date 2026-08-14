import { apiRequest, resolveApiUrl } from "@/api/client"
import type { ArticleRequestOptions } from "@/api/articles"

export type AssetType = "image" | "video" | "audio" | "file"
export type AssetStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "processing"
  | "ready"
  | "pending_delete"
  | "failed"
  | "quarantined"

export type AssetVariant = {
  variant_type: string
  format: string
  width: number | null
  height: number | null
  byte_size: number
  status: string
}

export type ContentAsset = {
  asset_id: string
  canonical_asset_id: string | null
  asset_type: AssetType
  status: AssetStatus
  original_filename: string
  title: string | null
  default_alt_text: string | null
  caption: string | null
  description: string | null
  mime_type: string | null
  detected_mime_type: string | null
  byte_size: number | null
  content_hash: string | null
  width: number | null
  height: number | null
  duration_ms: number | null
  source_type: string
  source_url: string | null
  final_source_url: string | null
  failure_code: string | null
  failure_detail: string | null
  created_at: string
  updated_at: string
  ready_at: string | null
  active_reference_count: number
  variants: AssetVariant[]
  actions: string[]
}

export type AssetUsageItem = {
  article_id: string
  article_title: string | null
  article_status: string
  current_reference_count: number
  version_reference_count: number
  binding_roles: string[]
  node_ids: string[]
  version_numbers: number[]
}

export type AssetUsage = {
  asset_id: string
  active_reference_count: number
  article_count: number
  items: AssetUsageItem[]
}

export type AssetUploadSession = {
  asset_id: string
  upload_id: string
  status: string
  part_size: number
  maximum_bytes: number
  expires_at: string
}

export type UploadedAssetPart = {
  asset_id: string
  upload_id: string
  part_number: number
  etag: string
  byte_size: number
  uploaded_bytes: number
  status: string
}

export type AssetCollection = {
  items: ContentAsset[]
  next_cursor: string | null
}

export type AssetPartProgress = {
  partNumber: number
  partBytes: number
  partUploadedBytes: number
  completedBytes: number
  totalUploadedBytes: number
  totalBytes: number
}

export type AssetDownloadAuthorization = {
  url: string
  expires_at: string
}

function assetPath(projectId: string, suffix = "") {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/assets${suffix}`
}

function requestHeaders(
  options?: ArticleRequestOptions,
  headers?: HeadersInit
) {
  const result = new Headers(headers)
  if (options?.accessToken) {
    result.set("Authorization", `Bearer ${options.accessToken}`)
  }
  if (options?.requestId) result.set("X-Request-ID", options.requestId)
  return result
}

function requestInit(
  options?: ArticleRequestOptions,
  init: RequestInit = {}
): RequestInit {
  return {
    ...init,
    signal: options?.signal ?? init.signal,
    headers: requestHeaders(options, init.headers),
  }
}

export function createAssetUpload(
  projectId: string,
  input: {
    filename: string
    byte_size: number
    declared_mime_type: string
    asset_type: AssetType
    sha256?: string | null
    source_type: "upload" | "paste"
  },
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<AssetUploadSession>(
    assetPath(projectId, "/uploads"),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function uploadAssetPart(
  projectId: string,
  assetId: string,
  partNumber: number,
  body: Blob,
  input: {
    contentSha256: string
    completedBytes: number
    totalBytes: number
    onProgress?: (progress: AssetPartProgress) => void
  },
  options?: ArticleRequestOptions
): Promise<UploadedAssetPart> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const query = new URLSearchParams({ part_number: String(partNumber) })
    xhr.open(
      "PUT",
      resolveApiUrl(
        `${assetPath(projectId, `/${encodeURIComponent(assetId)}/content`)}?${query}`
      )
    )
    xhr.responseType = "json"
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.setRequestHeader("Content-SHA256", input.contentSha256)
    if (options?.accessToken) {
      xhr.setRequestHeader("Authorization", `Bearer ${options.accessToken}`)
    }
    if (options?.requestId) {
      xhr.setRequestHeader("X-Request-ID", options.requestId)
    }

    const abort = () => xhr.abort()
    options?.signal?.addEventListener("abort", abort, { once: true })
    const clean = () => options?.signal?.removeEventListener("abort", abort)

    xhr.upload.onprogress = (event) => {
      const partUploadedBytes = event.lengthComputable
        ? Math.min(event.loaded, body.size)
        : Math.min(event.loaded, body.size)
      input.onProgress?.({
        partNumber,
        partBytes: body.size,
        partUploadedBytes,
        completedBytes: input.completedBytes,
        totalUploadedBytes: Math.min(
          input.totalBytes,
          input.completedBytes + partUploadedBytes
        ),
        totalBytes: input.totalBytes,
      })
    }
    xhr.onerror = () => {
      clean()
      reject(new Error("asset_upload_network_error"))
    }
    xhr.onabort = () => {
      clean()
      reject(new DOMException("Upload aborted", "AbortError"))
    }
    xhr.onload = () => {
      clean()
      const response = xhr.response as
        | UploadedAssetPart
        | { error?: { code?: string; message?: string } }
        | null
      if (xhr.status >= 200 && xhr.status < 300 && response) {
        resolve(response as UploadedAssetPart)
        return
      }
      const error = response && "error" in response ? response.error : null
      reject(
        new Error(
          error?.code || error?.message || `asset_upload_http_${xhr.status}`
        )
      )
    }
    if (options?.signal?.aborted) {
      abort()
      return
    }
    xhr.send(body)
  })
}

export function completeAssetUpload(
  projectId: string,
  assetId: string,
  input: {
    parts: Array<{ part_number: number; etag: string }>
    sha256?: string | null
  },
  options?: ArticleRequestOptions
) {
  return apiRequest<ContentAsset>(
    assetPath(projectId, `/${encodeURIComponent(assetId)}/complete`),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function getAsset(
  projectId: string,
  assetId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ContentAsset>(
    assetPath(projectId, `/${encodeURIComponent(assetId)}`),
    requestInit(options)
  )
}

export function updateAssetMetadata(
  projectId: string,
  assetId: string,
  input: {
    title?: string | null
    default_alt_text?: string | null
    caption?: string | null
    description?: string | null
  },
  options?: ArticleRequestOptions
) {
  return apiRequest<ContentAsset>(
    assetPath(projectId, `/${encodeURIComponent(assetId)}`),
    requestInit(options, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function getAssetUsage(
  projectId: string,
  assetId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<AssetUsage>(
    assetPath(projectId, `/${encodeURIComponent(assetId)}/usage`),
    requestInit(options)
  )
}

export function retryAsset(
  projectId: string,
  assetId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ContentAsset>(
    assetPath(projectId, `/${encodeURIComponent(assetId)}/retry`),
    requestInit(options, { method: "POST" })
  )
}

export function cancelAsset(
  projectId: string,
  assetId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ContentAsset>(
    assetPath(projectId, `/${encodeURIComponent(assetId)}/cancel`),
    requestInit(options, { method: "POST" })
  )
}

export function importAsset(
  projectId: string,
  input: {
    source_url: string
    asset_type: AssetType
    filename?: string | null
  },
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ContentAsset>(
    assetPath(projectId, "/import"),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function listAssets(
  projectId: string,
  params: {
    assetType?: AssetType
    status?: AssetStatus
    query?: string
    cursor?: string
    limit?: number
  } = {},
  options?: ArticleRequestOptions
) {
  const query = new URLSearchParams()
  if (params.assetType) query.set("asset_type", params.assetType)
  if (params.status) query.set("status", params.status)
  if (params.query?.trim()) query.set("query", params.query.trim())
  if (params.cursor) query.set("cursor", params.cursor)
  query.set("limit", String(params.limit ?? 30))
  return apiRequest<AssetCollection>(
    `${assetPath(projectId)}?${query}`,
    requestInit(options)
  )
}

export function assetDownloadUrl(projectId: string, assetId: string) {
  return resolveApiUrl(
    assetPath(projectId, `/${encodeURIComponent(assetId)}/download`)
  )
}

export function authorizeAssetDownload(
  projectId: string,
  assetId: string,
  disposition: "inline" | "attachment",
  options?: ArticleRequestOptions,
  variantType?: string
) {
  return apiRequest<AssetDownloadAuthorization>(
    assetPath(
      projectId,
      `/${encodeURIComponent(assetId)}/download-authorizations`
    ),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        disposition,
        ...(variantType ? { variant_type: variantType } : {}),
      }),
    })
  )
}

export function deleteAsset(
  projectId: string,
  assetId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<void>(
    assetPath(projectId, `/${encodeURIComponent(assetId)}`),
    requestInit(options, { method: "DELETE" })
  )
}
