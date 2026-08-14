import { Editor } from "@tiptap/core"
import { EditorContent } from "@tiptap/react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleDocument,
  ArticleDocumentCapabilities,
} from "@/api/articles"
import { ArticleEditor } from "@/features/content/article-editor"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"
import { ArticleEditorOperationLayer } from "@/features/content/article-editor-operation-layer"

vi.mock("@tiptap/extension-drag-handle-react", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

const emptyRect = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
}

Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => emptyRect
HTMLElement.prototype.getClientRects = () => [] as unknown as DOMRectList

afterEach(cleanup)

const capabilities: ArticleDocumentCapabilities = {
  schema_version: 2,
  writable: true,
  recovery_scope: "test-scope",
  nodes: ["paragraph", "heading", "table"],
  marks: ["bold", "italic", "underline", "strike", "link"],
  heading_levels: [2, 3, 4, 5, 6],
  asset_types: [],
  media_upload_enabled: false,
  can_manage_seo_advanced: false,
  limits: {},
}

const tableDocument: ArticleDocument = {
  type: "doc",
  schema_version: 2,
  content: [
    {
      type: "table",
      attrs: { node_id: "table-controlled" },
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [
                {
                  type: "paragraph",
                  attrs: { node_id: "table-heading" },
                  content: [{ type: "text", text: "Heading" }],
                },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { node_id: "table-value" },
                  content: [{ type: "text", text: "Value" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}

function editorWithTable() {
  return new Editor({
    extensions: articleEditorExtensions,
    content: "<table><tbody><tr><td>Cell</td></tr></tbody></table>",
  })
}

describe("article editor operation layer runtime", () => {
  it("does not update the table toolbar while the controlled editor is rendering", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

    function ControlledArticleEditor() {
      const [document, setDocument] = React.useState(tableDocument)
      return (
        <ArticleEditor
          projectId="project-controlled-table"
          articleId="article-controlled-table"
          document={document}
          capabilities={capabilities}
          readOnly={false}
          onChange={(next) => setDocument(next)}
        />
      )
    }

    render(<ControlledArticleEditor />)
    await screen.findByLabelText("文章正文编辑器")
    const editable = document.querySelector<HTMLElement>(".ProseMirror")
    if (!editable) throw new Error("ProseMirror editor was not mounted")

    fireEvent.paste(editable, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/plain" ? "Controlled table update" : "",
      },
    })
    await waitFor(() =>
      expect(editable.textContent).toContain("Controlled table update")
    )

    expect(
      consoleError.mock.calls.some((call) =>
        call.some((item) =>
          String(item).includes(
            "Cannot update a component (`ArticleTableToolbar`) while rendering a different component (`ForwardRef(ArticleEditor)`)"
          )
        )
      )
    ).toBe(false)
  })

  it("does not create a BubbleMenu option-update transaction loop", async () => {
    const editor = editorWithTable()
    const transactions = vi.fn()
    editor.on("transaction", transactions)

    render(
      <>
        <EditorContent editor={editor} />
        <ArticleEditorOperationLayer
          editor={editor}
          capabilities={capabilities}
          onOpenLink={vi.fn()}
          onMedia={vi.fn()}
          onEnhanced={vi.fn()}
        />
      </>
    )

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "打开表格操作" })).toBeTruthy()
    })
    transactions.mockClear()
    editor.view.dispatch(editor.state.tr.setMeta("runtime-test", true))
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    expect(transactions.mock.calls.length).toBeLessThanOrEqual(2)

    editor.destroy()
  })
})
