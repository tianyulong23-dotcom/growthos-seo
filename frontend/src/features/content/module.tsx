import * as React from "react"
import { ArrowRight, ExternalLink, FilePlus2 } from "lucide-react"

import { ModuleTableToolbar } from "@/components/shared/module-table-toolbar"
import { StatusBadge } from "@/components/shared/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { contentNavigation } from "@/features/content/manifest"
import { contentRows } from "@/features/content/mock-data"
import { ModulePage } from "@/pages/module-page"

function ContentContent({ view }: { view: string }) {
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState("全部")
  const rows = contentRows.filter(
    (row) =>
      row.title.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "全部" || row.status === filter)
  )

  if (view === "opportunities") {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[
          ["solar tax credit 2026", "高", "6,600", "预计 +1,240 点击/月"],
          ["solar battery payback", "高", "3,600", "预计 +680 点击/月"],
          ["solaredge vs enphase", "中", "2,900", "预计 +420 点击/月"],
          ["best solar companies florida", "中", "2,400", "预计 +350 点击/月"],
        ].map(([keyword, priority, volume, impact]) => (
          <Card key={keyword}>
            <CardContent className="flex items-center gap-4 p-5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate font-medium">{keyword}</h3>
                  <Badge variant={priority === "高" ? "default" : "secondary"}>
                    {priority}优先级
                  </Badge>
                </div>
                <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                  <span>搜索量 {volume}</span>
                  <span>{impact}</span>
                </div>
              </div>
              <Button variant="outline" size="sm">
                创建简报
                <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        ))}
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
        options={["全部", "草稿", "撰写中", "待审核", "已发布"]}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>内容</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>目标关键词</TableHead>
              <TableHead className="text-right">SEO 评分</TableHead>
              <TableHead>最后更新</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.title}>
                <TableCell className="max-w-80 font-medium">
                  {row.title}
                </TableCell>
                <TableCell>
                  <StatusBadge value={row.status} />
                </TableCell>
                <TableCell>{row.keyword}</TableCell>
                <TableCell className="text-right">
                  <span
                    className={
                      row.score >= 80 ? "text-emerald-600" : "text-amber-600"
                    }
                  >
                    {row.score}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.updated}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" title="打开内容">
                    <ExternalLink />
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

export function ContentModulePage() {
  const [actionCount, setActionCount] = React.useState(0)

  return (
    <ModulePage
      module={contentNavigation}
      actionLabel={
        actionCount > 0 ? `已添加 ${actionCount} 项` : contentNavigation.action
      }
      actionIcon={<FilePlus2 />}
      onAction={() => setActionCount((count) => count + 1)}
    >
      {(activeView) => <ContentContent view={activeView} />}
    </ModulePage>
  )
}
