import * as React from "react"
import { ArrowRight, LoaderCircle, Play } from "lucide-react"

import { ModuleTableToolbar } from "@/components/shared/module-table-toolbar"
import { StatusBadge } from "@/components/shared/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { auditNavigation } from "@/features/audit/manifest"
import { auditRows } from "@/features/audit/mock-data"
import { ModulePage } from "@/pages/module-page"

function AuditContent({ view }: { view: string }) {
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState("全部")
  const rows = auditRows.filter(
    (row) =>
      row.item.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "全部" || row.type === filter)
  )

  if (view === "overview") {
    return (
      <div className="grid gap-6 xl:grid-cols-[1fr_1.3fr]">
        <Card>
          <CardHeader>
            <CardTitle>审计健康度</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between">
              <div className="text-5xl font-semibold">86</div>
              <Badge className="bg-emerald-600">良好</Badge>
            </div>
            <Progress value={86} className="mt-4" />
            <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border text-center">
              {[
                ["29", "错误"],
                ["76", "警告"],
                ["143", "提示"],
              ].map(([value, label]) => (
                <div key={label} className="bg-background p-3">
                  <div className="text-xl font-semibold tabular-nums">
                    {value}
                  </div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>问题分布</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              ["索引与抓取", 73, 18],
              ["页面元素", 58, 31],
              ["性能体验", 42, 26],
              ["站内链接", 81, 11],
              ["结构化数据", 89, 7],
            ].map(([label, score, count]) => (
              <div key={label}>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="text-muted-foreground">{count} 个问题</span>
                </div>
                <Progress value={Number(score)} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <Card className="overflow-hidden">
      <ModuleTableToolbar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        options={["全部", "错误", "警告", "提示"]}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox aria-label="选择全部" />
              </TableHead>
              <TableHead>{view === "pages" ? "页面问题" : "问题"}</TableHead>
              <TableHead>类型</TableHead>
              <TableHead className="text-right">受影响</TableHead>
              <TableHead className="text-right">变化</TableHead>
              <TableHead>负责人</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.item}>
                <TableCell>
                  <Checkbox aria-label={`选择 ${row.item}`} />
                </TableCell>
                <TableCell className="font-medium">{row.item}</TableCell>
                <TableCell>
                  <StatusBadge value={row.type} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.count}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${
                    row.change.startsWith("+")
                      ? "text-destructive"
                      : "text-emerald-600"
                  }`}
                >
                  {row.change}
                </TableCell>
                <TableCell>{row.owner}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" title="查看详情">
                    <ArrowRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

export function AuditModulePage() {
  const [running, setRunning] = React.useState(false)

  function startScan() {
    setRunning(true)
    window.setTimeout(() => setRunning(false), 2200)
  }

  return (
    <ModulePage
      module={auditNavigation}
      actionLabel={running ? "扫描中..." : auditNavigation.action}
      actionIcon={
        running ? <LoaderCircle className="animate-spin" /> : <Play />
      }
      onAction={startScan}
      actionDisabled={running}
      beforeContent={
        running ? (
          <div className="mb-5 rounded-md border bg-muted/40 p-4">
            <div className="flex items-center gap-3">
              <LoaderCircle className="size-4 animate-spin text-primary" />
              <div className="flex-1">
                <div className="text-sm font-medium">正在扫描网站页面</div>
                <div className="text-xs text-muted-foreground">
                  当前为前端演示，任务将在几秒后完成
                </div>
              </div>
            </div>
            <Progress value={68} className="mt-3 h-1.5" />
          </div>
        ) : null
      }
    >
      {(activeView) => <AuditContent view={activeView} />}
    </ModulePage>
  )
}
