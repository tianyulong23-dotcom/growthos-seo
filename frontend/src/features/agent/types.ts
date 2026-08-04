export type AgentRunStatus =
  | "queued"
  | "running"
  | "executing"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed"
  | "limit_reached"
  // Legacy statuses remain readable in historical conversations.
  | "waiting_approval"
  | "rejected"
  | "expired"

export type AgentMessage = {
  id: string
  runId: string | null
  role: "user" | "assistant" | "system_event"
  content: string
  metadata: Record<string, unknown>
  sequence: number
  createdAt: string
  streaming?: boolean
  streamError?: string | null
}

export type AgentAction = {
  id: string
  runId: string
  toolName: string
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "executing"
    | "completed"
    | "failed"
    | "expired"
  preview: {
    title?: string
    impact?: string
    changes?: { field: string; before: unknown; after: unknown }[]
    settings?: Record<string, unknown>
  }
  parametersHash: string
  expiresAt: string
  result: Record<string, unknown>
}

export type AgentRun = {
  id: string
  conversationId: string
  status: AgentRunStatus
  currentStep: number
  errorCode: string | null
  errorMessage: string | null
  action: AgentAction | null
  finalMessageId: string | null
  steps: AgentRunStep[]
  createdAt: string
  updatedAt: string
}

export type AgentRunStep = {
  sequence: number
  stepType: "model" | "tool" | "action" | "execution" | "verification" | "cancellation"
  name: string
  label: string
  summary: string | null
  status: "running" | "completed" | "failed" | "cancelled"
  input: Record<string, unknown>
  output: Record<string, unknown>
  durationMs: number | null
  errorMessage: string | null
}

export type AgentConversation = {
  id: string
  projectId: string
  title: string
  createdAt: string
  updatedAt: string
}

export type AgentConversationDetail = {
  conversation: AgentConversation
  messages: AgentMessage[]
  run: AgentRun | null
  action: AgentAction | null
  runtime?: AgentRuntime
}

type AgentStreamBase = {
  eventId: string
  eventKey: string
  sequence: number
  projectId: string
  conversationId: string
  runId: string
  createdAt: string
}

type AgentMessageStreamBase = AgentStreamBase & {
  messageId: string
  partId: string
  phase: "decision" | "final"
  attempt: number
  round: number | null
}

export type AgentAssistantMessageEvent =
  | { kind: "text_start" }
  | { kind: "text_delta"; delta: string }
  | { kind: "text_end" }
  | { kind: "thinking_start" }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "thinking_end" }
  | {
      kind: "toolcall_start"
      index: number
      toolCallId: string
      toolName: string
    }
  | {
      kind: "toolcall_delta"
      index: number
      idDelta: string
      nameDelta: string
      argumentsDelta: string
    }
  | {
      kind: "toolcall_end"
      index: number
      toolCallId: string
      toolName: string
    }

export type AgentRuntimeMessage = {
  id: string
  phase: "decision" | "final"
  attempt: number
  round: number | null
  status: "streaming" | "completed" | "invalid" | "error" | "recovered"
  text: string
  thinking: string
  toolCalls: {
    index: number
    toolCallId: string
    toolName: string
    argumentsText: string
    status: "streaming" | "completed"
  }[]
}

export type AgentRuntimeTool = {
  toolCallId: string
  toolName: string
  attempt: number
  stage: "claimed" | "running" | "writing" | "verifying" | "retrying" | "completed" | "failed" | "rejected" | "cancelled" | "recovered"
  isError: boolean
  summary: string
  errorCode: string
  retryable: boolean
}

export type AgentRuntime = {
  runId: string
  agentStatus: "running" | "completed" | "failed" | "cancelled" | "limit_reached"
  activeRound: number | null
  messages: AgentRuntimeMessage[]
  tools: AgentRuntimeTool[]
  lastEventType: Exclude<AgentStreamEvent["type"], "snapshot">
}

export type AgentStreamEvent =
  | { type: "snapshot"; detail: AgentConversationDetail; eventId: string }
  | (AgentStreamBase & { type: "agent_start"; status: "running" })
  | (AgentStreamBase & {
      type: "agent_end"
      status: AgentRuntime["agentStatus"]
      errorCode: string
    })
  | (AgentStreamBase & { type: "turn_start"; round: number })
  | (AgentStreamBase & {
      type: "turn_end"
      round: number
      outcome: string
      toolResultCount: number
      errorCode: string
    })
  | (AgentMessageStreamBase & { type: "message_start" })
  | (AgentMessageStreamBase & {
      type: "message_update"
      assistantMessageEvent: AgentAssistantMessageEvent
    })
  | (AgentMessageStreamBase & {
      type: "message_end"
      status: AgentRuntimeMessage["status"] | AgentRunStatus
      code: string
      message: string
      outcome: string
    })
  | (AgentStreamBase & {
      type: "tool_execution_start"
      toolCallId: string
      toolName: string
      attempt: number
      args: Record<string, unknown>
    })
  | (AgentStreamBase & {
      type: "tool_execution_update"
      toolCallId: string
      toolName: string
      attempt: number
      stage: AgentRuntimeTool["stage"]
    })
  | (AgentStreamBase & {
      type: "tool_execution_end"
      toolCallId: string
      toolName: string
      attempt: number
      status: AgentRuntimeTool["stage"]
      isError: boolean
      summary: string
      errorCode: string
      retryable: boolean
    })
