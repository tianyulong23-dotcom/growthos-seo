import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Link2,
  Mail,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-react"
import { Link } from "react-router"

import { ApiError } from "@/api/client"
import {
  requestBacklinks,
  type BacklinksResponse,
} from "@/api/generated/backlinks"
import { overviewNavigation } from "@/app/platform-navigation"
import { useCurrentProject } from "@/app/project-context"
import { PageHeader } from "@/components/shared/page-header"
import { Button } from "@/components/ui/button"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

type SummaryResponse = BacklinksResponse<"backlinksGetSummaryV1">
type ViewState = "loading" | "ready" | "error" | "forbidden" | "offline"

const formatGeneratedAt = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))

export function OverviewPage() {
  const { currentProject: project } = useCurrentProject()
  if (!project) {
    throw new Error("OverviewPage requires an authorized current project.")
  }
  const projectId = project.id
  const [state, setState] = useState<ViewState>("loading")
  const [response, setResponse] = useState<SummaryResponse | null>(null)
  const requestSequence = useRef(0)
  const summaryKey = useMemo(
    () => createProjectQueryKey(projectId, "summary"),
    [projectId]
  )
  const destinations = [
    {
      label: "推荐与机会",
      detail: "读取服务端推荐、评估与 Opportunity 生命周期。",
      icon: Search,
      href: `/projects/${project.id}/backlinks/recommendations`,
    },
    {
      label: "邮件中心",
      detail: "查看 Gmail 同步、线程、人工确认和发送状态。",
      icon: Mail,
      href: `/projects/${project.id}/backlinks/email`,
    },
    {
      label: "链接监控",
      detail: "查看 Candidate、Confirmed、Changed、Lost 与 Recovered。",
      icon: Link2,
      href: `/projects/${project.id}/performance/links`,
    },
    {
      label: "指标与报告",
      detail: "查看服务端 Metric Snapshot、Report Revision 与导出任务。",
      icon: BarChart3,
      href: `/projects/${project.id}/performance/reports`,
    },
    {
      label: "外联治理",
      detail: "查看设置版本、Retention 与分层 Kill Switch。",
      icon: Settings2,
      href: `/projects/${project.id}/settings/outreach`,
    },
  ]

  const load = useCallback(
    async (force = false) => {
      const request = ++requestSequence.current
      if (force) backlinksProjectQueries.invalidate(summaryKey)
      setState("loading")
      try {
        const next = await backlinksProjectQueries.fetch(summaryKey, (signal) =>
          requestBacklinks(
            "backlinksGetSummaryV1",
            { path: { websiteProjectKey: projectId } },
            { signal }
          )
        )
        if (request !== requestSequence.current) return
        setResponse(next)
        setState("ready")
      } catch (error) {
        if (request !== requestSequence.current) return
        if (error instanceof DOMException && error.name === "AbortError") return
        setResponse(null)
        setState(
          isOutreachOffline()
            ? "offline"
            : error instanceof ApiError && error.status === 403
              ? "forbidden"
              : "error"
        )
      }
    },
    [projectId, summaryKey]
  )

  useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      requestSequence.current += 1
      backlinksProjectQueries.invalidate(summaryKey)
    }
  }, [load, summaryKey])

  return (
    <div className="min-w-0">
      <PageHeader module={overviewNavigation} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-8">
        {state === "loading" ? (
          <OutreachStandardStateView
            state="loading"
            title="正在加载外链项目总览"
          />
        ) : state === "ready" && response ? (
          <>
            <section className="flex flex-col gap-3 border-y bg-muted/20 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-5 text-emerald-600" />
                  <h2 className="text-base font-semibold">
                    {project.name} 外链服务已连接
                  </h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  项目边界由服务端确认，业务计数不在总览页推断。
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  project {response.meta.websiteProjectId} ·{" "}
                  {formatGeneratedAt(response.meta.generatedAt)}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void load(true)}
              >
                <RefreshCw data-icon="inline-start" />
                刷新
              </Button>
            </section>

            <section aria-labelledby="backlinks-destinations-heading">
              <h2
                id="backlinks-destinations-heading"
                className="text-base font-semibold"
              >
                外链工作区
              </h2>
              <div className="mt-3 grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 xl:grid-cols-3">
                {destinations.map((destination) => {
                  const Icon = destination.icon
                  return (
                    <Link
                      key={destination.label}
                      to={destination.href}
                      className="group min-h-36 bg-background p-4 transition hover:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <Icon className="size-5 text-primary" />
                        <ArrowRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5" />
                      </div>
                      <h3 className="mt-5 text-sm font-medium">
                        {destination.label}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        {destination.detail}
                      </p>
                    </Link>
                  )
                })}
              </div>
            </section>
          </>
        ) : (
          <OutreachStandardStateView
            state={state === "ready" ? "error" : state}
            title={
              state === "forbidden"
                ? "无权读取此外链项目"
                : state === "offline"
                  ? "外链项目总览当前离线"
                  : "外链项目总览读取失败"
            }
            description="不会回退到本地指标、任务或活动数据。"
            onRetry={() => void load(true)}
          />
        )}
      </div>
    </div>
  )
}
