import * as React from "react"

import type { Project } from "@/app/project-context"

import {
  requestRecommendationRefill,
  type RecommendationItem,
} from "./api"

const targetInventory = 20
const pollIntervalMs = 2_000
const maxWaitMs = 10 * 60_000

type RefillStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"

type RefillMarker = {
  websiteProjectKey: string
  websiteProjectId: string
  profileVersionId: string
  contextVersion: number
  idempotencyKey: string
  refillWindowKey: string
  jobId: string | null
  workflowId: string | null
  startedAt: number
  expiresAt: number
  pollCount: number
  lastQueryAt: number | null
}

export type RecommendationRefillState = {
  status: RefillStatus
  phase: string
  jobId: string | null
  startedAt: number | null
  elapsedMs: number
  pollCount: number
  lastQueryAt: number | null
  error: string | null
}

const idleState: RecommendationRefillState = {
  status: "idle",
  phase: "等待用户生成推荐",
  jobId: null,
  startedAt: null,
  elapsedMs: 0,
  pollCount: 0,
  lastQueryAt: null,
  error: null,
}

function storageKey(project: Project) {
  return `growthos:recommendation-refill:${project.id}:${project.profileVersionId}`
}

function readMarker(project: Project): RefillMarker | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(project))
    if (!raw) return null
    const marker = JSON.parse(raw) as RefillMarker
    if (
      marker.websiteProjectKey !== project.id ||
      marker.websiteProjectId !== project.websiteProjectId ||
      marker.profileVersionId !== project.profileVersionId ||
      marker.contextVersion !== project.contextVersion ||
      marker.expiresAt <= Date.now()
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

function writeMarker(project: Project, marker: RefillMarker) {
  window.sessionStorage.setItem(storageKey(project), JSON.stringify(marker))
}

function runningState(marker: RefillMarker): RecommendationRefillState {
  return {
    status: "running",
    phase:
      marker.pollCount === 0
        ? "补池任务已提交"
        : "正在读取当前项目推荐库存",
    jobId: marker.jobId,
    startedAt: marker.startedAt,
    elapsedMs: Math.max(0, Date.now() - marker.startedAt),
    pollCount: marker.pollCount,
    lastQueryAt: marker.lastQueryAt,
    error: null,
  }
}

function createMarker(project: Project): RefillMarker {
  const startedAt = Date.now()
  const windowStart = new Date(
    Math.floor(startedAt / (15 * 60_000)) * 15 * 60_000
  )
    .toISOString()
    .slice(0, 16)
  return {
    websiteProjectKey: project.id,
    websiteProjectId: project.websiteProjectId,
    profileVersionId: project.profileVersionId,
    contextVersion: project.contextVersion,
    idempotencyKey: crypto.randomUUID(),
    refillWindowKey: `${project.websiteProjectId}:${project.profileVersionId}:${windowStart}`,
    jobId: null,
    workflowId: null,
    startedAt,
    expiresAt: startedAt + maxWaitMs,
    pollCount: 0,
    lastQueryAt: null,
  }
}

export function useRecommendationRefill(
  project: Project,
  pollInventory: () => Promise<readonly RecommendationItem[] | null>
) {
  const scopeKey = `${project.id}:${project.profileVersionId}:${project.contextVersion}`
  const activeScopeRef = React.useRef(scopeKey)
  const submittingRef = React.useRef(false)
  const pollInFlightRef = React.useRef(false)
  const [state, setState] = React.useState<RecommendationRefillState>(() => {
    const marker = readMarker(project)
    return marker ? runningState(marker) : idleState
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
        window.sessionStorage.removeItem(storageKey(project))
        setState({
          ...runningState(marker),
          status: "timed_out",
          phase: "等待推荐库存超时",
          elapsedMs: Date.now() - marker.startedAt,
          error: "后台任务未在十分钟内返回足够推荐，请检查任务状态后重试。",
        })
        return
      }

      pollInFlightRef.current = true
      try {
        const items = await pollInventory()
        if (cancelled || activeScopeRef.current !== expectedScope) return
        const queriedAt = Date.now()
        const nextMarker = {
          ...marker,
          pollCount: marker.pollCount + 1,
          lastQueryAt: queriedAt,
        }
        if (items !== null && items.length >= targetInventory) {
          window.sessionStorage.removeItem(storageKey(project))
          setState({
            status: "succeeded",
            phase: "当前项目推荐库存已就绪",
            jobId: nextMarker.jobId,
            startedAt: nextMarker.startedAt,
            elapsedMs: queriedAt - nextMarker.startedAt,
            pollCount: nextMarker.pollCount,
            lastQueryAt: queriedAt,
            error: null,
          })
          return
        }
        writeMarker(project, nextMarker)
        setState(runningState(nextMarker))
      } finally {
        pollInFlightRef.current = false
      }
    }, pollIntervalMs)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [pollInventory, project, scopeKey, state.status, state.pollCount])

  const start = React.useCallback(async () => {
    if (
      submittingRef.current ||
      state.status === "running" ||
      project.inputRequired.length > 0
    ) {
      return
    }
    submittingRef.current = true
    const expectedScope = scopeKey
    const marker = readMarker(project) ?? createMarker(project)
    writeMarker(project, marker)
    setState(runningState(marker))
    try {
      const job = await requestRecommendationRefill(
        project.id,
        project.profileVersionId,
        marker.idempotencyKey,
        marker.refillWindowKey
      )
      if (activeScopeRef.current !== expectedScope) return
      const nextMarker = {
        ...marker,
        jobId: job.jobId,
        workflowId: job.workflowId,
      }
      writeMarker(project, nextMarker)
      setState(runningState(nextMarker))
    } catch {
      if (activeScopeRef.current !== expectedScope) return
      window.sessionStorage.removeItem(storageKey(project))
      setState({
        ...runningState(marker),
        status: "failed",
        phase: "补池任务提交失败",
        elapsedMs: Date.now() - marker.startedAt,
        error: "服务端没有接受本次补池任务，未创建浏览器本地推荐。",
      })
    } finally {
      submittingRef.current = false
    }
  }, [project, scopeKey, state.status])

  return {
    ...state,
    targetInventory,
    start,
  }
}
