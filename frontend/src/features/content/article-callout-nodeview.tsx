import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react"
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  Copy,
  Info,
  Lightbulb,
  Trash2,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ARTICLE_CALLOUT_ICONS,
  ARTICLE_CALLOUT_TONES,
  normalizeArticleCalloutIcon,
  normalizeArticleCalloutTone,
  type ArticleCalloutIcon,
} from "@/features/content/article-callout"
import {
  deleteArticleTopLevelBlock,
  duplicateArticleTopLevelBlock,
  moveArticleTopLevelBlock,
} from "@/features/content/article-editor-operations"
import { cn } from "@/lib/utils"

const CALLOUT_ICONS = {
  info: Info,
  lightbulb: Lightbulb,
  "triangle-alert": TriangleAlert,
  "circle-check": CircleCheck,
} satisfies Record<ArticleCalloutIcon, typeof Info>

export function ArticleCalloutNodeView({
  node,
  editor,
  selected,
  getPos,
  updateAttributes,
}: ReactNodeViewProps) {
  const tone = normalizeArticleCalloutTone(node.attrs.tone)
  const icon = normalizeArticleCalloutIcon(node.attrs.icon)
  const Icon = icon ? CALLOUT_ICONS[icon] : null
  const position = getPos()
  const editable = editor.isEditable && typeof position === "number"
  const canMoveUp = editable && position > 0
  const canMoveDown =
    editable && position + node.nodeSize < editor.state.doc.content.size
  const currentPosition = () => {
    const current = getPos()
    return typeof current === "number" ? current : null
  }

  return (
    <NodeViewWrapper
      as="aside"
      data-article-node="callout"
      data-node-id={node.attrs.node_id}
      data-tone={tone}
      data-icon={icon ?? undefined}
      className={cn("article-callout", selected && "is-selected")}
    >
      {editor.isEditable && (
        <div
          className="article-callout-toolbar"
          contentEditable={false}
          role="toolbar"
          aria-label="提示框工具栏"
        >
          <div className="article-callout-tone-control" aria-label="提示框类型">
            {ARTICLE_CALLOUT_TONES.map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={tone === value ? "secondary" : "ghost"}
                aria-label={`设为${label}`}
                aria-pressed={tone === value}
                onClick={() => updateAttributes({ tone: value })}
              >
                {label}
              </Button>
            ))}
          </div>
          <Select
            value={icon ?? "none"}
            onValueChange={(value) =>
              updateAttributes({ icon: value === "none" ? null : value })
            }
          >
            <SelectTrigger size="sm" aria-label="提示框图标">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-md" align="start">
              <SelectItem value="none" className="rounded-sm">
                无图标
              </SelectItem>
              {ARTICLE_CALLOUT_ICONS.map(([value, label]) => (
                <SelectItem key={value} value={value} className="rounded-sm">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="article-callout-block-actions">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="上移提示框"
              title="上移提示框"
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
              aria-label="下移提示框"
              title="下移提示框"
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
              aria-label="复制提示框"
              title="复制提示框"
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
              aria-label="删除提示框"
              title="删除提示框"
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
      )}
      <div className="article-callout-body">
        {Icon && (
          <span
            className="article-callout-icon"
            contentEditable={false}
            aria-hidden="true"
          >
            <Icon />
          </span>
        )}
        <NodeViewContent className="article-callout-content" />
      </div>
    </NodeViewWrapper>
  )
}
