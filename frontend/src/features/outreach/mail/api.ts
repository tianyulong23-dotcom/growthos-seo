import {
  requestBacklinks,
  type BacklinksResponse,
} from "@/api/generated/backlinks"
import { ApiError } from "@/api/client"

import type { MailMatchStatus } from "./types"

export type MailListResponse =
  BacklinksResponse<"backlinksListReplyMailMessagesV1">
export type MailDetailResponse =
  BacklinksResponse<"backlinksGetReplyMailMessageV1">
export type MailThreadResponse =
  BacklinksResponse<"backlinksGetReplyMailThreadV1">
export type ReplyMatchCandidateListResponse =
  BacklinksResponse<"backlinksListReplyMatchCandidatesV1">
export type ReplyMatchConfirmResponse =
  BacklinksResponse<"backlinksConfirmReplyMatchCandidateV1">
export type ReplyMatchUnbindResponse =
  BacklinksResponse<"backlinksUnbindReplyMatchV1">
export type GmailPollingSyncResponse =
  BacklinksResponse<"backlinksStartGmailPollingSyncV1">
export type GmailPollingSyncStatusResponse =
  BacklinksResponse<"backlinksGetGmailPollingSyncStatusV1">

export function startGmailPollingSync(
  websiteProjectKey: string,
  connectionId: string
): Promise<GmailPollingSyncResponse> {
  return requestBacklinks("backlinksStartGmailPollingSyncV1", {
    path: { websiteProjectKey, connectionId },
  })
}

export function getGmailPollingSyncStatus(
  websiteProjectKey: string,
  connectionId: string,
  signal?: AbortSignal
): Promise<GmailPollingSyncStatusResponse> {
  return requestBacklinks(
    "backlinksGetGmailPollingSyncStatusV1",
    {
      path: { websiteProjectKey, connectionId },
    },
    { signal }
  )
}

export async function listReplyMailMessages(
  websiteProjectKey: string,
  input: {
    matchStatus?: MailMatchStatus
    limit?: number
    cursor?: string
  } = {},
  signal?: AbortSignal
): Promise<MailListResponse> {
  return requestBacklinks(
    "backlinksListReplyMailMessagesV1",
    {
      path: { websiteProjectKey },
      query: {
        matchStatus: input.matchStatus,
        limit: input.limit ?? 25,
        cursor: input.cursor,
      },
    },
    { signal }
  )
}

export async function getReplyMailMessage(
  websiteProjectKey: string,
  messageId: string,
  signal?: AbortSignal
): Promise<MailDetailResponse> {
  return requestBacklinks(
    "backlinksGetReplyMailMessageV1",
    {
      path: { websiteProjectKey, messageId },
    },
    { signal }
  )
}

export async function getReplyMailThread(
  websiteProjectKey: string,
  threadId: string,
  signal?: AbortSignal
): Promise<MailThreadResponse> {
  return requestBacklinks(
    "backlinksGetReplyMailThreadV1",
    {
      path: { websiteProjectKey, threadId },
    },
    { signal }
  )
}

export async function listReplyMatchCandidates(
  websiteProjectKey: string,
  inboundMessageId: string,
  signal?: AbortSignal
): Promise<ReplyMatchCandidateListResponse> {
  return requestBacklinks(
    "backlinksListReplyMatchCandidatesV1",
    {
      path: { websiteProjectKey, inboundMessageId },
    },
    { signal }
  )
}

export async function confirmReplyMatchCandidate(
  websiteProjectKey: string,
  inboundMessageId: string,
  candidateId: string,
  reason: string
): Promise<ReplyMatchConfirmResponse> {
  return requestBacklinks("backlinksConfirmReplyMatchCandidateV1", {
    path: { websiteProjectKey, inboundMessageId, candidateId },
    body: {
      expectedMatchStatus: "CANDIDATES_READY",
      reason,
    },
  })
}

export async function unbindReplyMatch(
  websiteProjectKey: string,
  inboundMessageId: string,
  reason: string
): Promise<ReplyMatchUnbindResponse> {
  return requestBacklinks("backlinksUnbindReplyMatchV1", {
    path: { websiteProjectKey, inboundMessageId },
    body: {
      expectedMatchStatus: "MATCH_CONFIRMED",
      reason,
    },
  })
}

export const isMailApiStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status
