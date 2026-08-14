import * as React from "react"

import type { OutreachProject } from "@/features/outreach/project"

import type {
  RecommendationInventoryStatus,
  RequestRecommendationRefillResponse,
} from "./api"
import {
  isRecommendationRefillActive,
  pollRecommendationRefill,
  recommendationContactBatchActivity,
  type RecommendationContactBatchActivity,
} from "./recommendation-refill-polling"

type RecommendationRefillStatus =
  "idle" | "running" | "paused" | "succeeded" | "partial" | "failed"

export type RecommendationRefillState = {
  status: RecommendationRefillStatus
  contactBatchActivity: RecommendationContactBatchActivity
  phase: string
  jobId: string | null
  batchId: string | null
  startedAt: number | null
  elapsedMs: number
  pollCount: number
  lastQueryAt: number | null
  lastServerUpdateAt: string | null
  error: string | null
  batch: RecommendationInventoryStatus["contactBatch"]
}

type PendingServerCommand = {
  jobId: string | null
  batchId: string | null
  startedAt: number
}

const idleState: RecommendationRefillState = {
  status: "idle",
  contactBatchActivity: "none",
  phase: "尚未生成推荐",
  jobId: null,
  batchId: null,
  startedAt: null,
  elapsedMs: 0,
  pollCount: 0,
  lastQueryAt: null,
  lastServerUpdateAt: null,
  error: null,
  batch: null,
}

const parseTime = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function jobPhase(
  inventory: RecommendationInventoryStatus,
  contactBatchActivity: RecommendationContactBatchActivity
) {
  const batch = inventory.contactBatch
  if (batch !== null && contactBatchActivity === "recovery_required") {
    return `联系人批次已暂停，等待服务恢复 ${batch.terminalJobCount}/${batch.totalJobCount}`
  }
  if (batch !== null && contactBatchActivity === "waiting_retry") {
    return `联系人批次等待计划重试 ${batch.terminalJobCount}/${batch.totalJobCount}`
  }
  if (batch !== null && contactBatchActivity === "processing") {
    return `正在处理联系人 ${batch.terminalJobCount}/${batch.totalJobCount}`
  }
  if (inventory.refillState === "waiting_contact") {
    return "候选发现已完成，正在创建联系人批次"
  }
  const job = inventory.refillJob
  if (job?.step === "paused_budget") return "本轮已因 DataForSEO 预算暂停"
  if (job?.step === "paused_provider")
    return "本轮已因 DataForSEO 暂不可用而暂停"
  if (job?.step === "paused_project_context") return "本轮等待完整的项目资料"
  if (job?.status === "queued") return "推荐任务已排队"
  if (job?.status === "waiting_provider") return "正在等待 DataForSEO"
  if (job?.status === "running") {
    switch (job.step) {
      case "provider_request_reserved":
        return "正在发现候选网站"
      case "provider_response_received":
        return "正在保存 DataForSEO 候选"
      case "candidate_scoring":
        return "正在计算网站适合度"
      case "contact_enrichment":
        return "正在处理联系人"
      default:
        return job.step
          ? `正在执行 ${job.step.replaceAll("_", " ")}`
          : "推荐任务正在运行"
    }
  }
  if (job?.status === "partial_success") {
    return "本批部分完成，已保留可用推荐"
  }
  if (job?.status === "failed" || job?.status === "cancelled") {
    return "本批生成失败，已保留此前可用推荐"
  }
  if (batch?.status === "stale_context") {
    return "项目资料已更新，本批已停止发布"
  }
  if (
    job?.status === "success" ||
    inventory.refillState === "completed" ||
    batch?.status === "completed"
  ) {
    return "本批推荐与联系人处理已完成"
  }
  if (inventory.refillState === "paused") return "本批已暂停"
  if (inventory.refillState === "exhausted") return "本批发现范围已完成"
  return "等待生成推荐"
}

function terminalError(inventory: RecommendationInventoryStatus) {
  const job = inventory.refillJob
  if (job?.failure) {
    const action = {
      RESUME_OPERATION: "请恢复原操作。",
      WAIT_PROVIDER: "请等待 provider 恢复后重试。",
      COMPLETE_PROJECT_CONTEXT: "请补全当前项目资料后重试。",
      RESTART_SERVICE: "请重启本地服务后继续。",
      ACCEPT_SUPPLY_FLOOR: "当前可接受已有的合格推荐数量。",
      CONTACT_SUPPORT: `请提供诊断编号 ${job.failure.diagnosticId}。`,
    }[job.failure.recovery]
    return `${job.failure.message} ${action}`
  }
  if (job?.errorMessage) return job.errorMessage
  if (job?.errorCode) return `失败代码：${job.errorCode}`
  switch (inventory.terminationReason) {
    case "BUDGET":
      return "DataForSEO 预算不足；已保留本批已有结果。"
    case "PROVIDER_UNAVAILABLE":
      return "DataForSEO 当前不可用；配置恢复后可显式补充推荐。"
    case "TIERS_EXHAUSTED":
      return "所有发现层级已完成；系统不会用低质量网站凑数。"
    case "PROJECT_CONTEXT":
      return "当前项目资料不足；完善项目资料后可重试。"
    default:
      return null
  }
}

function stateFromInventory(
  inventory: RecommendationInventoryStatus,
  pollCount: number,
  lastQueryAt: number
): RecommendationRefillState {
  const job = inventory.refillJob
  const batch = inventory.contactBatch
  const now = Date.now()
  const contactBatchActivity = recommendationContactBatchActivity(
    inventory,
    now
  )
  const active = isRecommendationRefillActive(inventory, now)
  const startedAt =
    parseTime(job?.startedAt) ??
    parseTime(job?.createdAt) ??
    parseTime(batch?.startedAt)
  const finishedAt =
    parseTime(batch?.completedAt) ??
    parseTime(job?.finishedAt) ??
    (active ? null : parseTime(inventory.serverUpdatedAt))
  const status: RecommendationRefillStatus =
    contactBatchActivity === "recovery_required"
      ? "paused"
      : active
        ? "running"
        : job?.status === "failed" ||
            job?.status === "cancelled" ||
            batch?.status === "stale_context" ||
            (inventory.terminationReason !== null &&
              inventory.terminationReason !== "HIGH_WATERMARK" &&
              inventory.publishedContactReadyCount === 0)
          ? "failed"
          : job?.status === "partial_success" ||
              (inventory.terminationReason !== null &&
                inventory.terminationReason !== "HIGH_WATERMARK" &&
                inventory.publishedContactReadyCount > 0)
            ? "partial"
            : job !== null ||
                batch !== null ||
                inventory.refillState === "completed" ||
                inventory.refillState === "paused" ||
                inventory.refillState === "exhausted"
              ? "succeeded"
              : "idle"

  return {
    status,
    contactBatchActivity,
    phase: jobPhase(inventory, contactBatchActivity),
    jobId: job?.id ?? null,
    batchId: batch?.id ?? null,
    startedAt,
    elapsedMs:
      startedAt === null
        ? 0
        : Math.max(0, (finishedAt ?? Date.now()) - startedAt),
    pollCount,
    lastQueryAt,
    lastServerUpdateAt: inventory.serverUpdatedAt,
    error:
      status === "failed" || status === "partial"
        ? terminalError(inventory)
        : null,
    batch,
  }
}

export function useRecommendationRefill(
  project: OutreachProject,
  readInventory: (
    signal: AbortSignal
  ) => Promise<RecommendationInventoryStatus>,
  onInventoryChanged: (
    inventory: RecommendationInventoryStatus
  ) => Promise<void>
) {
  const scopeKey = `${project.id}:${project.profileVersion ?? "no-profile"}`
  const pendingRef = React.useRef<PendingServerCommand | null>(null)
  const terminalRefreshKeysRef = React.useRef(new Set<string>())
  const publishedRefreshRef = React.useRef<{
    scopeKey: string
    count: number | null
  }>({ scopeKey, count: null })
  const [pollEpoch, setPollEpoch] = React.useState(0)
  const [inventory, setInventory] =
    React.useState<RecommendationInventoryStatus | null>(null)
  const [state, setState] = React.useState<RecommendationRefillState>(idleState)

  React.useEffect(() => {
    const controller = new AbortController()
    let pollCount = 0
    let sawActive = pendingRef.current !== null
    if (publishedRefreshRef.current.scopeKey !== scopeKey) {
      publishedRefreshRef.current = { scopeKey, count: null }
    }

    void pollRecommendationRefill({
      signal: controller.signal,
      getInventory: readInventory,
      onInventory: (nextInventory) => {
        const queriedAt = Date.now()
        pollCount += 1
        const pending = pendingRef.current
        if (
          pending !== null &&
          (pending.jobId === null ||
            nextInventory.refillJob?.id === pending.jobId) &&
          (pending.batchId === null ||
            nextInventory.contactBatch?.id === pending.batchId)
        ) {
          pendingRef.current = null
        }
        if (isRecommendationRefillActive(nextInventory)) sawActive = true
        const previousPublishedCount = publishedRefreshRef.current.count
        publishedRefreshRef.current = {
          scopeKey,
          count: nextInventory.publishedCount,
        }
        if (
          previousPublishedCount !== null &&
          nextInventory.publishedCount > previousPublishedCount
        ) {
          void onInventoryChanged(nextInventory)
        }
        setInventory(nextInventory)
        setState(stateFromInventory(nextInventory, pollCount, queriedAt))
      },
      shouldContinue: (nextInventory) =>
        pendingRef.current !== null ||
        isRecommendationRefillActive(nextInventory),
      onTerminal: async (nextInventory) => {
        if (!sawActive) return
        const terminalKey = [
          nextInventory.refillJob?.id ?? "no-job",
          nextInventory.contactBatch?.id ?? "no-batch",
          nextInventory.operationId ?? "no-operation",
          nextInventory.terminalState ?? "no-terminal-state",
          nextInventory.serverUpdatedAt ?? "no-update",
        ].join(":")
        if (terminalRefreshKeysRef.current.has(terminalKey)) return
        terminalRefreshKeysRef.current.add(terminalKey)
        await onInventoryChanged(nextInventory)
      },
      onError: () => {
        setState((current) => ({
          ...current,
          status:
            current.status === "idle" && pendingRef.current === null
              ? "failed"
              : current.status,
          phase:
            current.status === "idle" && pendingRef.current === null
              ? "无法读取当前项目推荐批次"
              : current.phase,
          error: "服务端状态读取暂时失败，正在按退避间隔重试。",
        }))
      },
    })

    return () => controller.abort()
  }, [onInventoryChanged, pollEpoch, readInventory, scopeKey])

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

  const refresh = React.useCallback(() => {
    setPollEpoch((current) => current + 1)
  }, [])

  const connectJob = React.useCallback(
    (result: RequestRecommendationRefillResponse) => {
      const startedAt = Date.now()
      pendingRef.current = {
        jobId: result.jobId,
        batchId: null,
        startedAt,
      }
      setState({
        status: "running",
        contactBatchActivity: "none",
        phase: "推荐任务已排队",
        jobId: result.jobId,
        batchId: null,
        startedAt,
        elapsedMs: 0,
        pollCount: 0,
        lastQueryAt: null,
        lastServerUpdateAt: result.meta.generatedAt,
        error: null,
        batch: null,
      })
      setPollEpoch((current) => current + 1)
    },
    []
  )

  const connectBatch = React.useCallback((batchId: string) => {
    const startedAt = Date.now()
    pendingRef.current = { jobId: null, batchId, startedAt }
    setState({
      status: "running",
      contactBatchActivity: "processing",
      phase: "联系人重试批次已排队",
      jobId: null,
      batchId,
      startedAt,
      elapsedMs: 0,
      pollCount: 0,
      lastQueryAt: null,
      lastServerUpdateAt: null,
      error: null,
      batch: null,
    })
    setPollEpoch((current) => current + 1)
  }, [])

  return {
    ...state,
    inventory,
    active:
      inventory !== null
        ? isRecommendationRefillActive(inventory)
        : state.status === "running",
    refresh,
    connectJob,
    connectBatch,
  }
}
