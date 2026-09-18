import { ApiError, apiRequest } from "@/api/client"

export type DraftParameters = {
  promotionTargetUrl: string
  language: string
}

export type ConsentPolicy = {
  policy_version: "backlinks-drafts-only.v1"
  max_opportunities: number
  max_drafts: number
  max_model_cost_usd: string
  max_paid_tool_cost_usd: string
}

export type ConsentInput = ConsentPolicy & {
  request_id: string
  expires_at: string
  confirmed: true
}

export type Consent = {
  id: string
  state: "active" | "expired" | "revoked"
  policy: ConsentPolicy | (Omit<ConsentPolicy, "policy_version"> & {
    policy_version: "backlinks-chat-campaign.v1"
    source_message_id: string
    send_authorized: boolean
    gmail_connection_id: string | null
  }) | {
    policy_version: "backlinks-chat-send.v1"
    source_message_id: string
    targets: {
      gmail_connection_id: string
      items: { draft_id: string }[]
    }
  }
  created_at: string
  expires_at: string
  automation_enabled: boolean
  sending_allowed: boolean
}

export type Execution = {
  run_id: string
  status: string
  sending_allowed: boolean
  checkpoint: {
    stage: string
    reason?: string
    usage: {
      opportunities: number
      drafts: number
      model_usd: string
      paid_usd: string
    }
    results: {
      feedItemId: string
      opportunityId?: string
      draftId?: string | null
      quality?: { state: string; reasons: string[] }
      state: string
      reason?: string | null
    }[]
  }
}

const path = (project: string) =>
  `/api/v1/projects/${encodeURIComponent(project)}/agent/automation/consents`

function post<T>(url: string, body?: unknown): Promise<T> {
  return apiRequest<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export const createConsent = (project: string, input: ConsentInput) =>
  post<Consent>(path(project), input)

export const revokeConsent = (project: string, id: string) =>
  post<Consent>(`${path(project)}/${encodeURIComponent(id)}/revoke`)

export const startExecution = (
  project: string,
  id: string,
  request: DraftParameters
) =>
  post<Execution>(`${path(project)}/${encodeURIComponent(id)}/start`, {
    confirmed: true,
    request,
  })

export async function readAutomation(
  project: string,
  selected: string | null,
  signal: AbortSignal
) {
  const { items } = await apiRequest<{ items: Consent[] }>(path(project), {
    signal,
  })
  const consent = items.find((item) => item.id === selected) ?? items[0] ?? null
  let execution: Execution | null = null
  if (consent) {
    try {
      execution = await apiRequest<Execution>(
        `${path(project)}/${encodeURIComponent(consent.id)}/execution`,
        { signal }
      )
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 404 ||
        error.message !== "BACKLINKS_AUTOMATION_NOT_FOUND"
      ) {
        throw error
      }
    }
  }
  return { items, consent, execution }
}

export type SendBatch = {
  confirmation_expires_at?: string
  id: string
  run_id: string | null
  state: string
  reason: string | null
  manifest_hash: string
  expires_at: string
  confirmed_at: string | null
  revoked_at: string | null
  items: {
    target: {
      draftId: string
      approvedDraftVersionId: string
      gmailConnectionId: string
    }
    preview: {
      recipient: string
      sender: string
      subject: string
      body: string
    }
    state: string
    sendIntentId?: string
  }[]
}

export type SendPreviewInput = {
  request_id: string
  draft_ids: string[]
  gmail_connection_id: string
}
const batchesPath = (project: string, consent: string) =>
  `${path(project)}/${encodeURIComponent(consent)}/send-batches`
export const readSendBatches = (
  project: string,
  consent: string,
  signal: AbortSignal
) =>
  apiRequest<{ items: SendBatch[] }>(batchesPath(project, consent), { signal })
export const previewSendBatch = (
  project: string,
  consent: string,
  input: SendPreviewInput
) => post<SendBatch>(`${batchesPath(project, consent)}/preview`, input)
export const confirmSendBatch = (
  project: string,
  consent: string,
  batch: SendBatch
) =>
  post<SendBatch>(
    `${batchesPath(project, consent)}/${encodeURIComponent(batch.id)}/confirm`,
    {
      confirmed: true,
      manifest_hash: batch.manifest_hash,
    }
  )
export const revokeSendBatch = (
  project: string,
  consent: string,
  batch: string
) =>
  post<SendBatch>(
    `${batchesPath(project, consent)}/${encodeURIComponent(batch)}/revoke`
  )

export type DraftReviewItem = {
  quality?: { state: string; reasons: string[]; version_id: string; reviewed_at: string } | null
  draft_id: string
  version_id: string
  expected_version: number
  subject: string | null
  body: string | null
  approved: boolean
  reviewable: boolean
}
export const readDraftReview = (project: string, consent: string, signal: AbortSignal) =>
  apiRequest<{ items: DraftReviewItem[] }>(
    `${path(project)}/${encodeURIComponent(consent)}/draft-review`, { signal }
  )
export const aiReviewDrafts = (project: string, consent: string, requestId: string) =>
  post<{ approved_draft_ids: string[]; sent: false }>(
    `${path(project)}/${encodeURIComponent(consent)}/draft-review/ai`,
    { request_id: requestId, retry: true }
  )
export type BatchMonitoring = {
  items: { draft_id: string; state: string; reply_state?: string; replies?: {
    id: string; threadId: string; receivedAt: string; subject: string
  }[] }[]
  connections: Record<string, {
    unavailable?: boolean; state?: string; killSwitchOpen?: boolean
    lastSuccessfulSyncAt?: string | null; lastError?: string | null
  }>
  partial: boolean
  mail_unavailable: boolean
}
export const readBatchMonitoring = (project: string, consent: string, signal: AbortSignal) =>
  apiRequest<BatchMonitoring>(
    `${path(project)}/${encodeURIComponent(consent)}/mail-monitoring`, { signal }
  )
export const approveDraftReview = (
  project: string, consent: string, requestId: string, items: DraftReviewItem[]
) => post<{ approved_draft_ids: string[]; sent: false }>(
  `${path(project)}/${encodeURIComponent(consent)}/draft-review/approve`,
  { request_id: requestId, confirmed: true, items: items.map((item) => ({
    draft_id: item.draft_id, version_id: item.version_id, expected_version: item.expected_version,
  })) }
)
