import type { NodeViewProps } from "@tiptap/core"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import * as React from "react"
import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  Download,
  FileText,
  ImageIcon,
  Link2,
  LoaderCircle,
  Music2,
  RefreshCw,
  Replace,
  Trash2,
  Video,
  X,
} from "lucide-react"

import type { AssetStatus, ContentAsset } from "@/api/assets"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { ArticleAssetAccessStore } from "@/features/content/article-asset-access"
import { ArticleLinkDialog } from "@/features/content/article-link-dialog"
import { convertArticleGalleryToImage } from "@/features/content/article-media-editor"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export type ArticleMediaReplaceTarget = {
  nodeId: string
  nodeType: "image" | "gallery" | "file" | "audio" | "video"
  itemId?: string
  assetType: "image" | "file" | "audio" | "video"
}

export type ArticleMediaRuntimeStorage = {
  projectId: string
  readOnly: boolean
  assetAccess: ArticleAssetAccessStore
  subscribe?: (listener: () => void) => () => void
  getReadOnly?: () => boolean
  replace: (target: ArticleMediaReplaceTarget) => void
  addGalleryItems: (nodeId: string) => void
  replacePoster: (nodeId: string) => void
}

function runtime(editor: NodeViewProps["editor"]) {
  return (
    editor.storage as unknown as {
      articleMediaRuntime: ArticleMediaRuntimeStorage
    }
  ).articleMediaRuntime
}

function useMediaRuntime(editor: NodeViewProps["editor"]) {
  const media = runtime(editor)
  const subscribe = React.useCallback(
    (listener: () => void) => media.subscribe?.(listener) ?? (() => undefined),
    [media]
  )
  const getSnapshot = React.useCallback(
    () => media.getReadOnly?.() ?? media.readOnly,
    [media]
  )
  const readOnly = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  )
  return React.useMemo(() => ({ ...media, readOnly }), [media, readOnly])
}

function useAssetAccess(
  store: ArticleAssetAccessStore,
  assetId: string,
  disposition: "inline" | "attachment" = "inline",
  enabled = true,
  variantType?: string
) {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      store.subscribe(assetId, disposition, listener, variantType),
    [assetId, disposition, store, variantType]
  )
  const getSnapshot = React.useCallback(
    () => store.snapshot(assetId, disposition, variantType),
    [assetId, disposition, store, variantType]
  )
  const snapshot = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  )
  React.useEffect(() => {
    if (!enabled) return
    void store.load(assetId, disposition, false, variantType)
  }, [assetId, disposition, enabled, store, variantType])
  return snapshot
}

function useAssetMetadata(store: ArticleAssetAccessStore, assetId: string) {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribeMetadata(assetId, listener),
    [assetId, store]
  )
  const getSnapshot = React.useCallback(
    () => store.metadataSnapshot(assetId),
    [assetId, store]
  )
  const snapshot = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  )
  React.useEffect(() => {
    void store.loadMetadata(assetId)
  }, [assetId, store])
  return snapshot
}

function formatBytes(value: number | null | undefined) {
  if (typeof value !== "number" || value < 0) return "大小待检测"
  if (value === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const unit = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1
  )
  const amount = value / 1024 ** unit
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}

function formatDuration(value: number | null | undefined) {
  if (typeof value !== "number" || value < 0) return "时长待检测"
  const totalSeconds = Math.round(value / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`
}

const assetStatusLabels: Record<AssetStatus, string> = {
  pending: "等待上传",
  uploading: "正在上传",
  uploaded: "等待处理",
  processing: "正在优化",
  ready: "可用",
  pending_delete: "等待删除",
  failed: "处理失败",
  quarantined: "已隔离",
}

function AssetState({
  asset,
  loading,
  error,
  action,
  readOnly,
  onRetry,
  onCancel,
}: {
  asset: ContentAsset | null
  loading: boolean
  error: string
  action: "" | "retry" | "cancel"
  readOnly: boolean
  onRetry: () => void
  onCancel: () => void
}) {
  const status = asset?.status
  const processing =
    loading ||
    status === "pending" ||
    status === "uploading" ||
    status === "uploaded" ||
    status === "processing"
  const failed = status === "failed" || status === "quarantined" || error
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <Badge
        variant={
          failed ? "destructive" : status === "ready" ? "outline" : "secondary"
        }
        role={failed ? "alert" : "status"}
      >
        {processing && <LoaderCircle className="animate-spin" />}
        {failed && <AlertTriangle />}
        {status
          ? assetStatusLabels[status]
          : loading
            ? "读取资产信息"
            : "资产信息不可用"}
      </Badge>
      {error && <span className="text-destructive">{error}</span>}
      {asset?.failure_detail && (
        <span className="text-destructive">{asset.failure_detail}</span>
      )}
      {!readOnly && asset?.actions.includes("retry") && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={Boolean(action)}
          onClick={onRetry}
        >
          <RefreshCw className={action === "retry" ? "animate-spin" : ""} />
          重试处理
        </Button>
      )}
      {!readOnly && asset?.actions.includes("cancel") && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={Boolean(action)}
          onClick={onCancel}
        >
          <X /> 取消处理
        </Button>
      )}
    </div>
  )
}

function AssetImage({
  store,
  assetId,
  alt,
  className,
  width,
  height,
}: {
  store: ArticleAssetAccessStore
  assetId: string
  alt: string
  className: string
  width?: number
  height?: number
}) {
  const access = useAssetAccess(store, assetId)
  if (!access.url) {
    return (
      <div
        className={cn(
          "grid place-items-center text-muted-foreground",
          className
        )}
        role={access.error ? "alert" : "status"}
      >
        {access.error ? "图片暂时无法加载" : "正在加载图片"}
      </div>
    )
  }
  return (
    <img
      src={access.url}
      alt={alt}
      width={width}
      height={height}
      className={className}
      onError={() => void store.load(assetId, "inline", true)}
    />
  )
}

function MediaShell({
  selected,
  children,
  className,
}: {
  selected: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "group/media relative my-5 overflow-hidden rounded-md border bg-background",
        selected && "border-primary ring-2 ring-primary/15",
        className
      )}
    >
      {children}
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </Label>
  )
}

function MediaActions({
  onReplace,
  onDelete,
  disabled,
  children,
}: {
  onReplace: () => void
  onDelete: () => void
  disabled: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1">
      {children}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title="替换"
        aria-label="替换"
        disabled={disabled}
        onClick={onReplace}
      >
        <Replace />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title="删除"
        aria-label="删除"
        disabled={disabled}
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  )
}

function DisplayControl({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (value: "regular" | "wide" | "full") => void
}) {
  return (
    <div className="flex rounded-md border p-0.5" aria-label="媒体宽度">
      {(["regular", "wide", "full"] as const).map((item) => (
        <Button
          key={item}
          type="button"
          size="xs"
          variant={value === item ? "secondary" : "ghost"}
          disabled={disabled}
          aria-pressed={value === item}
          onClick={() => onChange(item)}
        >
          {{ regular: "正文", wide: "加宽", full: "全宽" }[item]}
        </Button>
      ))}
    </div>
  )
}

export function ArticleImageNodeView({
  node,
  editor,
  selected,
  updateAttributes,
  deleteNode,
}: ReactNodeViewProps) {
  const media = useMediaRuntime(editor)
  const disabled = media.readOnly
  const nodeId = String(node.attrs.node_id || "")
  const assetId = String(node.attrs.asset_id || "")
  const decorative = Boolean(node.attrs.decorative)
  const [linkOpen, setLinkOpen] = React.useState(false)
  const download = useAssetAccess(
    media.assetAccess,
    assetId,
    "attachment",
    selected
  )
  return (
    <NodeViewWrapper as="figure" data-node-id={nodeId}>
      <MediaShell selected={selected}>
        <div className="relative bg-muted/30">
          {assetId ? (
            <AssetImage
              store={media.assetAccess}
              assetId={assetId}
              alt={decorative ? "" : String(node.attrs.alt || "")}
              width={node.attrs.width || undefined}
              height={node.attrs.height || undefined}
              className="mx-auto max-h-[70dvh] w-auto max-w-full object-contain"
            />
          ) : (
            <div className="grid min-h-48 place-items-center text-muted-foreground">
              <ImageIcon className="size-8" />
            </div>
          )}
        </div>
        {selected && !disabled && (
          <div className="grid gap-3 border-t p-3" contentEditable={false}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <DisplayControl
                value={String(node.attrs.display || "regular")}
                disabled={disabled}
                onChange={(display) => updateAttributes({ display })}
              />
              <MediaActions
                disabled={disabled}
                onReplace={() =>
                  media.replace({
                    nodeId,
                    nodeType: "image",
                    assetType: "image",
                  })
                }
                onDelete={deleteNode}
              >
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  title="编辑图片链接"
                  aria-label="编辑图片链接"
                  disabled={disabled}
                  onClick={() => setLinkOpen(true)}
                >
                  <Link2 />
                </Button>
                {download.url ? (
                  <a
                    className={buttonVariants({
                      size: "icon-sm",
                      variant: "ghost",
                    })}
                    href={download.url}
                    target="_blank"
                    rel="noreferrer"
                    title="下载原图"
                    aria-label="下载原图"
                  >
                    <Download />
                  </a>
                ) : (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    title="下载原图"
                    aria-label="下载原图"
                    disabled
                  >
                    <Download />
                  </Button>
                )}
              </MediaActions>
            </div>
            <Label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={decorative}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  updateAttributes({
                    decorative: Boolean(checked),
                    ...(checked ? { alt: "" } : {}),
                  })
                }
              />
              装饰图片，不需要替代文本
            </Label>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="替代文本">
                <Input
                  value={String(node.attrs.alt || "")}
                  disabled={disabled || decorative}
                  maxLength={2_000}
                  onChange={(event) =>
                    updateAttributes({ alt: event.target.value })
                  }
                />
              </Field>
              <div className="grid gap-1 text-xs font-medium text-muted-foreground">
                图片链接
                <Button
                  type="button"
                  variant="outline"
                  className="min-w-0 justify-start font-normal"
                  disabled={disabled}
                  onClick={() => setLinkOpen(true)}
                >
                  <Link2 />
                  <span className="truncate">
                    {String(node.attrs.link || "") || "添加链接"}
                  </span>
                </Button>
              </div>
            </div>
            <Field label="说明文字">
              <Textarea
                value={String(node.attrs.caption || "")}
                disabled={disabled}
                maxLength={5_000}
                onChange={(event) =>
                  updateAttributes({ caption: event.target.value || null })
                }
              />
            </Field>
          </div>
        )}
      </MediaShell>
      <ArticleLinkDialog
        open={linkOpen}
        simple
        value={{ href: String(node.attrs.link || "") }}
        onOpenChange={setLinkOpen}
        onSubmit={(value) => updateAttributes({ link: value.href })}
        onRemove={() => updateAttributes({ link: null })}
      />
    </NodeViewWrapper>
  )
}

type GalleryItem = {
  item_id: string
  asset_id: string
  alt: string
  decorative?: boolean
  caption?: string
  link?: string
  width?: number
  height?: number
}

export function ArticleGalleryNodeView({
  node,
  editor,
  selected,
  updateAttributes,
  deleteNode,
}: ReactNodeViewProps) {
  const media = useMediaRuntime(editor)
  const disabled = media.readOnly
  const nodeId = String(node.attrs.node_id || "")
  const items = Array.isArray(node.attrs.items)
    ? (node.attrs.items as GalleryItem[])
    : []
  const [linkItemId, setLinkItemId] = React.useState<string | null>(null)
  const [removeItemId, setRemoveItemId] = React.useState<string | null>(null)
  const updateItems = (next: GalleryItem[]) => updateAttributes({ items: next })
  const updateItem = (itemId: string, values: Partial<GalleryItem>) =>
    updateItems(
      items.map((item) =>
        item.item_id === itemId ? { ...item, ...values } : item
      )
    )
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    updateItems(next)
  }
  const removeItem = (itemId: string) => {
    if (items.length > 2) {
      updateItems(items.filter((item) => item.item_id !== itemId))
      return
    }
    setRemoveItemId(itemId)
  }
  const convertToImage = () => {
    if (!removeItemId) return
    if (convertArticleGalleryToImage(editor, nodeId, removeItemId)) {
      setRemoveItemId(null)
    }
  }
  return (
    <NodeViewWrapper as="figure" data-node-id={nodeId}>
      <MediaShell selected={selected}>
        <div className="grid grid-cols-2 gap-1 bg-muted/30 p-1 md:grid-cols-3">
          {items.map((item, index) => (
            <div
              key={item.item_id}
              className="relative min-h-32 overflow-hidden bg-muted"
            >
              <AssetImage
                store={media.assetAccess}
                assetId={item.asset_id}
                alt={item.decorative ? "" : item.alt || ""}
                className="size-full object-cover"
              />
              {selected && !disabled && (
                <div
                  className="absolute top-1 right-1 flex gap-1 rounded-md bg-background/90 p-1 shadow"
                  contentEditable={false}
                >
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="前移"
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="后移"
                    disabled={disabled || index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="替换图片"
                    disabled={disabled}
                    onClick={() =>
                      media.replace({
                        nodeId,
                        nodeType: "gallery",
                        itemId: item.item_id,
                        assetType: "image",
                      })
                    }
                  >
                    <Replace />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="移除图片"
                    disabled={disabled}
                    onClick={() => removeItem(item.item_id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
        {selected && !disabled && (
          <div className="grid gap-3 border-t p-3" contentEditable={false}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <DisplayControl
                value={String(node.attrs.display || "regular")}
                disabled={disabled}
                onChange={(display) => updateAttributes({ display })}
              />
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || items.length >= 20}
                  onClick={() => media.addGalleryItems(nodeId)}
                >
                  添加图片
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="删除图库"
                  disabled={disabled}
                  onClick={deleteNode}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            {items.map((item, index) => (
              <div
                key={item.item_id}
                className="grid gap-2 border-t pt-3 md:grid-cols-2"
              >
                <Label className="flex items-center gap-2 text-xs md:col-span-2">
                  <Checkbox
                    checked={Boolean(item.decorative)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updateItem(item.item_id, {
                        decorative: Boolean(checked),
                        ...(checked ? { alt: "" } : {}),
                      })
                    }
                  />
                  装饰图片，不需要替代文本
                </Label>
                <Field label={`图片 ${index + 1} 替代文本`}>
                  <Input
                    value={item.alt || ""}
                    disabled={disabled || Boolean(item.decorative)}
                    maxLength={2_000}
                    onChange={(event) =>
                      updateItem(item.item_id, { alt: event.target.value })
                    }
                  />
                </Field>
                <Field label="说明文字">
                  <Input
                    value={item.caption || ""}
                    disabled={disabled}
                    maxLength={5_000}
                    onChange={(event) =>
                      updateItem(item.item_id, {
                        caption: event.target.value || undefined,
                      })
                    }
                  />
                </Field>
                <div className="md:col-span-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => setLinkItemId(item.item_id)}
                  >
                    <Link2 />
                    {item.link ? "编辑链接" : "添加链接"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </MediaShell>
      {linkItemId && (
        <ArticleLinkDialog
          open
          simple
          value={{
            href: items.find((item) => item.item_id === linkItemId)?.link || "",
          }}
          onOpenChange={(open) => {
            if (!open) setLinkItemId(null)
          }}
          onSubmit={(value) => {
            updateItem(linkItemId, { link: value.href })
            setLinkItemId(null)
          }}
          onRemove={() => {
            updateItem(linkItemId, { link: undefined })
            setLinkItemId(null)
          }}
        />
      )}
      <Dialog
        open={Boolean(removeItemId)}
        onOpenChange={(open) => {
          if (!open) setRemoveItemId(null)
        }}
      >
        <DialogContent className="rounded-md sm:max-w-md">
          <DialogHeader>
            <DialogTitle>图库将只剩一张图片</DialogTitle>
            <DialogDescription>
              图库至少需要两张图片。可以把剩余图片转为单图，或删除整个图库。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveItemId(null)}
            >
              取消
            </Button>
            <Button type="button" variant="outline" onClick={deleteNode}>
              删除图库
            </Button>
            <Button type="button" onClick={convertToImage}>
              转为单图
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </NodeViewWrapper>
  )
}

function GenericMediaNodeView({
  kind,
  icon,
  node,
  editor,
  selected,
  updateAttributes,
  deleteNode,
}: ReactNodeViewProps & {
  kind: "file" | "audio" | "video"
  icon: React.ReactNode
}) {
  const media = useMediaRuntime(editor)
  const disabled = media.readOnly
  const nodeId = String(node.attrs.node_id || "")
  const assetId = String(node.attrs.asset_id || "")
  const metadata = useAssetMetadata(media.assetAccess, assetId)
  const asset = metadata.asset
  const ready = asset?.status === "ready"
  const access = useAssetAccess(
    media.assetAccess,
    assetId,
    kind === "file" ? "attachment" : "inline",
    ready
  )
  const customPosterId =
    kind === "video" ? String(node.attrs.poster_asset_id || "") : ""
  const customPosterAccess = useAssetAccess(
    media.assetAccess,
    customPosterId,
    "inline",
    Boolean(customPosterId)
  )
  const hasAutomaticPoster = Boolean(
    kind === "video" &&
    asset?.variants.some(
      (variant) =>
        variant.variant_type === "poster" && variant.status === "ready"
    )
  )
  const automaticPosterAccess = useAssetAccess(
    media.assetAccess,
    kind === "video" ? assetId : "",
    "inline",
    kind === "video" && ready && hasAutomaticPoster && !customPosterId,
    "poster"
  )
  const src = access.url
  const poster = customPosterId
    ? customPosterAccess.url
    : automaticPosterAccess.url
  const title = String(
    kind === "file"
      ? node.attrs.display_name || asset?.original_filename || assetId
      : node.attrs.title || asset?.original_filename || assetId
  )
  const description = String(
    kind === "file" ? node.attrs.description || "" : node.attrs.caption || ""
  )
  const mime = asset?.detected_mime_type || asset?.mime_type
  const facts = [
    asset?.original_filename,
    mime,
    formatBytes(asset?.byte_size),
    ...(kind === "audio" || kind === "video"
      ? [formatDuration(asset?.duration_ms ?? node.attrs.duration_ms)]
      : []),
    ...(kind === "video" && asset?.width && asset.height
      ? [`${asset.width} x ${asset.height}`]
      : []),
  ].filter(Boolean)
  const refreshPoster = () => {
    if (customPosterId) {
      void media.assetAccess.load(customPosterId, "inline", true)
      return
    }
    void media.assetAccess.load(assetId, "inline", true, "poster")
  }
  return (
    <NodeViewWrapper data-node-id={nodeId}>
      <MediaShell selected={selected}>
        <div className="flex min-h-24 items-start gap-4 p-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{title}</p>
            {description && (
              <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">
                {description}
              </p>
            )}
            <p className="mt-2 text-xs break-words text-muted-foreground">
              {facts.join(" · ")}
            </p>
            <AssetState
              {...metadata}
              readOnly={disabled}
              onRetry={() => void media.assetAccess.retry(assetId)}
              onCancel={() => void media.assetAccess.cancel(assetId)}
            />
            {kind === "file" &&
              ready &&
              (src ? (
                <a
                  className={cn(
                    buttonVariants({ size: "sm", variant: "outline" }),
                    "mt-3"
                  )}
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  download={asset?.original_filename}
                >
                  <Download />
                  下载 {asset?.original_filename || "文件"}
                </a>
              ) : (
                <Button
                  type="button"
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled
                >
                  <Download />
                  准备下载链接
                </Button>
              ))}
            {kind === "audio" && ready && src && (
              <audio
                className="mt-3 w-full"
                src={src}
                controls
                preload="metadata"
                onError={() =>
                  void media.assetAccess.load(assetId, "inline", true)
                }
              />
            )}
            {kind === "video" && ready && src && (
              <div className="relative mt-3">
                <video
                  className="max-h-[60dvh] w-full bg-black"
                  src={src}
                  poster={poster || undefined}
                  controls
                  playsInline
                  preload="metadata"
                  onError={() =>
                    void media.assetAccess.load(assetId, "inline", true)
                  }
                />
                {poster && (
                  <img
                    src={poster}
                    alt=""
                    aria-hidden="true"
                    className="pointer-events-none absolute size-px opacity-0"
                    onError={refreshPoster}
                  />
                )}
              </div>
            )}
            {access.error && (
              <p className="mt-2 text-sm text-destructive" role="alert">
                媒体暂时无法加载
              </p>
            )}
            {kind === "video" &&
              ready &&
              !customPosterId &&
              !hasAutomaticPoster && (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  自动封面不可用，请上传自定义封面。
                </p>
              )}
          </div>
        </div>
        {selected && !disabled && (
          <div className="grid gap-3 border-t p-3" contentEditable={false}>
            <div className="flex justify-end">
              <MediaActions
                disabled={disabled}
                onReplace={() =>
                  media.replace({ nodeId, nodeType: kind, assetType: kind })
                }
                onDelete={deleteNode}
              />
            </div>
            <Field label={kind === "file" ? "显示名称" : "标题"}>
              <Input
                value={String(
                  kind === "file"
                    ? node.attrs.display_name || ""
                    : node.attrs.title || ""
                )}
                disabled={disabled}
                onChange={(event) =>
                  updateAttributes(
                    kind === "file"
                      ? { display_name: event.target.value }
                      : { title: event.target.value || null }
                  )
                }
              />
            </Field>
            <Field label={kind === "file" ? "文件说明" : "说明文字"}>
              <Textarea
                value={String(
                  kind === "file"
                    ? node.attrs.description || ""
                    : node.attrs.caption || ""
                )}
                disabled={disabled}
                onChange={(event) =>
                  updateAttributes(
                    kind === "file"
                      ? { description: event.target.value || null }
                      : { caption: event.target.value || null }
                  )
                }
              />
            </Field>
            {kind === "video" && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => media.replacePoster(nodeId)}
                >
                  <ImageIcon />{" "}
                  {customPosterId ? "替换自定义封面" : "上传自定义封面"}
                </Button>
                {customPosterId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => updateAttributes({ poster_asset_id: null })}
                  >
                    使用自动封面
                  </Button>
                )}
                <span className="text-xs text-muted-foreground">
                  {customPosterId
                    ? "当前使用自定义封面，替换视频时会保留。"
                    : hasAutomaticPoster
                      ? "当前使用视频处理器生成的自动封面。"
                      : "自动封面尚不可用。"}
                </span>
              </div>
            )}
          </div>
        )}
      </MediaShell>
    </NodeViewWrapper>
  )
}

export const ArticleFileNodeView = (props: ReactNodeViewProps) => (
  <GenericMediaNodeView {...props} kind="file" icon={<FileText />} />
)
export const ArticleAudioNodeView = (props: ReactNodeViewProps) => (
  <GenericMediaNodeView {...props} kind="audio" icon={<Music2 />} />
)
export const ArticleVideoNodeView = (props: ReactNodeViewProps) => (
  <GenericMediaNodeView {...props} kind="video" icon={<Video />} />
)
