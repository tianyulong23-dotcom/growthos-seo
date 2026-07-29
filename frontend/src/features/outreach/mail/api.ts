import { ApiError, apiRequest } from "@/api/client"

import type {
  MailDetailResponse,
  MailListResponse,
  MailMatchStatus,
  MailThreadResponse,
  ReplyMatchCandidateListResponse,
  ReplyMatchConfirmResponse,
} from "./types"

const projectBasePath = (websiteProjectKey: string) =>
  `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks`

export async function listReplyMailMessages(
  websiteProjectKey: string,
  input: {
    matchStatus?: MailMatchStatus
    limit?: number
    cursor?: string
  } = {}
): Promise<MailListResponse> {
  const query = new URLSearchParams()
  query.set("limit", String(input.limit ?? 25))
  if (input.matchStatus) query.set("matchStatus", input.matchStatus)
  if (input.cursor) query.set("cursor", input.cursor)

  return apiRequest<MailListResponse>(
    `${projectBasePath(websiteProjectKey)}/mail/messages?${query.toString()}`
  )
}

export async function getReplyMailMessage(
  websiteProjectKey: string,
  messageId: string
): Promise<MailDetailResponse> {
  return apiRequest<MailDetailResponse>(
    `${projectBasePath(websiteProjectKey)}/mail/messages/${encodeURIComponent(
      messageId
    )}`
  )
}

export async function getReplyMailThread(
  websiteProjectKey: string,
  threadId: string
): Promise<MailThreadResponse> {
  return apiRequest<MailThreadResponse>(
    `${projectBasePath(websiteProjectKey)}/mail/threads/${encodeURIComponent(
      threadId
    )}`
  )
}

export async function listReplyMatchCandidates(
  websiteProjectKey: string,
  inboundMessageId: string
): Promise<ReplyMatchCandidateListResponse> {
  return apiRequest<ReplyMatchCandidateListResponse>(
    `${projectBasePath(
      websiteProjectKey
    )}/replies/${encodeURIComponent(inboundMessageId)}/match-candidates`
  )
}

export async function confirmReplyMatchCandidate(
  websiteProjectKey: string,
  inboundMessageId: string,
  candidateId: string,
  reason: string
): Promise<ReplyMatchConfirmResponse> {
  return apiRequest<ReplyMatchConfirmResponse>(
    `${projectBasePath(websiteProjectKey)}/replies/${encodeURIComponent(
      inboundMessageId
    )}/match-candidates/${encodeURIComponent(candidateId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedMatchStatus: "CANDIDATES_READY",
        reason,
      }),
    }
  )
}

export const isMailApiStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status
