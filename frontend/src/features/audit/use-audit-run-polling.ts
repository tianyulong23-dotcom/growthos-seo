import * as React from "react"

import { getAuditRun, type AuditRun } from "@/api/audits"

const ACTIVE_AUDIT_STATUSES = new Set([
  "queued",
  "running",
  "stopping",
  "recalculating",
])

type AuditRunPollingOptions = {
  run: AuditRun | null
  onRunChange: (run: AuditRun) => void
  onError: (message: string) => void
  onTerminal: (projectId: string) => void | Promise<unknown>
  fetchRun?: typeof getAuditRun
  intervalMs?: number
}

export function useAuditRunPolling({
  run,
  onRunChange,
  onError,
  onTerminal,
  fetchRun = getAuditRun,
  intervalMs = 1500,
}: AuditRunPollingOptions) {
  const selectedRunKey = run ? `${run.project_id}:${run.run_id}` : null
  const selectedRunKeyRef = React.useRef(selectedRunKey)
  React.useLayoutEffect(() => {
    selectedRunKeyRef.current = selectedRunKey
  }, [selectedRunKey])

  React.useEffect(() => {
    if (!run || !ACTIVE_AUDIT_STATUSES.has(run.status)) {
      return
    }

    let active = true
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const nextRun = await fetchRun(run.project_id, run.run_id)
          if (!active) return

          onRunChange(nextRun)
          if (nextRun.status === "failed") {
            onError(nextRun.message)
          } else {
            onError("")
          }

          if (nextRun.status === "failed" || nextRun.status === "completed") {
            try {
              await onTerminal(nextRun.project_id)
            } catch (error) {
              if (
                selectedRunKeyRef.current !==
                `${nextRun.project_id}:${nextRun.run_id}`
              ) {
                return
              }
              onError(
                `审计状态已更新，但项目状态刷新失败：${
                  error instanceof Error ? error.message : "未知错误"
                }`
              )
            }
          }
        } catch (error) {
          if (!active) return
          onError(error instanceof Error ? error.message : "读取审计进度失败")
        }
      })()
    }, intervalMs)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [fetchRun, intervalMs, onError, onRunChange, onTerminal, run])
}
