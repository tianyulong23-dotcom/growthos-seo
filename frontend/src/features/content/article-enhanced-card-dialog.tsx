import * as React from "react"

import {
  refreshArticleBookmark,
  resolveArticleBookmark,
  resolveArticleEmbed,
  type ArticleRequestOptions,
  type BookmarkResolveResult,
  type EmbedResolveResult,
} from "@/api/articles"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Textarea } from "@/components/ui/textarea"
import {
  articleEnhancedErrorLabel,
  articleEmbedUrl,
  bookmarkAttributesFromResult,
  embedAttributesFromResult,
  normalizeArticleButtonAttributes,
  type ArticleButtonAttributes,
  type ArticleEmbedAttributes,
  type ArticleEnhancedCardSubmission,
  type ArticleEnhancedCardType,
  type ArticleBookmarkAttributes,
} from "@/features/content/article-enhanced-cards"
import { ARTICLE_LINK_REL_OPTIONS } from "@/features/content/article-link"

type ArticleEnhancedCardDialogProps = {
  projectId: string
  articleId: string
  type: ArticleEnhancedCardType
  initial?: Record<string, unknown> | null
  requestOptions?: Omit<ArticleRequestOptions, "signal">
  onOpenChange: (open: boolean) => void
  onSubmit: (submission: ArticleEnhancedCardSubmission) => void
  onFallback: (href: string, label: string) => void
}

const TITLES: Record<ArticleEnhancedCardType, string> = {
  bookmark: "书签卡片",
  button: "CTA 按钮",
  embed: "嵌入内容",
}

function initialUrl(
  type: ArticleEnhancedCardType,
  initial?: Record<string, unknown> | null
) {
  const value =
    type === "bookmark"
      ? initial?.url
      : type === "embed"
        ? initial?.source_url
        : initial?.href
  return typeof value === "string" ? value : ""
}

function BookmarkPreview({ result }: { result: BookmarkResolveResult }) {
  if (result.kind !== "bookmark") return null
  return (
    <div className="grid min-w-0 gap-2 rounded-md border p-3">
      <p className="text-sm font-medium break-words">
        {result.title || result.final_url}
      </p>
      {result.description && (
        <p className="line-clamp-3 text-xs text-muted-foreground">
          {result.description}
        </p>
      )}
      <p className="truncate text-xs text-muted-foreground">
        {result.publisher || result.final_url}
      </p>
    </div>
  )
}

function EmbedPreview({ result }: { result: EmbedResolveResult }) {
  if (result.kind !== "embed") return null
  const embedUrl = articleEmbedUrl(result)
  return (
    <div className="grid min-w-0 gap-2 rounded-md border p-3">
      {embedUrl && (
        <iframe
          src={embedUrl}
          title={`${result.provider} 嵌入预览`}
          loading="lazy"
          allow="fullscreen; autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
          className="aspect-video w-full border-0"
        />
      )}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>{result.provider}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {result.embed_id}
        </span>
      </div>
    </div>
  )
}

function initialBookmarkResult(
  initial?: Record<string, unknown> | null
): BookmarkResolveResult | null {
  if (typeof initial?.url !== "string" || !initial.url) return null
  return {
    kind: "bookmark",
    source_url: initial.url,
    final_url: initial.url,
    title: typeof initial.title === "string" ? initial.title : null,
    description:
      typeof initial.description === "string" ? initial.description : null,
    publisher: typeof initial.publisher === "string" ? initial.publisher : null,
    icon_url: typeof initial.icon_url === "string" ? initial.icon_url : null,
    image_url: typeof initial.image_url === "string" ? initial.image_url : null,
    fetched_at:
      typeof initial.fetched_at === "string" ? initial.fetched_at : null,
    error_code: null,
    retryable: false,
  }
}

function initialEmbedResult(
  initial?: Record<string, unknown> | null
): EmbedResolveResult | null {
  const provider = initial?.provider
  if (
    !["youtube", "vimeo", "spotify"].includes(String(provider)) ||
    typeof initial?.source_url !== "string" ||
    typeof initial?.embed_id !== "string"
  ) {
    return null
  }
  return {
    kind: "embed",
    source_url: initial.source_url,
    provider: provider as "youtube" | "vimeo" | "spotify",
    embed_id: initial.embed_id,
    embed_url: null,
    error_code: null,
  }
}

export function ArticleEnhancedCardDialog({
  projectId,
  articleId,
  type,
  initial,
  requestOptions,
  onOpenChange,
  onSubmit,
  onFallback,
}: ArticleEnhancedCardDialogProps) {
  const [url, setUrl] = React.useState(() => initialUrl(type, initial))
  const [label, setLabel] = React.useState(() =>
    typeof initial?.label === "string" ? initial.label : ""
  )
  const [style, setStyle] = React.useState<"primary" | "secondary">(() =>
    initial?.style === "secondary" ? "secondary" : "primary"
  )
  const [targetBlank, setTargetBlank] = React.useState(
    initial?.target === "_blank"
  )
  const [rel, setRel] = React.useState(
    () =>
      new Set(
        typeof initial?.rel === "string"
          ? initial.rel
              .split(/\s+/)
              .filter((token) =>
                ARTICLE_LINK_REL_OPTIONS.includes(
                  token as (typeof ARTICLE_LINK_REL_OPTIONS)[number]
                )
              )
          : []
      )
  )
  const [caption, setCaption] = React.useState(() =>
    typeof initial?.caption === "string" ? initial.caption : ""
  )
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState("")
  const [retryable, setRetryable] = React.useState(false)
  const [bookmarkResult, setBookmarkResult] =
    React.useState<BookmarkResolveResult | null>(() =>
      type === "bookmark" ? initialBookmarkResult(initial) : null
    )
  const [embedResult, setEmbedResult] =
    React.useState<EmbedResolveResult | null>(() =>
      type === "embed" ? initialEmbedResult(initial) : null
    )

  const resolveBookmark = async (refresh: boolean) => {
    const normalized = url.trim()
    if (!normalized) {
      setError("请输入完整的 HTTP/HTTPS 地址。")
      return
    }
    setWorking(true)
    setError("")
    try {
      const result = await (
        refresh ? refreshArticleBookmark : resolveArticleBookmark
      )(projectId, articleId, normalized, requestOptions)
      setBookmarkResult(result)
      setRetryable(result.retryable)
      const attrs = bookmarkAttributesFromResult(result)
      if (!attrs) {
        setError(articleEnhancedErrorLabel(result.error_code))
        return
      }
    } catch (reason) {
      setRetryable(true)
      setError(reason instanceof Error ? reason.message : "书签解析失败")
    } finally {
      setWorking(false)
    }
  }

  const resolveEmbed = async () => {
    const normalized = url.trim()
    if (!normalized) {
      setError("请输入 YouTube、Vimeo 或 Spotify 地址。")
      return
    }
    setWorking(true)
    setError("")
    try {
      const result = await resolveArticleEmbed(
        projectId,
        articleId,
        normalized,
        requestOptions
      )
      setEmbedResult(result)
      const attrs = embedAttributesFromResult(result, caption)
      if (!attrs) {
        setError(articleEnhancedErrorLabel(result.error_code))
        return
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "嵌入地址解析失败")
    } finally {
      setWorking(false)
    }
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (type === "bookmark") {
      const attributes = bookmarkResult
        ? bookmarkAttributesFromResult(bookmarkResult)
        : null
      if (attributes) {
        onSubmit({
          type,
          attributes: {
            ...(initial?.node_id ? { node_id: String(initial.node_id) } : {}),
            ...attributes,
          } satisfies ArticleBookmarkAttributes,
        })
        onOpenChange(false)
        return
      }
      void resolveBookmark(false)
      return
    }
    if (type === "embed") {
      const attributes = embedResult
        ? embedAttributesFromResult(embedResult, caption)
        : null
      if (attributes) {
        onSubmit({
          type,
          attributes: {
            ...(initial?.node_id ? { node_id: String(initial.node_id) } : {}),
            ...attributes,
          } satisfies ArticleEmbedAttributes,
        })
        onOpenChange(false)
        return
      }
      void resolveEmbed()
      return
    }
    const attrs = normalizeArticleButtonAttributes({
      label,
      href: url,
      style,
      target: targetBlank ? "_blank" : null,
      rel: rel.size ? [...rel].join(" ") : null,
    })
    if (!attrs) {
      setError(
        "按钮文字不能为空，URL 必须是站内相对路径或完整的 HTTP/HTTPS 地址。"
      )
      return
    }
    onSubmit({
      type,
      attributes: {
        ...(initial?.node_id ? { node_id: String(initial.node_id) } : {}),
        ...attrs,
      } satisfies ArticleButtonAttributes,
    })
    onOpenChange(false)
  }

  const fallbackLabel =
    type === "bookmark"
      ? bookmarkResult?.title ||
        (typeof initial?.title === "string" ? initial.title : url)
      : url

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {initial?.node_id ? `编辑${TITLES[type]}` : `插入${TITLES[type]}`}
          </DialogTitle>
          <DialogDescription>
            {type === "bookmark"
              ? "由服务器安全抓取网页标题、摘要、站点和图片，可随时刷新或退化为普通链接。"
              : type === "embed"
                ? "仅识别 YouTube、Vimeo 和 Spotify，不保存第三方脚本或 HTML。"
                : "按钮链接使用与正文链接相同的协议、target 和 rel 安全规则。"}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          {type === "button" && (
            <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
              按钮文字
              <Input
                autoFocus
                value={label}
                maxLength={200}
                onChange={(event) => {
                  setLabel(event.target.value)
                  setError("")
                }}
              />
            </Label>
          )}
          <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
            URL
            <Input
              autoFocus={type !== "button"}
              value={url}
              maxLength={2_048}
              placeholder={
                type === "button"
                  ? "/guides/example/ 或 https://example.com"
                  : "https://example.com"
              }
              onChange={(event) => {
                setUrl(event.target.value)
                setError("")
                setBookmarkResult(null)
                setEmbedResult(null)
              }}
            />
          </Label>
          {type === "button" && (
            <>
              <fieldset className="grid gap-2">
                <legend className="text-xs font-medium text-muted-foreground">
                  按钮样式
                </legend>
                <div className="flex rounded-md border p-0.5">
                  {(["primary", "secondary"] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={style === value ? "secondary" : "ghost"}
                      aria-pressed={style === value}
                      onClick={() => setStyle(value)}
                    >
                      {value === "primary" ? "主要" : "次要"}
                    </Button>
                  ))}
                </div>
              </fieldset>
              <Label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={targetBlank}
                  onCheckedChange={(checked) =>
                    setTargetBlank(checked === true)
                  }
                />
                在新窗口打开
              </Label>
              <fieldset className="grid gap-2">
                <legend className="text-xs font-medium text-muted-foreground">
                  链接关系
                </legend>
                <div className="flex flex-wrap gap-4">
                  {ARTICLE_LINK_REL_OPTIONS.map((option) => (
                    <Label
                      key={option}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={rel.has(option)}
                        onCheckedChange={(checked) => {
                          setRel((current) => {
                            const next = new Set(current)
                            if (checked === true) next.add(option)
                            else next.delete(option)
                            return next
                          })
                        }}
                      />
                      {option}
                    </Label>
                  ))}
                </div>
              </fieldset>
            </>
          )}
          {type === "embed" && (
            <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
              说明文字
              <Textarea
                value={caption}
                maxLength={5_000}
                onChange={(event) => setCaption(event.target.value)}
              />
            </Label>
          )}
          {bookmarkResult?.kind === "bookmark" && (
            <section className="grid gap-2" aria-label="书签预览">
              <BookmarkPreview result={bookmarkResult} />
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={working}
                  onClick={() => void resolveBookmark(true)}
                >
                  刷新元数据
                </Button>
              </div>
            </section>
          )}
          {embedResult?.kind === "embed" && (
            <section aria-label="嵌入预览">
              <EmbedPreview result={embedResult} />
            </section>
          )}
          {error && (
            <div
              className="grid gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
              role="alert"
            >
              <p>{error}</p>
              {(type === "bookmark" || type === "embed") && url.trim() && (
                <div className="flex flex-wrap gap-2">
                  {type === "bookmark" && retryable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={working}
                      onClick={() => void resolveBookmark(true)}
                    >
                      重试抓取
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onFallback(url.trim(), fallbackLabel)
                      onOpenChange(false)
                    }}
                  >
                    改为普通链接
                  </Button>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={working}>
              {working
                ? "正在解析..."
                : type === "button" ||
                    bookmarkResult?.kind === "bookmark" ||
                    embedResult?.kind === "embed"
                  ? initial?.node_id
                    ? "保存"
                    : "确认插入"
                  : "解析并预览"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
