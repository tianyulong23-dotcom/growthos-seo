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
    let timer: number
    let polling = true
    const poll = async () => {
      try {
        const nextRun = await fetchRun(run.project_id, run.run_id)
        if (!active || selectedRunKeyRef.current !== selectedRunKey) return
        polling = ACTIVE_AUDIT_STATUSES.has(nextRun.status)

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
        if (!active || selectedRunKeyRef.current !== selectedRunKey) return
        onError(error instanceof Error ? error.message : "读取审计进度失败")
      } finally {
        if (active && polling && selectedRunKeyRef.current === selectedRunKey) {
          timer = window.setTimeout(() => void poll(), intervalMs)
        }
      }
    }
    timer = window.setTimeout(() => void poll(), intervalMs)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [
    fetchRun,
    intervalMs,
    onError,
    onRunChange,
    onTerminal,
    run,
    selectedRunKey,
  ])
}
