import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  ArticleDocument,
  ArticleDocumentCapabilities,
} from "@/api/articles"
import { ArticleEditor } from "@/features/content/article-editor"

vi.mock("@/features/content/article-editor-operation-layer", () => ({
  ArticleEditorOperationLayer: () => null,
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

const initialDocument: ArticleDocument = {
  type: "doc",
  schema_version: 2,
  content: [
    {
      type: "paragraph",
      attrs: { node_id: "blk_initial" },
      content: [{ type: "text", text: "Initial body" }],
    },
  ],
}

const capabilities: ArticleDocumentCapabilities = {
  schema_version: 2,
  writable: true,
  recovery_scope: "history-test",
  nodes: ["doc", "paragraph", "text"],
  marks: [],
  heading_levels: [2, 3, 4, 5, 6],
  asset_types: [],
  media_upload_enabled: false,
  can_manage_seo_advanced: false,
  limits: {},
}

function ControlledEditor() {
  const [document, setDocument] = React.useState(initialDocument)
  return (
    <ArticleEditor
      projectId="project-history"
      articleId="article-history"
      document={document}
      capabilities={capabilities}
      readOnly={false}
      onChange={(next) => setDocument(next)}
    />
  )
}

afterEach(cleanup)

describe("article editor controlled history", () => {
  it("preserves redo after the controlled parent echoes an editor update", async () => {
    render(<ControlledEditor />)
    await screen.findByLabelText("文章正文编辑器")
    const editable = document.querySelector<HTMLElement>(".ProseMirror")
    if (!editable) throw new Error("ProseMirror editor was not mounted")

    fireEvent.paste(editable, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/plain" ? "Undo redo acceptance" : "",
      },
    })
    await waitFor(() =>
      expect(editable.textContent).toContain("Undo redo acceptance")
    )

    fireEvent.click(screen.getByRole("button", { name: "撤销" }))
    await waitFor(() =>
      expect(editable.textContent).not.toContain("Undo redo acceptance")
    )

    const redo = screen.getByRole("button", { name: "重做" })
    await waitFor(() => expect(redo.hasAttribute("disabled")).toBe(false))
    fireEvent.click(redo)
    await waitFor(() =>
      expect(editable.textContent).toContain("Undo redo acceptance")
    )
  })
})
