import * as React from "react"
import { ArrowDown, ArrowUp, Plus } from "lucide-react"

import { ModuleTableToolbar } from "@/components/shared/module-table-toolbar"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { keywordsNavigation } from "@/features/keywords/manifest"
import { keywordRows } from "@/features/keywords/mock-data"
import { ModulePage } from "@/pages/module-page"

function KeywordsContent({ view }: { view: string }) {
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState("全部")
  const rows = keywordRows.filter(
    (row) =>
      row.keyword.includes(search.toLowerCase()) &&
      (filter === "全部" || row.intent === filter)
  )

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-px border-b bg-border sm:grid-cols-3">
        {[
          [view === "opportunities" ? "可争取机会" : "跟踪关键词", "420"],
          ["前 10 名", "286"],
          ["本周上升", "78"],
        ].map(([label, value]) => (
          <div key={label} className="bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <ModuleTableToolbar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        options={["全部", "商业", "信息"]}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox aria-label="选择全部" />
              </TableHead>
              <TableHead>关键词</TableHead>
              <TableHead>意图</TableHead>
              <TableHead className="text-right">搜索量</TableHead>
              <TableHead className="text-right">排名</TableHead>
              <TableHead className="text-right">变化</TableHead>
              <TableHead>目标页面</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.keyword}>
                <TableCell>
                  <Checkbox aria-label={`选择 ${row.keyword}`} />
                </TableCell>
                <TableCell className="font-medium">{row.keyword}</TableCell>
                <TableCell>
                  <Badge variant="outline">{row.intent}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.volume}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.position}
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={`inline-flex items-center ${
                      row.change.startsWith("+")
                        ? "text-emerald-600"
                        : row.change.startsWith("-")
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}
                  >
                    {row.change.startsWith("+") && (
                      <ArrowUp className="size-3" />
                    )}
                    {row.change.startsWith("-") && (
                      <ArrowDown className="size-3" />
                    )}
                    {row.change}
                  </span>
                </TableCell>
                <TableCell className="max-w-60 truncate text-muted-foreground">
                  {row.url}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

export function KeywordsModulePage() {
  const [actionCount, setActionCount] = React.useState(0)

  return (
    <ModulePage
      module={keywordsNavigation}
      actionLabel={
        actionCount > 0 ? `已添加 ${actionCount} 项` : keywordsNavigation.action
      }
      actionIcon={<Plus />}
      onAction={() => setActionCount((count) => count + 1)}
    >
      {(activeView) => <KeywordsContent view={activeView} />}
    </ModulePage>
  )
}
