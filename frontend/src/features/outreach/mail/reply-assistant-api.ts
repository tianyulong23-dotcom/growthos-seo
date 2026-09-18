import { apiRequest } from "@/api/client"

export type ReplyLanguage = "zh-CN" | "en" | "pt" | "es" | "fr" | "de" | "ja"
export type ReplyIntent = "interested" | "decline" | "negotiate" | "details" | "custom"
export type ReplyContext = {
  recipient: string
  subject: string
  gmailConnectionId: string
  message: { id: string; version: number; matchedOpportunityId: string | null }
  existingReply: { draftId: string; sendIntentId: string | null; status: string | null; body: string } | null
}
export type ReplyProposal = {
  detected_language: string
  summary: string
  key_points: string[]
  questions: string[]
  warnings: string[]
  model: string
  expectedVersion: number
  gmailConnectionId: string
  recipient: string
  subject: string
  body: string
  generationToken: string | null
}
const path = (project: string, message: string) =>
  `/api/v1/projects/${encodeURIComponent(project)}/backlinks/mail/messages/${encodeURIComponent(message)}`

export const getReplyContext = (project: string, message: string, signal: AbortSignal) =>
  apiRequest<ReplyContext>(`${path(project, message)}/reply-context`, { signal })

export const generateReply = (project: string, message: string, input: {
  action: "summarize" | "draft"
  summary_language: ReplyLanguage
  reply_language: ReplyLanguage | "same"
  stance: ReplyIntent
  instructions: string
  authorize_one_reply: boolean
}, signal: AbortSignal) =>
  apiRequest<ReplyProposal>(`${path(project, message)}/reply-assistant`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
  })

export const sendReply = (project: string, message: string, input: {
  expectedVersion: number
  gmailConnectionId: string
  recipient: string
  subject: string
  body: string
  confirmed: true
  confirmationMode: "MANUAL" | "ONE_REPLY"
  generationToken?: string | null
}, signal: AbortSignal) =>
  apiRequest<{ id: string; status: string }>(`${path(project, message)}/reply-send`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
  })
