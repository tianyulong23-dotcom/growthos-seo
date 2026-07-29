import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileText,
  Globe2,
  Link2,
  Mail,
  Search,
  Sparkles,
  TriangleAlert,
  UserSearch,
} from "lucide-react"
import { Link, useParams } from "react-router"

import { overviewNavigation } from "@/app/platform-navigation"
import { defaultProject, getProject } from "@/app/project-context"
import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

const metrics = [
  { label: "有效推荐", value: "18", detail: "本周新增 6 个" },
  { label: "活跃机会", value: "5", detail: "2 个可继续推进" },
  { label: "邮件回复率", value: "24%", detail: "较上周 +6.2%" },
  { label: "健康外链", value: "12", detail: "1 changed · 1 lost" },
]

export function OverviewPage() {
  const { projectId = defaultProject.id } = useParams()
  const project = getProject(projectId)
  const journey = [
    {
      label: "网站项目",
      value: "1",
      detail: "ElephTV 资料完整度 84%",
      icon: Globe2,
      href: `/projects/${project.id}/backlinks/projects`,
    },
    {
      label: "推荐池",
      value: "18",
      detail: "9 个高匹配网站",
      icon: Search,
      href: `/projects/${project.id}/backlinks/recommendations`,
    },
    {
      label: "补联系人",
      value: "1",
      detail: "watchwise.io 待处理",
      icon: UserSearch,
      href: `/projects/${project.id}/backlinks/opportunities`,
    },
    {
      label: "可写信 / 草稿",
      value: "2",
      detail: "1 封等待人工确认",
      icon: Sparkles,
      href: `/projects/${project.id}/backlinks/email`,
    },
    {
      label: "已发送 / 待回复",
      value: "1",
      detail: "2 天后计划跟进",
      icon: Mail,
      href: `/projects/${project.id}/backlinks/email`,
    },
    {
      label: "回复与洽谈",
      value: "1",
      detail: "收到 1 个合作报价",
      icon: CheckCircle2,
      href: `/projects/${project.id}/backlinks/email`,
    },
    {
      label: "链接监控",
      value: "14",
      detail: "12 active · 1 changed · 1 lost",
      icon: Link2,
      href: `/projects/${project.id}/performance/links`,
    },
    {
      label: "客户报告",
      value: "86%",
      detail: "本月报告数据完整度",
      icon: FileText,
      href: `/projects/${project.id}/performance/reports`,
    },
  ]

  const tasks = [
    {
      title: "补充 watchwise.io 联系人",
      meta: "高优先级 · 外链机会",
      icon: UserSearch,
      href: `/projects/${project.id}/backlinks/opportunities`,
    },
    {
      title: "确认 streamscope.co 开发信",
      meta: "人工确认 · 邮件草稿",
      icon: Mail,
      href: `/projects/${project.id}/backlinks/email`,
    },
    {
      title: "修复 livingroomlab.com 丢失链接",
      meta: "高优先级 · 链接监控",
      icon: TriangleAlert,
      href: `/projects/${project.id}/performance/links`,
    },
  ]

  return (
    <div className="min-w-0">
      <PageHeader module={overviewNavigation} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        <section className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="bg-card p-5">
              <div className="text-sm text-muted-foreground">
                {metric.label}
              </div>
              <div className="mt-2 text-3xl font-semibold tabular-nums">
                {metric.value}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {metric.detail}
              </div>
            </div>
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/25">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>外链旅程工作总览</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    从网站项目、推荐筛选到邮件外联、链接监控与客户报告。
                  </p>
                </div>
                <Badge variant="secondary">elephtv.com · Mock 数据</Badge>
              </div>
            </CardHeader>
            <CardContent className="p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {journey.map((stage, index) => {
                  const Icon = stage.icon
                  return (
                    <Link
                      key={stage.label}
                      to={stage.href}
                      className="group relative min-h-40 rounded-2xl border bg-card p-4 transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-sm"
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                          <Icon className="size-4.5" />
                        </span>
                        <span className="text-xs font-medium text-muted-foreground">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                      </div>
                      <div className="mt-5 text-sm font-medium">
                        {stage.label}
                      </div>
                      <div className="mt-1 text-2xl font-semibold tabular-nums">
                        {stage.value}
                      </div>
                      <div className="mt-2 text-xs leading-5 text-muted-foreground">
                        {stage.detail}
                      </div>
                      <ArrowRight className="absolute right-4 bottom-4 size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                    </Link>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>今日下一步</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  任务从生命周期状态自动汇总
                </p>
              </div>
              <Badge variant="destructive">{tasks.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {tasks.map((task) => {
                const Icon = task.icon
                return (
                  <Link
                    key={task.title}
                    to={task.href}
                    className="flex items-start gap-3 rounded-xl border p-3.5 transition hover:border-primary/30 hover:bg-muted/40"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Icon className="size-4 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {task.title}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {task.meta}
                      </span>
                    </span>
                    <ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground" />
                  </Link>
                )
              })}
              <Button
                variant="outline"
                className="w-full"
                nativeButton={false}
                render={
                  <Link
                    to={`/projects/${project.id}/backlinks/opportunities`}
                  />
                }
              >
                打开外链机会
                <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>项目推进状态</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {[
                ["项目资料完整度", 84, "已具备推荐条件"],
                ["联系人覆盖率", 68, "仍有 1 个高优先级缺口"],
                ["草稿确认进度", 50, "1 / 2 已处理"],
                ["已获得链接健康率", 92, "12 / 14 正常收录"],
              ].map(([label, value, detail]) => (
                <div key={String(label)}>
                  <div className="mb-2 flex justify-between gap-4 text-sm">
                    <span>{label}</span>
                    <span className="text-muted-foreground">{detail}</span>
                  </div>
                  <Progress value={Number(value)} />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>最近活动</CardTitle>
              <Badge variant="outline">实时 Mock</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                ["收到外联回复", "streamerfocus.com 返回合作报价", "18 分钟前"],
                ["推荐池已更新", "新增 6 个美国英语市场网站", "1 小时前"],
                ["链接状态变化", "streamerbase.net Anchor 已改变", "昨天"],
                ["客户报告已准备", "7 月外链增长报告完整度 86%", "7月20日"],
              ].map(([title, detail, time]) => (
                <div key={title} className="flex gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Clock3 className="size-4 text-muted-foreground" />
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
