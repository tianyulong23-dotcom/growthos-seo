import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { NodeSelection, Selection } from "@tiptap/pm/state"
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Copy,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  ARTICLE_DETAILS_SUMMARY_MAX_LENGTH,
  normalizeArticleDetailsSummary,
  validateArticleDetailsSummary,
} from "@/features/content/article-details"
import {
  deleteArticleTopLevelBlock,
  duplicateArticleTopLevelBlock,
  moveArticleTopLevelBlock,
} from "@/features/content/article-editor-operations"
import { cn } from "@/lib/utils"

function ArticleDetailsReadonly({
  children,
  openByDefault,
  summary,
}: {
  children: ReactNode
  openByDefault: boolean
  summary: string
}) {
  const [open, setOpen] = useState(openByDefault)
  return (
    <details
      className="article-details-readonly"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  )
}

export function ArticleDetailsNodeView({
  node,
  editor,
  selected,
  getPos,
  updateAttributes,
}: ReactNodeViewProps) {
  const initialSummary = normalizeArticleDetailsSummary(node.attrs.summary)
  const [summaryDraft, setSummaryDraft] = useState(initialSummary)
  const [open, setOpen] = useState(Boolean(node.attrs.open_by_default))
  const summaryInput = useRef<HTMLInputElement>(null)
  const submittedSummary = useRef<string | null>(null)
  const generatedId = useId().replaceAll(":", "")
  const contentId = `article-details-content-${String(node.attrs.node_id || generatedId)}`
  const validation = validateArticleDetailsSummary(summaryDraft)
  const position = getPos()
  const editable = editor.isEditable && typeof position === "number"
  const canMoveUp = editable && position > 0
  const canMoveDown =
    editable && position + node.nodeSize < editor.state.doc.content.size

  useEffect(() => {
    const current = normalizeArticleDetailsSummary(node.attrs.summary)
    if (submittedSummary.current === current) {
      submittedSummary.current = null
      return
    }
    setSummaryDraft(current)
  }, [node.attrs.summary])

  const currentPosition = () => {
    const current = getPos()
    return typeof current === "number" ? current : null
  }

  const selectDetails = () => {
    const current = currentPosition()
    if (current === null) return
    const transaction = editor.state.tr.setSelection(
      NodeSelection.create(editor.state.doc, current)
    )
    editor.view.dispatch(transaction.scrollIntoView())
    editor.view.focus()
  }

  const focusBody = () => {
    const current = currentPosition()
    if (current === null) return
    setOpen(true)
    const resolved = editor.state.doc.resolve(current + 2)
    const selection = Selection.near(resolved, 1)
    editor.view.dispatch(
      editor.state.tr.setSelection(selection).scrollIntoView()
    )
    editor.view.focus()
  }

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      const current = currentPosition()
      if (
        current !== null &&
        editor.state.selection.from > current &&
        editor.state.selection.to < current + node.nodeSize
      ) {
        editor.view.dispatch(
          editor.state.tr.setSelection(
            NodeSelection.create(editor.state.doc, current)
          )
        )
      }
    }
    setOpen(nextOpen)
  }

  const content = (hidden: boolean) => (
    <NodeViewContent
      id={contentId}
      className="article-details-content"
      hidden={hidden}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        selectDetails()
      }}
    />
  )

  return (
    <NodeViewWrapper
      data-article-node="details"
      data-node-id={node.attrs.node_id}
      className={cn("article-details", selected && "is-selected")}
    >
      {editor.isEditable ? (
        <section aria-label="折叠内容">
          <div
            className="article-details-toolbar"
            contentEditable={false}
            role="toolbar"
            aria-label="折叠内容工具栏"
          >
            <label className="article-details-default-open">
              <Switch
                size="sm"
                checked={Boolean(node.attrs.open_by_default)}
                onCheckedChange={(checked) => {
                  updateAttributes({ open_by_default: checked })
                  setOpen(checked)
                }}
              />
              发布后默认展开
            </label>
            <div className="article-details-block-actions">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="上移折叠内容"
                title="上移折叠内容"
                disabled={!canMoveUp}
                onClick={() => {
                  const current = currentPosition()
                  if (current !== null)
                    moveArticleTopLevelBlock(editor, current, -1)
                }}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="下移折叠内容"
                title="下移折叠内容"
                disabled={!canMoveDown}
                onClick={() => {
                  const current = currentPosition()
                  if (current !== null)
                    moveArticleTopLevelBlock(editor, current, 1)
                }}
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="复制折叠内容"
                title="复制折叠内容"
                disabled={!editable}
                onClick={() => {
                  const current = currentPosition()
                  if (current !== null)
                    duplicateArticleTopLevelBlock(editor, current)
                }}
              >
                <Copy />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="删除折叠内容"
                title="删除折叠内容"
                disabled={!editable}
                onClick={() => {
                  const current = currentPosition()
                  if (current !== null)
                    deleteArticleTopLevelBlock(editor, current)
                }}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          <div className="article-details-heading" contentEditable={false}>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="article-details-toggle"
              aria-label={open ? "收起折叠内容" : "展开折叠内容"}
              aria-expanded={open}
              aria-controls={contentId}
              onClick={() => changeOpen(!open)}
            >
              <ChevronDown />
            </Button>
            <div className="article-details-summary-field">
              <Input
                ref={summaryInput}
                value={summaryDraft}
                maxLength={ARTICLE_DETAILS_SUMMARY_MAX_LENGTH}
                className="article-details-summary-input"
                aria-label="折叠内容摘要"
                aria-invalid={!validation.valid}
                aria-describedby={
                  validation.error ? `${contentId}-summary-error` : undefined
                }
                onChange={(event) => {
                  const next = event.target.value
                  setSummaryDraft(next)
                  const checked = validateArticleDetailsSummary(next)
                  if (checked.valid && checked.value !== node.attrs.summary) {
                    submittedSummary.current = checked.value
                    updateAttributes({ summary: checked.value })
                  }
                }}
                onBlur={() => {
                  const checked = validateArticleDetailsSummary(summaryDraft)
                  if (!checked.valid) return
                  setSummaryDraft(checked.value)
                  if (checked.value !== node.attrs.summary) {
                    submittedSummary.current = checked.value
                    updateAttributes({ summary: checked.value })
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    selectDetails()
                    return
                  }
                  if (
                    event.key === "Enter" ||
                    (event.key === "Tab" && !event.shiftKey) ||
                    (event.key === "ArrowDown" &&
                      event.currentTarget.selectionStart === summaryDraft.length)
                  ) {
                    event.preventDefault()
                    focusBody()
                  }
                }}
              />
              {validation.error && (
                <span
                  id={`${contentId}-summary-error`}
                  className="article-details-summary-error"
                  role="alert"
                >
                  {validation.error}
                </span>
              )}
            </div>
          </div>
          {content(!open)}
        </section>
      ) : (
        <ArticleDetailsReadonly
          key={`${String(node.attrs.node_id)}:${String(Boolean(node.attrs.open_by_default))}`}
          openByDefault={Boolean(node.attrs.open_by_default)}
          summary={initialSummary}
        >
          {content(false)}
        </ArticleDetailsReadonly>
      )}
    </NodeViewWrapper>
  )
}
