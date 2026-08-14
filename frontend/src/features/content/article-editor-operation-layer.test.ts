import { Editor, type JSONContent } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { CellSelection, TableMap, selectedRect } from "@tiptap/pm/tables"
import { describe, expect, it, vi } from "vitest"

import { executeArticleEditorCommand } from "@/features/content/article-editor-commands"
import { editorJsonToArticleDocument } from "@/features/content/article-document"
import { articleEditorExtensions } from "@/features/content/article-editor-extensions"
import {
  articleEditorMenuPosition,
  canOpenArticleSlashMenu,
  canMoveArticleTableColumn,
  canMoveArticleTableRow,
  deleteArticleTopLevelBlock,
  duplicateArticleTopLevelBlock,
  duplicateCurrentArticleTable,
  insertArticleTable,
  moveArticleTableColumn,
  moveArticleTableRow,
  moveArticleTopLevelBlock,
  normalizeArticleTableSize,
  selectCurrentArticleTable,
  slashCommandQuery,
} from "@/features/content/article-editor-operations"

function editorWithParagraphs() {
  return new Editor({
    extensions: articleEditorExtensions,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { node_id: "first" },
          content: [{ type: "text", text: "First" }],
        },
        {
          type: "paragraph",
          attrs: { node_id: "second" },
          content: [{ type: "text", text: "Second" }],
        },
      ],
    },
  })
}

function editorWithTable() {
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
    `,
  })
}

function tableRows(editor: Editor) {
  const table = (editor.getJSON() as JSONContent).content?.find(
    (node) => node.type === "table"
  )
  return (table?.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .flatMap((paragraph) => paragraph.content ?? [])
        .map((text) => text.text ?? "")
        .join("")
    )
  )
}

function currentTable(editor: Editor) {
  let result: { node: ProseMirrorNode; start: number } | undefined
  editor.state.doc.descendants((node, position) => {
    if (!result && node.type.name === "table") {
      result = { node, start: position + 1 }
      return false
    }
  })
  if (!result) throw new Error("Table not found")
  return result as { node: ProseMirrorNode; start: number }
}

function selectTableRect(
  editor: Editor,
  top: number,
  left: number,
  bottom: number,
  right: number
) {
  const table = currentTable(editor)
  const map = TableMap.get(table.node)
  editor.view.dispatch(
    editor.state.tr.setSelection(
      CellSelection.create(
        editor.state.doc,
        table.start + map.map[top * map.width + left],
        table.start + map.map[(bottom - 1) * map.width + right - 1]
      )
    )
  )
}

function ensureDeterministicNodeIds(editor: Editor) {
  let transaction = editor.state.tr
  let index = 0
  editor.state.doc.descendants((node, position) => {
    if (!("node_id" in node.attrs) || node.attrs.node_id) return
    transaction = transaction.setNodeMarkup(position, undefined, {
      ...node.attrs,
      node_id: `test-node-${index++}`,
    })
  })
  if (transaction.docChanged) {
    editor.view.dispatch(transaction.setMeta("addToHistory", false))
  }
}

function articleNodeIds(editor: Editor) {
  const nodeIds: string[] = []
  editor.state.doc.descendants((node) => {
    if (typeof node.attrs.node_id === "string" && node.attrs.node_id) {
      nodeIds.push(node.attrs.node_id)
    }
  })
  return nodeIds
}

function expectUniqueArticleNodeIds(editor: Editor) {
  const nodeIds = articleNodeIds(editor)
  expect(new Set(nodeIds).size).toBe(nodeIds.length)
}

function expectSingleUpdateAndUndo(
  editor: Editor,
  run: () => boolean,
  assertAfter?: () => void
) {
  ensureDeterministicNodeIds(editor)
  const before = editor.getJSON()
  const onUpdate = vi.fn()
  editor.on("update", onUpdate)
  expect(run()).toBe(true)
  expect(onUpdate).toHaveBeenCalledTimes(1)
  assertAfter?.()
  expect(editor.commands.undo()).toBe(true)
  expect(editor.getJSON()).toEqual(before)
  editor.off("update", onUpdate)
}

function editorWithBodyTable() {
  return new Editor({
    extensions: articleEditorExtensions,
    content: `
      <table>
        <tbody>
          <tr><td>A1</td><td>B1</td><td>C1</td></tr>
          <tr><td>A2</td><td>B2</td><td>C2</td></tr>
          <tr><td>A3</td><td>B3</td><td>C3</td></tr>
        </tbody>
      </table>
    `,
  })
}

function selectText(editor: Editor, value: string) {
  let position: number | null = null
  editor.state.doc.descendants((node, offset) => {
    if (position === null && node.isText && node.text?.includes(value)) {
      position = offset + node.text.indexOf(value)
    }
  })
  if (position === null) throw new Error(`Text not found: ${value}`)
  editor.commands.setTextSelection(position)
}

describe("article editor operation layer", () => {
  it("keeps command menus inside the viewport", () => {
    expect(articleEditorMenuPosition(-50, -20, 1024, 768)).toEqual({
      left: 8,
      top: 8,
    })
    expect(articleEditorMenuPosition(1000, 760, 1024, 768)).toEqual({
      left: 696,
      top: 428,
    })
    expect(articleEditorMenuPosition(50, 50, 240, 200)).toEqual({
      left: 8,
      top: 8,
    })
  })

  it("does not open Slash commands during Chinese IME composition", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<p></p>",
    })
    editor.commands.setTextSelection(1)
    expect(
      canOpenArticleSlashMenu(editor, { key: "/", isComposing: true })
    ).toBe(false)
    expect(
      canOpenArticleSlashMenu(editor, { key: "/", isComposing: false })
    ).toBe(true)
    editor.destroy()
  })

  it("reads a compact slash query and rejects whitespace", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<p>/tab</p>",
    })
    editor.commands.setTextSelection(5)
    expect(slashCommandQuery(editor, 1)).toEqual({ query: "tab", to: 5 })
    editor.commands.insertContent(" le")
    expect(slashCommandQuery(editor, 1)).toBeNull()
    editor.destroy()
  })

  it("moves a top-level block in one transaction while preserving its ID", () => {
    const editor = editorWithParagraphs()
    const updates = vi.fn()
    editor.on("update", updates)

    expect(moveArticleTopLevelBlock(editor, 0, 1)).toBe(true)
    expect(
      editor.getJSON().content?.map((node) => node.attrs?.node_id)
    ).toEqual(["second", "first"])
    expect(updates).toHaveBeenCalledOnce()
    expect(editor.commands.undo()).toBe(true)
    expect(
      editor.getJSON().content?.map((node) => node.attrs?.node_id)
    ).toEqual(["first", "second"])
    editor.destroy()
  })

  it("duplicates a block with fresh IDs and keeps the original unchanged", () => {
    const editor = editorWithParagraphs()
    expect(duplicateArticleTopLevelBlock(editor, 0)).toBe(true)
    const content = (editor.getJSON() as JSONContent).content ?? []
    expect(
      content.map((node) => node.content?.map((child) => child.text).join(""))
    ).toEqual(["First", "First", "Second"])
    expect(content[0].attrs?.node_id).toBe("first")
    expect(content[1].attrs?.node_id).toMatch(/^blk_/)
    expect(content[1].attrs?.node_id).not.toBe("first")
    editor.destroy()
  })

  it("deletes the only top-level block while preserving a valid empty document", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<p>Only</p>",
    })
    expect(deleteArticleTopLevelBlock(editor, 0)).toBe(true)
    expect(editor.getJSON()).toMatchObject({
      type: "doc",
      content: [{ type: "paragraph" }],
    })
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe("Only")
    editor.destroy()
  })

  it("inserts a configured table from slash in one undo step", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<p>/table</p>",
    })
    editor.commands.setTextSelection(7)
    expect(
      insertArticleTable(
        editor,
        { mode: "slash", from: 1, to: 7 },
        { rows: 2, columns: 4, withHeaderRow: false }
      )
    ).toBe(true)
    expect(tableRows(editor)).toEqual([
      ["", "", "", ""],
      ["", "", "", ""],
    ])
    expect(
      (editor.getJSON() as JSONContent).content?.[0].content?.[0].content?.map(
        (cell) => cell.type
      )
    ).toEqual(["tableCell", "tableCell", "tableCell", "tableCell"])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).toBe("/table")
    editor.destroy()
  })

  it("inserts a table from the Plus menu without adding an extra paragraph", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: "<p>Before</p><p>After</p>",
    })
    const secondParagraphPosition = editor.state.doc.child(0).nodeSize
    expect(
      insertArticleTable(
        editor,
        { mode: "plus", position: secondParagraphPosition },
        { rows: 2, columns: 2, withHeaderRow: true }
      )
    ).toBe(true)
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON().content?.map((node) => node.type)).toEqual([
      "paragraph",
      "paragraph",
    ])
    editor.destroy()
  })

  it("clears marks and block formatting in one undo step", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [
              {
                type: "text",
                text: "Formatted",
                marks: [
                  { type: "bold" },
                  { type: "underline" },
                  { type: "highlight", attrs: { color: "#fef3c7" } },
                ],
              },
            ],
          },
        ],
      },
    })
    editor.commands.setTextSelection({ from: 1, to: 10 })
    expect(editor.chain().focus().unsetAllMarks().clearNodes().run()).toBe(true)
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "Formatted" }],
    })
    expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined()
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "heading",
      attrs: { level: 2 },
      content: [
        {
          type: "text",
          marks: [
            { type: "bold" },
            { type: "underline" },
            { type: "highlight", attrs: { color: "#fef3c7" } },
          ],
        },
      ],
    })
    editor.destroy()
  })

  it("clamps table dimensions to the supported 1-10 range", () => {
    expect(normalizeArticleTableSize(Number.NaN)).toBe(1)
    expect(normalizeArticleTableSize(0)).toBe(1)
    expect(normalizeArticleTableSize(4.8)).toBe(4)
    expect(normalizeArticleTableSize(99)).toBe(10)
  })

  it("moves body rows without allowing the header row to be displaced", () => {
    const editor = editorWithTable()
    selectText(editor, "Row 1 A")
    expect(canMoveArticleTableRow(editor, -1)).toBe(false)
    expect(canMoveArticleTableRow(editor, 1)).toBe(true)
    expect(moveArticleTableRow(editor, 1)).toBe(true)
    expect(tableRows(editor)).toEqual([
      ["Head A", "Head B"],
      ["Row 2 A", "Row 2 B"],
      ["Row 1 A", "Row 1 B"],
    ])
    expect(editor.commands.undo()).toBe(true)
    expect(tableRows(editor)[1]).toEqual(["Row 1 A", "Row 1 B"])
    editor.destroy()
  })

  it("moves a rectangular row selection as one transaction and preserves it", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: `
        <table>
          <tbody>
            <tr><td>Row 1 A</td><td>Row 1 B</td></tr>
            <tr><td>Row 2 A</td><td>Row 2 B</td></tr>
            <tr><td>Row 3 A</td><td>Row 3 B</td></tr>
            <tr><td>Row 4 A</td><td>Row 4 B</td></tr>
          </tbody>
        </table>
      `,
    })
    selectTableRect(editor, 1, 0, 3, 2)
    expect(canMoveArticleTableRow(editor, -1)).toBe(true)
    expectSingleUpdateAndUndo(editor, () => moveArticleTableRow(editor, -1))

    selectTableRect(editor, 1, 0, 3, 2)
    expectSingleUpdateAndUndo(editor, () => moveArticleTableRow(editor, 1))
    editor.destroy()
  })

  it("moves multiple body rows while keeping the first header row fixed", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: `
        <table>
          <thead><tr><th>Head A</th><th>Head B</th></tr></thead>
          <tbody>
            <tr><td>Row 1 A</td><td>Row 1 B</td></tr>
            <tr><td>Row 2 A</td><td>Row 2 B</td></tr>
            <tr><td>Row 3 A</td><td>Row 3 B</td></tr>
          </tbody>
        </table>
      `,
    })
    selectTableRect(editor, 1, 0, 3, 2)
    expect(canMoveArticleTableRow(editor, -1)).toBe(false)
    expect(canMoveArticleTableRow(editor, 1)).toBe(true)
    expect(moveArticleTableRow(editor, 1)).toBe(true)
    expect(tableRows(editor)).toEqual([
      ["Head A", "Head B"],
      ["Row 3 A", "Row 3 B"],
      ["Row 1 A", "Row 1 B"],
      ["Row 2 A", "Row 2 B"],
    ])
    expect(selectedRect(editor.state)).toMatchObject({
      top: 2,
      bottom: 4,
      left: 0,
      right: 2,
    })
    expect(editor.commands.undo()).toBe(true)
    expect(tableRows(editor)[1]).toEqual(["Row 1 A", "Row 1 B"])
    editor.destroy()
  })

  it("moves columns, selects the table, and duplicates it with fresh IDs", () => {
    const editor = editorWithTable()
    selectText(editor, "Row 1 A")
    expect(canMoveArticleTableColumn(editor, -1)).toBe(false)
    expect(moveArticleTableColumn(editor, 1)).toBe(true)
    expect(tableRows(editor)[0]).toEqual(["Head B", "Head A"])
    expect(editor.commands.undo()).toBe(true)
    expect(selectCurrentArticleTable(editor)).toBe(true)
    expect(editor.state.selection.constructor.name).toBe("CellSelection")
    expect(duplicateCurrentArticleTable(editor)).toBe(true)
    const tables = editor
      .getJSON()
      .content?.filter((node) => node.type === "table")
    expect(tables).toHaveLength(2)
    expect(tables?.[0].attrs?.node_id).not.toBe(tables?.[1].attrs?.node_id)
    editor.destroy()
  })

  it("moves a rectangular column selection in one undo step", () => {
    const editor = new Editor({
      extensions: articleEditorExtensions,
      content: `
        <table>
          <tbody>
            <tr><td>A1</td><td>B1</td><td>C1</td><td>D1</td></tr>
            <tr><td>A2</td><td>B2</td><td>C2</td><td>D2</td></tr>
          </tbody>
        </table>
      `,
    })
    selectTableRect(editor, 0, 1, 2, 3)
    expect(canMoveArticleTableColumn(editor, -1)).toBe(true)
    expect(moveArticleTableColumn(editor, -1)).toBe(true)
    expect(tableRows(editor)).toEqual([
      ["B1", "C1", "A1", "D1"],
      ["B2", "C2", "A2", "D2"],
    ])
    expect(selectedRect(editor.state)).toMatchObject({
      top: 0,
      bottom: 2,
      left: 0,
      right: 2,
    })
    expect(editor.commands.undo()).toBe(true)
    expect(tableRows(editor)[0]).toEqual(["A1", "B1", "C1", "D1"])

    selectTableRect(editor, 0, 1, 2, 3)
    expectSingleUpdateAndUndo(editor, () => moveArticleTableColumn(editor, 1))
    editor.destroy()
  })

  it("adds and deletes rows through one update and one undo step", () => {
    const cases = [
      {
        run: (editor: Editor) => editor.chain().focus().addRowBefore().run(),
        expected: ["A1", "", "A2", "A3"],
      },
      {
        run: (editor: Editor) => editor.chain().focus().addRowAfter().run(),
        expected: ["A1", "A2", "", "A3"],
      },
      {
        run: (editor: Editor) => editor.chain().focus().deleteRow().run(),
        expected: ["A1", "A3"],
      },
    ]
    for (const testCase of cases) {
      const editor = editorWithBodyTable()
      selectText(editor, "B2")
      expectSingleUpdateAndUndo(editor, () => testCase.run(editor), () => {
        expect(tableRows(editor).map((row) => row[0])).toEqual(
          testCase.expected
        )
        expectUniqueArticleNodeIds(editor)
      })
      editor.destroy()
    }
  })

  it("adds and deletes columns through one update and one undo step", () => {
    const cases = [
      {
        run: (editor: Editor) =>
          editor.chain().focus().addColumnBefore().run(),
        expected: ["A2", "", "B2", "C2"],
      },
      {
        run: (editor: Editor) => editor.chain().focus().addColumnAfter().run(),
        expected: ["A2", "B2", "", "C2"],
      },
      {
        run: (editor: Editor) => editor.chain().focus().deleteColumn().run(),
        expected: ["A2", "C2"],
      },
    ]
    for (const testCase of cases) {
      const editor = editorWithBodyTable()
      selectText(editor, "B2")
      expectSingleUpdateAndUndo(editor, () => testCase.run(editor), () => {
        expect(tableRows(editor)[1]).toEqual(testCase.expected)
        expectUniqueArticleNodeIds(editor)
      })
      editor.destroy()
    }
  })

  it("merges and splits a rectangular selection without losing cell content", () => {
    const editor = editorWithBodyTable()
    selectTableRect(editor, 0, 0, 2, 2)
    expectSingleUpdateAndUndo(
      editor,
      () => editor.chain().focus().mergeCells().run(),
      () => {
        const cell = currentTable(editor).node.child(0).child(0)
        expect(cell.attrs).toMatchObject({ colspan: 2, rowspan: 2 })
        expect(cell.textContent).toBe("A1B1A2B2")
      }
    )

    selectTableRect(editor, 0, 0, 2, 2)
    expect(editor.chain().focus().mergeCells().run()).toBe(true)
    ensureDeterministicNodeIds(editor)
    const merged = editor.getJSON()
    const onUpdate = vi.fn()
    editor.on("update", onUpdate)
    expect(editor.chain().focus().splitCell().run()).toBe(true)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(tableRows(editor)).toEqual([
      ["A1B1A2B2", "", "C1"],
      ["", "", "C2"],
      ["A3", "B3", "C3"],
    ])
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(merged)
    editor.off("update", onUpdate)
    editor.destroy()
  })

  it("exports merged cells with only server-supported attributes", () => {
    const editor = editorWithBodyTable()
    selectTableRect(editor, 0, 0, 2, 2)
    expect(editor.chain().focus().mergeCells().run()).toBe(true)

    const document = editorJsonToArticleDocument(editor.getJSON())
    const table = (document as unknown as JSONContent).content?.[0]
    const mergedCell = table?.content?.[0].content?.[0]

    expect(mergedCell?.attrs).toEqual({
      colspan: 2,
      rowspan: 2,
    })

    editor.destroy()
  })

  it("toggles row, column, and cell headers as independent undo steps", () => {
    const cases = [
      {
        select: (editor: Editor) => selectText(editor, "B1"),
        run: (editor: Editor) => editor.chain().focus().toggleHeaderRow().run(),
        row: 0,
        expected: ["tableHeader", "tableHeader", "tableHeader"],
      },
      {
        select: (editor: Editor) => selectText(editor, "A2"),
        run: (editor: Editor) =>
          editor.chain().focus().toggleHeaderColumn().run(),
        row: 1,
        expected: ["tableHeader", "tableCell", "tableCell"],
      },
      {
        select: (editor: Editor) => selectText(editor, "B2"),
        run: (editor: Editor) => editor.chain().focus().toggleHeaderCell().run(),
        row: 1,
        expected: ["tableCell", "tableHeader", "tableCell"],
      },
    ]
    for (const testCase of cases) {
      const editor = editorWithBodyTable()
      testCase.select(editor)
      expectSingleUpdateAndUndo(editor, () => testCase.run(editor), () => {
        expect(
          currentTable(editor)
            .node.child(testCase.row)
            .content.content.map((cell) => cell.type.name)
        ).toEqual(testCase.expected)
      })
      editor.destroy()
    }
  })

  it("applies horizontal and vertical alignment to the whole rectangle", () => {
    const cases = [
      { name: "textAlign", value: "center" },
      { name: "verticalAlign", value: "bottom" },
    ]
    for (const testCase of cases) {
      const editor = editorWithBodyTable()
      selectTableRect(editor, 0, 0, 2, 2)
      expectSingleUpdateAndUndo(
        editor,
        () =>
          editor
            .chain()
            .focus()
            .setCellAttribute(testCase.name, testCase.value)
            .run(),
        () => {
          const table = currentTable(editor).node
          for (const row of [0, 1]) {
            for (const column of [0, 1]) {
              expect(table.child(row).child(column).attrs[testCase.name]).toBe(
                testCase.value
              )
            }
          }
          expect(table.child(2).child(2).attrs[testCase.name]).toBeNull()
        }
      )
      editor.destroy()
    }
  })

  it("clears only the selected cell rectangle in one undo step", () => {
    const editor = editorWithBodyTable()
    selectTableRect(editor, 0, 1, 2, 3)
    expectSingleUpdateAndUndo(
      editor,
      () => editor.chain().focus().deleteSelection().run(),
      () => {
        expect(tableRows(editor)).toEqual([
          ["A1", "", ""],
          ["A2", "", ""],
          ["A3", "B3", "C3"],
        ])
      }
    )
    editor.destroy()
  })

  it("selects, copies, and deletes the whole table with correct history", () => {
    const editor = editorWithBodyTable()
    selectText(editor, "B2")
    const onUpdate = vi.fn()
    editor.on("update", onUpdate)
    expect(selectCurrentArticleTable(editor)).toBe(true)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(selectedRect(editor.state)).toMatchObject({
      top: 0,
      bottom: 3,
      left: 0,
      right: 3,
    })
    editor.off("update", onUpdate)

    expectSingleUpdateAndUndo(editor, () => duplicateCurrentArticleTable(editor), () => {
      const tables = (editor.getJSON() as JSONContent).content?.filter(
        (node) => node.type === "table"
      )
      expect(tables).toHaveLength(2)
      expect(tables?.[0].attrs?.node_id).not.toBe(tables?.[1].attrs?.node_id)
      const firstParagraphId = tables?.[0].content?.[0].content?.[0].content?.[0].attrs?.node_id
      const copiedParagraphId = tables?.[1].content?.[0].content?.[0].content?.[0].attrs?.node_id
      expect(firstParagraphId).not.toBe(copiedParagraphId)
      expectUniqueArticleNodeIds(editor)
    })

    selectText(editor, "B2")
    expectSingleUpdateAndUndo(
      editor,
      () => editor.chain().focus().deleteTable().run(),
      () => expect(editor.getJSON().content?.some((node) => node.type === "table")).toBe(false)
    )
    editor.destroy()
  })

  it("preserves rowspan and colspan while moving merged row and column groups", () => {
    const rowEditor = editorWithBodyTable()
    selectTableRect(rowEditor, 0, 0, 2, 2)
    expect(rowEditor.chain().focus().mergeCells().run()).toBe(true)
    selectTableRect(rowEditor, 0, 0, 2, 2)
    expectSingleUpdateAndUndo(rowEditor, () => moveArticleTableRow(rowEditor, 1), () => {
      const merged = currentTable(rowEditor).node.child(1).child(0)
      expect(merged.attrs).toMatchObject({ colspan: 2, rowspan: 2 })
      expect(merged.textContent).toBe("A1B1A2B2")
    })
    rowEditor.destroy()

    const columnEditor = editorWithBodyTable()
    selectTableRect(columnEditor, 0, 0, 2, 2)
    expect(columnEditor.chain().focus().mergeCells().run()).toBe(true)
    selectTableRect(columnEditor, 0, 0, 2, 2)
    expectSingleUpdateAndUndo(
      columnEditor,
      () => moveArticleTableColumn(columnEditor, 1),
      () => {
        const merged = currentTable(columnEditor).node.child(0).child(1)
        expect(merged.attrs).toMatchObject({ colspan: 2, rowspan: 2 })
        expect(merged.textContent).toBe("A1B1A2B2")
      }
    )
    columnEditor.destroy()
  })

  it("routes media commands into the shared media handler", () => {
    const editor = editorWithParagraphs()
    const onMedia = vi.fn()
    expect(
      executeArticleEditorCommand(
        editor,
        {
          id: "video",
          label: "视频",
          aliases: [],
          group: "media",
          phase: "P2",
          node: "video",
          media: true,
          run: () => false,
        },
        onMedia
      )
    ).toBe(true)
    expect(onMedia).toHaveBeenCalledWith("video")
    editor.destroy()
  })
})
