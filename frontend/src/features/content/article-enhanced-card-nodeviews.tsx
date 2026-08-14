import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import * as React from "react"
import {
  AlertTriangle,
  ExternalLink,
  Link2,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react"

import type { BookmarkResolveResult } from "@/api/articles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  articleEmbedUrl,
  articleEnhancedErrorLabel,
  articlePublicHostname,
  bookmarkAttributesFromResult,
  type ArticleEnhancedCardType,
} from "@/features/content/article-enhanced-cards"
import { cn } from "@/lib/utils"

export type ArticleEnhancedCardRuntimeStorage = {
  readOnly: boolean
  open: (type: ArticleEnhancedCardType, nodeId?: string) => void
  refreshBookmark: (url: string) => Promise<BookmarkResolveResult>
  fallback: (nodeId: string, href: string, label: string) => boolean
}

function runtime(editor: ReactNodeViewProps["editor"]) {
  return (
    editor.storage as unknown as {
      articleEnhancedCardRuntime: ArticleEnhancedCardRuntimeStorage
    }
  ).articleEnhancedCardRuntime
}

function CardShell({
  selected,
  children,
}: {
  selected: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "group/enhanced relative my-5 overflow-hidden rounded-md border bg-background",
        selected && "border-primary ring-2 ring-primary/15"
      )}
    >
      {children}
    </div>
  )
}

function CardActions({
  onEdit,
  onDelete,
  children,
}: {
  onEdit: () => void
  onDelete: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 border-t p-2" contentEditable={false}>
      {children}
      <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
        <Pencil /> 编辑
      </Button>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="删除卡片" title="删除卡片" onClick={onDelete}>
        <Trash2 />
      </Button>
    </div>
  )
}

function RemoteImage({
  src,
  className,
}: {
  src: string
  className: string
}) {
  const [failed, setFailed] = React.useState(false)
  if (failed) return null
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => setFailed(true)}
    />
  )
}

export function ArticleBookmarkNodeView({
  node,
  editor,
  selected,
  updateAttributes,
  deleteNode,
}: ReactNodeViewProps) {
  const enhanced = runtime(editor)
  const nodeId = String(node.attrs.node_id || "")
  const url = String(node.attrs.url || "")
  const title = String(node.attrs.title || url)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState("")
  const refresh = async () => {
    setRefreshing(true)
    setError("")
    try {
      const result = await enhanced.refreshBookmark(url)
      const attrs = bookmarkAttributesFromResult(result)
      if (!attrs) {
        setError(articleEnhancedErrorLabel(result.error_code))
        return
      }
      updateAttributes(attrs)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刷新书签失败")
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <NodeViewWrapper as="aside" data-node-id={nodeId}>
      <CardShell selected={selected}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="grid min-w-0 text-foreground no-underline sm:grid-cols-[minmax(0,1fr)_10rem]"
          contentEditable={false}
        >
          <span className="grid min-w-0 gap-2 p-4">
            <strong className="break-words text-base">{title}</strong>
            {node.attrs.description && (
              <span className="line-clamp-3 text-sm text-muted-foreground">
                {String(node.attrs.description)}
              </span>
            )}
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {node.attrs.icon_url && (
                <RemoteImage
                  src={String(node.attrs.icon_url)}
                  className="size-4 shrink-0"
                />
              )}
              <span className="truncate">
                {String(node.attrs.publisher || articlePublicHostname(url))}
              </span>
              <ExternalLink className="size-3.5 shrink-0" />
            </span>
          </span>
          {node.attrs.image_url && (
            <RemoteImage
              src={String(node.attrs.image_url)}
              className="h-36 w-full border-t object-cover sm:h-full sm:border-t-0 sm:border-l"
            />
          )}
        </a>
        {error && (
          <div className="flex items-center gap-2 border-t bg-amber-50 px-3 py-2 text-xs text-amber-950" role="alert">
            <AlertTriangle className="size-4 shrink-0" /> {error}
          </div>
        )}
        {selected && !enhanced.readOnly && (
          <CardActions onEdit={() => enhanced.open("bookmark", nodeId)} onDelete={deleteNode}>
            <Button type="button" size="sm" variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} /> 刷新元数据
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => enhanced.fallback(nodeId, url, title)}>
              <Link2 /> 转为普通链接
            </Button>
          </CardActions>
        )}
      </CardShell>
    </NodeViewWrapper>
  )
}

export function ArticleButtonNodeView({
  node,
  editor,
  selected,
  deleteNode,
}: ReactNodeViewProps) {
  const enhanced = runtime(editor)
  const nodeId = String(node.attrs.node_id || "")
  const href = String(node.attrs.href || "")
  const label = String(node.attrs.label || href)
  const secondary = node.attrs.style === "secondary"
  return (
    <NodeViewWrapper as="div" data-node-id={nodeId}>
      <CardShell selected={selected}>
        <div className="flex justify-center p-6" contentEditable={false}>
          <a
            href={href}
            target={node.attrs.target || undefined}
            rel={node.attrs.rel || undefined}
            className={cn(
              "inline-flex min-h-10 items-center justify-center rounded-md border px-5 py-2 text-sm font-medium no-underline",
              secondary
                ? "border-input bg-background text-foreground"
                : "border-primary bg-primary text-primary-foreground"
            )}
          >
            {label}
          </a>
        </div>
        {selected && !enhanced.readOnly && (
          <CardActions onEdit={() => enhanced.open("button", nodeId)} onDelete={deleteNode} />
        )}
      </CardShell>
    </NodeViewWrapper>
  )
}

export function ArticleEmbedNodeView({
  node,
  editor,
  selected,
  deleteNode,
}: ReactNodeViewProps) {
  const enhanced = runtime(editor)
  const nodeId = String(node.attrs.node_id || "")
  const sourceUrl = String(node.attrs.source_url || "")
  const embedUrl = articleEmbedUrl({
    provider: node.attrs.provider,
    embed_id: node.attrs.embed_id,
  })
  return (
    <NodeViewWrapper as="figure" data-node-id={nodeId}>
      <CardShell selected={selected}>
        {embedUrl ? (
          <iframe
            src={embedUrl}
            title={`${String(node.attrs.provider)} 嵌入内容`}
            loading="lazy"
            allow="fullscreen; autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            className="aspect-video w-full border-0"
            contentEditable={false}
          />
        ) : (
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 p-4">
            <Badge variant="outline">嵌入不可用</Badge>
            <span className="min-w-0 truncate">{sourceUrl}</span>
          </a>
        )}
        {node.attrs.caption && (
          <figcaption className="border-t px-4 py-2 text-sm text-muted-foreground">
            {String(node.attrs.caption)}
          </figcaption>
        )}
        {selected && !enhanced.readOnly && (
          <CardActions onEdit={() => enhanced.open("embed", nodeId)} onDelete={deleteNode}>
            <Button type="button" size="sm" variant="ghost" onClick={() => enhanced.fallback(nodeId, sourceUrl, sourceUrl)}>
              <Link2 /> 转为普通链接
            </Button>
          </CardActions>
        )}
      </CardShell>
    </NodeViewWrapper>
  )
}
