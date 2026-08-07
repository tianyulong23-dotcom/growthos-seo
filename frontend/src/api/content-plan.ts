import { apiRequest } from "@/api/client"

export type ContentPlanCadence =
  "weekly_1" | "weekly_2_3" | "weekly_5" | "weekly_7"

export type ContentPlanItemStatus =
  | "unscheduled"
  | "scheduled"
  | "triggering"
  | "generating"
  | "generated"
  | "failed"
  | "cancelled"

export type ContentPlanItemSummary = {
  id: string
  project_id: string
  source: "automatic" | "manual"
  title: string
  primary_keyword: string
  edit_state: "idle" | "repreparing" | "reprepare_failed"
  version: number
  publish_local_date: string | null
  schedule_timezone: string | null
  generation_at: string | null
  status: ContentPlanItemStatus
  schedule_attention_reason: string | null
  article_id: string | null
  publication_status: string | null
  review_status: string | null
}

export type ContentPlanItemCollection = {
  items: ContentPlanItemSummary[]
  total: number
}

export type ContentPlanKeyword = {
  keyword: string
  role: "primary" | "secondary"
  keyword_type: "informational" | "service" | "product" | "unknown"
  source: "seed" | "related" | "ai" | "user"
  position: number
}

export type ContentPlanItem = ContentPlanItemSummary & {
  seed_keyword: string
  secondary_keywords: string[]
  keywords: ContentPlanKeyword[]
  writing_direction: string
  title_source: "system" | "user"
  writing_direction_source: "system" | "user"
  title_user_edited: boolean
  direction_user_edited: boolean
  pending_preparation_id: string | null
  preparation_version: number
  current_serp_snapshot_id: string
  current_serp_snapshot: {
    id: string
    preparation_id: string
    snapshot_version: number
    primary_keyword: string
    provider: string
    provider_request_id: string | null
  } | null
  pending_preparation: {
    id: string
    preparation_version: number
    state: string
    stage: string | null
    error_code: string | null
    error_detail: string | null
  } | null
  review_version: number | null
  publication_blocked_reason: string | null
}

export type ContentPlanSettings = {
  cadence: ContentPlanCadence
  paused: boolean
  timezone: string
  default_publish_local_time: string
  cadence_anchor_week: string | null
  version: number
  updated_at: string
}

export type ContentPlanBatch = {
  batch_id: string
  project_id: string
  source: "automatic" | "manual"
  target_count: number
  status: string
  stage: string
  candidate_snapshot_count: number
  selected_count: number
  valid_pack_count: number
  preparation_count: number
  preview_ready_count: number
  plan_item_count: number
  external_request_count: number
  total_cost_usd: number
  retryable: boolean
  error_code: string | null
  error_detail: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export type ContentPlanBatchCollection = {
  items: ContentPlanBatch[]
  total: number
}

export type PlanItemUpdate = {
  version: number
  seed_keyword?: string
  primary_keyword?: string
  secondary_keywords?: string[]
  title?: string
  writing_direction?: string
  publish_local_date?: string
}

type AcceptedBatch = {
  batch_id: string
  status: "queued"
  target_count: number
}

type AcceptedManualPlan = {
  batch_id: string
  preparation_id: string
  status: "queued"
}

type AcceptedPlanEdit = {
  item_id: string
  version: number
  pending_preparation_id: string
  preparation_version: number
  edit_state: "repreparing"
}

function contentPlanPath(projectId: string, suffix = "") {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/content-plan${suffix}`
}

export function listContentPlanItems(
  projectId: string,
  options: {
    startDate?: string
    endDate?: string
    statuses?: ContentPlanItemStatus[]
  } = {}
) {
  const query = new URLSearchParams()
  if (options.startDate) query.set("start_date", options.startDate)
  if (options.endDate) query.set("end_date", options.endDate)
  for (const status of options.statuses ?? []) query.append("status", status)
  const suffix = query.size ? `?${query.toString()}` : ""
  return apiRequest<ContentPlanItemCollection>(
    contentPlanPath(projectId, `/items${suffix}`)
  )
}

export function getContentPlanItem(projectId: string, itemId: string) {
  return apiRequest<ContentPlanItem>(
    contentPlanPath(projectId, `/items/${encodeURIComponent(itemId)}`)
  )
}

export function createManualContentPlanItem(
  projectId: string,
  seedKeyword: string,
  idempotencyKey: string
) {
  return apiRequest<AcceptedManualPlan>(contentPlanPath(projectId, "/items"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ seed_keyword: seedKeyword }),
  })
}

export function updateContentPlanItem(
  projectId: string,
  itemId: string,
  update: PlanItemUpdate
) {
  return apiRequest<ContentPlanItem | AcceptedPlanEdit>(
    contentPlanPath(projectId, `/items/${encodeURIComponent(itemId)}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }
  )
}

export function cancelContentPlanItem(
  projectId: string,
  itemId: string,
  version: number
) {
  return apiRequest<ContentPlanItem>(
    contentPlanPath(projectId, `/items/${encodeURIComponent(itemId)}/cancel`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    }
  )
}

export function generateContentPlanItemNow(
  projectId: string,
  itemId: string,
  version: number
) {
  const query = new URLSearchParams({ expected_version: String(version) })
  return apiRequest<{ id: string }>(
    contentPlanPath(
      projectId,
      `/items/${encodeURIComponent(itemId)}/generate-now?${query.toString()}`
    ),
    { method: "POST" }
  )
}

export function getContentPlanSettings(projectId: string) {
  return apiRequest<ContentPlanSettings>(
    contentPlanPath(projectId, "/settings")
  )
}

export function updateContentPlanSettings(
  projectId: string,
  update: {
    version: number
    cadence?: ContentPlanCadence
    paused?: boolean
    timezone?: string
  }
) {
  return apiRequest<ContentPlanSettings>(
    contentPlanPath(projectId, "/settings"),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }
  )
}

export function createAutomaticContentPlanBatch(
  projectId: string,
  idempotencyKey: string
) {
  return apiRequest<AcceptedBatch>(contentPlanPath(projectId, "/batches"), {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
  })
}

export function listContentPlanBatches(projectId: string, limit = 20) {
  const query = new URLSearchParams({ limit: String(limit) })
  return apiRequest<ContentPlanBatchCollection>(
    contentPlanPath(projectId, `/batches?${query.toString()}`)
  )
}

export function getContentPlanBatch(projectId: string, batchId: string) {
  return apiRequest<ContentPlanBatch>(
    contentPlanPath(projectId, `/batches/${encodeURIComponent(batchId)}`)
  )
}

export function retryContentPlanBatch(projectId: string, batchId: string) {
  return apiRequest<AcceptedBatch>(
    contentPlanPath(projectId, `/batches/${encodeURIComponent(batchId)}/retry`),
    { method: "POST" }
  )
}
