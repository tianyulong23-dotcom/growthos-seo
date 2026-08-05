import * as React from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { LinksWorkspace } from "@/features/outreach/links/links-workspace"
import { ReportsWorkspace } from "@/features/outreach/reports/reports-workspace"
import type { ReportingWindow } from "@/features/outreach/reports/types"

function AnalyticsView({ view }: { view: string }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {[
          [view === "search" ? "自然点击" : "内容点击", "12,648", "+18.4%"],
          ["转化", "486", "+9.2%"],
          ["转化率", "3.84%", "+0.3%"],
          ["预估价值", "¥86,420", "+14.8%"],
        ].map(([label, value, change]) => (
          <div key={label} className="bg-card p-5">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
            <div className="mt-1 text-xs text-emerald-600">{change}</div>
          </div>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{view === "search" ? "渠道表现" : "内容贡献"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {[
            ["Google 自然搜索", 68, "8,598"],
            ["Bing 自然搜索", 21, "2,656"],
            ["AI 搜索引用", 7, "885"],
            ["其他搜索引擎", 4, "509"],
          ].map(([label, value, clicks]) => (
            <div
              key={label}
              className="grid gap-2 sm:grid-cols-[180px_1fr_70px] sm:items-center"
            >
              <span className="text-sm">{label}</span>
              <Progress value={Number(value)} />
              <span className="text-right text-sm text-muted-foreground tabular-nums">
                {clicks}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function createReportingWindow(): ReportingWindow {
  const asOf = new Date()
  const from = new Date(asOf)
  from.setUTCDate(from.getUTCDate() - 30)
  return {
    from: from.toISOString(),
    to: asOf.toISOString(),
    asOf: asOf.toISOString(),
  }
}

export function PerformanceWorkspace({
  view,
  websiteProjectKey,
}: {
  view: string
  websiteProjectKey: string
}) {
  const [reportingWindow] = React.useState(createReportingWindow)

  if (view === "links") {
    return <LinksWorkspace websiteProjectKey={websiteProjectKey} />
  }
  if (view === "reports") {
    return (
      <ReportsWorkspace
        websiteProjectKey={websiteProjectKey}
        workspaceTimezone="UTC"
        reportingWindow={reportingWindow}
      />
    )
  }
  return <AnalyticsView view={view} />
}
