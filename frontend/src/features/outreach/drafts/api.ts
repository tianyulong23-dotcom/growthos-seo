import {
  requestBacklinks,
  type BacklinksRequest,
  type BacklinksResponse,
} from "@/api/generated/backlinks"
import type {
  DraftDocument,
  DraftMutationResult,
} from "@/features/outreach/drafts/types"

export type DraftJobStatus =
  BacklinksResponse<"backlinksGetDraftJobV1">["job"]["status"]
export type DraftJob = BacklinksResponse<"backlinksGetDraftJobV1">["job"]
export type DraftRequest = NonNullable<DraftJob["request"]>

export type ManualContactRole =
  BacklinksRequest<"backlinksCreateManualContactCandidateV1">["body"]["contactRole"]

export type ManualContactCandidate =
  BacklinksResponse<"backlinksCreateManualContactCandidateV1">

export function createDraftJob(
  websiteProjectKey: string,
  opportunityId: string,
  input: BacklinksRequest<"backlinksCreateDraftJobV1">["body"],
  idempotencyKey: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksCreateDraftJobV1",
    {
      path: { websiteProjectKey, opportunityId },
      headers: { "idempotency-key": idempotencyKey },
      body: input,
    },
    { signal }
  )
}

export function getDraftJob(
  websiteProjectKey: string,
  jobId: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetDraftJobV1",
    {
      path: { websiteProjectKey, jobId },
    },
    { signal }
  )
}

export function getLatestDraftJob(
  websiteProjectKey: string,
  opportunityId: string,
  logicalDraftKey: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetLatestDraftJobV1",
    {
      path: { websiteProjectKey, opportunityId },
      query: { logicalDraftKey },
    },
    { signal }
  )
}

export function getDraft(
  websiteProjectKey: string,
  draftId: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetDraftV1",
    {
      path: { websiteProjectKey, draftId },
    },
    { signal }
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
  return requestBacklinks("backlinksSaveDraftVersionV1", {
    path: { websiteProjectKey, draftId },
    body: input,
  }) satisfies Promise<DraftMutationResult>
}

export function approveDraft(
  websiteProjectKey: string,
  draftId: string,
  expectedVersion: number
) {
  return requestBacklinks("backlinksApproveDraftV1", {
    path: { websiteProjectKey, draftId },
    body: { expectedVersion },
  }) satisfies Promise<DraftMutationResult>
}

export function listContactCandidates(
  websiteProjectKey: string,
  prospectId: string
) {
  return requestBacklinks("backlinksListContactCandidatesV1", {
    path: { websiteProjectKey },
    query: { prospectId, limit: 25 },
  })
}

export function listOpportunityContacts(
  websiteProjectKey: string,
  opportunityId: string,
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksListOpportunityContactsV1",
    {
      path: { websiteProjectKey, opportunityId },
    },
    signal ? { signal } : undefined
  )
}

export function createManualContactCandidate(
  websiteProjectKey: string,
  opportunityId: string,
  input: Readonly<{
    normalizedEmail: string
    contactRole: ManualContactRole
    reason: string
  }>,
  idempotencyKey: string
) {
  return requestBacklinks("backlinksCreateManualContactCandidateV1", {
    path: { websiteProjectKey, opportunityId },
    headers: { "idempotency-key": idempotencyKey },
    body: input,
  })
}

export function confirmContactCandidate(
  websiteProjectKey: string,
  candidateId: string,
  input: Readonly<{
    expectedVersion: number
    contactRole: ManualContactRole
    reason: string
  }>
) {
  return requestBacklinks("backlinksConfirmContactCandidateV1", {
    path: { websiteProjectKey, candidateId },
    body: input,
  })
}

export function createSendIntent(
  websiteProjectKey: string,
  draftId: string,
  input: BacklinksRequest<"backlinksCreateSendIntentV1">["body"],
  idempotencyKey: string
) {
  return requestBacklinks("backlinksCreateSendIntentV1", {
    path: { websiteProjectKey, draftId },
    headers: { "idempotency-key": idempotencyKey },
    body: input,
  })
}

export function preflightSendIntent(
  websiteProjectKey: string,
  draftId: string,
  input: BacklinksRequest<"backlinksPreflightSendIntentV1">["body"],
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksPreflightSendIntentV1",
    {
      path: { websiteProjectKey, draftId },
      body: input,
    },
    signal ? { signal } : undefined
  )
}

export function getSendIntent(
  websiteProjectKey: string,
  sendIntentId: string,
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetSendIntentV1",
    {
      path: { websiteProjectKey, sendIntentId },
    },
    signal ? { signal } : undefined
  )
}

export function listDraftSendIntents(
  websiteProjectKey: string,
  draftId: string,
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksListSendIntentsV1",
    {
      path: { websiteProjectKey },
      query: { draftId, limit: 1 },
    },
    signal ? { signal } : undefined
  )
}
