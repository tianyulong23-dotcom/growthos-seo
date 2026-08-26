import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router"

import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"
import { linksApi } from "@/features/outreach/links/api"
import { LinksWorkspace } from "@/features/outreach/links/links-workspace"
import { MailSyncStatusPanel } from "@/features/outreach/mail/mail-sync-status-panel"
import { OpportunitiesWorkspace } from "@/features/outreach/opportunities/opportunities-workspace"
import { toOutreachProject } from "@/features/outreach/project"
import { RecommendationsWorkspace } from "@/features/outreach/recommendations/recommendations-workspace"
import { ReportsWorkspace } from "@/features/outreach/reports/reports-workspace"
import type { ReportingWindow } from "@/features/outreach/reports/types"
import {
  getSettings,
  isSettingsApiStatus,
} from "@/features/outreach/settings/api"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import type { Project } from "@/features/projects/types"

type ReportsConfiguration = {
  workspaceTimezone: string
  reportingWindow: ReportingWindow
}

function ReportsRouteWorkspace({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const [configuration, setConfiguration] =
    useState<ReportsConfiguration | null>(null)
  const [state, setState] = useState<"loading" | "error" | "forbidden">(
    "loading"
  )
  const request = useRef(0)
  const asOf = useMemo(() => new Date().toISOString(), [websiteProjectKey])
  const settingsKey = useMemo(
    () => createProjectQueryKey(websiteProjectKey, "settings-governance"),
    [websiteProjectKey]
  )

  const load = useCallback(
    async (force = false) => {
      const currentRequest = ++request.current
      if (force) backlinksProjectQueries.invalidate(settingsKey)
      setState("loading")
      setConfiguration(null)
      try {
        const response = await backlinksProjectQueries.fetch(
          settingsKey,
          (signal) => getSettings(websiteProjectKey, signal)
        )
        if (currentRequest !== request.current) return
        const lookbackMs =
          response.settings.values.reportLookbackDays * 24 * 60 * 60 * 1000
        setConfiguration({
          workspaceTimezone: response.settings.values.reportingTimezone,
          reportingWindow: {
            from: new Date(new Date(asOf).getTime() - lookbackMs).toISOString(),
            to: asOf,
            asOf,
          },
        })
      } catch (error) {
        if (currentRequest !== request.current) return
        if (error instanceof DOMException && error.name === "AbortError") return
        setState(isSettingsApiStatus(error, 403) ? "forbidden" : "error")
      }
    },
    [asOf, settingsKey, websiteProjectKey]
  )

  useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      request.current += 1
    }
  }, [load])

  if (configuration === null) {
    return (
      <OutreachStandardStateView
        state={state}
        title={
          state === "loading"
            ? "正在读取报告配置"
            : state === "forbidden"
              ? "没有读取此项目报告配置的权限"
              : "报告配置读取失败"
        }
        description="报告时区和统计窗口必须来自当前项目的服务端设置。"
        onRetry={state === "loading" ? undefined : () => void load(true)}
      />
    )
  }

  return (
    <ReportsWorkspace
      websiteProjectKey={websiteProjectKey}
      workspaceTimezone={configuration.workspaceTimezone}
      reportingWindow={configuration.reportingWindow}
    />
  )
}

function BusinessContextBar({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const [searchParams] = useSearchParams()
  const context = [
    ["Opportunity", searchParams.get("opportunityId")],
    ["Reply", searchParams.get("replyId")],
    ["Placement", searchParams.get("placementId")],
  ].filter((item): item is [string, string] => Boolean(item[1]?.trim()))
  const returnTo = searchParams.get("returnTo")
  const performanceReturnTo = `/projects/${websiteProjectKey}/performance/backlinks`
  const safeReturnTo =
    returnTo?.startsWith(`/projects/${websiteProjectKey}/backlinks/`) === true ||
    returnTo === performanceReturnTo ||
    returnTo?.startsWith(`${performanceReturnTo}?`) === true
      ? returnTo
      : null

  if (context.length === 0 && safeReturnTo === null) return null

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-y bg-muted/20 px-3 py-2 text-xs">
      {context.map(([label, value]) => (
        <span className="break-all" key={label}>
          <span className="text-muted-foreground">{label}：</span>
          {value}
        </span>
      ))}
      {safeReturnTo ? (
        <Link
          className="ml-auto text-primary hover:underline"
          to={safeReturnTo}
        >
          返回来源
        </Link>
      ) : null}
    </div>
  )
}

export function OutreachWorkspace({
  view,
  project,
}: {
  view: string
  project: Project
}) {
  const projectId = project.id
  const gmailConnection = useGmailConnection(projectId, view === "email")
  let content

  if (view === "recommendations") {
    content = <RecommendationsWorkspace project={toOutreachProject(project)} />
  } else if (view === "opportunities") {
    content = <OpportunitiesWorkspace websiteProjectKey={projectId} />
  } else if (view === "links") {
    content = <LinksWorkspace client={linksApi} websiteProjectKey={projectId} />
  } else if (view === "reports") {
    content = <ReportsRouteWorkspace websiteProjectKey={projectId} />
  } else if (view === "email") {
    content = <MailSyncStatusPanel controller={gmailConnection} />
  } else {
    content = (
      <OutreachStandardStateView
        state="error"
        title="页面不可用"
        description="当前 Outreach 路由未注册。"
      />
    )
  }

  return (
    <>
      <BusinessContextBar websiteProjectKey={projectId} />
      {content}
    </>
  )
}
