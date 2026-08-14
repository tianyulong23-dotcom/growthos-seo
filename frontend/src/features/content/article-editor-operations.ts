import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { closeHistory } from "@tiptap/pm/history"
import { NodeSelection } from "@tiptap/pm/state"
import {
  CellSelection,
  findTable,
  isInTable,
  moveTableRow,
  selectedRect,
  TableMap,
} from "@tiptap/pm/tables"

export function articleEditorMenuPosition(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 320,
  menuHeight = 332
) {
  const gutter = 8
  return {
    left: Math.max(
      gutter,
      Math.min(left, Math.max(gutter, viewportWidth - menuWidth - gutter))
    ),
    top: Math.max(
      gutter,
      Math.min(top, Math.max(gutter, viewportHeight - menuHeight - gutter))
    ),
  }
}

export function canOpenArticleSlashMenu(
  editor: Editor,
  event: Pick<KeyboardEvent, "key" | "isComposing">
) {
  return (
    event.key === "/" &&
    !event.isComposing &&
    !editor.view.composing &&
    editor.state.selection.empty &&
    editor.state.selection.$from.parent.type.name === "paragraph" &&
    editor.state.selection.$from.parent.content.size === 0
  )
}

export type ArticleTableInsertionTarget =
  | { mode: "slash"; from: number; to: number }
  | { mode: "plus"; position: number }

export function normalizeArticleTableSize(value: number) {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(10, Math.trunc(value)))
}

export function insertArticleTable(
  editor: Editor,
  target: ArticleTableInsertionTarget,
  options: { rows: number; columns: number; withHeaderRow: boolean }
) {
  const rows = normalizeArticleTableSize(options.rows)
  const columns = normalizeArticleTableSize(options.columns)
  const chain = editor.chain().focus()
  if (target.mode === "slash") {
    return chain
      .deleteRange({ from: target.from, to: target.to })
      .insertTable({
        rows,
        cols: columns,
        withHeaderRow: options.withHeaderRow,
      })
      .run()
  }
  const cell = (type: "tableHeader" | "tableCell") => ({
    type,
    content: [{ type: "paragraph" }],
  })
  const table = {
    type: "table",
    content: Array.from({ length: rows }, (_, row) => ({
      type: "tableRow",
      content: Array.from({ length: columns }, () =>
        cell(options.withHeaderRow && row === 0 ? "tableHeader" : "tableCell")
      ),
    })),
  }
  return chain.insertContentAt(target.position, table).run()
}

export function slashCommandQuery(
  editor: Editor,
  from: number
): { query: string; to: number } | null {
  const { selection, doc } = editor.state
  if (!selection.empty || selection.from < from) return null
  const value = doc.textBetween(from, selection.from, "\n", "\0")
  if (!value.startsWith("/") || /\s/.test(value.slice(1))) return null
  return { query: value.slice(1), to: selection.from }
}

function withoutNodeIds(node: ProseMirrorNode): ProseMirrorNode {
  if (node.isText) return node
  const attrs = { ...node.attrs }
  delete attrs.node_id
  const content = node.content.size
    ? node.content.content.map(withoutNodeIds)
    : undefined
  return node.type.create(attrs, content, node.marks)
}

function topLevelBlocks(editor: Editor) {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = []
  editor.state.doc.forEach((node, offset) => blocks.push({ node, pos: offset }))
  return blocks
}

export function moveArticleTopLevelBlock(
  editor: Editor,
  position: number,
  direction: -1 | 1
) {
  const blocks = topLevelBlocks(editor)
  const index = blocks.findIndex(({ pos }) => pos === position)
  const targetIndex = index + direction
  if (index < 0 || targetIndex < 0 || targetIndex >= blocks.length) return false
  const current = blocks[index]
  const target = blocks[targetIndex]
  const transaction = closeHistory(
    editor.state.tr.delete(current.pos, current.pos + current.node.nodeSize)
  )
  const insertAt =
    direction < 0 ? target.pos : current.pos + target.node.nodeSize
  transaction.insert(insertAt, current.node)
  transaction.setSelection(NodeSelection.create(transaction.doc, insertAt))
  editor.view.dispatch(transaction.scrollIntoView())
  return true
}

export function duplicateArticleTopLevelBlock(
  editor: Editor,
  position: number
) {
  const current = topLevelBlocks(editor).find(({ pos }) => pos === position)
  if (!current) return false
  const copy = withoutNodeIds(current.node)
  const insertAt = current.pos + current.node.nodeSize
  const transaction = closeHistory(editor.state.tr.insert(insertAt, copy))
  transaction.setSelection(NodeSelection.create(transaction.doc, insertAt))
  editor.view.dispatch(transaction.scrollIntoView())
  return true
}

export function deleteArticleTopLevelBlock(editor: Editor, position: number) {
  const current = topLevelBlocks(editor).find(({ pos }) => pos === position)
  if (!current) return false
  const transaction = closeHistory(
    editor.state.tr.delete(current.pos, current.pos + current.node.nodeSize)
  )
  editor.view.dispatch(transaction.scrollIntoView())
  return true
}

function currentTableRect(editor: Editor) {
  if (!isInTable(editor.state)) return null
  try {
    return selectedRect(editor.state)
  } catch {
    return null
  }
}

function articleTableCellPosition(
  map: TableMap,
  tableStart: number,
  row: number,
  column: number
) {
  return tableStart + map.map[row * map.width + column]
}

export function canMoveArticleTableRow(editor: Editor, direction: -1 | 1) {
  const rect = currentTableRect(editor)
  if (!rect) return false
  const adjacentRow = direction < 0 ? rect.top - 1 : rect.bottom
  if (adjacentRow < 0 || adjacentRow >= rect.map.height) return false
  const firstRowIsHeader = Array.from({
    length: rect.table.child(0).childCount,
  })
    .map((_, index) => rect.table.child(0).child(index).type.name)
    .every((type) => type === "tableHeader")
  return !firstRowIsHeader || (rect.top > 0 && adjacentRow > 0)
}

export function moveArticleTableRow(editor: Editor, direction: -1 | 1) {
  const rect = currentTableRect(editor)
  if (!rect || !canMoveArticleTableRow(editor, direction)) return false
  const from = direction < 0 ? rect.top - 1 : rect.bottom
  const to = direction < 0 ? rect.bottom - 1 : rect.top
  editor.view.focus()
  return moveTableRow({
    from,
    to,
    select: false,
  })(editor.state, (transaction) => {
    closeHistory(transaction)
    const table = transaction.doc.nodeAt(rect.tableStart - 1)
    if (!table) return
    const map = TableMap.get(table)
    const top = rect.top + direction
    const bottom = rect.bottom + direction
    transaction.setSelection(
      CellSelection.create(
        transaction.doc,
        articleTableCellPosition(map, rect.tableStart, top, rect.left),
        articleTableCellPosition(
          map,
          rect.tableStart,
          bottom - 1,
          rect.right - 1
        )
      )
    )
    editor.view.dispatch(transaction.scrollIntoView())
  })
}

export function canMoveArticleTableColumn(editor: Editor, direction: -1 | 1) {
  return articleTableColumnMove(editor, direction) !== null
}

function expandArticleTableColumnRange(
  map: TableMap,
  left: number,
  right: number
) {
  let expandedLeft = left
  let expandedRight = right
  let changed = true
  const cells = [...new Set(map.map)]
  while (changed) {
    changed = false
    for (const position of cells) {
      const cell = map.findCell(position)
      if (cell.left >= expandedRight || cell.right <= expandedLeft) continue
      if (cell.left < expandedLeft) {
        expandedLeft = cell.left
        changed = true
      }
      if (cell.right > expandedRight) {
        expandedRight = cell.right
        changed = true
      }
    }
  }
  return { left: expandedLeft, right: expandedRight }
}

function articleTableColumnMove(editor: Editor, direction: -1 | 1) {
  const rect = currentTableRect(editor)
  if (!rect) return null
  const selected = expandArticleTableColumnRange(
    rect.map,
    rect.left,
    rect.right
  )
  const adjacentColumn = direction < 0 ? selected.left - 1 : selected.right
  if (adjacentColumn < 0 || adjacentColumn >= rect.map.width) return null
  const adjacent = expandArticleTableColumnRange(
    rect.map,
    adjacentColumn,
    adjacentColumn + 1
  )
  if (
    (direction < 0 && adjacent.right !== selected.left) ||
    (direction > 0 && adjacent.left !== selected.right)
  ) {
    return null
  }
  return { rect, selected, adjacent }
}

function articleTableRowsByGrid(table: ProseMirrorNode, map: TableMap) {
  return Array.from({ length: map.height }, (_, row) =>
    Array.from({ length: map.width }, (_, column) => {
      const mapIndex = row * map.width + column
      const position = map.map[mapIndex]
      if (row > 0 && position === map.map[mapIndex - map.width]) return null
      if (column > 0 && position === map.map[mapIndex - 1]) return null
      return table.nodeAt(position)
    })
  )
}

export function moveArticleTableColumn(editor: Editor, direction: -1 | 1) {
  const move = articleTableColumnMove(editor, direction)
  if (!move) return false
  const { rect, selected, adjacent } = move
  const rows = articleTableRowsByGrid(rect.table, rect.map)
  const rangeLeft = Math.min(selected.left, adjacent.left)
  const rangeRight = Math.max(selected.right, adjacent.right)
  const selectedWidth = selected.right - selected.left
  const adjacentWidth = adjacent.right - adjacent.left
  for (const row of rows) {
    const range = row.slice(rangeLeft, rangeRight)
    const splitAt = direction < 0 ? adjacentWidth : selectedWidth
    const before = range.slice(0, splitAt)
    const after = range.slice(splitAt)
    row.splice(rangeLeft, range.length, ...after, ...before)
  }
  const tableRows = rows.map((cells, index) => {
    const row = rect.table.child(index)
    return row.type.createChecked(
      row.attrs,
      cells.filter((cell): cell is ProseMirrorNode => cell !== null),
      row.marks
    )
  })
  const table = rect.table.type.createChecked(
    rect.table.attrs,
    tableRows,
    rect.table.marks
  )
  const transaction = closeHistory(
    editor.state.tr.replaceWith(
      rect.tableStart - 1,
      rect.tableStart - 1 + rect.table.nodeSize,
      table
    )
  )
  const map = TableMap.get(table)
  const left =
    direction < 0 ? adjacent.left : selected.left + adjacentWidth
  const right = left + selectedWidth
  transaction.setSelection(
    CellSelection.create(
      transaction.doc,
      articleTableCellPosition(map, rect.tableStart, rect.top, left),
      articleTableCellPosition(
        map,
        rect.tableStart,
        rect.bottom - 1,
        right - 1
      )
    )
  )
  editor.view.focus()
  editor.view.dispatch(transaction.scrollIntoView())
  return true
}

export function selectCurrentArticleTable(editor: Editor) {
  const table = findTable(editor.state.selection.$from)
  if (!table) return false
  const map = TableMap.get(table.node)
  if (!map.map.length) return false
  const firstCell = table.start + map.map[0]
  const lastCell = table.start + map.map[map.map.length - 1]
  const transaction = editor.state.tr.setSelection(
    CellSelection.create(editor.state.doc, firstCell, lastCell)
  )
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return true
}

export function duplicateCurrentArticleTable(editor: Editor) {
  const table = findTable(editor.state.selection.$from)
  if (!table) return false
  return duplicateArticleTopLevelBlock(editor, table.pos)
}
