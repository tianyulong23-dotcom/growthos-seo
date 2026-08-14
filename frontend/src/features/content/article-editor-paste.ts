export const ARTICLE_HIGHLIGHT_COLORS = [
  "#fef3c7",
  "#dbeafe",
  "#dcfce7",
  "#fce7f3",
  "#f3e8ff",
] as const

export const ARTICLE_PASTE_TABLE_LIMITS = {
  rows: 20,
  columns: 20,
} as const

export const ARTICLE_PASTE_LIST_DEPTH_LIMIT = 3

export type ArticlePasteSource =
  "excel" | "word" | "google_docs" | "web" | "html"

export type ArticlePasteRemoteImage = {
  url: string
  alt: string
}

export type ArticlePasteTableReview = {
  index: number
  originalRows: number
  originalColumns: number
  acceptedRows: number
  acceptedColumns: number
  clipped: boolean
  preview: string[][]
}

export type ArticlePasteSegment =
  { type: "html"; html: string } | { type: "remote_image"; imageIndex: number }

export type ArticlePasteReview = {
  source: ArticlePasteSource
  sanitizedHtml: string
  segments: ArticlePasteSegment[]
  tables: ArticlePasteTableReview[]
  remoteImages: ArticlePasteRemoteImage[]
  listDepthExceeded: boolean
  requiresConfirmation: boolean
}

export type ArticlePasteReviewRequest = ArticlePasteReview & {
  from: number
  to: number
}

export type ArticlePasteRemoteImageInsertion = {
  imageIndex: number
  anchorNodeId: string
}

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "strike",
  "strong",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
])

const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "svg",
  "math",
])

const REMOTE_IMAGE_TOKEN_PREFIX = "\uE000ARTICLE_PASTE_IMAGE_"
const REMOTE_IMAGE_TOKEN_RE = /\uE000ARTICLE_PASTE_IMAGE_(\d+)\uE001/g

function articlePasteSource(
  html: string,
  body: HTMLElement
): ArticlePasteSource {
  if (
    /urn:schemas-microsoft-com:office:excel|mso-number-format|ProgId[^>]*Excel/i.test(
      html
    )
  ) {
    return "excel"
  }
  if (/docs-internal-guid-|googleusercontent\.com/i.test(html)) {
    return "google_docs"
  }
  if (
    /class=["'][^"']*Mso|urn:schemas-microsoft-com:office:word|WordDocument/i.test(
      html
    )
  ) {
    return "word"
  }
  return body.querySelector("img") ? "web" : "html"
}

function normalizedColor(value: string) {
  const probe = document.createElement("span")
  probe.style.color = value
  document.body.append(probe)
  const normalized = getComputedStyle(probe).color
  probe.remove()
  const match = normalized.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
  if (!match) return null
  return `#${match
    .slice(1)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`
}

function closestHighlightColor(value: string) {
  const normalized = normalizedColor(value)
  if (!normalized) return ARTICLE_HIGHLIGHT_COLORS[0]
  if ((ARTICLE_HIGHLIGHT_COLORS as readonly string[]).includes(normalized)) {
    return normalized
  }
  return ARTICLE_HIGHLIGHT_COLORS[0]
}

function safeLink(value: string) {
  const trimmed = value.trim()
  if (/^\/(?!\/)/.test(trimmed)) return trimmed
  try {
    const parsed = new URL(trimmed)
    if (!["http:", "https:"].includes(parsed.protocol)) return null
    if (parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function safeRemoteImage(value: string) {
  const safe = safeLink(value)
  if (!safe || safe.startsWith("/")) return null
  return safe
}

function replaceTag(element: Element, tag: string) {
  const replacement = element.ownerDocument.createElement(tag)
  while (element.firstChild) replacement.append(element.firstChild)
  element.replaceWith(replacement)
  return replacement
}

function replacePresentationalInline(element: Element, style: string) {
  const wrappers: Array<{ tag: string; attributes?: Record<string, string> }> =
    []
  const background = style.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1]
  if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)) {
    wrappers.push({ tag: "strong" })
  }
  if (/font-style\s*:\s*italic/i.test(style)) wrappers.push({ tag: "em" })
  const decoration = style.match(
    /text-decoration(?:-line)?\s*:\s*([^;]+)/i
  )?.[1]
  if (decoration?.includes("underline")) wrappers.push({ tag: "u" })
  if (decoration?.includes("line-through")) wrappers.push({ tag: "s" })
  if (background && element.textContent?.trim()) {
    wrappers.push({
      tag: "mark",
      attributes: { "data-color": closestHighlightColor(background) },
    })
  }
  if (!wrappers.length) {
    element.replaceWith(...Array.from(element.childNodes))
    return
  }
  let replacement = element.ownerDocument.createElement(wrappers[0].tag)
  for (const [name, value] of Object.entries(wrappers[0].attributes ?? {})) {
    replacement.setAttribute(name, value)
  }
  const root = replacement
  for (const wrapper of wrappers.slice(1)) {
    const child = element.ownerDocument.createElement(wrapper.tag)
    for (const [name, value] of Object.entries(wrapper.attributes ?? {})) {
      child.setAttribute(name, value)
    }
    replacement.append(child)
    replacement = child
  }
  replacement.append(...Array.from(element.childNodes))
  element.replaceWith(root)
}

function cleanElement(element: Element) {
  let current = element
  let tag = current.tagName.toLowerCase()
  if (tag === "h1") {
    current = replaceTag(current, "h2")
    tag = "h2"
  }
  if (/^h[2-6]$/.test(tag) && current.closest("td, th")) {
    current = replaceTag(current, "p")
    tag = "p"
  }
  if (tag === "font" || tag === "span" || tag === "div") {
    const style = current.getAttribute("style") || ""
    if (tag !== "div") replacePresentationalInline(current, style)
    else current.replaceWith(...Array.from(current.childNodes))
    return
  }
  if (!ALLOWED_TAGS.has(tag)) {
    current.replaceWith(...Array.from(current.childNodes))
    return
  }

  const original = new Map(
    Array.from(current.attributes).map((attribute) => [
      attribute.name.toLowerCase(),
      attribute.value,
    ])
  )
  for (const attribute of Array.from(current.attributes)) {
    current.removeAttribute(attribute.name)
  }

  if (tag === "a") {
    const href = safeLink(original.get("href") || "")
    if (!href) {
      current.replaceWith(...Array.from(current.childNodes))
      return
    }
    current.setAttribute("href", href)
    const title = original.get("title")?.trim()
    if (title) current.setAttribute("title", title.slice(0, 300))
    if (original.get("target") === "_blank") {
      current.setAttribute("target", "_blank")
      const rel = new Set(
        (original.get("rel") || "")
          .split(/\s+/)
          .filter((item) => ["nofollow", "sponsored", "ugc"].includes(item))
      )
      rel.add("noopener")
      rel.add("noreferrer")
      current.setAttribute("rel", [...rel].join(" "))
    }
  }
  if (tag === "ol") {
    const start = Number(original.get("start"))
    if (Number.isInteger(start) && start > 1 && start <= 1_000_000) {
      current.setAttribute("start", String(start))
    }
  }
  if (tag === "td" || tag === "th") {
    for (const name of ["colspan", "rowspan"]) {
      const value = Number(original.get(name))
      if (Number.isInteger(value) && value > 1 && value <= 100) {
        current.setAttribute(name, String(value))
      }
    }
    const style = original.get("style") || ""
    const textAlign = style.match(/text-align\s*:\s*(left|center|right)/i)?.[1]
    const verticalAlign = style.match(
      /vertical-align\s*:\s*(top|middle|bottom)/i
    )?.[1]
    const styles = [
      textAlign ? `text-align:${textAlign.toLowerCase()}` : null,
      verticalAlign ? `vertical-align:${verticalAlign.toLowerCase()}` : null,
    ].filter(Boolean)
    if (styles.length) current.setAttribute("style", styles.join(";"))
  }
  if (tag === "p" || /^h[2-6]$/.test(tag)) {
    const style = original.get("style") || ""
    const textAlign = style.match(/text-align\s*:\s*(left|center|right)/i)?.[1]
    if (textAlign) current.setAttribute("style", `text-align:${textAlign}`)
  }
  if (tag === "mark") {
    const style = original.get("style") || ""
    const rawColor =
      original.get("data-color") ||
      style.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1] ||
      ARTICLE_HIGHLIGHT_COLORS[0]
    current.setAttribute("data-color", closestHighlightColor(rawColor))
  }
}

function tableColumnCount(row: Element) {
  return Array.from(row.children).reduce((count, cell) => {
    if (!cell.matches("td, th")) return count
    const colspan = Number(cell.getAttribute("colspan"))
    return count + (Number.isInteger(colspan) && colspan > 0 ? colspan : 1)
  }, 0)
}

function limitTable(
  table: HTMLTableElement,
  index: number
): ArticlePasteTableReview {
  const rows = Array.from(table.querySelectorAll("tr"))
  const originalRows = rows.length
  const originalColumns = rows.reduce(
    (maximum, row) => Math.max(maximum, tableColumnCount(row)),
    0
  )
  rows.slice(ARTICLE_PASTE_TABLE_LIMITS.rows).forEach((row) => row.remove())
  const acceptedRows = Math.min(originalRows, ARTICLE_PASTE_TABLE_LIMITS.rows)

  for (const [rowIndex, row] of rows.slice(0, acceptedRows).entries()) {
    let occupiedColumns = 0
    for (const cell of Array.from(row.children)) {
      if (!cell.matches("td, th")) {
        cell.remove()
        continue
      }
      if (occupiedColumns >= ARTICLE_PASTE_TABLE_LIMITS.columns) {
        cell.remove()
        continue
      }
      const rawColspan = Number(cell.getAttribute("colspan"))
      const colspan =
        Number.isInteger(rawColspan) && rawColspan > 0 ? rawColspan : 1
      const acceptedColspan = Math.min(
        colspan,
        ARTICLE_PASTE_TABLE_LIMITS.columns - occupiedColumns
      )
      if (acceptedColspan === 1) cell.removeAttribute("colspan")
      else cell.setAttribute("colspan", String(acceptedColspan))
      const rawRowspan = Number(cell.getAttribute("rowspan"))
      const rowspan =
        Number.isInteger(rawRowspan) && rawRowspan > 0 ? rawRowspan : 1
      const acceptedRowspan = Math.min(rowspan, acceptedRows - rowIndex)
      if (acceptedRowspan === 1) cell.removeAttribute("rowspan")
      else cell.setAttribute("rowspan", String(acceptedRowspan))
      occupiedColumns += acceptedColspan
    }
  }

  const acceptedColumns = Math.min(
    originalColumns,
    ARTICLE_PASTE_TABLE_LIMITS.columns
  )
  return {
    index,
    originalRows,
    originalColumns,
    acceptedRows,
    acceptedColumns,
    clipped:
      originalRows > ARTICLE_PASTE_TABLE_LIMITS.rows ||
      originalColumns > ARTICLE_PASTE_TABLE_LIMITS.columns,
    preview: rows.slice(0, 3).map((row) =>
      Array.from(row.querySelectorAll(":scope > td, :scope > th"))
        .slice(0, 4)
        .map((cell) => cell.textContent?.trim() ?? "")
    ),
  }
}

function limitListDepth(body: HTMLElement) {
  let exceeded = false
  for (const list of Array.from(body.querySelectorAll("ul, ol")).reverse()) {
    let depth = 1
    let parent = list.parentElement
    while (parent) {
      if (parent.matches("ul, ol")) depth += 1
      parent = parent.parentElement
    }
    if (depth <= ARTICLE_PASTE_LIST_DEPTH_LIMIT) continue
    exceeded = true
    const fragment = list.ownerDocument.createDocumentFragment()
    for (const item of Array.from(list.querySelectorAll(":scope > li"))) {
      const paragraph = list.ownerDocument.createElement("p")
      paragraph.textContent = item.textContent
      if (paragraph.textContent?.trim()) fragment.append(paragraph)
    }
    list.replaceWith(fragment)
  }
  return exceeded
}

function extractRemoteImages(body: HTMLElement) {
  const images: ArticlePasteRemoteImage[] = []
  for (const image of Array.from(body.querySelectorAll("img"))) {
    const url = safeRemoteImage(image.getAttribute("src") ?? "")
    if (url) {
      images.push({
        url,
        alt: image.getAttribute("alt")?.trim().slice(0, 500) ?? "",
      })
      image.replaceWith(
        image.ownerDocument.createTextNode(
          `${REMOTE_IMAGE_TOKEN_PREFIX}${images.length - 1}\uE001`
        )
      )
      continue
    }
    image.remove()
  }
  return images
}

function serializeText(document: Document, value: string) {
  const wrapper = document.createElement("div")
  wrapper.textContent = value
  return wrapper.innerHTML
}

function splitPasteNode(node: ChildNode): ArticlePasteSegment[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const ownerDocument = node.ownerDocument
    if (!ownerDocument) return []
    const value = node.textContent ?? ""
    const segments: ArticlePasteSegment[] = []
    let offset = 0
    for (const match of value.matchAll(REMOTE_IMAGE_TOKEN_RE)) {
      if (match.index > offset) {
        segments.push({
          type: "html",
          html: serializeText(
            ownerDocument,
            value.slice(offset, match.index)
          ),
        })
      }
      segments.push({ type: "remote_image", imageIndex: Number(match[1]) })
      offset = match.index + match[0].length
    }
    if (offset < value.length) {
      segments.push({
        type: "html",
        html: serializeText(ownerDocument, value.slice(offset)),
      })
    }
    return segments.length
      ? segments
      : [{ type: "html", html: serializeText(ownerDocument, value) }]
  }
  if (!(node instanceof Element)) return []
  if (!node.childNodes.length) {
    return [{ type: "html", html: node.outerHTML }]
  }

  const result: ArticlePasteSegment[] = []
  let html = ""
  const flush = () => {
    if (!html) return
    const wrapper = node.cloneNode(false) as Element
    wrapper.innerHTML = html
    result.push({ type: "html", html: wrapper.outerHTML })
    html = ""
  }
  for (const child of Array.from(node.childNodes)) {
    for (const segment of splitPasteNode(child)) {
      if (segment.type === "html") {
        html += segment.html
      } else {
        flush()
        result.push(segment)
      }
    }
  }
  flush()
  return result
}

function pasteSegments(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const segments: ArticlePasteSegment[] = []
  for (const child of Array.from(parsed.body.childNodes)) {
    for (const segment of splitPasteNode(child)) {
      const previous = segments.at(-1)
      if (segment.type === "html" && previous?.type === "html") {
        previous.html += segment.html
      } else {
        segments.push(segment)
      }
    }
  }
  return segments.filter(
    (segment) => segment.type === "remote_image" || segment.html.length > 0
  )
}

export function reviewArticlePasteHtml(html: string): ArticlePasteReview {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const source = articlePasteSource(html, parsed.body)
  const remoteImages = extractRemoteImages(parsed.body)
  const tables = Array.from(parsed.body.querySelectorAll("table")).map(
    (table, index) => limitTable(table, index + 1)
  )
  const listDepthExceeded = limitListDepth(parsed.body)
  const sanitizedWithMarkers = sanitizeArticlePasteHtml(parsed.body.innerHTML)
  const segments = pasteSegments(sanitizedWithMarkers)
  const sanitizedHtml = segments
    .filter(
      (segment): segment is Extract<ArticlePasteSegment, { type: "html" }> =>
        segment.type === "html"
    )
    .map((segment) => segment.html)
    .join("")
  return {
    source,
    sanitizedHtml,
    segments,
    tables,
    remoteImages,
    listDepthExceeded,
    requiresConfirmation:
      remoteImages.length > 0 ||
      listDepthExceeded ||
      tables.some((table) => table.clipped),
  }
}

export function buildArticlePasteInsertion(
  review: Pick<ArticlePasteReview, "segments" | "remoteImages">,
  selectedImageIndexes: ReadonlySet<number>,
  createAnchorNodeId: () => string
) {
  const remoteImages: ArticlePasteRemoteImageInsertion[] = []
  const html = review.segments
    .map((segment) => {
      if (segment.type === "html") return segment.html
      if (
        !selectedImageIndexes.has(segment.imageIndex) ||
        !review.remoteImages[segment.imageIndex]
      ) {
        return ""
      }
      const anchorNodeId = createAnchorNodeId()
      remoteImages.push({ imageIndex: segment.imageIndex, anchorNodeId })
      return `<p data-node-id="${anchorNodeId}"></p>`
    })
    .join("")
  return { html, remoteImages }
}

export function sanitizeArticlePasteHtml(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html")
  for (const element of Array.from(parsed.body.querySelectorAll("*"))) {
    if (DROP_WITH_CONTENT.has(element.tagName.toLowerCase())) element.remove()
  }
  for (const element of Array.from(parsed.body.querySelectorAll("*"))) {
    if (element.isConnected) cleanElement(element)
  }
  return parsed.body.innerHTML
}
