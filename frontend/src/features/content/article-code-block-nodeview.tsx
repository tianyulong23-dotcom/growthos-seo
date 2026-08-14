import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react"
import * as React from "react"
import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ARTICLE_CODE_LANGUAGES,
  copyArticleCode,
  normalizeArticleCodeLanguage,
} from "@/features/content/article-code-block"
import { cn } from "@/lib/utils"

export function ArticleCodeBlockNodeView({
  node,
  editor,
  selected,
  updateAttributes,
}: ReactNodeViewProps) {
  const [copyState, setCopyState] = React.useState<
    "idle" | "copied" | "failed"
  >("idle")
  const timeout = React.useRef<number | null>(null)
  const language = normalizeArticleCodeLanguage(node.attrs.language)
  const languageLabel = ARTICLE_CODE_LANGUAGES.find(
    ([value]) => value === language
  )?.[1]

  React.useEffect(
    () => () => {
      if (timeout.current !== null) window.clearTimeout(timeout.current)
    },
    []
  )

  const copy = async () => {
    try {
      await copyArticleCode(node.textContent)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
    if (timeout.current !== null) window.clearTimeout(timeout.current)
    timeout.current = window.setTimeout(() => setCopyState("idle"), 2000)
  }

  return (
    <NodeViewWrapper
      data-node-id={node.attrs.node_id}
      data-language={language}
      className={cn("article-code-block", selected && "is-selected")}
    >
      <div
        className="article-code-block-toolbar"
        contentEditable={false}
        role="toolbar"
        aria-label="代码块工具栏"
      >
        <Select
          value={language}
          disabled={!editor.isEditable}
          onValueChange={(value) =>
            updateAttributes({
              language: value === "plaintext" ? null : value,
            })
          }
        >
          <SelectTrigger
            size="sm"
            className="rounded-md border-border/70 bg-background/10 text-slate-200 hover:bg-background/15"
            aria-label="代码语言"
          >
            <SelectValue>{languageLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent className="rounded-md" align="start">
            {ARTICLE_CODE_LANGUAGES.map(([value, label]) => (
              <SelectItem key={value} value={value} className="rounded-sm">
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-slate-200 hover:bg-white/10 hover:text-white"
          aria-label="复制代码"
          title="复制代码"
          onClick={() => void copy()}
        >
          {copyState === "copied" ? <Check /> : <Copy />}
          {copyState === "copied"
            ? "已复制"
            : copyState === "failed"
              ? "复制失败"
              : "复制"}
        </Button>
      </div>
      <pre>
        <NodeViewContent<"code"> as="code" spellCheck={false} />
      </pre>
      <span className="sr-only" aria-live="polite">
        {copyState === "copied"
          ? "代码已复制"
          : copyState === "failed"
            ? "代码复制失败"
            : ""}
      </span>
    </NodeViewWrapper>
  )
}
