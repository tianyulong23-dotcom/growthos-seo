import type { BacklinksResponse } from "@/api/generated/backlinks"

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
export type NegotiationFactsResponse =
  BacklinksResponse<"backlinksListNegotiationFactsV1">
export type NegotiationFactDecisionResponse =
  BacklinksResponse<"backlinksReviewNegotiationFactV1">
export type SendIntentListResponse =
  BacklinksResponse<"backlinksListSendIntentsV1">
export type SendIntentDetailResponse =
  BacklinksResponse<"backlinksGetSendIntentV1">
export type GmailPollingSyncStatus =
  BacklinksResponse<"backlinksGetGmailPollingSyncStatusV1">

export type MailListItem = MailListResponse["items"][number]
export type MailDirection = MailListItem["direction"]
export type MailParseStatus = MailListItem["parseStatus"]
export type MailMatchStatus = Exclude<MailListItem["matchStatus"], null>
export type MailMeta = MailListResponse["meta"]
export type MailDetail = MailDetailResponse["item"]
export type SafeMailBody = MailDetail["body"]
export type SanitizedMailHtml = NonNullable<SafeMailBody["sanitizedHtml"]>
export type MailThread = MailThreadResponse["item"]
export type ReplyMatchCandidate =
  ReplyMatchCandidateListResponse["items"][number]
export type NegotiationFact = NegotiationFactsResponse["items"][number]
export type NegotiationFactDecision =
  NegotiationFactDecisionResponse["decision"]
export type SendIntentListItem = SendIntentListResponse["items"][number]
export type SendIntentQueueKind = NonNullable<SendIntentListItem["queueKind"]>
export type SendIntentDetail = SendIntentDetailResponse["sendIntent"]
