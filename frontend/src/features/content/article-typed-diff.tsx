import * as React from "react"
import { ChevronDown } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import type { ArticleVersionDiff } from "@/api/articles"
import { cn } from "@/lib/utils"

const METADATA_LABELS: Record<string, string> = {
  title: "标题",
  slug: "Slug",
  meta_title: "Meta Title",
  meta_description: "Meta Description",
  focus_keyword: "主关键词",
  secondary_keywords: "次关键词",
  canonical_url: "Canonical URL",
  indexing: "索引设置",
  field_states: "SEO 字段状态",
  publication_status: "质量状态",
}

function valueLabel(value: unknown) {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

function changeKindLabel(value: string) {
  return (
    {
      added: "新增",
      removed: "删除",
      moved: "移动",
      updated: "更新",
      marks_changed: "格式变化",
      reordered: "顺序变化",
      item_changed: "项目变化",
      asset_replaced: "资产替换",
      attributes_changed: "属性变化",
      cell_changed: "单元格变化",
    }[value] ?? value
  )
}

function ValuePair({ before, after }: { before: unknown; after: unknown }) {
  return (
    <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
      <pre className="max-h-44 overflow-auto rounded-sm bg-red-50 p-2 break-words whitespace-pre-wrap text-red-900 dark:bg-red-950/30 dark:text-red-100">
        {valueLabel(before)}
      </pre>
      <pre className="max-h-44 overflow-auto rounded-sm bg-emerald-50 p-2 break-words whitespace-pre-wrap text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100">
        {valueLabel(after)}
      </pre>
    </div>
  )
}

export function ArticleTypedDiff({ diff }: { diff: ArticleVersionDiff }) {
  const [lineDiffOpen, setLineDiffOpen] = React.useState(false)
  const summary = diff.summary
  const hasTypedChanges =
    diff.block_changes.length > 0 ||
    diff.inline_changes.length > 0 ||
    diff.media_changes.length > 0 ||
    diff.table_changes.length > 0 ||
    diff.metadata_changes.length > 0

  return (
    <div className="space-y-5" data-testid="article-typed-diff">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">块新增 {summary.blocks_added}</Badge>
        <Badge variant="outline">块删除 {summary.blocks_removed}</Badge>
        <Badge variant="outline">块移动 {summary.blocks_moved}</Badge>
        <Badge variant="outline">块更新 {summary.blocks_updated}</Badge>
        <Badge variant="outline">行内 {summary.inline_changes}</Badge>
        <Badge variant="outline">媒体 {summary.media_changes}</Badge>
        <Badge variant="outline">表格 {summary.table_changes}</Badge>
        <Badge variant="outline">元数据 {summary.metadata_changes}</Badge>
        <Badge variant="secondary" title="差异算法版本">
          {diff.algorithm_version}
        </Badge>
      </div>

      {!hasTypedChanges && (
        <p className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
          两个版本没有结构化变化。
        </p>
      )}

      {diff.block_changes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">内容块变化</h3>
          <div className="divide-y rounded-md border">
            {diff.block_changes.map((change) => (
              <article key={change.change_id} className="p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">
                    {changeKindLabel(change.kind)}
                  </Badge>
                  <span className="font-medium">{change.node_type}</span>
                  <span className="font-mono text-muted-foreground">
                    {change.node_id}
                  </span>
                  {(change.before_index !== null ||
                    change.after_index !== null) && (
                    <span className="text-muted-foreground">
                      位置 {change.before_index ?? "-"} →{" "}
                      {change.after_index ?? "-"}
                    </span>
                  )}
                </div>
                <ValuePair before={change.before} after={change.after} />
                {change.attribute_changes.length > 0 && (
                  <div className="mt-2 space-y-1 border-t pt-2 text-xs">
                    {change.attribute_changes.map((item) => (
                      <p key={item.path}>
                        <span className="font-mono">{item.path}</span>：
                        {valueLabel(item.before)} → {valueLabel(item.after)}
                      </p>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {diff.inline_changes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">文字与格式变化</h3>
          <div className="divide-y rounded-md border">
            {diff.inline_changes.map((change) => (
              <article key={change.change_id} className="p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">
                    {changeKindLabel(change.kind)}
                  </Badge>
                  <span className="font-mono text-muted-foreground">
                    {change.node_id}
                  </span>
                  <span className="text-muted-foreground">
                    {change.before_range?.join("-") ?? "-"} →{" "}
                    {change.after_range?.join("-") ?? "-"}
                  </span>
                </div>
                <ValuePair
                  before={change.before_text}
                  after={change.after_text}
                />
                {(change.before_marks.length > 0 ||
                  change.after_marks.length > 0) && (
                  <ValuePair
                    before={change.before_marks}
                    after={change.after_marks}
                  />
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {diff.media_changes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">媒体变化</h3>
          <div className="divide-y rounded-md border">
            {diff.media_changes.map((change) => (
              <article key={change.change_id} className="p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">
                    {changeKindLabel(change.kind)}
                  </Badge>
                  <span>{change.node_type}</span>
                  <span className="font-mono text-muted-foreground">
                    {change.node_id}
                  </span>
                  <span className="font-mono text-muted-foreground">
                    {change.path}
                  </span>
                </div>
                <ValuePair before={change.before} after={change.after} />
              </article>
            ))}
          </div>
        </section>
      )}

      {diff.table_changes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">表格变化</h3>
          <div className="divide-y rounded-md border">
            {diff.table_changes.map((change) => (
              <article key={change.change_id} className="p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">单元格变化</Badge>
                  <span className="font-mono text-muted-foreground">
                    {change.node_id}
                  </span>
                  <span>
                    第 {change.row + 1} 行，第 {change.column + 1} 列
                  </span>
                </div>
                <ValuePair before={change.before} after={change.after} />
              </article>
            ))}
          </div>
        </section>
      )}

      {diff.metadata_changes.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">搜索与发布元数据变化</h3>
          <div className="divide-y rounded-md border">
            {diff.metadata_changes.map((change) => (
              <article key={change.field} className="p-3">
                <p className="text-xs font-medium">
                  {METADATA_LABELS[change.field] ?? change.field}
                </p>
                <ValuePair before={change.before} after={change.after} />
              </article>
            ))}
          </div>
        </section>
      )}

      <Collapsible
        open={lineDiffOpen}
        onOpenChange={setLineDiffOpen}
        className="rounded-md border"
      >
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              className="h-10 w-full justify-between rounded-none px-3"
            />
          }
        >
          <span>
            兼容行差异（+{diff.added_lines} / -{diff.removed_lines}）
          </span>
          <ChevronDown
            className={cn("transition-transform", lineDiffOpen && "rotate-180")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="max-h-80 overflow-auto border-t bg-muted/20 font-mono text-xs">
          {diff.lines.length === 0 ? (
            <p className="p-4 text-muted-foreground">没有行差异。</p>
          ) : (
            diff.lines.map((line, index) => (
              <div
                key={`${index}:${line.kind}:${line.old_line_number}:${line.new_line_number}`}
                className={
                  line.kind === "added"
                    ? "grid min-w-[640px] grid-cols-[48px_48px_24px_1fr] bg-emerald-50 dark:bg-emerald-950/30"
                    : line.kind === "removed"
                      ? "grid min-w-[640px] grid-cols-[48px_48px_24px_1fr] bg-red-50 dark:bg-red-950/30"
                      : "grid min-w-[640px] grid-cols-[48px_48px_24px_1fr]"
                }
              >
                <span className="border-r px-2 py-1 text-right text-muted-foreground">
                  {line.old_line_number ?? ""}
                </span>
                <span className="border-r px-2 py-1 text-right text-muted-foreground">
                  {line.new_line_number ?? ""}
                </span>
                <span className="px-2 py-1">
                  {line.kind === "added"
                    ? "+"
                    : line.kind === "removed"
                      ? "-"
                      : " "}
                </span>
                <span className="py-1 pr-3 break-words whitespace-pre-wrap">
                  {line.content || " "}
                </span>
              </div>
            ))
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
