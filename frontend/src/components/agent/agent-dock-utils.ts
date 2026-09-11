import type {
  AgentDisplayPart,
  AgentMessage,
  AgentRun,
  AgentTimelineEvent,
} from "@/features/agent/types"

export type BusinessProgressItem = {
  toolCallId?: string
  tool: string
  label: string
  status: "completed" | "failed" | "interrupted"
}

export type ConversationTimelineItem =
  | { type: "message"; id: string; createdAt: string; message: AgentMessage }
  | { type: "event"; id: string; createdAt: string; event: AgentTimelineEvent }

export function cleanAgentMessageContent(content: string) {
  return content
    .split("\n")
    .filter(
      (line) => !/^(?:(?:\\)|(?:&#x20;)|(?:&nbsp;)|\s)+$/i.test(line.trim())
    )
    .join("\n")
}

function messageBusinessProgress(
  metadata: AgentMessage["metadata"]
): BusinessProgressItem[] {
  const value = metadata.business_progress
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const entry = item as Record<string, unknown>
    const status = String(entry.status)
    if (
      typeof entry.tool !== "string" ||
      typeof entry.label !== "string" ||
      !["completed", "failed", "interrupted"].includes(status)
    ) {
      return []
    }
    return [
      {
        toolCallId:
          typeof entry.tool_call_id === "string"
            ? entry.tool_call_id
            : undefined,
        tool: entry.tool,
        label: entry.label,
        status: status as BusinessProgressItem["status"],
      },
    ]
  })
}

export function messageDisplayParts(message: AgentMessage): AgentDisplayPart[] {
  const value = message.metadata.display_parts
  if (Array.isArray(value)) {
    const parts = value.flatMap((item): AgentDisplayPart[] => {
      if (!item || typeof item !== "object") return []
      const entry = item as Record<string, unknown>
      if (entry.type === "text" && typeof entry.text === "string") {
        const text = cleanAgentMessageContent(entry.text)
        return text.trim() ? [{ type: "text", text }] : []
      }
      const status = String(entry.status)
      if (
        entry.type !== "tool" ||
        typeof entry.tool !== "string" ||
        typeof entry.label !== "string" ||
        !["completed", "failed", "interrupted"].includes(status)
      ) {
        return []
      }
      return [
        {
          type: "tool",
          toolCallId:
            typeof entry.tool_call_id === "string"
              ? entry.tool_call_id
              : undefined,
          tool: entry.tool,
          label: entry.label,
          status: status as "completed" | "failed" | "interrupted",
        },
      ]
    })
    if (parts.length > 0) return parts
  }
  const content = cleanAgentMessageContent(message.content)
  return [
    ...messageBusinessProgress(message.metadata).map(
      (item): AgentDisplayPart => ({ type: "tool", ...item })
    ),
    ...(content.trim()
      ? ([{ type: "text", text: content }] satisfies AgentDisplayPart[])
      : []),
  ]
}

export function hasVisibleAssistantReply(
  messages: AgentMessage[],
  runId: string | undefined
) {
  if (!runId) return false
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.runId === runId &&
      messageDisplayParts(message).length > 0
  )
}

export function conversationTimelineItems(
  messages: AgentMessage[],
  events: AgentTimelineEvent[]
): ConversationTimelineItem[] {
  return [
    ...messages
      .filter((message) => message.metadata.hidden_from_user !== true)
      .map((message): ConversationTimelineItem => ({
        type: "message",
        id: message.id,
        createdAt: message.createdAt,
        message,
      })),
    ...events.map((event): ConversationTimelineItem => ({
      type: "event",
      id: event.id,
      createdAt: event.createdAt,
      event,
    })),
  ].sort((left, right) => {
    if (left.type === "event" && right.type === "event") {
      const leftOrder = left.event.metadata.onboarding_order
      const rightOrder = right.event.metadata.onboarding_order
      if (typeof leftOrder === "number" && typeof rightOrder === "number") {
        const onboardingOrder = leftOrder - rightOrder
        if (onboardingOrder !== 0) return onboardingOrder
      }
    }
    const timeOrder = Date.parse(left.createdAt) - Date.parse(right.createdAt)
    if (timeOrder !== 0) return timeOrder
    if (left.type === "event" && right.type === "event") {
      return left.event.sequence - right.event.sequence
    }
    if (left.type === "message" && right.type === "message") {
      return left.message.sequence - right.message.sequence
    }
    return left.type === "event" ? -1 : 1
  })
}

export function shouldShowAgentWelcomeFallback(
  loading: boolean,
  timelineItems: ConversationTimelineItem[]
) {
  return !loading && timelineItems.length === 0
}

export function shouldShowRunError(
  run: Pick<AgentRun, "id" | "status" | "errorMessage"> | null | undefined,
  messages: AgentMessage[]
) {
  if (run?.status !== "failed" || !run.errorMessage) return false
  return !hasVisibleAssistantReply(messages, run.id)
}

export function runStatusLabel(status?: string, awaitingRun = false) {
  if (awaitingRun) return "正在接收任务..."
  return (
    {
      queued: "等待 Agent 服务接收任务...",
      running: "正在处理任务...",
      executing: "正在执行操作...",
      verifying: "正在核对结果...",
    }[status ?? ""] ?? "正在加载 Agent 对话..."
  )
}
