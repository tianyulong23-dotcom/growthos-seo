import * as React from "react"
import {
  CheckCircle2,
  Download,
  FileText,
  Link2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type LinkStatus = "active" | "changed" | "lost"

type MonitoredLink = {
  domain: string
  page: string
  anchor: string
  status: LinkStatus
  checked: string
}

const monitoredLinks: MonitoredLink[] = [
  {
    domain: "techviewdaily.com",
    page: "/best-free-tv-apps",
    anchor: "ElephTV",
    status: "active",
    checked: "12 分钟前",
  },
  {
    domain: "streamerbase.net",
    page: "/cord-cutting-guide",
    anchor: "free streaming",
    status: "changed",
    checked: "1 小时前",
  },
  {
    domain: "livingroomlab.com",
    page: "/smart-tv-tools",
    anchor: "ElephTV app",
    status: "lost",
    checked: "昨天",
  },
]

const linkStatus: Record<
  LinkStatus,
  { label: string; variant: "default" | "secondary" | "destructive" }
> = {
  active: { label: "正常收录", variant: "default" as const },
  changed: { label: "链接变化", variant: "secondary" as const },
  lost: { label: "链接丢失", variant: "destructive" as const },
}

function AnalyticsView({ view }: { view: string }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
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

function LinkMonitoringView() {
  const [checking, setChecking] = React.useState(false)
  const [message, setMessage] = React.useState("")

  function notify(nextMessage: string) {
    setMessage(nextMessage)
    window.setTimeout(() => setMessage(""), 2200)
  }

  return (
    <div>
      {message && (
        <div className="mb-5 flex items-center gap-2 rounded-xl border bg-muted/50 px-4 py-3 text-sm">
          <CheckCircle2 className="size-4 text-emerald-600" />
          {message}
        </div>
      )}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["正常收录", "12", "92% 健康率"],
          ["链接变化", "1", "Anchor 已改变"],
          ["链接丢失", "1", "已生成修复任务"],
          ["下次检查", "6 小时后", "每日自动检查"],
        ].map(([label, value, detail]) => (
          <Card key={label} size="sm">
            <CardContent>
              <div className="text-sm text-muted-foreground">{label}</div>
              <div className="mt-2 text-2xl font-semibold">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-medium">外链健康检查</div>
            <div className="text-xs text-muted-foreground">
              监控 active、changed、lost，并从异常生成任务
            </div>
          </div>
          <Button
            disabled={checking}
            onClick={() => {
              setChecking(true)
              window.setTimeout(() => {
                setChecking(false)
                notify("检查完成：12 active / 1 changed / 1 lost")
              }, 1000)
            }}
          >
            <RefreshCw className={checking ? "animate-spin" : ""} />
            {checking ? "检查中" : "检查全部链接"}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>来源网站</TableHead>
                <TableHead>发布页面</TableHead>
                <TableHead>Anchor</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最近检查</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {monitoredLinks.map((item) => (
                <TableRow key={item.domain}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      <Link2 className="size-4 text-muted-foreground" />
                      {item.domain}
                    </span>
                  </TableCell>
                  <TableCell>{item.page}</TableCell>
                  <TableCell>{item.anchor}</TableCell>
                  <TableCell>
                    <Badge variant={linkStatus[item.status].variant}>
                      {linkStatus[item.status].label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.checked}
                  </TableCell>
                  <TableCell>
                    {item.status === "active" ? (
                      <Button variant="outline" size="sm">
                        查看详情
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          notify(`${item.domain} 修复任务已加入顶部任务中心`)
                        }
                      >
                        <TriangleAlert />
                        创建修复任务
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  )
}

function ReportView() {
  const [generating, setGenerating] = React.useState(false)
  const [generated, setGenerated] = React.useState(false)

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="bg-[#f5f3ee] p-3 dark:bg-muted/30">
        <div className="mx-auto w-full max-w-3xl rounded-3xl bg-card p-7 shadow-sm sm:p-10">
          <div className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            Monthly outreach report · July 2026
          </div>
          <h2 className="mt-3 text-2xl font-semibold">
            elephtv.com 外链增长进展
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            推荐筛选、邮件外联和已获得链接的客户安全汇总。
          </p>
          <div className="my-7 grid gap-3 sm:grid-cols-3">
            {[
              ["新增机会", "18"],
              ["收到回复", "6"],
              ["健康链接", "12"],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-muted/60 p-4">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-2 text-2xl font-semibold">{value}</div>
              </div>
            ))}
          </div>
          <div className="space-y-6 border-t pt-6">
            <section>
              <h3 className="font-medium">本月进展</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                邮件回复率达到 24%。新增 3 条有效收录，其中 1 条链接发生
                anchor 变化，已进入修复流程。
              </p>
            </section>
            <section>
              <h3 className="font-medium">下月重点</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                推进 4 个可写信机会，完成 2 个待发布站点跟进，并优先恢复丢失链接。
              </p>
            </section>
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>报告状态</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span>数据完整度</span>
              <Badge variant="secondary">86%</Badge>
            </div>
            <Progress value={86} />
            <div className="text-xs leading-5 text-muted-foreground">
              客户报告不会包含供应商报价、内部成本、API 原始响应或调试字段。
            </div>
            <Button
              className="w-full"
              disabled={generating}
              onClick={() => {
                setGenerating(true)
                setGenerated(false)
                window.setTimeout(() => {
                  setGenerating(false)
                  setGenerated(true)
                }, 1000)
              }}
            >
              <FileText />
              {generating
                ? "生成中..."
                : generated
                  ? "报告已生成"
                  : "生成客户报告"}
            </Button>
            <Button variant="outline" className="w-full">
              <Download />
              导出预览
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export function PerformanceWorkspace({ view }: { view: string }) {
  if (view === "links") return <LinkMonitoringView />
  if (view === "reports") return <ReportView />
  return <AnalyticsView view={view} />
}
