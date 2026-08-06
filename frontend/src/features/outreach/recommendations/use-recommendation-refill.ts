import * as React from "react"

import type { Project } from "@/app/project-context"

import type { RecommendationInventoryStatus } from "./api"

const pollIntervalMs = 2_000
const maxWaitMs = 60_000
const markerRetentionMs = 24 * 60 * 60_000

type ContactBatchWaitStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"

type ContactBatchWaitMarker = {
  websiteProjectKey: string
  websiteProjectId: string
  profileVersionId: string
  contextVersion: number
  batchId: string | null
  startedAt: number
  retainedUntil: number
  pollCount: number
  lastQueryAt: number | null
}

export type RecommendationRefillState = {
  status: ContactBatchWaitStatus
  phase: string
  batchId: string | null
  startedAt: number | null
  elapsedMs: number
  pollCount: number
  lastQueryAt: number | null
  error: string | null
  batch: RecommendationInventoryStatus["contactBatch"]
}

const idleState: RecommendationRefillState = {
  status: "idle",
  phase: "等待查看本批联系人处理进度",
  batchId: null,
  startedAt: null,
  elapsedMs: 0,
  pollCount: 0,
  lastQueryAt: null,
  error: null,
  batch: null,
}

function storageKey(project: Project) {
  return `growthos:contact-batch-wait:${project.id}:${project.profileVersionId}`
}

function readMarker(project: Project): ContactBatchWaitMarker | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(project))
    if (!raw) return null
    const marker = JSON.parse(raw) as ContactBatchWaitMarker
    if (
      marker.websiteProjectKey !== project.id ||
      marker.websiteProjectId !== project.websiteProjectId ||
      marker.profileVersionId !== project.profileVersionId ||
      marker.contextVersion !== project.contextVersion ||
      marker.retainedUntil <= Date.now()
    ) {
      window.sessionStorage.removeItem(storageKey(project))
      return null
    }
    return marker
  } catch {
    window.sessionStorage.removeItem(storageKey(project))
    return null
  }
}

function writeMarker(project: Project, marker: ContactBatchWaitMarker) {
  window.sessionStorage.setItem(storageKey(project), JSON.stringify(marker))
}

function createMarker(
  project: Project,
  batchId: string | null
): ContactBatchWaitMarker {
  const startedAt = Date.now()
  return {
    websiteProjectKey: project.id,
    websiteProjectId: project.websiteProjectId,
    profileVersionId: project.profileVersionId,
    contextVersion: project.contextVersion,
    batchId,
    startedAt,
    retainedUntil: startedAt + markerRetentionMs,
    pollCount: 0,
    lastQueryAt: null,
  }
}

function runningState(
  marker: ContactBatchWaitMarker,
  batch: RecommendationInventoryStatus["contactBatch"] = null
): RecommendationRefillState {
  return {
    status: "running",
    phase:
      batch === null
        ? "正在读取当前项目联系人批次"
        : `正在等待本批联系人终态 ${batch.terminalJobCount}/${batch.totalJobCount}`,
    batchId: marker.batchId,
    startedAt: marker.startedAt,
    elapsedMs: Math.max(0, Date.now() - marker.startedAt),
    pollCount: marker.pollCount,
    lastQueryAt: marker.lastQueryAt,
    error: null,
    batch,
  }
}

export function useRecommendationRefill(
  project: Project,
  pollInventory: () => Promise<RecommendationInventoryStatus | null>
) {
  const scopeKey = `${project.id}:${project.profileVersionId}:${project.contextVersion}`
  const activeScopeRef = React.useRef(scopeKey)
  const pollInFlightRef = React.useRef(false)
  const [state, setState] = React.useState<RecommendationRefillState>(() => {
    const marker = readMarker(project)
    if (!marker) return idleState
    if (Date.now() - marker.startedAt >= maxWaitMs) {
      return {
        ...runningState(marker),
        status: "timed_out",
        phase: "前台等待已结束",
        error: "后台继续处理中",
      }
    }
    return runningState(marker)
  })

  React.useEffect(() => {
    activeScopeRef.current = scopeKey
    return () => {
      if (activeScopeRef.current === scopeKey) {
        activeScopeRef.current = ""
      }
    }
  }, [scopeKey])

  React.useEffect(() => {
    if (state.status !== "running" || state.startedAt === null) return
    const timer = window.setInterval(() => {
      setState((current) =>
        current.status === "running" && current.startedAt !== null
          ? {
              ...current,
              elapsedMs: Math.max(0, Date.now() - current.startedAt),
            }
          : current
      )
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [state.startedAt, state.status])

  React.useEffect(() => {
    if (state.status !== "running") return
    let cancelled = false
    const expectedScope = scopeKey
    const timer = window.setTimeout(async () => {
      if (
        cancelled ||
        pollInFlightRef.current ||
        activeScopeRef.current !== expectedScope
      ) {
        return
      }
      const marker = readMarker(project)
      if (!marker) {
        setState(idleState)
        return
      }
      if (Date.now() - marker.startedAt >= maxWaitMs) {
        setState({
          ...runningState(marker, state.batch),
          status: "timed_out",
          phase: "前台等待已结束",
          elapsedMs: Date.now() - marker.startedAt,
          error: "后台继续处理中",
        })
        return
      }

      pollInFlightRef.current = true
      try {
        const inventory = await pollInventory()
        if (cancelled || activeScopeRef.current !== expectedScope) return
        const queriedAt = Date.now()
        const observedBatch = inventory?.contactBatch ?? null
        const batch =
          marker.batchId === null ||
          observedBatch === null ||
          observedBatch.id === marker.batchId
            ? observedBatch
            : null
        const nextMarker = {
          ...marker,
          batchId: marker.batchId ?? batch?.id ?? null,
          pollCount: marker.pollCount + 1,
          lastQueryAt: queriedAt,
        }
        const terminal =
          batch !== null &&
          (batch.status === "completed" ||
            batch.status === "stale_context" ||
            (batch.totalJobCount > 0 &&
              batch.terminalJobCount >= batch.totalJobCount))
        if (terminal) {
          window.sessionStorage.removeItem(storageKey(project))
          setState({
            status: "succeeded",
            phase:
              batch.status === "stale_context"
                ? "项目资料已更新，本批停止发布"
                : "本批联系人处理已完成",
            batchId: batch.id,
            startedAt: nextMarker.startedAt,
            elapsedMs: queriedAt - nextMarker.startedAt,
            pollCount: nextMarker.pollCount,
            lastQueryAt: queriedAt,
            error: null,
            batch,
          })
          return
        }
        writeMarker(project, nextMarker)
        setState(runningState(nextMarker, batch))
      } catch {
        if (!cancelled && activeScopeRef.current === expectedScope) {
          setState((current) => ({
            ...current,
            status: "failed",
            phase: "联系人批次状态读取失败",
            error: "当前无法读取联系人批次状态。",
          }))
        }
      } finally {
        pollInFlightRef.current = false
      }
    }, pollIntervalMs)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [pollInventory, project, scopeKey, state.batch, state.pollCount, state.status])

  const start = React.useCallback(
    (batchId: string | null = null) => {
      if (project.inputRequired.length > 0 || state.status === "running") return
      const existing = readMarker(project)
      const marker =
        existing === null
          ? createMarker(project, batchId)
          : {
              ...existing,
              batchId: batchId ?? existing.batchId,
              startedAt: Date.now(),
              retainedUntil: Date.now() + markerRetentionMs,
              pollCount: 0,
              lastQueryAt: null,
            }
      writeMarker(project, marker)
      setState(runningState(marker))
    },
    [project, state.status]
  )

  return {
    ...state,
    start,
  }
}
