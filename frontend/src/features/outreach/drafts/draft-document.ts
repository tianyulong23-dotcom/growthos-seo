import type {
  DraftBlockNode,
  DraftDocument,
  DraftHardBreakNode,
  DraftListItemNode,
  DraftParagraphNode,
  DraftTextMark,
  DraftTextNode,
} from "@/features/outreach/drafts/types"

const MAX_CHARACTERS = 50_000
const MAX_NODES = 20_000
const MAX_DEPTH = 12

export const emptyDraftDocument: DraftDocument = {
  type: "doc",
  content: [{ type: "paragraph" }],
}

type InspectionState = {
  characters: number
  nodes: number
  depth: number
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields.`)
  }
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`)
  }
  return value
}

function normalizeHref(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("Draft links require a valid URL.")
  }
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported protocol.")
    }
    return value
  } catch {
    throw new Error("Draft links must use an absolute HTTP or HTTPS URL.")
  }
}

function normalizeMark(value: unknown): DraftTextMark {
  const mark = asRecord(value, "Draft mark")
  if (mark.type === "bold" || mark.type === "italic") {
    assertKeys(mark, ["type"], "Draft mark")
    return { type: mark.type }
  }
  if (mark.type === "link") {
    assertKeys(mark, ["type", "attrs"], "Draft link mark")
    const attrs = asRecord(mark.attrs, "Draft link attributes")
    assertKeys(
      attrs,
      ["href", "target", "rel", "class", "title"],
      "Draft link attributes"
    )
    return { type: "link", attrs: { href: normalizeHref(attrs.href) } }
  }
  throw new Error("Draft mark is not approved.")
}

function normalizeInlineNode(
  value: unknown,
  state: InspectionState
): DraftTextNode | DraftHardBreakNode {
  const node = asRecord(value, "Draft inline node")
  state.nodes += 1
  if (node.type === "hardBreak") {
    assertKeys(node, ["type"], "Draft hard break")
    return { type: "hardBreak" }
  }
  if (node.type !== "text") {
    throw new Error("Draft inline node is not approved.")
  }
  assertKeys(node, ["type", "text", "marks"], "Draft text node")
  if (
    typeof node.text !== "string" ||
    node.text.length === 0 ||
    node.text.length > MAX_CHARACTERS
  ) {
    throw new Error("Draft text node is invalid.")
  }
  state.characters += node.text.length
  const result: DraftTextNode = { type: "text", text: node.text }
  if (node.marks !== undefined) {
    const marks = asArray(node.marks, "Draft marks").map(normalizeMark)
    if (
      marks.length > 3 ||
      new Set(marks.map((mark) => mark.type)).size !== marks.length
    ) {
      throw new Error("Draft marks are invalid.")
    }
    if (marks.length > 0) result.marks = marks
  }
  return result
}

function normalizeParagraph(
  node: Record<string, unknown>,
  state: InspectionState
): DraftParagraphNode {
  assertKeys(node, ["type", "content"], "Draft paragraph")
  const result: DraftParagraphNode = { type: "paragraph" }
  if (node.content !== undefined) {
    const content = asArray(node.content, "Draft paragraph content")
    if (content.length > 10_000) {
      throw new Error("Draft paragraph contains too many nodes.")
    }
    const normalized = content.map((item) => normalizeInlineNode(item, state))
    if (normalized.length > 0) result.content = normalized
  }
  return result
}

function normalizeListItem(
  value: unknown,
  state: InspectionState,
  depth: number
): DraftListItemNode {
  const item = asRecord(value, "Draft list item")
  assertKeys(item, ["type", "content"], "Draft list item")
  if (item.type !== "listItem") {
    throw new Error("Draft list item is invalid.")
  }
  state.nodes += 1
  const content = asArray(item.content, "Draft list item content")
  if (content.length === 0 || content.length > 1_000) {
    throw new Error("Draft list item content is invalid.")
  }
  const normalized = content.map((child) =>
    normalizeBlockNode(child, state, depth + 1)
  )
  if (normalized[0]?.type !== "paragraph") {
    throw new Error("Draft list items must start with a paragraph.")
  }
  return { type: "listItem", content: normalized }
}

function normalizeBlockNode(
  value: unknown,
  state: InspectionState,
  depth: number
): DraftBlockNode {
  if (depth > MAX_DEPTH) {
    throw new Error("Draft document nesting is too deep.")
  }
  state.nodes += 1
  state.depth = Math.max(state.depth, depth)
  const node = asRecord(value, "Draft block node")
  if (node.type === "paragraph") {
    return normalizeParagraph(node, state)
  }
  if (node.type !== "bulletList" && node.type !== "orderedList") {
    throw new Error("Draft block node is not approved.")
  }
  assertKeys(
    node,
    node.type === "orderedList"
      ? ["type", "attrs", "content"]
      : ["type", "content"],
    "Draft list"
  )
  const content = asArray(node.content, "Draft list content")
  if (content.length === 0 || content.length > 1_000) {
    throw new Error("Draft list content is invalid.")
  }
  const items = content.map((item) => normalizeListItem(item, state, depth + 1))
  if (node.type === "bulletList") {
    return { type: "bulletList", content: items }
  }
  const attrs =
    node.attrs === undefined
      ? undefined
      : asRecord(node.attrs, "Draft ordered-list attributes")
  if (attrs !== undefined) {
    assertKeys(attrs, ["start"], "Draft ordered-list attributes")
  }
  const start = attrs?.start
  if (
    start !== undefined &&
    (!Number.isInteger(start) || Number(start) < 1 || Number(start) > 1_000_000)
  ) {
    throw new Error("Draft ordered-list start is invalid.")
  }
  return {
    type: "orderedList",
    ...(start === undefined ? {} : { attrs: { start: Number(start) } }),
    content: items,
  }
}

export function normalizeDraftDocument(
  value: unknown,
  options: Readonly<{ allowEmpty?: boolean }> = {}
): DraftDocument {
  const document = asRecord(value, "Draft document")
  assertKeys(document, ["type", "content"], "Draft document")
  if (document.type !== "doc") {
    throw new Error("Draft document root must be a doc.")
  }
  const content = asArray(document.content, "Draft document content")
  if (content.length === 0 || content.length > 10_000) {
    throw new Error("Draft document content is invalid.")
  }
  const state: InspectionState = { characters: 0, nodes: 1, depth: 1 }
  const normalized = content.map((node) => normalizeBlockNode(node, state, 2))
  if (state.nodes > MAX_NODES) {
    throw new Error("Draft document contains too many nodes.")
  }
  if (!options.allowEmpty && state.characters < 1) {
    throw new Error("Draft body cannot be empty.")
  }
  if (state.characters > MAX_CHARACTERS) {
    throw new Error("Draft body exceeds 50000 characters.")
  }
  return { type: "doc", content: normalized }
}

export function isSafeHttpUrl(value: string): boolean {
  try {
    normalizeHref(value)
    return true
  } catch {
    return false
  }
}
