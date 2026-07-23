import { ArrowDownRight, ArrowRight, ArrowUpRight, Clock3 } from "lucide-react"
import { Link, useParams } from "react-router"
import { Line, LineChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Progress } from "@/components/ui/progress"
import { modules, trendData } from "@/data/mock-data"
import { useProjects } from "@/features/projects/project-context"

const chartConfig = {
  clicks: { label: "自然点击", color: "var(--chart-4)" },
  impressions: { label: "搜索曝光", color: "var(--chart-1)" },
} satisfies ChartConfig

const metrics = [
  {
    label: "自然点击",
    value: "12,648",
    change: "+18.4%",
    positive: true,
  },
  {
    label: "搜索曝光",
    value: "168,420",
    change: "+12.7%",
    positive: true,
  },
  {
    label: "关键词前 10",
    value: "286",
    change: "+21",
    positive: true,
  },
  {
    label: "平均排名",
    value: "18.6",
    change: "-1.8",
    positive: true,
  },
]

export function OverviewPage() {
  const { projects, getProject } = useProjects()
  const { projectId = projects[0]?.id ?? "" } = useParams()
  const overview = modules[0]
  const project = getProject(projectId)
  const auditStarted = project.auditStatus !== "never_started"

  return (
    <div className="min-w-0">
      <PageHeader module={overview} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <section className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="bg-card p-4">
              <div className="text-sm text-muted-foreground">
                {metric.label}
              </div>
              <div className="mt-2 flex items-end justify-between gap-3">
                <div className="text-2xl font-semibold tabular-nums">
                  {metric.value}
                </div>
                <div className="flex items-center text-xs font-medium text-emerald-600">
                  {metric.positive ? (
                    <ArrowUpRight className="size-3.5" />
                  ) : (
                    <ArrowDownRight className="size-3.5" />
                  )}
                  {metric.change}
                </div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                较前 28 天
              </div>
            </div>
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)]">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>自然搜索趋势</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  最近 7 天点击和曝光变化
                </p>
              </div>
              <Badge variant="secondary">每日</Badge>
            </CardHeader>
            <CardContent>
              <ChartContainer config={chartConfig} className="h-[280px] w-full">
                <LineChart data={trendData} margin={{ left: -12, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                  />
                  <YAxis
                    yAxisId="left"
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `${Math.round(value / 1000)}k`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="clicks"
                    stroke="var(--color-clicks)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="impressions"
                    stroke="var(--color-impressions)"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>项目健康度</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {auditStarted ? (
                <div>
                  <div className="mb-2 text-4xl font-semibold tabular-nums">
                    {project.auditHealth ?? "--"}
                  </div>
                  <Progress value={project.auditHealth ?? 0} />
                  <p className="mt-3 text-xs text-muted-foreground">
                    详细问题和页面数据请前往网站审计查看。
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm font-medium">尚未开始网站审计</p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    网站业务识别不会自动运行技术审计。
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={
                      <Link to={`/projects/${project.id}/audit/overview`} />
                    }
                  >
                    开始网站审计
                    <ArrowRight />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>待处理事项</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link to={`/projects/${project.id}/audit/issues`} />}
              >
                全部问题
                <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="py-6 text-sm text-muted-foreground">
                {auditStarted
                  ? "请前往网站审计查看实际检测到的问题。"
                  : "完成网站审计后，待处理问题会显示在这里。"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>最近活动</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                ["内容简报已创建", "2026 年太阳能税收抵免完整指南", "1 小时前"],
                ["关键词已导入", "新增 86 个商业意图关键词", "昨天"],
                [
                  "外链状态已更新",
                  "renewableenergyworld.com 已获得",
                  "7月15日",
                ],
              ].map(([title, detail, time]) => (
                <div key={title} className="flex gap-3">
                  <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Clock3 className="size-3.5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {detail}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {time}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  )
}
