import { apiRequest } from "@/api/client"
import { requestBacklinks } from "@/api/generated/backlinks"

export type TaskKind =
  | "article" | "content_plan" | "audit" | "project" | "keywords" | "agent"
  | "performance" | "onboarding" | "recommendation" | "send" | "draft"
export type TaskSource = "platform" | "recommendation" | "send"
export type TaskItem = {
  id: string
  kind: TaskKind
  title: string
  status: string
  progress: number | null
  stage: string | null
  updated_at: string | null
  related_id: string | null
  scheduled_at?: string | null
  reason_code?: string | null
}
export type TaskPage = { items: TaskItem[]; has_more: boolean }

export const taskSources: TaskSource[] = ["platform", "recommendation", "send"]
export const taskSourceLabels = {
  platform: "项目任务", recommendation: "推荐池", send: "发件队列",
}

export async function readTasks(
  projectId: string, source: TaskSource, signal: AbortSignal
): Promise<TaskPage> {
  if (source === "platform") {
    return apiRequest(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, { signal })
  }
  const path = { websiteProjectKey: projectId }
  if (source === "recommendation") {
    const result = await requestBacklinks(
      "backlinksListRecommendationFeedV2", { path, query: { limit: 1 } }, { signal }
    )
    const run = result.latestGeneration
    return {
      has_more: false,
      items: run ? [{
        id: run.generationContractId, kind: "recommendation", title: "推荐池生成",
        status: run.jobState, progress: run.progress, stage: run.terminalReason,
        updated_at: null, related_id: run.generationContractId,
      }] : [],
    }
  }
  const result = await requestBacklinks(
    "backlinksListSendIntentsV1", { path, query: { limit: 100 } }, { signal }
  )
  return {
    has_more: Boolean(result.nextCursor),
    items: result.items.map((item) => ({
      id: item.sendIntentId, kind: "send",
      title: item.deliveryEnvelope?.recipient ?? "开发信发送",
      status: item.status, progress: null, stage: item.diagnostics.primaryNextAction,
      updated_at: item.updatedAt, related_id: item.draftId,
      scheduled_at: item.diagnostics.nextRetryAt ?? item.requestedSendAt,
    })),
  }
}

const activeStatuses = new Set([
  "queued", "running", "executing", "verifying", "waiting", "blocked",
  "waiting_for_confirmation", "awaiting_approval", "stopping", "recalculating",
  "paused", "ready", "dispatching", "failed_retryable", "delivery_unknown",
  "selecting_seeds", "expanding", "building_packs", "supplementing",
  "building_previews", "creating_items", "scheduling", "needs_attention",
  "retry_scheduled",
])
export function isTaskActive(task: TaskItem) {
  return activeStatuses.has(task.status.toLowerCase())
}

const labels: Record<string, string> = {
  queued: "排队中", running: "执行中", executing: "执行中", verifying: "核验中",
  waiting: "等待中", blocked: "受阻", waiting_for_confirmation: "待确认",
  awaiting_approval: "待确认", stopping: "停止中", recalculating: "重新计算中",
  paused: "已暂停", completed: "已完成", succeeded: "已完成", success: "已完成",
  completed_with_warnings: "完成，有提醒", partial: "部分完成",
  failed: "失败", cancelled: "已取消", stopped: "已停止", limit_reached: "达到任务限制",
  ready: "等待发送", dispatching: "发送中", provider_accepted: "邮件服务已接收",
  delivery_unknown: "发送结果待核验", failed_retryable: "等待重试",
  failed_final: "发送失败", rejected: "已拦截",
  retry_scheduled: "等待重试", refused: "已拦截",
  selecting_seeds: "筛选关键词", expanding: "扩展中", building_packs: "生成资料中",
  supplementing: "补充中", building_previews: "生成预览中", creating_items: "创建计划中",
  scheduling: "排期中", needs_attention: "需要处理",
}
export function taskStatusLabel(task: TaskItem) {
  if (task.reason_code === "onboarding_step_failed") return "需要处理"
  return labels[task.status.toLowerCase()] ?? task.status
}

export function taskReasonLabel(task: TaskItem) {
  const code = (task.reason_code || task.stage || "").toLowerCase()
  if (code === "onboarding_step_failed") return "初始化步骤失败，请查看项目任务"
  if (code === "background_dispatch_disabled") return "后台调度未启用"
  if (["wait_for_worker", "waiting_for_worker", "worker_unavailable"].includes(code))
    return "等待后台服务"
  if (/quota|rate_limit|budget|daily_limit/.test(code))
    return isTaskActive(task) ? `等待额度或限流恢复（${code}）` : `额度或限流限制（${code}）`
  return code && code !== task.status.toLowerCase() ? code : null
}

export function taskHref(projectId: string, task: TaskItem) {
  const base = `/projects/${encodeURIComponent(projectId)}`
  const related = encodeURIComponent(task.related_id ?? "")
  switch (task.kind) {
    case "article": return `${base}/content/articles/${related}/edit`
    case "content_plan": return `${base}/content/plans`
    case "audit": return `${base}/audit/overview?runId=${related}`
    case "keywords": return `${base}/keywords/library`
    case "performance": return `${base}/performance/overview`
    case "recommendation": return `${base}/backlinks/recommendations`
    case "send": return `${base}/backlinks/email`
    case "draft": return `${base}/backlinks/email`
    case "agent":
    case "onboarding": return `${base}/audit/overview${related ? `?agentConversation=${related}` : ""}`
    default: return `${base}/settings/business`
  }
}
