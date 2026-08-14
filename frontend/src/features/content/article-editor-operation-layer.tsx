import type { Editor } from "@tiptap/core"
import DragHandle from "@tiptap/extension-drag-handle-react"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import type { EditorState } from "@tiptap/pm/state"
import { BubbleMenu } from "@tiptap/react/menus"
import { useEditorState } from "@tiptap/react"
import * as React from "react"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bold,
  Columns3,
  Copy,
  GripVertical,
  Italic,
  Link2,
  Plus,
  Rows3,
  Sparkles,
  Strikethrough,
  Table2,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  Underline,
  Unlink,
} from "lucide-react"

import type {
  ArticleAIEditCommand,
  ArticleDocumentCapabilities,
} from "@/api/articles"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  availableArticleEditorCommands,
  executeArticleEditorCommand,
  searchArticleEditorCommands,
  type ArticleEditorCommand,
  type ArticleEditorCommandGroup,
  type ArticleEditorEnhancedCommandHandler,
  type ArticleEditorMediaCommandHandler,
} from "@/features/content/article-editor-commands"
import {
  type ArticleTableInsertionTarget,
  articleEditorMenuPosition,
  canMoveArticleTableColumn,
  canMoveArticleTableRow,
  canOpenArticleSlashMenu,
  deleteArticleTopLevelBlock,
  duplicateCurrentArticleTable,
  duplicateArticleTopLevelBlock,
  insertArticleTable,
  moveArticleTableColumn,
  moveArticleTableRow,
  moveArticleTopLevelBlock,
  normalizeArticleTableSize,
  selectCurrentArticleTable,
  slashCommandQuery,
} from "@/features/content/article-editor-operations"
import { cn } from "@/lib/utils"

const COMMAND_GROUP_LABELS: Record<ArticleEditorCommandGroup, string> = {
  text: "文本",
  media: "媒体",
  structure: "结构",
  enhanced: "增强",
}

const ARTICLE_TEXT_BUBBLE_MENU_OPTIONS = {
  placement: "top",
  offset: 8,
} as const

const ARTICLE_TABLE_BUBBLE_MENU_OPTIONS = {
  placement: "bottom",
  offset: 8,
} as const

function shouldShowArticleTextBubbleMenu({ state }: { state: EditorState }) {
  return !state.selection.empty && state.selection.$from.parent.inlineContent
}

function shouldShowArticleTableToolbar({ editor }: { editor: Editor }) {
  return editor.isActive("table")
}

type CommandMenuState =
  | {
      mode: "slash"
      from: number
      query: string
      left: number
      top: number
    }
  | {
      mode: "plus"
      insertionPos: number
      left: number
      top: number
    }

function selectionButton(
  label: string,
  active: boolean,
  disabled: boolean,
  action: () => void,
  icon: React.ReactNode
) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={active ? "secondary" : "ghost"}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={action}
    >
      {icon}
    </Button>
  )
}

function ArticleTextBubbleMenu({
  editor,
  onOpenLink,
  onAI,
}: {
  editor: Editor
  onOpenLink: () => void
  onAI?: (command: ArticleAIEditCommand) => void
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      underline: current.isActive("underline"),
      strike: current.isActive("strike"),
      link: current.isActive("link"),
      canBold: current.can().chain().focus().toggleBold().run(),
      canItalic: current.can().chain().focus().toggleItalic().run(),
      canUnderline: current.can().chain().focus().toggleUnderline().run(),
      canStrike: current.can().chain().focus().toggleStrike().run(),
    }),
  })
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="articleTextBubbleMenu"
      shouldShow={shouldShowArticleTextBubbleMenu}
      options={ARTICLE_TEXT_BUBBLE_MENU_OPTIONS}
      className="flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-lg"
      role="toolbar"
      aria-label="文本选区工具栏"
    >
      {selectionButton(
        "粗体",
        state.bold,
        !state.canBold,
        () => {
          editor.chain().focus().toggleBold().run()
        },
        <Bold />
      )}
      {selectionButton(
        "斜体",
        state.italic,
        !state.canItalic,
        () => {
          editor.chain().focus().toggleItalic().run()
        },
        <Italic />
      )}
      {selectionButton(
        "下划线",
        state.underline,
        !state.canUnderline,
        () => {
          editor.chain().focus().toggleUnderline().run()
        },
        <Underline />
      )}
      {selectionButton(
        "删除线",
        state.strike,
        !state.canStrike,
        () => {
          editor.chain().focus().toggleStrike().run()
        },
        <Strikethrough />
      )}
      <Separator orientation="vertical" className="mx-0.5 h-6" />
      {selectionButton("编辑链接", state.link, false, onOpenLink, <Link2 />)}
      {selectionButton(
        "移除链接",
        false,
        !state.link,
        () => {
          editor.chain().focus().unsetLink().run()
        },
        <Unlink />
      )}
      {selectionButton(
        "清除格式",
        false,
        false,
        () => {
          editor.chain().focus().unsetAllMarks().clearNodes().run()
        },
        <Trash2 />
      )}
      <Separator orientation="vertical" className="mx-0.5 h-6" />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="AI 编辑选区"
              title="AI 编辑选区"
            />
          }
        >
          <Sparkles />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="rounded-md">
          <DropdownMenuGroup>
            <DropdownMenuLabel>AI 编辑选区</DropdownMenuLabel>
            {(
              [
                ["rewrite", "改写"],
                ["polish", "润色"],
                ["shorten", "缩短"],
                ["expand", "扩写"],
                ["proofread", "校对"],
                ["translate", "翻译为英文"],
              ] as const
            ).map(([command, label]) => (
              <DropdownMenuItem
                key={command}
                className="rounded-sm"
                disabled={!onAI}
                onClick={() => onAI?.(command)}
              >
                <Sparkles /> {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </BubbleMenu>
  )
}

type TableAction = {
  label: string
  icon?: React.ReactNode
  can: () => boolean
  run: () => boolean
}

type TableActionGroup = {
  label: string
  icon: React.ReactNode
  actions: TableAction[]
}

function TableActionMenu({
  label,
  icon,
  actions,
}: {
  label: string
  icon: React.ReactNode
  actions: TableAction[]
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" size="sm" variant="ghost" title={label} />
        }
      >
        {icon}
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="rounded-md" align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.label}
              className="rounded-sm"
              disabled={!action.can()}
              onClick={() => action.run()}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ArticleTableToolbar({ editor }: { editor: Editor }) {
  const { tableActive } = useEditorState({
    editor,
    selector: ({ editor: currentEditor, transactionNumber }) => ({
      tableActive: currentEditor.isActive("table"),
      transactionNumber,
    }),
  })
  const [mobileOpen, setMobileOpen] = React.useState(false)
  const mobileTriggerRef = React.useRef<HTMLButtonElement>(null)
  const getTableReference = React.useCallback(() => {
    const domAtSelection = editor.view.domAtPos(
      editor.state.selection.from
    ).node
    const element =
      domAtSelection.nodeType === Node.ELEMENT_NODE
        ? (domAtSelection as Element)
        : domAtSelection.parentElement
    return element?.closest("table") ?? null
  }, [editor])
  const chain = () => editor.chain().focus()
  const action = (
    label: string,
    command: (value: ReturnType<typeof chain>) => { run: () => boolean },
    icon?: React.ReactNode
  ): TableAction => ({
    label,
    icon,
    can: () => command(editor.can().chain().focus()).run(),
    run: () => command(chain()).run(),
  })
  const groups: TableActionGroup[] = [
    {
      label: "行",
      icon: <Rows3 />,
      actions: [
        action("上方添加行", (value) => value.addRowBefore(), <ArrowUp />),
        action("下方添加行", (value) => value.addRowAfter(), <ArrowDown />),
        {
          label: "向上移动当前行",
          icon: <ArrowUp />,
          can: () => canMoveArticleTableRow(editor, -1),
          run: () => moveArticleTableRow(editor, -1),
        },
        {
          label: "向下移动当前行",
          icon: <ArrowDown />,
          can: () => canMoveArticleTableRow(editor, 1),
          run: () => moveArticleTableRow(editor, 1),
        },
        action("删除当前行", (value) => value.deleteRow(), <Trash2 />),
        action("切换表头行", (value) => value.toggleHeaderRow()),
      ],
    },
    {
      label: "列",
      icon: <Columns3 />,
      actions: [
        action("左侧添加列", (value) => value.addColumnBefore(), <ArrowLeft />),
        action("右侧添加列", (value) => value.addColumnAfter(), <ArrowRight />),
        {
          label: "向左移动当前列",
          icon: <ArrowLeft />,
          can: () => canMoveArticleTableColumn(editor, -1),
          run: () => moveArticleTableColumn(editor, -1),
        },
        {
          label: "向右移动当前列",
          icon: <ArrowRight />,
          can: () => canMoveArticleTableColumn(editor, 1),
          run: () => moveArticleTableColumn(editor, 1),
        },
        action("删除当前列", (value) => value.deleteColumn(), <Trash2 />),
        action("切换表头列", (value) => value.toggleHeaderColumn()),
      ],
    },
    {
      label: "单元格",
      icon: <TableCellsMerge />,
      actions: [
        action(
          "合并单元格",
          (value) => value.mergeCells(),
          <TableCellsMerge />
        ),
        action("拆分单元格", (value) => value.splitCell(), <TableCellsSplit />),
        action("切换表头单元格", (value) => value.toggleHeaderCell()),
        action(
          "清空所选单元格",
          (value) => value.deleteSelection(),
          <Trash2 />
        ),
      ],
    },
    {
      label: "对齐",
      icon: <AlignLeft />,
      actions: [
        action(
          "水平左对齐",
          (value) => value.setCellAttribute("textAlign", "left"),
          <AlignLeft />
        ),
        action(
          "水平居中",
          (value) => value.setCellAttribute("textAlign", "center"),
          <AlignCenter />
        ),
        action(
          "水平右对齐",
          (value) => value.setCellAttribute("textAlign", "right"),
          <AlignRight />
        ),
        action(
          "垂直顶部",
          (value) => value.setCellAttribute("verticalAlign", "top"),
          <ArrowUp />
        ),
        action("垂直居中", (value) =>
          value.setCellAttribute("verticalAlign", "middle")
        ),
        action(
          "垂直底部",
          (value) => value.setCellAttribute("verticalAlign", "bottom"),
          <ArrowDown />
        ),
      ],
    },
    {
      label: "表格",
      icon: <Table2 />,
      actions: [
        {
          label: "选择整张表格",
          can: () => editor.isActive("table"),
          run: () => selectCurrentArticleTable(editor),
        },
        {
          label: "复制整张表格",
          icon: <Copy />,
          can: () => editor.isActive("table"),
          run: () => duplicateCurrentArticleTable(editor),
        },
        action("删除表格", (value) => value.deleteTable(), <Trash2 />),
      ],
    },
  ]
  React.useEffect(() => {
    const closeWhenSelectionLeavesTable = () => {
      if (!editor.isActive("table")) setMobileOpen(false)
    }
    editor.on("transaction", closeWhenSelectionLeavesTable)
    return () => {
      editor.off("transaction", closeWhenSelectionLeavesTable)
    }
  }, [editor])
  return (
    <>
      <BubbleMenu
        editor={editor}
        pluginKey="articleTableToolbar"
        shouldShow={shouldShowArticleTableToolbar}
        getReferencedVirtualElement={getTableReference}
        options={ARTICLE_TABLE_BUBBLE_MENU_OPTIONS}
        className="hidden max-w-[calc(100vw-1rem)] flex-wrap items-center gap-0.5 rounded-md border bg-popover p-1 shadow-lg md:flex"
        role="toolbar"
        aria-label="表格工具栏"
      >
        {groups.map((group) => (
          <TableActionMenu key={group.label} {...group} />
        ))}
      </BubbleMenu>
      {tableActive && (
        <Button
          ref={mobileTriggerRef}
          type="button"
          className="fixed right-3 bottom-3 z-40 shadow-lg md:hidden"
          aria-label="打开表格操作"
          onClick={() => setMobileOpen(true)}
        >
          <Table2 /> 表格操作
        </Button>
      )}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="bottom"
          finalFocus={() =>
            mobileTriggerRef.current ??
            (editor.isDestroyed ? false : editor.view.dom)
          }
          className="w-full max-w-full overflow-x-hidden rounded-t-md pb-[max(1rem,env(safe-area-inset-bottom))] md:hidden"
        >
          <SheetHeader className="border-b pr-14">
            <SheetTitle>表格操作</SheetTitle>
            <SheetDescription className="sr-only">
              当前表格的编辑操作
            </SheetDescription>
          </SheetHeader>
          <div className="grid max-h-[calc(80dvh-5rem)] min-w-0 gap-5 overflow-y-auto p-4">
            {groups.map((group) => (
              <section key={group.label} className="grid min-w-0 gap-2">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  {group.icon}
                  {group.label}
                </h3>
                <div className="grid min-w-0 grid-cols-1 gap-2 min-[360px]:grid-cols-2">
                  {group.actions.map((item) => (
                    <Button
                      key={item.label}
                      type="button"
                      variant="outline"
                      className="h-auto min-h-10 w-full min-w-0 justify-start text-left whitespace-normal"
                      disabled={!item.can()}
                      onClick={() => item.run()}
                    >
                      {item.icon}
                      <span className="min-w-0 break-words">{item.label}</span>
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function CommandMenu({
  editor,
  state,
  capabilities,
  activeIndex,
  onActiveIndexChange,
  onClose,
  onInsertTable,
  onMedia,
  onEnhanced,
}: {
  editor: Editor
  state: CommandMenuState
  capabilities: ArticleDocumentCapabilities
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onClose: () => void
  onInsertTable: (target: ArticleTableInsertionTarget) => void
  onMedia: ArticleEditorMediaCommandHandler
  onEnhanced: ArticleEditorEnhancedCommandHandler
}) {
  const [plusQuery, setPlusQuery] = React.useState("")
  const query = state.mode === "slash" ? state.query : plusQuery
  const commands = searchArticleEditorCommands(
    availableArticleEditorCommands(capabilities, "P3"),
    query
  )
  const run = (command: ArticleEditorCommand) => {
    if (command.id === "table") {
      if (state.mode === "slash") {
        const match = slashCommandQuery(editor, state.from)
        if (!match) return onClose()
        onInsertTable({ mode: "slash", from: state.from, to: match.to })
      } else {
        onInsertTable({ mode: "plus", position: state.insertionPos })
      }
      return
    }
    if (state.mode === "slash") {
      const match = slashCommandQuery(editor, state.from)
      if (!match) return onClose()
      editor
        .chain()
        .focus()
        .deleteRange({ from: state.from, to: match.to })
        .run()
    } else {
      editor
        .chain()
        .focus()
        .insertContentAt(state.insertionPos, { type: "paragraph" })
        .setTextSelection(state.insertionPos + 1)
        .run()
    }
    executeArticleEditorCommand(editor, command, onMedia, onEnhanced)
    onClose()
  }
  const byGroup = (["text", "media", "structure", "enhanced"] as const)
    .map((group) => ({
      group,
      commands: commands.filter((command) => command.group === group),
    }))
    .filter(({ commands: items }) => items.length)
  return (
    <div
      className="fixed z-50 w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-md border bg-popover shadow-lg"
      style={{ left: state.left, top: state.top }}
      role="dialog"
      aria-label="插入内容"
    >
      {state.mode === "plus" && (
        <div className="border-b p-2">
          <Input
            autoFocus
            value={plusQuery}
            placeholder="搜索内容类型"
            aria-label="搜索内容类型"
            onChange={(event) => {
              setPlusQuery(event.target.value)
              onActiveIndexChange(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose()
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                if (!commands.length) return
                const delta = event.key === "ArrowDown" ? 1 : -1
                onActiveIndexChange(
                  (activeIndex + delta + commands.length) % commands.length
                )
              }
              if (event.key === "Enter" && commands[activeIndex]) {
                event.preventDefault()
                run(commands[activeIndex])
              }
            }}
          />
        </div>
      )}
      <div className="max-h-80 overflow-y-auto p-1" role="listbox">
        {byGroup.map(({ group, commands: items }) => (
          <div key={group}>
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {COMMAND_GROUP_LABELS[group]}
            </p>
            {items.map((command) => {
              const index = commands.indexOf(command)
              return (
                <Button
                  key={command.id}
                  type="button"
                  role="option"
                  variant="ghost"
                  aria-selected={index === activeIndex}
                  className={cn(
                    "h-auto w-full justify-between rounded-sm px-2 py-2 text-left text-sm whitespace-normal",
                    index === activeIndex && "bg-accent text-accent-foreground"
                  )}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run(command)}
                >
                  <span>{command.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {command.aliases[0]}
                  </span>
                </Button>
              )
            })}
          </div>
        ))}
        {!commands.length && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            没有匹配的内容类型
          </p>
        )}
      </div>
    </div>
  )
}

function ArticleTableInsertDialog({
  editor,
  target,
  onOpenChange,
}: {
  editor: Editor
  target: ArticleTableInsertionTarget
  onOpenChange: (open: boolean) => void
}) {
  const [rows, setRows] = React.useState(3)
  const [columns, setColumns] = React.useState(3)
  const [withHeaderRow, setWithHeaderRow] = React.useState(true)
  const setSize = (nextRows: number, nextColumns: number) => {
    setRows(normalizeArticleTableSize(nextRows))
    setColumns(normalizeArticleTableSize(nextColumns))
  }
  const insert = () => {
    insertArticleTable(editor, target, { rows, columns, withHeaderRow })
    onOpenChange(false)
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="rounded-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>插入表格</DialogTitle>
          <DialogDescription>
            选择 1-10 行、1-10 列，并决定是否把首行设为表头。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div
            className="grid w-fit grid-cols-10 gap-1"
            role="grid"
            aria-label="表格尺寸选择器"
          >
            {Array.from({ length: 100 }, (_, index) => {
              const row = Math.floor(index / 10) + 1
              const column = (index % 10) + 1
              const selected = row <= rows && column <= columns
              return (
                <Button
                  key={`${row}-${column}`}
                  type="button"
                  role="gridcell"
                  variant="outline"
                  size="icon-xs"
                  aria-label={`${row} 行 ${column} 列`}
                  aria-selected={selected}
                  title={`${row} × ${column}`}
                  className={cn(
                    "size-6 rounded-sm bg-background p-0 outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring",
                    selected && "border-primary bg-primary/15"
                  )}
                  onMouseEnter={() => setSize(row, column)}
                  onFocus={() => setSize(row, column)}
                  onClick={() => setSize(row, column)}
                />
              )
            })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
              行数
              <Input
                type="number"
                min={1}
                max={10}
                value={rows}
                onChange={(event) =>
                  setSize(Number(event.target.value), columns)
                }
              />
            </Label>
            <Label className="grid gap-1 text-xs font-medium text-muted-foreground">
              列数
              <Input
                type="number"
                min={1}
                max={10}
                value={columns}
                onChange={(event) => setSize(rows, Number(event.target.value))}
              />
            </Label>
          </div>
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={withHeaderRow}
              onCheckedChange={(checked) => setWithHeaderRow(checked === true)}
            />
            首行作为表头
          </Label>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            将插入 {rows} 行 × {columns} 列
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button type="button" onClick={insert}>
            插入表格
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ArticleEditorOperationLayer({
  editor,
  capabilities,
  onOpenLink,
  onMedia,
  onEnhanced,
  onAI,
}: {
  editor: Editor
  capabilities: ArticleDocumentCapabilities
  onOpenLink: () => void
  onMedia: ArticleEditorMediaCommandHandler
  onEnhanced: ArticleEditorEnhancedCommandHandler
  onAI?: (command: ArticleAIEditCommand) => void
}) {
  const [menu, setMenu] = React.useState<CommandMenuState | null>(null)
  const [tableTarget, setTableTarget] =
    React.useState<ArticleTableInsertionTarget | null>(null)
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [dragTarget, setDragTarget] = React.useState<{
    node: ProseMirrorNode
    pos: number
  } | null>(null)
  const handleDragNodeChange = React.useCallback(
    ({ node, pos }: { node: ProseMirrorNode | null; pos: number }) => {
      setDragTarget(node && pos >= 0 ? { node, pos } : null)
    },
    []
  )
  const closeMenu = React.useCallback(() => {
    setMenu(null)
    requestAnimationFrame(() => editor.commands.focus())
  }, [editor])

  React.useEffect(() => {
    const element = editor.view.dom
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || editor.view.composing) return
      if (menu?.mode === "slash") {
        const commands = searchArticleEditorCommands(
          availableArticleEditorCommands(capabilities, "P3"),
          menu.query
        )
        if (event.key === "Escape") {
          event.preventDefault()
          setMenu(null)
          return
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          if (!commands.length) return
          const delta = event.key === "ArrowDown" ? 1 : -1
          setActiveIndex(
            (current) => (current + delta + commands.length) % commands.length
          )
          return
        }
        if (event.key === "Enter" && commands[activeIndex]) {
          event.preventDefault()
          const match = slashCommandQuery(editor, menu.from)
          if (!match) return setMenu(null)
          if (commands[activeIndex].id === "table") {
            setMenu(null)
            setTableTarget({
              mode: "slash",
              from: menu.from,
              to: match.to,
            })
            return
          }
          editor
            .chain()
            .focus()
            .deleteRange({ from: menu.from, to: match.to })
            .run()
          executeArticleEditorCommand(
            editor,
            commands[activeIndex],
            onMedia,
            onEnhanced
          )
          setMenu(null)
          return
        }
      }
      if (canOpenArticleSlashMenu(editor, event)) {
        const from = editor.state.selection.from
        const coordinates = editor.view.coordsAtPos(from)
        const position = articleEditorMenuPosition(
          coordinates.left,
          coordinates.bottom + 6,
          window.innerWidth,
          window.innerHeight
        )
        setActiveIndex(0)
        setMenu({
          mode: "slash",
          from,
          query: "",
          ...position,
        })
      }
    }
    const onTransaction = () => {
      setMenu((current) => {
        if (current?.mode !== "slash") return current
        const match = slashCommandQuery(editor, current.from)
        if (!match) return null
        return match.query === current.query
          ? current
          : { ...current, query: match.query }
      })
      setActiveIndex(0)
    }
    element.addEventListener("keydown", onKeyDown, true)
    editor.on("transaction", onTransaction)
    return () => {
      element.removeEventListener("keydown", onKeyDown, true)
      editor.off("transaction", onTransaction)
    }
  }, [activeIndex, capabilities, editor, menu, onEnhanced, onMedia])

  return (
    <>
      <ArticleTextBubbleMenu
        editor={editor}
        onOpenLink={onOpenLink}
        onAI={onAI}
      />
      <ArticleTableToolbar editor={editor} />
      <DragHandle
        editor={editor}
        onNodeChange={handleDragNodeChange}
        className="z-30 flex items-center gap-0.5 rounded-md border bg-background p-0.5 shadow-sm"
      >
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="在下方插入内容"
          title="在下方插入内容"
          disabled={!dragTarget}
          onClick={(event) => {
            if (!dragTarget) return
            const rect = event.currentTarget.getBoundingClientRect()
            const position = articleEditorMenuPosition(
              rect.left,
              rect.bottom + 6,
              window.innerWidth,
              window.innerHeight
            )
            setActiveIndex(0)
            setMenu({
              mode: "plus",
              insertionPos: dragTarget.pos + dragTarget.node.nodeSize,
              ...position,
            })
          }}
        >
          <Plus />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="拖动或管理内容块"
                title="拖动或管理内容块"
              />
            }
          >
            <GripVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="rounded-md" side="right">
            <DropdownMenuGroup>
              <DropdownMenuLabel>内容块</DropdownMenuLabel>
              <DropdownMenuItem
                className="rounded-sm"
                disabled={!dragTarget || dragTarget.pos === 0}
                onClick={() =>
                  dragTarget &&
                  moveArticleTopLevelBlock(editor, dragTarget.pos, -1)
                }
              >
                <ArrowUp /> 上移
              </DropdownMenuItem>
              <DropdownMenuItem
                className="rounded-sm"
                disabled={
                  !dragTarget ||
                  dragTarget.pos + dragTarget.node.nodeSize >=
                    editor.state.doc.content.size
                }
                onClick={() =>
                  dragTarget &&
                  moveArticleTopLevelBlock(editor, dragTarget.pos, 1)
                }
              >
                <ArrowDown /> 下移
              </DropdownMenuItem>
              <DropdownMenuItem
                className="rounded-sm"
                disabled={!dragTarget}
                onClick={() =>
                  dragTarget &&
                  duplicateArticleTopLevelBlock(editor, dragTarget.pos)
                }
              >
                <Copy /> 复制
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="rounded-sm"
                variant="destructive"
                disabled={!dragTarget}
                onClick={() =>
                  dragTarget &&
                  deleteArticleTopLevelBlock(editor, dragTarget.pos)
                }
              >
                <Trash2 /> 删除
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </DragHandle>
      {menu && (
        <CommandMenu
          editor={editor}
          state={menu}
          capabilities={capabilities}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onClose={closeMenu}
          onInsertTable={(target) => {
            setMenu(null)
            setTableTarget(target)
          }}
          onMedia={onMedia}
          onEnhanced={onEnhanced}
        />
      )}
      {tableTarget && (
        <ArticleTableInsertDialog
          editor={editor}
          target={tableTarget}
          onOpenChange={(open) => {
            if (!open) setTableTarget(null)
            if (!open) requestAnimationFrame(() => editor.commands.focus())
          }}
        />
      )}
    </>
  )
}
