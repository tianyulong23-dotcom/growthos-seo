import {
  authorizeAssetDownload,
  cancelAsset,
  getAsset,
  retryAsset,
  type ContentAsset,
} from "@/api/assets"
import type { ArticleRequestOptions } from "@/api/articles"

const REFRESH_EARLY_MS = 30_000
const PROCESSING_REFRESH_MS = 2_000

export type ArticleAssetAccessSnapshot = {
  url: string
  loading: boolean
  error: string
}

const emptySnapshot: ArticleAssetAccessSnapshot = {
  url: "",
  loading: false,
  error: "",
}

type AssetAccessEntry = {
  snapshot: ArticleAssetAccessSnapshot
  expiresAt: number
  listeners: Set<() => void>
  request: Promise<void> | null
  refreshTimer: ReturnType<typeof setTimeout> | null
}

export type ArticleAssetMetadataSnapshot = {
  asset: ContentAsset | null
  loading: boolean
  error: string
  action: "" | "retry" | "cancel"
}

const emptyMetadataSnapshot: ArticleAssetMetadataSnapshot = {
  asset: null,
  loading: false,
  error: "",
  action: "",
}

type AssetMetadataEntry = {
  snapshot: ArticleAssetMetadataSnapshot
  listeners: Set<() => void>
  request: Promise<void> | null
  actionRequest: Promise<void> | null
  refreshTimer: ReturnType<typeof setTimeout> | null
}

export class ArticleAssetAccessStore {
  private readonly entries = new Map<string, AssetAccessEntry>()
  private readonly metadataEntries = new Map<string, AssetMetadataEntry>()
  private projectId: string
  private requestOptions?: Omit<ArticleRequestOptions, "signal">

  constructor(
    projectId: string,
    requestOptions?: Omit<ArticleRequestOptions, "signal">
  ) {
    this.projectId = projectId
    this.requestOptions = requestOptions
  }

  configure(
    projectId: string,
    requestOptions?: Omit<ArticleRequestOptions, "signal">
  ) {
    if (
      this.projectId === projectId &&
      this.requestOptions?.accessToken === requestOptions?.accessToken &&
      this.requestOptions?.requestId === requestOptions?.requestId
    ) {
      return
    }
    this.dispose()
    this.projectId = projectId
    this.requestOptions = requestOptions
  }

  subscribe(
    assetId: string,
    disposition: "inline" | "attachment",
    listener: () => void,
    variantType?: string
  ) {
    const entry = this.entry(assetId, disposition, variantType)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  snapshot(
    assetId: string,
    disposition: "inline" | "attachment",
    variantType?: string
  ) {
    if (!assetId) return emptySnapshot
    return (
      this.entries.get(this.key(assetId, disposition, variantType))?.snapshot ??
      emptySnapshot
    )
  }

  load(
    assetId: string,
    disposition: "inline" | "attachment",
    force = false,
    variantType?: string
  ) {
    if (!assetId) return Promise.resolve()
    const entry = this.entry(assetId, disposition, variantType)
    if (entry.request) return entry.request
    if (
      !force &&
      entry.snapshot.url &&
      Date.now() < entry.expiresAt - REFRESH_EARLY_MS
    ) {
      return Promise.resolve()
    }
    this.update(entry, { loading: true, error: "" })
    const requestId =
      this.requestOptions?.requestId ?? `asset-access-${crypto.randomUUID()}`
    const request = authorizeAssetDownload(
      this.projectId,
      assetId,
      disposition,
      { ...this.requestOptions, requestId },
      variantType
    )
      .then((authorization) => {
        const expiresAt = Date.parse(authorization.expires_at)
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          throw new Error("asset_download_authorization_expired")
        }
        entry.snapshot = {
          url: authorization.url,
          loading: false,
          error: "",
        }
        entry.expiresAt = expiresAt
        this.scheduleRefresh(assetId, disposition, entry, variantType)
        this.notify(entry)
      })
      .catch((reason: unknown) => {
        entry.snapshot = {
          ...entry.snapshot,
          loading: false,
          error:
            reason instanceof Error
              ? reason.message
              : "asset_preview_unavailable",
        }
        this.notify(entry)
      })
      .finally(() => {
        entry.request = null
      })
    entry.request = request
    return request
  }

  subscribeMetadata(assetId: string, listener: () => void) {
    const entry = this.metadataEntry(assetId)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  metadataSnapshot(assetId: string) {
    if (!assetId) return emptyMetadataSnapshot
    return this.metadataEntries.get(assetId)?.snapshot ?? emptyMetadataSnapshot
  }

  loadMetadata(assetId: string, force = false) {
    if (!assetId) return Promise.resolve()
    const entry = this.metadataEntry(assetId)
    if (entry.request) return entry.request
    if (!force && entry.snapshot.asset) return Promise.resolve()
    this.updateMetadata(entry, { loading: true, error: "" })
    const request = getAsset(this.projectId, assetId, this.requestOptions)
      .then((asset) => {
        entry.snapshot = { asset, loading: false, error: "", action: "" }
        this.scheduleMetadataRefresh(assetId, entry)
        this.notifyMetadata(entry)
      })
      .catch((reason: unknown) => {
        entry.snapshot = {
          ...entry.snapshot,
          loading: false,
          error:
            reason instanceof Error
              ? reason.message
              : "asset_metadata_unavailable",
        }
        this.notifyMetadata(entry)
      })
      .finally(() => {
        entry.request = null
      })
    entry.request = request
    return request
  }

  retry(assetId: string) {
    return this.runMetadataAction(assetId, "retry")
  }

  cancel(assetId: string) {
    return this.runMetadataAction(assetId, "cancel")
  }

  dispose() {
    for (const entry of this.entries.values()) {
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    }
    for (const entry of this.metadataEntries.values()) {
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    }
    this.entries.clear()
    this.metadataEntries.clear()
  }

  private key(assetId: string, disposition: string, variantType?: string) {
    return `${disposition}:${variantType ?? "original"}:${assetId}`
  }

  private entry(
    assetId: string,
    disposition: "inline" | "attachment",
    variantType?: string
  ) {
    const key = this.key(assetId, disposition, variantType)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        snapshot: emptySnapshot,
        expiresAt: 0,
        listeners: new Set(),
        request: null,
        refreshTimer: null,
      }
      this.entries.set(key, entry)
    }
    return entry
  }

  private metadataEntry(assetId: string) {
    let entry = this.metadataEntries.get(assetId)
    if (!entry) {
      entry = {
        snapshot: emptyMetadataSnapshot,
        listeners: new Set(),
        request: null,
        actionRequest: null,
        refreshTimer: null,
      }
      this.metadataEntries.set(assetId, entry)
    }
    return entry
  }

  private update(
    entry: AssetAccessEntry,
    values: Partial<ArticleAssetAccessSnapshot>
  ) {
    entry.snapshot = { ...entry.snapshot, ...values }
    this.notify(entry)
  }

  private notify(entry: AssetAccessEntry) {
    entry.listeners.forEach((listener) => listener())
  }

  private updateMetadata(
    entry: AssetMetadataEntry,
    values: Partial<ArticleAssetMetadataSnapshot>
  ) {
    entry.snapshot = { ...entry.snapshot, ...values }
    this.notifyMetadata(entry)
  }

  private notifyMetadata(entry: AssetMetadataEntry) {
    entry.listeners.forEach((listener) => listener())
  }

  private scheduleRefresh(
    assetId: string,
    disposition: "inline" | "attachment",
    entry: AssetAccessEntry,
    variantType?: string
  ) {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    const delay = Math.max(
      1_000,
      entry.expiresAt - Date.now() - REFRESH_EARLY_MS
    )
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null
      void this.load(assetId, disposition, true, variantType)
    }, delay)
  }

  private scheduleMetadataRefresh(assetId: string, entry: AssetMetadataEntry) {
    if (entry.refreshTimer) clearTimeout(entry.refreshTimer)
    if (
      !entry.snapshot.asset ||
      !["pending", "uploading", "uploaded", "processing"].includes(
        entry.snapshot.asset.status
      )
    ) {
      entry.refreshTimer = null
      return
    }
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = null
      void this.loadMetadata(assetId, true)
    }, PROCESSING_REFRESH_MS)
  }

  private runMetadataAction(assetId: string, action: "retry" | "cancel") {
    if (!assetId) return Promise.resolve()
    const entry = this.metadataEntry(assetId)
    if (entry.actionRequest) return entry.actionRequest
    this.updateMetadata(entry, { action, error: "" })
    const operation = action === "retry" ? retryAsset : cancelAsset
    const request = operation(this.projectId, assetId, this.requestOptions)
      .then((asset) => {
        entry.snapshot = { asset, loading: false, error: "", action: "" }
        this.scheduleMetadataRefresh(assetId, entry)
        this.notifyMetadata(entry)
      })
      .catch((reason: unknown) => {
        entry.snapshot = {
          ...entry.snapshot,
          action: "",
          error:
            reason instanceof Error ? reason.message : `asset_${action}_failed`,
        }
        this.notifyMetadata(entry)
      })
      .finally(() => {
        entry.actionRequest = null
      })
    entry.actionRequest = request
    return request
  }
}
