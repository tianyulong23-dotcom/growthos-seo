import { Editor } from "@tiptap/core"
import { describe, expect, it } from "vitest"

import type { ArticleDocument } from "@/api/articles"
import {
  articleDocumentToEditorJson,
  canonicalizeArticleDocument,
  editorJsonToArticleDocument,
} from "@/features/content/article-document"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"

const MAX_BENCHMARK_MS = 5_000

function benchmark(document: ArticleDocument) {
  const started = performance.now()
  const editor = new Editor({
    extensions: articleEditorExtensions,
    content: articleDocumentToEditorJson(document),
  })
  const exported = editorJsonToArticleDocument(editor.getJSON())
  const elapsed = performance.now() - started
  editor.destroy()
  expect(exported).toEqual(canonicalizeArticleDocument(document))
  expect(elapsed).toBeLessThan(MAX_BENCHMARK_MS)
}

describe("article editor foundation performance", () => {
  it("loads and exports a 50k-character, 200-block article", () => {
    const paragraph = "文章性能基准正文 ".repeat(28)
    const document = {
      type: "doc",
      schema_version: 2,
      content: Array.from({ length: 200 }, (_, index) => ({
        type: "paragraph",
        attrs: { node_id: `paragraph-${index}` },
        content: [{ type: "text", text: paragraph }],
      })),
    } satisfies ArticleDocument

    expect(paragraph.length * document.content.length).toBeGreaterThanOrEqual(
      50_000
    )
    benchmark(document)
  })

  it("loads and exports 50 immutable image references", () => {
    const document = {
      type: "doc",
      schema_version: 2,
      content: Array.from({ length: 50 }, (_, index) => ({
        type: "image",
        attrs: {
          node_id: `image-${index}`,
          asset_id: `asset-${index}`,
          alt: `Image ${index}`,
          display: "regular",
        },
      })),
    } satisfies ArticleDocument

    benchmark(document)
  })

  it("loads and exports a 20 by 20 table", () => {
    const document = {
      type: "doc",
      schema_version: 2,
      content: [
        {
          type: "table",
          attrs: { node_id: "table-20x20" },
          content: Array.from({ length: 20 }, (_, row) => ({
            type: "tableRow",
            content: Array.from({ length: 20 }, (_, column) => ({
              type: row === 0 ? "tableHeader" : "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { node_id: `cell-${row}-${column}` },
                  content: [{ type: "text", text: `${row}:${column}` }],
                },
              ],
            })),
          })),
        },
      ],
    } satisfies ArticleDocument

    benchmark(document)
  })
})
