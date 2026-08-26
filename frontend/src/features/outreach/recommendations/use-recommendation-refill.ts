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
import {
  isStaleRecommendationInventoryIdentity,
  recommendationInventoryIdentity,
  type RecommendationInventoryIdentity,
} from "./recommendation-inventory-identity"

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
  backgroundContinuation: boolean
  batch: RecommendationInventoryStatus["contactBatch"]
}

type PendingServerCommand = {
  scopeKey: string
  jobId: string | null
  batchId: string | null
  startedAt: number
}

type ScopedValue<T> = {
  scopeKey: string
  value: T
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
  backgroundContinuation: false,
  batch: null,
}

const parseTime = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function jobPhase(inventory: RecommendationInventoryStatus) {
  if (inventory.productState === "blocked") {
    return "推荐流程已阻塞，需要人工处理"
  }
  if (inventory.productState === "maintenance") {
    return "推荐流程处于维护状态"
  }
  if (inventory.productState === "paused_provider") {
    return "候选数据服务暂不可用"
  }
  if (inventory.productState === "partial_exhausted") {
    return "本轮已保留部分匹配结果"
  }
  if (inventory.productState === "waiting_retry") {
    return "推荐流程等待计划重试"
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
        return "正在整理推荐结果"
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
  if (
    job?.status === "success" ||
    inventory.refillState === "completed"
  ) {
    return "本批推荐生成已完成"
  }
  if (inventory.refillState === "paused") return "本批已暂停"
  if (inventory.refillState === "exhausted") return "本批发现范围已完成"
  return "等待生成推荐"
}

function terminalError(inventory: RecommendationInventoryStatus) {
  const job = inventory.refillJob
  if (job?.failure) {
    if (inventory.recoveryCommand === "CONTINUE_SAME_CRITERIA") {
      return `${job.failure.message} 未发生供应商调用或费用，可安全恢复原操作。`
    }
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
    parseTime(job?.createdAt)
  const status: RecommendationRefillStatus =
    inventory.productState === "blocked"
      ? "failed"
      : inventory.productState === "maintenance" ||
          inventory.productState === "paused_provider"
        ? "paused"
        : inventory.productState === "partial_exhausted"
          ? "partial"
          : inventory.productState === "waiting_retry" || active
            ? "running"
            : inventory.productStateReason === "VISIBLE_TARGET_REACHED"
              ? "succeeded"
              : job?.status === "failed" ||
                  job?.status === "cancelled" ||
                  (inventory.terminationReason !== null &&
                    inventory.terminationReason !== "HIGH_WATERMARK" &&
                    inventory.visibleMatchCount === 0)
                ? "failed"
                : job?.status === "partial_success" ||
                    (inventory.terminationReason !== null &&
                      inventory.terminationReason !== "HIGH_WATERMARK" &&
                      inventory.visibleMatchCount > 0)
                  ? "partial"
                  : job !== null ||
                      inventory.refillState === "completed" ||
                      inventory.refillState === "paused" ||
                      inventory.refillState === "exhausted"
                    ? "succeeded"
                    : "idle"

  return {
    status,
    contactBatchActivity,
    phase: jobPhase(inventory),
    jobId: job?.id ?? null,
    batchId: batch?.id ?? null,
    startedAt,
    elapsedMs: inventory.activeProcessingSeconds * 1_000,
    pollCount,
    lastQueryAt,
    lastServerUpdateAt: inventory.serverUpdatedAt,
    error:
      status === "failed" || status === "partial"
        ? terminalError(inventory)
        : null,
    backgroundContinuation: false,
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
  const acceptedInventoryIdentityRef = React.useRef<{
    scopeKey: string
    value: RecommendationInventoryIdentity | null
  }>({ scopeKey, value: null })
  const visibleRefreshRef = React.useRef<{
    scopeKey: string
    count: number | null
  }>({ scopeKey, count: null })
  const [pollEpoch, setPollEpoch] = React.useState(0)
  const [scopedInventory, setScopedInventory] = React.useState<
    ScopedValue<RecommendationInventoryStatus | null>
  >({ scopeKey, value: null })
  const [scopedState, setScopedState] = React.useState<
    ScopedValue<RecommendationRefillState>
  >({ scopeKey, value: idleState })
  const inventory =
    scopedInventory.scopeKey === scopeKey ? scopedInventory.value : null
  const state =
    scopedState.scopeKey === scopeKey ? scopedState.value : idleState

  React.useEffect(() => {
    const controller = new AbortController()
    const effectScopeKey = scopeKey
    let pollCount = 0
    let sawActive = pendingRef.current?.scopeKey === effectScopeKey
    if (acceptedInventoryIdentityRef.current.scopeKey !== effectScopeKey) {
      acceptedInventoryIdentityRef.current = {
        scopeKey: effectScopeKey,
        value: null,
      }
    }
    if (visibleRefreshRef.current.scopeKey !== scopeKey) {
      visibleRefreshRef.current = { scopeKey, count: null }
    }

    void pollRecommendationRefill({
      signal: controller.signal,
      getInventory: readInventory,
      onInventory: (nextInventory) => {
        if (controller.signal.aborted) return
        const incomingIdentity =
          recommendationInventoryIdentity(nextInventory)
        if (
          isStaleRecommendationInventoryIdentity(
            project.id,
            acceptedInventoryIdentityRef.current.scopeKey === effectScopeKey
              ? acceptedInventoryIdentityRef.current.value
              : null,
            incomingIdentity
          )
        ) {
          return
        }
        acceptedInventoryIdentityRef.current = {
          scopeKey: effectScopeKey,
          value: incomingIdentity,
        }
        const queriedAt = Date.now()
        pollCount += 1
        const pending =
          pendingRef.current?.scopeKey === effectScopeKey
            ? pendingRef.current
            : null
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
        const previousVisibleCount = visibleRefreshRef.current.count
        visibleRefreshRef.current = {
          scopeKey,
          count: nextInventory.visibleMatchCount,
        }
        if (
          previousVisibleCount !== null &&
          nextInventory.visibleMatchCount > previousVisibleCount
        ) {
          void onInventoryChanged(nextInventory)
        }
        setScopedInventory({ scopeKey: effectScopeKey, value: nextInventory })
        setScopedState({
          scopeKey: effectScopeKey,
          value: stateFromInventory(nextInventory, pollCount, queriedAt),
        })
      },
      shouldContinue: (nextInventory) =>
        pendingRef.current?.scopeKey === effectScopeKey ||
        isRecommendationRefillActive(nextInventory),
      onTerminal: async (nextInventory) => {
        if (!sawActive || controller.signal.aborted) return
        const terminalKey = [
          effectScopeKey,
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
        if (controller.signal.aborted) return
        setScopedState((current) => {
          const currentState =
            current.scopeKey === effectScopeKey ? current.value : idleState
          const hasPending = pendingRef.current?.scopeKey === effectScopeKey
          return {
            scopeKey: effectScopeKey,
            value: {
              ...currentState,
              status:
                currentState.status === "idle" && !hasPending
                  ? "failed"
                  : currentState.status,
              phase:
                currentState.status === "idle" && !hasPending
                  ? "无法读取当前项目推荐批次"
                  : currentState.phase,
              error: "服务端状态读取暂时失败，正在按退避间隔重试。",
            },
          }
        })
      },
      onBackgroundContinuation: () => {
        if (controller.signal.aborted) return
        setScopedState((current) => {
          const currentState =
            current.scopeKey === effectScopeKey ? current.value : idleState
          return {
            scopeKey: effectScopeKey,
            value: {
              ...currentState,
              phase: "后台继续补充；可手动刷新查看新结果",
              error: null,
              backgroundContinuation: true,
            },
          }
        })
      },
    })

    return () => controller.abort()
  }, [onInventoryChanged, pollEpoch, project.id, readInventory, scopeKey])

  const refresh = React.useCallback(() => {
    setPollEpoch((current) => current + 1)
  }, [])

  const connectJob = React.useCallback(
    (result: RequestRecommendationRefillResponse) => {
      const startedAt = Date.now()
      pendingRef.current = {
        scopeKey,
        jobId: result.jobId,
        batchId: null,
        startedAt,
      }
      setScopedState({
        scopeKey,
        value: {
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
          backgroundContinuation: false,
          batch: null,
        },
      })
      setPollEpoch((current) => current + 1)
    },
    [scopeKey]
  )

  const connectBatch = React.useCallback(
    (batchId: string) => {
      const startedAt = Date.now()
      pendingRef.current = { scopeKey, jobId: null, batchId, startedAt }
      setScopedState({
        scopeKey,
        value: {
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
          backgroundContinuation: false,
          batch: null,
        },
      })
      setPollEpoch((current) => current + 1)
    },
    [scopeKey]
  )

  return {
    ...state,
    inventory,
    active:
      state.backgroundContinuation
        ? false
        : inventory !== null
        ? isRecommendationRefillActive(inventory)
        : state.status === "running",
    refresh,
    connectJob,
    connectBatch,
  }
}
