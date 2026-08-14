import { Editor } from "@tiptap/core"
import { EditorContent } from "@tiptap/react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { articleEditorExtensions } from "@/features/content/article-editor-extensions"
import type { ArticleDocumentCapabilities } from "@/api/articles"
import {
  ArticleEditorOperationLayer,
  ArticleTableToolbar,
} from "@/features/content/article-editor-operation-layer"

const capturedTableBubbleMenu = vi.hoisted(() => ({
  getReferencedVirtualElement: undefined as
    | (() => { getBoundingClientRect: () => DOMRect } | null)
    | undefined,
}))

vi.mock("@tiptap/extension-drag-handle-react", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({
    children,
    pluginKey,
    getReferencedVirtualElement,
  }: {
    children: React.ReactNode
    pluginKey?: string
    getReferencedVirtualElement?: () => {
      getBoundingClientRect: () => DOMRect
    } | null
  }) => {
    if (pluginKey === "articleTableToolbar") {
      capturedTableBubbleMenu.getReferencedVirtualElement =
        getReferencedVirtualElement
    }
    return <div>{children}</div>
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

function editorWithTableAndParagraph() {
  return new Editor({
    extensions: articleEditorExtensions,
    content: `
      <table>
        <thead><tr><th>Head A</th><th>Head B</th></tr></thead>
        <tbody>
          <tr><td>Row 1 A</td><td>Row 1 B</td></tr>
          <tr><td>Row 2 A</td><td>Row 2 B</td></tr>
        </tbody>
      </table>
      <p>After table</p>
    `,
  })
}

function textPosition(editor: Editor, value: string) {
  let result: number | null = null
  editor.state.doc.descendants((node, position) => {
    if (result === null && node.isText && node.text?.includes(value)) {
      result = position + node.text.indexOf(value)
    }
  })
  if (result === null) throw new Error(`Text not found: ${value}`)
  return result
}

function selectText(editor: Editor, value: string) {
  editor.commands.setTextSelection(textPosition(editor, value))
}

function renderToolbar(editor: Editor) {
  return render(
    <>
      <EditorContent editor={editor} />
      <ArticleTableToolbar editor={editor} />
    </>
  )
}

function openMobileToolbar() {
  const trigger = screen.getByRole("button", { name: "打开表格操作" })
  fireEvent.click(trigger)
  return trigger
}

describe("article table mobile toolbar", () => {
  it("positions the desktop toolbar against the whole table", () => {
    const editor = editorWithTableAndParagraph()
    selectText(editor, "Row 1 A")
    const { container } = renderToolbar(editor)
    const table = container.querySelector("table")

    expect(table).toBeTruthy()
    expect(capturedTableBubbleMenu.getReferencedVirtualElement?.()).toBe(table)

    editor.destroy()
  })

  it("opens the desktop row action menu", async () => {
    const editor = editorWithTableAndParagraph()
    selectText(editor, "Row 1 A")
    renderToolbar(editor)

    fireEvent.click(screen.getByRole("button", { name: /^行$/ }))

    expect(
      await screen.findByRole("menuitem", { name: "下方添加行" })
    ).toBeTruthy()

    editor.destroy()
  })

  it("mounts the complete operation layer without recursively dispatching transactions", async () => {
    const editor = editorWithTableAndParagraph()
    selectText(editor, "Row 1 A")
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
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(transactions).not.toHaveBeenCalled()

    editor.commands.setTextSelection(textPosition(editor, "Row 2 A"))
    await new Promise((resolve) => window.setTimeout(resolve, 20))
    expect(transactions).toHaveBeenCalledTimes(1)

    editor.destroy()
  })

  it("opens a non-overflowing bottom sheet with real command states", async () => {
    const editor = editorWithTableAndParagraph()
    selectText(editor, "Row 2 A")
    renderToolbar(editor)

    openMobileToolbar()

    const sheet = await screen.findByRole("dialog", { name: "表格操作" })
    expect(sheet.dataset.side).toBe("bottom")
    expect(sheet.className).toContain("max-w-full")
    expect(sheet.className).toContain("overflow-x-hidden")

    const moveDown = screen.getByRole("button", {
      name: "向下移动当前行",
    })
    const addBelow = screen.getByRole("button", { name: "下方添加行" })
    expect((moveDown as HTMLButtonElement).disabled).toBe(true)
    expect((addBelow as HTMLButtonElement).disabled).toBe(false)

    const actionGrid = addBelow.parentElement
    expect(actionGrid?.className).toContain("grid-cols-1")
    expect(actionGrid?.className).toContain("min-[360px]:grid-cols-2")
    expect(addBelow.className).toContain("whitespace-normal")

    editor.destroy()
  })

  it("closes with Escape and restores focus to the trigger", async () => {
    const editor = editorWithTableAndParagraph()
    selectText(editor, "Row 1 A")
    renderToolbar(editor)
    const trigger = openMobileToolbar()
    const sheet = await screen.findByRole("dialog", { name: "表格操作" })

    fireEvent.keyDown(sheet, { key: "Escape" })

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "表格操作" })).toBeNull()
    })
    expect(document.activeElement).toBe(trigger)

    editor.destroy()
  })

  it("keeps enabled actions keyboard-focusable and refreshes state after execution", async () => {
    const editor = editorWithTableAndParagraph()
    selectText(editor, "Row 1 A")
    renderToolbar(editor)
    openMobileToolbar()
    await screen.findByRole("dialog", { name: "表格操作" })

    const moveDown = screen.getByRole("button", {
      name: "向下移动当前行",
    })
    expect((moveDown as HTMLButtonElement).disabled).toBe(false)
    moveDown.focus()
    expect(document.activeElement).toBe(moveDown)
    fireEvent.click(moveDown)

    await waitFor(() =>
      expect((moveDown as HTMLButtonElement).disabled).toBe(true)
    )
    expect(editor.getText().indexOf("Row 2 A")).toBeLessThan(
      editor.getText().indexOf("Row 1 A")
    )

    editor.destroy()
  })

  it("closes when selection leaves the table and returns focus to the editor", async () => {
    const editor = editorWithTableAndParagraph()
    selectText(editor, "Row 1 A")
    renderToolbar(editor)
    openMobileToolbar()
    await screen.findByRole("dialog", { name: "表格操作" })

    selectText(editor, "After table")

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "表格操作" })).toBeNull()
      expect(
        screen.queryByRole("button", { name: "打开表格操作" })
      ).toBeNull()
    })
    expect(document.activeElement).toBe(editor.view.dom)

    editor.destroy()
  })
})
