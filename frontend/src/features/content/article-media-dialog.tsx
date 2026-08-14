import * as React from "react"
import {
  Download,
  FileAudio,
  FileText,
  FileVideo,
  ImageIcon,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from "lucide-react"

import {
  authorizeAssetDownload,
  cancelAsset,
  deleteAsset,
  getAssetUsage,
  listAssets,
  retryAsset,
  updateAssetMetadata,
  type AssetStatus,
  type AssetType,
  type AssetUsage,
  type ContentAsset,
} from "@/api/assets"
import type { ArticleRequestOptions } from "@/api/articles"
import { ApiError } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import type { ArticleAssetAccessStore } from "@/features/content/article-asset-access"
import type { ArticleImageProperties } from "@/features/content/article-upload-queue"

function LibraryImage({
  store,
  assetId,
}: {
  store: ArticleAssetAccessStore
  assetId: string
}) {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(assetId, "inline", listener),
    [assetId, store]
  )
  const getSnapshot = React.useCallback(
    () => store.snapshot(assetId, "inline"),
    [assetId, store]
  )
  const access = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  React.useEffect(() => {
    void store.load(assetId, "inline")
  }, [assetId, store])
  return access.url ? (
    <img
      src={access.url}
      alt=""
      className="aspect-video w-full rounded-sm bg-muted object-cover"
      onError={() => void store.load(assetId, "inline", true)}
    />
  ) : (
    <span className="grid aspect-video place-items-center rounded-sm bg-muted text-xs text-muted-foreground">
      {access.error ? "预览不可用" : "正在加载"}
    </span>
  )
}

export type ArticleMediaDialogMode = "upload" | "url" | "library"

export function ArticleImagePropertiesDialog({
  asset,
  filename,
  initialAlt = "",
  initialCaption = "",
  open,
  assetAccess,
  onCancel,
  onSubmit,
}: {
  asset: ContentAsset
  filename: string
  initialAlt?: string
  initialCaption?: string
  open: boolean
  assetAccess: ArticleAssetAccessStore
  onCancel: () => void
  onSubmit: (value: ArticleImageProperties) => void
}) {
  const [alt, setAlt] = React.useState(initialAlt)
  const [decorative, setDecorative] = React.useState(false)
  const [caption, setCaption] = React.useState(initialCaption)
  const [link, setLink] = React.useState("")
  const [display, setDisplay] =
    React.useState<ArticleImageProperties["display"]>("regular")
  const valid = decorative || Boolean(alt.trim())

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid) return
    onSubmit({
      alt: decorative ? "" : alt.trim(),
      decorative,
      caption: caption.trim() || undefined,
      link: link.trim() || undefined,
      display,
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>确认图片属性</DialogTitle>
          <DialogDescription>
            图片处理已完成。填写每张图片自己的替代文本后，才会插入文章。
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <LibraryImage
              store={assetAccess}
              assetId={asset.canonical_asset_id ?? asset.asset_id}
            />
            <div className="min-w-0 self-center">
              <p className="truncate text-sm font-medium">{filename}</p>
              <p className="text-xs text-muted-foreground">
                {asset.width && asset.height
                  ? `${asset.width} × ${asset.height}`
                  : "尺寸未知"}
              </p>
            </div>
          </div>
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={decorative}
              onCheckedChange={(checked) => {
                const next = Boolean(checked)
                setDecorative(next)
                if (next) setAlt("")
              }}
            />
            这是装饰图片，不需要替代文本
          </Label>
          <Label className="grid gap-1.5 text-sm font-medium">
            替代文本
            <Input
              autoFocus
              value={alt}
              disabled={decorative}
              maxLength={2_000}
              aria-invalid={!decorative && !alt.trim()}
              onChange={(event) => setAlt(event.target.value)}
            />
            {!decorative && !alt.trim() && (
              <span className="text-xs font-normal text-destructive">
                请描述图片的实际内容，或明确选择装饰图片。
              </span>
            )}
          </Label>
          <Label className="grid gap-1.5 text-sm font-medium">
            说明文字
            <Textarea
              value={caption}
              maxLength={5_000}
              onChange={(event) => setCaption(event.target.value)}
            />
          </Label>
          <Label className="grid gap-1.5 text-sm font-medium">
            图片链接
            <Input
              value={link}
              placeholder="/内部路径 或 https://example.com/page"
              onChange={(event) => setLink(event.target.value)}
            />
          </Label>
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">显示宽度</legend>
            <div className="flex rounded-md border p-0.5" aria-label="显示宽度">
              {(["regular", "wide", "full"] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={display === value ? "secondary" : "ghost"}
                  aria-pressed={display === value}
                  onClick={() => setDisplay(value)}
                >
                  {{ regular: "正文", wide: "加宽", full: "全宽" }[value]}
                </Button>
              ))}
            </div>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              取消插入
            </Button>
            <Button type="submit" disabled={!valid}>
              插入图片
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const assetStatusLabels: Record<AssetStatus, string> = {
  pending: "等待上传",
  uploading: "上传中",
  uploaded: "等待处理",
  processing: "处理中",
  ready: "可用",
  pending_delete: "等待删除",
  failed: "失败",
  quarantined: "已隔离",
}

const assetSourceLabels: Record<string, string> = {
  upload: "本地上传",
  paste: "粘贴上传",
  import: "URL 导入",
}

function formatBytes(value: number | null) {
  if (value === null) return "未知"
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function formatDate(value?: string | null) {
  if (!value) return "未知"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "未知"
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function assetAccept(assetType: AssetType) {
  if (assetType === "image") return "image/jpeg,image/png,image/gif,image/webp"
  if (assetType === "audio") return "audio/mpeg,audio/mp4,audio/ogg,audio/wav"
  if (assetType === "video") return "video/mp4,video/webm"
  return "application/pdf"
}

function AssetTypePreview({
  asset,
  assetAccess,
}: {
  asset: ContentAsset
  assetAccess: ArticleAssetAccessStore
}) {
  if (asset.asset_type === "image" && asset.status === "ready") {
    return (
      <LibraryImage
        store={assetAccess}
        assetId={asset.canonical_asset_id ?? asset.asset_id}
      />
    )
  }
  const Icon =
    asset.asset_type === "image"
      ? ImageIcon
      : asset.asset_type === "audio"
        ? FileAudio
        : asset.asset_type === "video"
          ? FileVideo
          : FileText
  return (
    <span className="grid aspect-video place-items-center rounded-sm bg-muted text-muted-foreground">
      <Icon className="size-8" aria-hidden="true" />
    </span>
  )
}

function AssetUsageList({ usage }: { usage: AssetUsage | null }) {
  if (!usage) {
    return <p className="text-xs text-muted-foreground">正在读取引用...</p>
  }
  if (usage.items.length === 0) {
    return <p className="text-xs text-muted-foreground">当前没有文章引用。</p>
  }
  return (
    <ul className="divide-y rounded-md border" aria-label="引用文章">
      {usage.items.map((item) => (
        <li key={item.article_id} className="px-3 py-2 text-xs">
          <p className="truncate font-medium">
            {item.article_title || "未命名文章"}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            当前草稿 {item.current_reference_count} 处，历史版本{" "}
            {item.version_reference_count} 处
          </p>
        </li>
      ))}
    </ul>
  )
}

export function ArticleMediaDialog({
  projectId,
  mode,
  assetType,
  open,
  onOpenChange,
  onImportUrl,
  onChooseFiles,
  onChooseAssets,
  assetAccess,
  requestOptions,
  multiple = false,
  minimumSelection = 1,
  maximumSelection = 1,
}: {
  projectId: string
  mode: ArticleMediaDialogMode
  assetType: AssetType
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportUrl: (url: string) => void
  onChooseFiles: (files: File[]) => void
  onChooseAssets: (assets: ContentAsset[]) => void
  assetAccess: ArticleAssetAccessStore
  requestOptions?: Omit<ArticleRequestOptions, "signal">
  multiple?: boolean
  minimumSelection?: number
  maximumSelection?: number
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [tab, setTab] = React.useState<ArticleMediaDialogMode>(mode)
  const [url, setUrl] = React.useState("")
  const [query, setQuery] = React.useState("")
  const [debouncedQuery, setDebouncedQuery] = React.useState("")
  const [status, setStatus] = React.useState<AssetStatus | "all">("all")
  const [refreshKey, setRefreshKey] = React.useState(0)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [activeAssetId, setActiveAssetId] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const requestKey =
    open && tab === "library"
      ? JSON.stringify({
          projectId,
          assetType,
          query: debouncedQuery,
          status,
          refreshKey,
        })
      : null
  const [result, setResult] = React.useState<{
    requestKey: string
    assets: ContentAsset[]
    nextCursor: string | null
    error: string
    loadingMore: boolean
  } | null>(null)
  const [usageResult, setUsageResult] = React.useState<{
    assetId: string
    usage: AssetUsage | null
    error: string
  } | null>(null)
  const [metadata, setMetadata] = React.useState({
    title: "",
    defaultAltText: "",
    caption: "",
    description: "",
  })
  const [actionState, setActionState] = React.useState<{
    kind: "metadata" | "retry" | "cancel" | "delete" | "download"
    error: string
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  React.useEffect(() => {
    if (!open) return
    setTab(mode)
    setSelectedIds(new Set())
    setActiveAssetId(null)
    setConfirmDelete(false)
    setActionState(null)
  }, [mode, open])

  React.useEffect(() => {
    if (!requestKey) return
    let active = true
    void listAssets(
      projectId,
      {
        assetType,
        status: status === "all" ? undefined : status,
        query: debouncedQuery,
        limit: 30,
      },
      requestOptions
    )
      .then((result) => {
        if (active) {
          setResult({
            requestKey,
            assets: result.items,
            nextCursor: result.next_cursor,
            error: "",
            loadingMore: false,
          })
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setResult({
            requestKey,
            assets: [],
            nextCursor: null,
            error: reason instanceof Error ? reason.message : "资产库加载失败",
            loadingMore: false,
          })
        }
      })
    return () => {
      active = false
    }
  }, [assetType, debouncedQuery, projectId, requestKey, requestOptions, status])

  const loading = requestKey !== null && result?.requestKey !== requestKey
  const assets = result?.requestKey === requestKey ? result.assets : []
  const error = result?.requestKey === requestKey ? result.error : ""
  const nextCursor =
    result?.requestKey === requestKey ? result.nextCursor : null
  const activeAsset =
    assets.find((asset) => asset.asset_id === activeAssetId) ?? null
  const selectedAssets = assets.filter((asset) =>
    selectedIds.has(asset.asset_id)
  )
  const canChoose =
    selectedAssets.length >= minimumSelection &&
    selectedAssets.length <= maximumSelection &&
    selectedAssets.every((asset) => asset.status === "ready")

  React.useEffect(() => {
    if (!activeAsset) return
    setMetadata({
      title: activeAsset.title ?? "",
      defaultAltText: activeAsset.default_alt_text ?? "",
      caption: activeAsset.caption ?? "",
      description: activeAsset.description ?? "",
    })
  }, [activeAsset])

  React.useEffect(() => {
    setConfirmDelete(false)
    setActionState(null)
  }, [activeAssetId])

  React.useEffect(() => {
    if (!activeAssetId) {
      setUsageResult(null)
      return
    }
    let active = true
    setUsageResult({ assetId: activeAssetId, usage: null, error: "" })
    void getAssetUsage(projectId, activeAssetId, requestOptions)
      .then((usage) => {
        if (active) setUsageResult({ assetId: activeAssetId, usage, error: "" })
      })
      .catch((reason: unknown) => {
        if (active) {
          setUsageResult({
            assetId: activeAssetId,
            usage: null,
            error:
              reason instanceof Error ? reason.message : "引用信息加载失败",
          })
        }
      })
    return () => {
      active = false
    }
  }, [activeAssetId, projectId, requestOptions])

  const replaceAsset = React.useCallback((updated: ContentAsset) => {
    setResult((current) =>
      current
        ? {
            ...current,
            assets: current.assets.map((asset) =>
              asset.asset_id === updated.asset_id ? updated : asset
            ),
          }
        : current
    )
  }, [])

  const runAssetAction = async (
    kind: "retry" | "cancel",
    action: () => Promise<ContentAsset>
  ) => {
    setActionState({ kind, error: "" })
    try {
      replaceAsset(await action())
      setActionState(null)
    } catch (reason) {
      setActionState({
        kind,
        error: reason instanceof Error ? reason.message : "资产操作失败",
      })
    }
  }

  const refreshUsage = async (asset: ContentAsset) => {
    try {
      const usage = await getAssetUsage(
        projectId,
        asset.asset_id,
        requestOptions
      )
      setUsageResult({ assetId: asset.asset_id, usage, error: "" })
      replaceAsset({
        ...asset,
        active_reference_count: usage.active_reference_count,
      })
    } catch (reason) {
      setUsageResult({
        assetId: asset.asset_id,
        usage: null,
        error: reason instanceof Error ? reason.message : "引用信息加载失败",
      })
    }
  }

  const chooseFiles = (files: File[]) => {
    const accepted = files.slice(0, maximumSelection)
    if (accepted.length < minimumSelection) return
    onChooseFiles(accepted)
    onOpenChange(false)
  }

  const loadMore = async () => {
    if (!requestKey || !nextCursor || result?.loadingMore) return
    setResult((current) =>
      current ? { ...current, loadingMore: true } : current
    )
    try {
      const next = await listAssets(
        projectId,
        {
          assetType,
          status: status === "all" ? undefined : status,
          query: debouncedQuery,
          cursor: nextCursor,
          limit: 30,
        },
        requestOptions
      )
      setResult((current) =>
        current?.requestKey === requestKey
          ? {
              ...current,
              assets: [...current.assets, ...next.items],
              nextCursor: next.next_cursor,
              loadingMore: false,
            }
          : current
      )
    } catch (reason) {
      setResult((current) =>
        current?.requestKey === requestKey
          ? {
              ...current,
              loadingMore: false,
              error:
                reason instanceof Error ? reason.message : "更多资产加载失败",
            }
          : current
      )
    }
  }

  const submitUrl = (event: React.FormEvent) => {
    event.preventDefault()
    const normalized = url.trim()
    if (!normalized) return
    onImportUrl(normalized)
    setUrl("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-6xl flex-col overflow-hidden rounded-md p-0 sm:max-w-6xl">
        <DialogHeader>
          <div className="px-5 pt-5">
            <DialogTitle>项目媒体</DialogTitle>
            <DialogDescription>
              上传新文件、复用项目资产，或由服务器安全导入远端媒体。
            </DialogDescription>
          </div>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as ArticleMediaDialogMode)}
          className="min-h-0 flex-1"
        >
          <TabsList variant="line" className="mx-5">
            <TabsTrigger value="upload">
              <Upload />
              上传
            </TabsTrigger>
            <TabsTrigger value="library">
              <ImageIcon />
              资产库
            </TabsTrigger>
            <TabsTrigger value="url" disabled={minimumSelection > 1}>
              <Link2 />
              URL
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="upload"
            className="min-h-0 overflow-y-auto px-5 pb-5"
          >
            <div
              className={`grid min-h-72 place-items-center rounded-md border border-dashed p-8 text-center ${dragging ? "border-primary bg-primary/5" : "bg-muted/20"}`}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                chooseFiles(Array.from(event.dataTransfer.files))
              }}
            >
              <div className="grid justify-items-center gap-3">
                <Upload className="size-10 text-muted-foreground" />
                <div>
                  <p className="font-medium">拖放文件到这里</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {multiple
                      ? `可选择 ${minimumSelection}-${maximumSelection} 个文件`
                      : "每次选择一个文件"}
                  </p>
                </div>
                <Input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  aria-label="本地媒体文件"
                  accept={assetAccept(assetType)}
                  multiple={multiple}
                  onChange={(event) => {
                    chooseFiles(Array.from(event.target.files ?? []))
                    event.target.value = ""
                  }}
                />
                <Button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload />
                  选择文件
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent
            value="url"
            className="min-h-0 overflow-y-auto px-5 pb-5"
          >
            <form
              className="mx-auto grid max-w-2xl gap-4 py-8"
              onSubmit={submitUrl}
            >
              <Label className="grid gap-1.5 text-sm font-medium">
                媒体 URL
                <Input
                  type="url"
                  placeholder="https://example.com/media.jpg"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Label>
              <p className="text-sm text-muted-foreground">
                远端文件会由服务器下载，经过类型、大小和安全校验后保存为项目资产。
              </p>
              <div>
                <Button type="submit" disabled={!url.trim()}>
                  <Link2 />
                  导入
                </Button>
              </div>
            </form>
          </TabsContent>

          <TabsContent value="library" className="min-h-0 overflow-hidden">
            <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_minmax(0,1fr)]">
              <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3 lg:col-start-1">
                <Label className="relative min-w-48 flex-1">
                  <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
                  <Input
                    aria-label="搜索资产"
                    className="pl-9"
                    placeholder="按文件名搜索"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setSelectedIds(new Set())
                      setActiveAssetId(null)
                    }}
                  />
                </Label>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    setStatus(value as AssetStatus | "all")
                    setSelectedIds(new Set())
                    setActiveAssetId(null)
                  }}
                >
                  <SelectTrigger
                    className="w-36 rounded-md bg-background"
                    aria-label="资产状态"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-md">
                    <SelectItem className="rounded-sm" value="all">
                      全部状态
                    </SelectItem>
                    {(Object.keys(assetStatusLabels) as AssetStatus[]).map(
                      (value) => (
                        <SelectItem
                          className="rounded-sm"
                          key={value}
                          value={value}
                        >
                          {assetStatusLabels[value]}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="刷新资产库"
                  aria-label="刷新资产库"
                  onClick={() => setRefreshKey((value) => value + 1)}
                >
                  <RefreshCw />
                </Button>
              </div>

              <div className="min-h-56 overflow-y-auto px-5 py-4 lg:col-start-1">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {assets.map((asset) => {
                    const selected = selectedIds.has(asset.asset_id)
                    return (
                      <Button
                        key={asset.asset_id}
                        type="button"
                        variant="outline"
                        aria-pressed={selected}
                        className={`relative grid h-auto min-w-0 justify-stretch gap-2 rounded-md p-2 text-left whitespace-normal focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${selected ? "border-primary ring-1 ring-primary" : "hover:border-foreground/30"}`}
                        onClick={() => {
                          setActiveAssetId(asset.asset_id)
                          setSelectedIds((current) => {
                            if (!multiple) return new Set([asset.asset_id])
                            const next = new Set(current)
                            if (next.has(asset.asset_id))
                              next.delete(asset.asset_id)
                            else if (next.size < maximumSelection)
                              next.add(asset.asset_id)
                            return next
                          })
                        }}
                      >
                        <AssetTypePreview
                          asset={asset}
                          assetAccess={assetAccess}
                        />
                        <span className="truncate text-sm font-medium">
                          {asset.title || asset.original_filename}
                        </span>
                        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{assetStatusLabels[asset.status]}</span>
                          {asset.active_reference_count > 0 && (
                            <span>{asset.active_reference_count} 次引用</span>
                          )}
                        </span>
                      </Button>
                    )
                  })}
                </div>
                {loading && (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    正在加载资产...
                  </p>
                )}
                {!loading && assets.length === 0 && (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    没有匹配的资产
                  </p>
                )}
                {nextCursor && (
                  <div className="mt-4 text-center">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={result?.loadingMore}
                      onClick={() => void loadMore()}
                    >
                      {result?.loadingMore && (
                        <Loader2 className="animate-spin" />
                      )}
                      加载更多
                    </Button>
                  </div>
                )}
                {error && (
                  <p className="mt-3 text-sm text-destructive">{error}</p>
                )}
              </div>

              <aside
                className="min-h-0 overflow-y-auto border-t px-5 py-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-t-0 lg:border-l"
                aria-label="资产详情"
              >
                {!activeAsset ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    选择资产后查看详情和引用。
                  </p>
                ) : (
                  <div className="grid gap-5">
                    <div className="grid gap-2">
                      <AssetTypePreview
                        asset={activeAsset}
                        assetAccess={assetAccess}
                      />
                      <div className="min-w-0">
                        <p
                          className="truncate font-medium"
                          title={activeAsset.original_filename}
                        >
                          {activeAsset.original_filename}
                        </p>
                        <Badge variant="secondary" className="mt-1 rounded-sm">
                          {assetStatusLabels[activeAsset.status]}
                        </Badge>
                      </div>
                    </div>

                    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                      <dt className="text-muted-foreground">类型</dt>
                      <dd className="truncate">
                        {activeAsset.detected_mime_type ||
                          activeAsset.mime_type ||
                          "未知"}
                      </dd>
                      <dt className="text-muted-foreground">尺寸</dt>
                      <dd>
                        {activeAsset.width && activeAsset.height
                          ? `${activeAsset.width} × ${activeAsset.height}`
                          : "不适用"}
                      </dd>
                      <dt className="text-muted-foreground">文件大小</dt>
                      <dd>{formatBytes(activeAsset.byte_size)}</dd>
                      <dt className="text-muted-foreground">来源</dt>
                      <dd>
                        {assetSourceLabels[activeAsset.source_type] ||
                          activeAsset.source_type}
                      </dd>
                      <dt className="text-muted-foreground">创建时间</dt>
                      <dd>{formatDate(activeAsset.created_at)}</dd>
                      <dt className="text-muted-foreground">更新时间</dt>
                      <dd>{formatDate(activeAsset.updated_at)}</dd>
                    </dl>

                    {activeAsset.actions.includes("edit_metadata") && (
                      <form
                        className="grid gap-3 border-t pt-4"
                        onSubmit={async (event) => {
                          event.preventDefault()
                          setActionState({ kind: "metadata", error: "" })
                          try {
                            const updated = await updateAssetMetadata(
                              projectId,
                              activeAsset.asset_id,
                              {
                                title: metadata.title || null,
                                default_alt_text:
                                  metadata.defaultAltText || null,
                                caption: metadata.caption || null,
                                description: metadata.description || null,
                              },
                              requestOptions
                            )
                            replaceAsset(updated)
                            setActionState(null)
                          } catch (reason) {
                            setActionState({
                              kind: "metadata",
                              error:
                                reason instanceof Error
                                  ? reason.message
                                  : "元数据保存失败",
                            })
                          }
                        }}
                      >
                        <h3 className="text-sm font-semibold">
                          资产默认元数据
                        </h3>
                        <Label className="grid gap-1 text-xs font-medium">
                          标题
                          <Input
                            value={metadata.title}
                            maxLength={255}
                            onChange={(event) =>
                              setMetadata((current) => ({
                                ...current,
                                title: event.target.value,
                              }))
                            }
                          />
                        </Label>
                        {activeAsset.asset_type === "image" && (
                          <Label className="grid gap-1 text-xs font-medium">
                            默认替代文本
                            <Textarea
                              value={metadata.defaultAltText}
                              maxLength={2000}
                              onChange={(event) =>
                                setMetadata((current) => ({
                                  ...current,
                                  defaultAltText: event.target.value,
                                }))
                              }
                            />
                          </Label>
                        )}
                        <Label className="grid gap-1 text-xs font-medium">
                          默认说明文字
                          <Textarea
                            value={metadata.caption}
                            maxLength={5000}
                            onChange={(event) =>
                              setMetadata((current) => ({
                                ...current,
                                caption: event.target.value,
                              }))
                            }
                          />
                        </Label>
                        <Label className="grid gap-1 text-xs font-medium">
                          描述
                          <Textarea
                            value={metadata.description}
                            maxLength={10000}
                            onChange={(event) =>
                              setMetadata((current) => ({
                                ...current,
                                description: event.target.value,
                              }))
                            }
                          />
                        </Label>
                        <Button
                          type="submit"
                          size="sm"
                          disabled={actionState?.kind === "metadata"}
                        >
                          {actionState?.kind === "metadata" &&
                            !actionState.error && (
                              <Loader2 className="animate-spin" />
                            )}
                          保存元数据
                        </Button>
                      </form>
                    )}

                    <section className="grid gap-2 border-t pt-4">
                      <h3 className="text-sm font-semibold">文章引用</h3>
                      {usageResult?.assetId === activeAsset.asset_id &&
                      usageResult.error ? (
                        <p className="text-xs text-destructive">
                          {usageResult.error}
                        </p>
                      ) : (
                        <AssetUsageList
                          usage={
                            usageResult?.assetId === activeAsset.asset_id
                              ? usageResult.usage
                              : null
                          }
                        />
                      )}
                    </section>

                    <div className="grid grid-cols-2 gap-2 border-t pt-4">
                      {activeAsset.actions.includes("download") && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            setActionState({ kind: "download", error: "" })
                            try {
                              const authorization =
                                await authorizeAssetDownload(
                                  projectId,
                                  activeAsset.asset_id,
                                  "attachment",
                                  requestOptions
                                )
                              const anchor = document.createElement("a")
                              anchor.href = authorization.url
                              anchor.download = activeAsset.original_filename
                              anchor.click()
                              setActionState(null)
                            } catch (reason) {
                              setActionState({
                                kind: "download",
                                error:
                                  reason instanceof Error
                                    ? reason.message
                                    : "下载失败",
                              })
                            }
                          }}
                        >
                          <Download />
                          下载
                        </Button>
                      )}
                      {activeAsset.actions.includes("retry") && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void runAssetAction("retry", () =>
                              retryAsset(
                                projectId,
                                activeAsset.asset_id,
                                requestOptions
                              )
                            )
                          }
                        >
                          <RotateCcw />
                          重试
                        </Button>
                      )}
                      {activeAsset.actions.includes("cancel") && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void runAssetAction("cancel", () =>
                              cancelAsset(
                                projectId,
                                activeAsset.asset_id,
                                requestOptions
                              )
                            )
                          }
                        >
                          取消处理
                        </Button>
                      )}
                      {activeAsset.actions.includes("delete") &&
                        (confirmDelete ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={
                              (usageResult?.usage?.active_reference_count ??
                                activeAsset.active_reference_count) > 0
                            }
                            onClick={async () => {
                              setActionState({ kind: "delete", error: "" })
                              try {
                                await deleteAsset(
                                  projectId,
                                  activeAsset.asset_id,
                                  requestOptions
                                )
                                setSelectedIds((current) => {
                                  const next = new Set(current)
                                  next.delete(activeAsset.asset_id)
                                  return next
                                })
                                setActiveAssetId(null)
                                setRefreshKey((value) => value + 1)
                              } catch (reason) {
                                if (
                                  reason instanceof ApiError &&
                                  reason.status === 409
                                )
                                  await refreshUsage(activeAsset)
                                setActionState({
                                  kind: "delete",
                                  error:
                                    reason instanceof Error
                                      ? reason.message
                                      : "删除失败",
                                })
                              }
                            }}
                          >
                            <Trash2 />
                            确认删除
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              (usageResult?.usage?.active_reference_count ??
                                activeAsset.active_reference_count) > 0
                            }
                            onClick={() => setConfirmDelete(true)}
                          >
                            <Trash2 />
                            删除
                          </Button>
                        ))}
                    </div>
                    {actionState?.error && (
                      <p className="text-xs text-destructive" role="alert">
                        {actionState.error}
                      </p>
                    )}
                    {(usageResult?.usage?.active_reference_count ??
                      activeAsset.active_reference_count) > 0 &&
                      activeAsset.actions.includes("delete") && (
                        <p className="text-xs text-muted-foreground">
                          资产仍被文章引用，解除全部引用后才能删除。
                        </p>
                      )}
                  </div>
                )}
              </aside>

              <DialogFooter className="border-t px-5 py-3 lg:col-start-1">
                <span className="mr-auto text-xs text-muted-foreground">
                  已选择 {selectedAssets.length} 个
                  {multiple &&
                    `，需要 ${minimumSelection}-${maximumSelection} 个`}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  disabled={!canChoose}
                  onClick={() => {
                    onChooseAssets(selectedAssets)
                    onOpenChange(false)
                  }}
                >
                  {multiple ? "插入所选资产" : "使用此资产"}
                </Button>
              </DialogFooter>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
