import type {
  ArticleDetail,
  ArticleDocument,
  ArticleMetadataSnapshot,
} from "@/api/articles"

export const ARTICLE_DOCUMENT_SCHEMA_VERSION = 2

const ARTICLE_SEO_FIELD_KEYS = [
  "title",
  "slug",
  "focus_keyword",
  "secondary_keywords",
  "meta_title",
  "meta_description",
  "canonical_url",
  "indexing",
] as const

export const EDITOR_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
  "gallery",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "file",
  "audio",
  "video",
  "bookmark",
  "callout",
  "details",
  "detailsContent",
  "button",
  "embed",
  "text",
  "hardBreak",
])

export const EDITOR_MARK_TYPES = new Set([
  "bold",
  "italic",
  "strike",
  "code",
  "underline",
  "highlight",
  "link",
])

const NODE_ID_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
  "gallery",
  "table",
  "file",
  "audio",
  "video",
  "bookmark",
  "callout",
  "details",
  "button",
  "embed",
])

function visitDocument(
  value: unknown,
  visitor: (node: Record<string, unknown>) => void
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const node = value as Record<string, unknown>
  visitor(node)
  if (Array.isArray(node.content)) {
    node.content.forEach((child) => visitDocument(child, visitor))
  }
}

export type ArticleAssetReference = {
  assetId: string
  role:
    | "image"
    | "gallery_item"
    | "file"
    | "audio"
    | "video"
    | "poster"
    | "thumbnail"
  nodeId: string
  itemId?: string
}

export function articleDocumentAssetReferences(document: ArticleDocument) {
  const references: ArticleAssetReference[] = []
  visitDocument(document, (node) => {
    const type = typeof node.type === "string" ? node.type : ""
    const attrs =
      node.attrs && typeof node.attrs === "object" && !Array.isArray(node.attrs)
        ? (node.attrs as Record<string, unknown>)
        : {}
    const nodeId = typeof attrs.node_id === "string" ? attrs.node_id : ""
    const add = (
      value: unknown,
      role: ArticleAssetReference["role"],
      itemId?: unknown
    ) => {
      if (typeof value !== "string" || !value || !nodeId) return
      references.push({
        assetId: value,
        role,
        nodeId,
        ...(typeof itemId === "string" && itemId ? { itemId } : {}),
      })
    }
    if (["image", "file", "audio", "video"].includes(type)) {
      add(attrs.asset_id, type as ArticleAssetReference["role"])
    }
    if (type === "gallery" && Array.isArray(attrs.items)) {
      attrs.items.forEach((rawItem) => {
        if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem))
          return
        const item = rawItem as Record<string, unknown>
        add(item.asset_id, "gallery_item", item.item_id)
      })
    }
    add(attrs.poster_asset_id, "poster")
    add(attrs.thumbnail_asset_id, "thumbnail")
  })
  return references
}

export function documentCompatibility(document: ArticleDocument) {
  const unsupportedNodes = new Set<string>()
  const unsupportedMarks = new Set<string>()
  visitDocument(document, (node) => {
    const type = typeof node.type === "string" ? node.type : "unknown"
    if (!EDITOR_NODE_TYPES.has(type)) unsupportedNodes.add(type)
    if (Array.isArray(node.marks)) {
      for (const rawMark of node.marks) {
        if (!rawMark || typeof rawMark !== "object") continue
        const mark = rawMark as Record<string, unknown>
        const markType = typeof mark.type === "string" ? mark.type : "unknown"
        if (!EDITOR_MARK_TYPES.has(markType)) unsupportedMarks.add(markType)
      }
    }
  })
  const schemaVersion = Number.isInteger(document.schema_version)
    ? document.schema_version
    : 1
  return {
    writable:
      schemaVersion <= ARTICLE_DOCUMENT_SCHEMA_VERSION &&
      unsupportedNodes.size === 0 &&
      unsupportedMarks.size === 0,
    unsupportedNodes: [...unsupportedNodes].sort(),
    unsupportedMarks: [...unsupportedMarks].sort(),
  }
}

function nodeId() {
  return `blk_${crypto.randomUUID().replaceAll("-", "")}`
}

export function editorJsonToArticleDocument(
  value: Record<string, unknown>
): ArticleDocument {
  const document = structuredClone(value) as ArticleDocument
  document.schema_version = ARTICLE_DOCUMENT_SCHEMA_VERSION
  visitDocument(document, (node) => {
    if (
      node.attrs &&
      typeof node.attrs === "object" &&
      !Array.isArray(node.attrs)
    ) {
      node.attrs = Object.fromEntries(
        Object.entries(node.attrs).filter(
          ([, item]) => item !== null && item !== undefined
        )
      )
    }
    if (Array.isArray(node.marks)) {
      node.marks = node.marks.map((rawMark) => {
        if (!rawMark || typeof rawMark !== "object" || Array.isArray(rawMark)) {
          return rawMark
        }
        const mark = rawMark as Record<string, unknown>
        if (
          mark.attrs &&
          typeof mark.attrs === "object" &&
          !Array.isArray(mark.attrs)
        ) {
          mark.attrs = Object.fromEntries(
            Object.entries(mark.attrs).filter(
              ([, item]) => item !== null && item !== undefined
            )
          )
        }
        return mark
      })
    }
    const type = typeof node.type === "string" ? node.type : ""
    if (type === "tableCell" || type === "tableHeader") {
      const attrs =
        node.attrs &&
        typeof node.attrs === "object" &&
        !Array.isArray(node.attrs)
          ? (node.attrs as Record<string, unknown>)
          : {}
      const supportedAttrs = Object.fromEntries(
        ["colspan", "rowspan", "colwidth", "textAlign", "verticalAlign"]
          .filter((field) => attrs[field] !== undefined)
          .map((field) => [field, attrs[field]])
      )
      if (
        supportedAttrs.textAlign === undefined &&
        (attrs.align === "left" ||
          attrs.align === "center" ||
          attrs.align === "right")
      ) {
        supportedAttrs.textAlign = attrs.align
      }
      if (supportedAttrs.colspan === 1) delete supportedAttrs.colspan
      if (supportedAttrs.rowspan === 1) delete supportedAttrs.rowspan
      node.attrs = supportedAttrs
    }
    if (!NODE_ID_TYPES.has(type)) return
    const attrs =
      node.attrs && typeof node.attrs === "object" && !Array.isArray(node.attrs)
        ? (node.attrs as Record<string, unknown>)
        : {}
    if (typeof attrs.node_id !== "string" || !attrs.node_id) {
      attrs.node_id = nodeId()
    }
    node.attrs = attrs
  })
  return document
}

export function articleDocumentToEditorJson(document: ArticleDocument) {
  const editorDocument = structuredClone(document) as Record<string, unknown>
  delete editorDocument.schema_version
  return editorDocument
}

export function canonicalizeArticleDocument(
  document: ArticleDocument
): ArticleDocument {
  return editorJsonToArticleDocument(articleDocumentToEditorJson(document))
}

export function articleMetadata(
  article: Pick<
    ArticleDetail,
    | "title"
    | "slug"
    | "meta_title"
    | "meta_description"
    | "focus_keyword"
    | "secondary_keywords"
    | "canonical_url"
    | "indexing"
    | "field_states"
    | "publication_status"
  >
): ArticleMetadataSnapshot {
  return {
    title: article.title,
    slug: article.slug,
    meta_title: article.meta_title,
    meta_description: article.meta_description,
    focus_keyword: article.focus_keyword,
    secondary_keywords: article.secondary_keywords,
    canonical_url: article.canonical_url,
    indexing: article.indexing,
    field_states: Object.fromEntries(
      ARTICLE_SEO_FIELD_KEYS.map((field) => [
        field,
        article.field_states[field] ?? "generated",
      ])
    ),
    publication_status: article.publication_status,
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    )
  }
  return value
}

export function canonicalArticleDocumentSnapshot(document: ArticleDocument) {
  return JSON.stringify(canonicalize(canonicalizeArticleDocument(document)))
}

export function canonicalArticleSnapshot(
  document: ArticleDocument,
  metadata: ArticleMetadataSnapshot
) {
  return JSON.stringify(canonicalize({ document, metadata }))
}

export async function articleSnapshotHash(
  document: ArticleDocument,
  metadata: ArticleMetadataSnapshot
) {
  const bytes = new TextEncoder().encode(
    canonicalArticleSnapshot(document, metadata)
  )
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("")
}

export async function articleMetadataHash(metadata: ArticleMetadataSnapshot) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonicalize(metadata))
  )
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("")
}

export async function articleDocumentHash(document: ArticleDocument) {
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonicalize(canonicalizeArticleDocument(document)))
  )
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("")
}

export function articleDocumentText(document: ArticleDocument) {
  const lines: string[] = []
  visitDocument(document, (node) => {
    if (typeof node.text === "string") lines.push(node.text)
    if (node.type === "hardBreak") lines.push("\n")
  })
  return lines.join("").replace(/\n{3,}/g, "\n\n")
}
