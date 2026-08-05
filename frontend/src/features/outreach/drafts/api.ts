import { apiRequest } from "@/api/client"
import type {
  BacklinksMeta,
  ContactCandidate,
  DraftDocument,
  DraftMutationResult,
  DraftSnapshot,
  SendIntentMessagePurpose,
  SendIntentResult,
} from "@/features/outreach/drafts/types"

const draftPath = (websiteProjectKey: string, draftId: string) =>
  `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/drafts/${encodeURIComponent(draftId)}`

export function getDraft(websiteProjectKey: string, draftId: string) {
  return apiRequest<{ draft: DraftSnapshot; meta: BacklinksMeta }>(
    draftPath(websiteProjectKey, draftId)
  )
}

export function saveDraftVersion(
  websiteProjectKey: string,
  draftId: string,
  input: Readonly<{
    expectedVersion: number
    subjectText: string
    bodyDocument: DraftDocument
  }>
) {
  return apiRequest<DraftMutationResult>(
    `${draftPath(websiteProjectKey, draftId)}/versions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }
  )
}

export function approveDraft(
  websiteProjectKey: string,
  draftId: string,
  expectedVersion: number
) {
  return apiRequest<DraftMutationResult>(
    `${draftPath(websiteProjectKey, draftId)}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion }),
    }
  )
}

export function listContactCandidates(
  websiteProjectKey: string,
  prospectId: string
) {
  const query = new URLSearchParams({ prospectId, limit: "25" })
  return apiRequest<{ items: ContactCandidate[]; meta: BacklinksMeta }>(
    `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/contacts/candidates?${query.toString()}`
  )
}

export function createSendIntent(
  websiteProjectKey: string,
  draftId: string,
  input: Readonly<{
    approvedDraftVersionId: string
    gmailConnectionId: string
    messagePurpose: SendIntentMessagePurpose
    followUpIndex: number
  }>,
  idempotencyKey: string
) {
  return apiRequest<SendIntentResult>(`${draftPath(websiteProjectKey, draftId)}/send-intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(input),
  })
}
