import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

const INVALID_OFFSET = "article_ai_edit_utf16_offset_invalid"

function assertUtf16Boundary(value: string, offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > value.length) {
    throw new Error(INVALID_OFFSET)
  }
  if (
    offset > 0 &&
    offset < value.length &&
    value.charCodeAt(offset - 1) >= 0xd800 &&
    value.charCodeAt(offset - 1) <= 0xdbff &&
    value.charCodeAt(offset) >= 0xdc00 &&
    value.charCodeAt(offset) <= 0xdfff
  ) {
    throw new Error(INVALID_OFFSET)
  }
}

function inlineLength(node: ProseMirrorNode) {
  if (node.isText) return node.text?.length ?? 0
  if (node.type.name === "hardBreak") return 1
  throw new Error("article_ai_edit_inline_node_unsupported")
}

export function textblockPlainText(node: ProseMirrorNode) {
  if (!node.isTextblock) throw new Error("article_ai_edit_anchor_invalid")
  let result = ""
  node.forEach((child) => {
    if (child.isText) {
      result += child.text ?? ""
    } else if (child.type.name === "hardBreak") {
      result += "\n"
    } else {
      throw new Error("article_ai_edit_inline_node_unsupported")
    }
  })
  return result
}

export function proseMirrorOffsetToPlainText(
  node: ProseMirrorNode,
  proseMirrorOffset: number
) {
  if (!node.isTextblock || !Number.isInteger(proseMirrorOffset)) {
    throw new Error(INVALID_OFFSET)
  }
  let proseMirrorCursor = 0
  let plainTextCursor = 0
  let result: number | null = proseMirrorOffset === 0 ? 0 : null

  node.forEach((child) => {
    if (result !== null) return
    const length = inlineLength(child)
    const end = proseMirrorCursor + child.nodeSize
    if (proseMirrorOffset <= end) {
      const localOffset = proseMirrorOffset - proseMirrorCursor
      if (child.isText) assertUtf16Boundary(child.text ?? "", localOffset)
      if (localOffset < 0 || localOffset > length)
        throw new Error(INVALID_OFFSET)
      result = plainTextCursor + localOffset
      return
    }
    proseMirrorCursor = end
    plainTextCursor += length
  })

  if (result === null && proseMirrorOffset === proseMirrorCursor) {
    result = plainTextCursor
  }
  if (result === null) throw new Error(INVALID_OFFSET)
  return result
}

export function plainTextOffsetToProseMirror(
  node: ProseMirrorNode,
  plainTextOffset: number
) {
  if (!node.isTextblock || !Number.isInteger(plainTextOffset)) {
    throw new Error(INVALID_OFFSET)
  }
  let proseMirrorCursor = 0
  let plainTextCursor = 0
  let result: number | null = plainTextOffset === 0 ? 0 : null

  node.forEach((child) => {
    if (result !== null) return
    const length = inlineLength(child)
    const end = plainTextCursor + length
    if (plainTextOffset <= end) {
      const localOffset = plainTextOffset - plainTextCursor
      if (child.isText) assertUtf16Boundary(child.text ?? "", localOffset)
      if (localOffset < 0 || localOffset > length)
        throw new Error(INVALID_OFFSET)
      result = proseMirrorCursor + localOffset
      return
    }
    plainTextCursor = end
    proseMirrorCursor += child.nodeSize
  })

  if (result === null && plainTextOffset === plainTextCursor) {
    result = proseMirrorCursor
  }
  if (result === null) throw new Error(INVALID_OFFSET)
  return result
}
