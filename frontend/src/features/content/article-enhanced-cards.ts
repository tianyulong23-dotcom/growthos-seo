import type { Editor, JSONContent } from "@tiptap/core"

import type {
  BookmarkResolveResult,
  EmbedResolveResult,
} from "@/api/articles"
import {
  normalizeArticleLinkHref,
  normalizeArticleLinkValue,
} from "@/features/content/article-link"
import { findArticleNodeById } from "@/features/content/article-media-editor"

export type ArticleEnhancedCardType = "bookmark" | "button" | "embed"
export type ArticleEmbedProvider = "youtube" | "vimeo" | "spotify"
export type ArticleButtonStyle = "primary" | "secondary"

export type ArticleBookmarkAttributes = {
  node_id?: string
  url: string
  title?: string | null
  description?: string | null
  thumbnail_asset_id?: string | null
  publisher?: string | null
  icon_url?: string | null
  image_url?: string | null
  fetched_at?: string | null
}

export type ArticleButtonAttributes = {
  node_id?: string
  label: string
  href: string
  style: ArticleButtonStyle
  target?: "_blank" | null
  rel?: string | null
}

export type ArticleEmbedAttributes = {
  node_id?: string
  provider: ArticleEmbedProvider
  source_url: string
  embed_id: string
  caption?: string | null
}

export type ArticleEnhancedCardAttributes =
  | ArticleBookmarkAttributes
  | ArticleButtonAttributes
  | ArticleEmbedAttributes

export type ArticleEnhancedCardSubmission =
  | { type: "bookmark"; attributes: ArticleBookmarkAttributes }
  | { type: "button"; attributes: ArticleButtonAttributes }
  | { type: "embed"; attributes: ArticleEmbedAttributes }

function optionalText(value: unknown, maximum: number) {
  const normalized = typeof value === "string" ? value.trim() : ""
  return normalized ? normalized.slice(0, maximum) : null
}

function absolutePublicUrl(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = normalizeArticleLinkHref(value)
  return normalized?.startsWith("http") ? normalized : null
}

export function articlePublicHostname(value: unknown) {
  const normalized = typeof value === "string" ? absolutePublicUrl(value) : null
  if (!normalized) return "链接地址不可用"
  try {
    return new URL(normalized).hostname
  } catch {
    return "链接地址不可用"
  }
}

export function bookmarkAttributesFromResult(
  result: BookmarkResolveResult
): ArticleBookmarkAttributes | null {
  if (result.kind !== "bookmark") return null
  const url = absolutePublicUrl(result.final_url)
  if (!url) return null
  return {
    url,
    title: optionalText(result.title, 500),
    description: optionalText(result.description, 5_000),
    publisher: optionalText(result.publisher, 500),
    icon_url: absolutePublicUrl(result.icon_url),
    image_url: absolutePublicUrl(result.image_url),
    fetched_at: optionalText(result.fetched_at, 100),
  }
}

export function normalizeArticleButtonAttributes(input: {
  label: string
  href: string
  style?: string | null
  target?: "_blank" | null
  rel?: string | null
}): ArticleButtonAttributes | null {
  const label = input.label.trim().slice(0, 200)
  const link = normalizeArticleLinkValue({
    href: input.href,
    target: input.target,
    rel: input.rel,
  })
  if (!label || !link) return null
  return {
    label,
    href: link.href,
    style: input.style === "secondary" ? "secondary" : "primary",
    target: link.target,
    rel: link.rel,
  }
}

export function embedAttributesFromResult(
  result: EmbedResolveResult,
  caption?: string | null
): ArticleEmbedAttributes | null {
  if (
    result.kind !== "embed" ||
    !result.provider ||
    !result.embed_id ||
    !absolutePublicUrl(result.source_url)
  ) {
    return null
  }
  return {
    provider: result.provider,
    source_url: result.source_url,
    embed_id: result.embed_id,
    caption: optionalText(caption, 5_000),
  }
}

export function articleEmbedUrl(input: {
  provider: unknown
  embed_id: unknown
}) {
  const provider = input.provider
  const embedId = typeof input.embed_id === "string" ? input.embed_id : ""
  if (!/^[A-Za-z0-9_/-]{3,200}$/.test(embedId)) return null
  if (provider === "youtube") {
    return `https://www.youtube-nocookie.com/embed/${embedId}`
  }
  if (provider === "vimeo") {
    return `https://player.vimeo.com/video/${embedId}`
  }
  if (provider === "spotify") {
    return `https://open.spotify.com/embed/${embedId}`
  }
  return null
}

export function articleEnhancedFallbackContent(
  href: string,
  label: string
): JSONContent | null {
  const link = normalizeArticleLinkValue({ href, target: "_blank" })
  const text = label.trim() || href.trim()
  if (!link || !text) return null
  return {
    type: "paragraph",
    content: [
      {
        type: "text",
        text,
        marks: [{ type: "link", attrs: link }],
      },
    ],
  }
}

export function replaceEnhancedCardWithLink(
  editor: Editor,
  nodeId: string,
  href: string,
  label: string
) {
  const located = findArticleNodeById(editor, nodeId)
  const content = articleEnhancedFallbackContent(href, label)
  if (!located || !content) return false
  editor.view.dispatch(
    editor.state.tr.replaceWith(
      located.position,
      located.position + located.node.nodeSize,
      editor.schema.nodeFromJSON(content)
    )
  )
  return true
}

export const ARTICLE_ENHANCED_ERROR_LABELS: Record<string, string> = {
  bookmark_not_html: "该地址不是网页，无法生成摘要卡片。",
  asset_import_ssrf_blocked: "该地址指向受保护的网络位置，已阻止抓取。",
  asset_import_timeout: "来源网站响应超时。",
  asset_import_failed: "来源网站暂时无法读取。",
  embed_provider_unsupported: "当前仅支持 YouTube、Vimeo 和 Spotify。",
}

export function articleEnhancedErrorLabel(code: string | null | undefined) {
  return code
    ? ARTICLE_ENHANCED_ERROR_LABELS[code] ?? `处理失败：${code}`
    : "处理失败，请稍后重试。"
}
