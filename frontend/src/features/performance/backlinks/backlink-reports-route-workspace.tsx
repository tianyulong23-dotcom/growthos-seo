import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { ReportsWorkspace } from "@/features/outreach/reports/reports-workspace"
import type { ReportingWindow } from "@/features/outreach/reports/types"
import {
  getSettings,
  isSettingsApiStatus,
} from "@/features/outreach/settings/api"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

type ReportsConfiguration = {
  workspaceTimezone: string
  reportingWindow: ReportingWindow
}

export function BacklinkReportsRouteWorkspace({
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
  const asOf = useMemo(() => new Date().toISOString(), [])
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
