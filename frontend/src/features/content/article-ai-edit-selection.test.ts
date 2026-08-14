import { Editor } from "@tiptap/core"
import { describe, expect, it } from "vitest"

import {
  plainTextOffsetToProseMirror,
  proseMirrorOffsetToPlainText,
  textblockPlainText,
} from "@/features/content/article-ai-edit-selection"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"

function mixedInlineEditor() {
  return new Editor({
    extensions: articleEditorExtensions,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "mixed-inline" },
          content: [
            {
              type: "text",
              text: "A😀",
              marks: [{ type: "bold" }],
            },
            { type: "text", text: "B" },
            { type: "hardBreak" },
            {
              type: "text",
              text: "C",
              marks: [{ type: "italic" }],
            },
          ],
        },
      ],
    },
  })
}

describe("article AI edit selection offsets", () => {
  it("maps marks, emoji, and hard breaks to the backend UTF-16 contract", () => {
    const editor = mixedInlineEditor()
    const paragraph = editor.state.doc.firstChild
    expect(paragraph).not.toBeNull()

    expect(textblockPlainText(paragraph!)).toBe("A😀B\nC")
    for (const offset of [0, 1, 3, 4, 5, 6]) {
      expect(proseMirrorOffsetToPlainText(paragraph!, offset)).toBe(offset)
      expect(plainTextOffsetToProseMirror(paragraph!, offset)).toBe(offset)
    }

    editor.destroy()
  })

  it("rejects offsets inside a UTF-16 surrogate pair", () => {
    const editor = mixedInlineEditor()
    const paragraph = editor.state.doc.firstChild
    expect(paragraph).not.toBeNull()

    expect(() => proseMirrorOffsetToPlainText(paragraph!, 2)).toThrow(
      "article_ai_edit_utf16_offset_invalid"
    )
    expect(() => plainTextOffsetToProseMirror(paragraph!, 2)).toThrow(
      "article_ai_edit_utf16_offset_invalid"
    )

    editor.destroy()
  })
})
