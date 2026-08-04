export type MailDirection = "INBOUND" | "OUTBOUND"
export type MailParseStatus = "PENDING" | "PARSED" | "FAILED"
export type MailMatchStatus =
  "UNMATCHED" | "CANDIDATES_READY" | "MATCH_CONFIRMED"

export type MailMeta = {
  organizationId: string
  workspaceId: string
  websiteProjectId: string
  requestId: string
  schemaVersion: "backlinks.v1"
  generatedAt: string
}

export type SanitizedMailHtml = {
  content: string
  trust: "SANITIZED"
  sanitized: true
  policyVersion: string
}

export type SafeMailBody = {
  plainText: string | null
  sanitizedHtml: SanitizedMailHtml | null
}

export type MailListItem = {
  id: string
  threadId: string
  direction: MailDirection
  fromAddress: string | null
  toAddresses: string[]
  ccAddresses: string[]
  subject: string | null
  receivedAt: string
  parseStatus: MailParseStatus
  version: number
  inboundMessageId: string | null
  matchStatus: MailMatchStatus | null
  matchedOpportunityId: string | null
}

export type MailDetail = MailListItem & {
  body: SafeMailBody
}

export type MailThread = {
  id: string
  latestMessageAt: string | null
  messageCount: number
  version: number
  messages: MailDetail[]
}

export type MailListResponse = {
  items: MailListItem[]
  nextCursor: string | null
  hasMore: boolean
  meta: MailMeta
}

export type MailDetailResponse = {
  item: MailDetail
  meta: MailMeta
}

export type MailThreadResponse = {
  item: MailThread
  meta: MailMeta
}

export type ReplyMatchCandidate = {
  id: string
  inboundMessageId: string
  opportunityId: string
  candidateRank: number
  confidenceScore: number
  reasonCodes: Array<Record<string, unknown>>
  requiresManualConfirmation: boolean
  createdAt: string
}

export type ReplyMatchCandidateListResponse = {
  inboundMessageId: string
  matchStatus: MailMatchStatus
  items: ReplyMatchCandidate[]
  meta: MailMeta
}

export type ReplyMatchConfirmResponse = {
  candidateId: string
  inboundMessageId: string
  opportunityId: string
  matchStatus: "MATCH_CONFIRMED"
  auditEventId: string
  meta: MailMeta
}
