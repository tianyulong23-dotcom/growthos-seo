import { apiRequest, resolveApiUrl } from "@/api/client"
import type {
  AgentAction,
  AgentAssistantMessageEvent,
  AgentConversation,
  AgentConversationDetail,
  AgentMessage,
  AgentRun,
  AgentRunStep,
  AgentStreamEvent,
} from "@/features/agent/types"

type ConversationResponse = {
  id: string
  project_id: string
  title: string
  created_at: string
  updated_at: string
}

type MessageResponse = {
  id: string
  run_id: string | null
  role: AgentMessage["role"]
  content: string
  metadata: Record<string, unknown>
  sequence: number
  created_at: string
}

type ActionResponse = {
  id: string
  run_id: string
  tool_name: string
  status: AgentAction["status"]
  preview: AgentAction["preview"]
  parameters_hash: string
  expires_at: string
  result: Record<string, unknown>
}

type RunResponse = {
  id: string
  conversation_id: string
  status: AgentRun["status"]
  current_step: number
  error_code: string | null
  error_message: string | null
  action: ActionResponse | null
  final_message_id: string | null
  steps: StepResponse[]
  created_at: string
  updated_at: string
}

type StepResponse = {
  sequence: number
  step_type: AgentRunStep["stepType"]
  name: string
  label: string
  summary: string | null
  status: AgentRunStep["status"]
  input: Record<string, unknown>
  output: Record<string, unknown>
  duration_ms: number | null
  error_message: string | null
}

type DetailResponse = {
  conversation: ConversationResponse
  messages: MessageResponse[]
  run: RunResponse | null
  action: ActionResponse | null
}

const path = (projectId: string) =>
  `/api/v1/projects/${encodeURIComponent(projectId)}/agent`

const mapConversation = (value: ConversationResponse): AgentConversation => ({
  id: value.id,
  projectId: value.project_id,
  title: value.title,
  createdAt: value.created_at,
  updatedAt: value.updated_at,
})

const mapAction = (value: ActionResponse): AgentAction => ({
  id: value.id,
  runId: value.run_id,
  toolName: value.tool_name,
  status: value.status,
  preview: value.preview,
  parametersHash: value.parameters_hash,
  expiresAt: value.expires_at,
  result: value.result,
})

const mapRun = (value: RunResponse): AgentRun => ({
  id: value.id,
  conversationId: value.conversation_id,
  status: value.status,
  currentStep: value.current_step,
  errorCode: value.error_code,
  errorMessage: value.error_message,
  action: value.action ? mapAction(value.action) : null,
  finalMessageId: value.final_message_id,
  steps: value.steps.map((step) => ({
    sequence: step.sequence,
    stepType: step.step_type,
    name: step.name,
    label: step.label,
    summary: step.summary,
    status: step.status,
    input: step.input,
    output: step.output,
    durationMs: step.duration_ms,
    errorMessage: step.error_message,
  })),
  createdAt: value.created_at,
  updatedAt: value.updated_at,
})

function mapDetail(value: DetailResponse): AgentConversationDetail {
  return {
    conversation: mapConversation(value.conversation),
    messages: value.messages.map((message) => ({
      id: message.id,
      runId: message.run_id,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
      sequence: message.sequence,
      createdAt: message.created_at,
    })),
    run: value.run ? mapRun(value.run) : null,
    action: value.action ? mapAction(value.action) : null,
  }
}

export function subscribeAgentConversation(
  projectId: string,
  conversationId: string,
  onEvent: (event: AgentStreamEvent) => void,
  onError: () => void
): () => void {
  const source = new EventSource(
    resolveApiUrl(
      `${path(projectId)}/conversations/${encodeURIComponent(conversationId)}/events`
    )
  )
  source.addEventListener("snapshot", (event) => {
    const message = event as MessageEvent<string>
    onEvent({
      type: "snapshot",
      detail: mapDetail(JSON.parse(message.data)),
      eventId: message.lastEventId,
    })
  })
  for (const type of [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ] as const) {
    source.addEventListener(type, (event) => {
      const message = event as MessageEvent<string>
      const payload = JSON.parse(message.data) as Record<string, unknown>
      const base = {
        type,
        eventId: message.lastEventId,
        eventKey: String(payload.event_key ?? ""),
        sequence: Number(payload.sequence ?? 0),
        projectId: String(payload.project_id ?? ""),
        conversationId: String(payload.conversation_id ?? ""),
        runId: String(payload.run_id ?? ""),
        createdAt: String(payload.created_at ?? new Date().toISOString()),
      }
      if (type === "agent_start") {
        onEvent({ ...base, type, status: "running" })
      } else if (type === "agent_end") {
        onEvent({
          ...base,
          type,
          status: String(payload.status ?? "completed") as
            | "completed"
            | "failed"
            | "cancelled"
            | "limit_reached",
          errorCode: String(payload.error_code ?? ""),
        })
      } else if (type === "turn_start") {
        onEvent({ ...base, type, round: Number(payload.round ?? 0) })
      } else if (type === "turn_end") {
        onEvent({
          ...base,
          type,
          round: Number(payload.round ?? 0),
          outcome: String(payload.outcome ?? ""),
          toolResultCount: Number(payload.tool_result_count ?? 0),
          errorCode: String(payload.error_code ?? ""),
        })
      } else if (
        type === "message_start" ||
        type === "message_update" ||
        type === "message_end"
      ) {
        const messageBase = {
          ...base,
          messageId: String(payload.message_id ?? ""),
          partId: String(payload.part_id ?? ""),
          phase: String(payload.phase ?? "decision") as "decision" | "final",
          attempt: Number(payload.attempt ?? 0),
          round:
            payload.round === undefined || payload.round === null
              ? null
              : Number(payload.round),
        }
        if (type === "message_update") {
          const assistantMessageEvent = mapAssistantMessageEvent(
            payload.assistant_message_event
          )
          if (!assistantMessageEvent) return
          onEvent({
            ...messageBase,
            type,
            assistantMessageEvent,
          })
        } else if (type === "message_end") {
          onEvent({
            ...messageBase,
            type,
            status: String(payload.status ?? "completed") as Extract<
              AgentStreamEvent,
              { type: "message_end" }
            >["status"],
            code: String(payload.code ?? ""),
            message: String(payload.message ?? ""),
            outcome: String(payload.outcome ?? ""),
          })
        } else {
          onEvent({ ...messageBase, type })
        }
      } else {
        const toolBase = {
          ...base,
          toolCallId: String(payload.tool_call_id ?? ""),
          toolName: String(payload.tool_name ?? ""),
          attempt: Number(payload.attempt ?? 1),
        }
        if (type === "tool_execution_start") {
          onEvent({
            ...toolBase,
            type,
            args: asRecord(payload.args),
          })
        } else if (type === "tool_execution_update") {
          onEvent({
            ...toolBase,
            type,
            stage: String(payload.stage ?? "running") as
              | "claimed"
              | "running"
              | "writing"
              | "verifying"
              | "retrying"
              | "completed"
              | "failed"
              | "rejected"
              | "cancelled"
              | "recovered",
          })
        } else {
          onEvent({
            ...toolBase,
            type,
            status: String(payload.status ?? "completed") as
              | "claimed"
              | "running"
              | "writing"
              | "verifying"
              | "retrying"
              | "completed"
              | "failed"
              | "rejected"
              | "cancelled"
              | "recovered",
            isError: Boolean(payload.is_error),
            summary: String(payload.summary ?? ""),
            errorCode: String(payload.error_code ?? ""),
            retryable: Boolean(payload.retryable),
          })
        }
      }
    })
  }
  source.onerror = onError
  return () => source.close()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function mapAssistantMessageEvent(
  value: unknown
): AgentAssistantMessageEvent | null {
  const event = asRecord(value)
  const kind = String(event.kind ?? "text_delta")
  if (kind === "text_delta" || kind === "thinking_delta") {
    return { kind, delta: String(event.delta ?? "") }
  }
  if (
    kind === "text_start" ||
    kind === "text_end" ||
    kind === "thinking_start" ||
    kind === "thinking_end"
  ) {
    return { kind }
  }
  if (kind === "toolcall_delta") {
    return {
      kind,
      index: Number(event.index ?? 0),
      idDelta: String(event.id_delta ?? ""),
      nameDelta: String(event.name_delta ?? ""),
      argumentsDelta: String(event.arguments_delta ?? ""),
    }
  }
  if (kind === "toolcall_start" || kind === "toolcall_end") {
    return {
      kind,
      index: Number(event.index ?? 0),
      toolCallId: String(event.tool_call_id ?? ""),
      toolName: String(event.tool_name ?? ""),
    }
  }
  return null
}

export async function createAgentConversation(
  projectId: string
): Promise<AgentConversation> {
  return mapConversation(
    await apiRequest<ConversationResponse>(`${path(projectId)}/conversations`, {
      method: "POST",
    })
  )
}

export async function listAgentConversations(
  projectId: string
): Promise<AgentConversation[]> {
  const response = await apiRequest<{
    items: ConversationResponse[]
  }>(`${path(projectId)}/conversations?page=1&page_size=20`)
  return response.items.map(mapConversation)
}

export async function getAgentConversation(
  projectId: string,
  conversationId: string
): Promise<AgentConversationDetail> {
  return mapDetail(
    await apiRequest<DetailResponse>(
      `${path(projectId)}/conversations/${encodeURIComponent(conversationId)}`
    )
  )
}

export async function sendAgentMessage(
  projectId: string,
  conversationId: string,
  content: string,
  pageContext?: { module: string; view?: string },
  clientRequestId = crypto.randomUUID()
): Promise<{ messageId: string; runId: string }> {
  const response = await apiRequest<{ message_id: string; run_id: string }>(
    `${path(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        client_request_id: clientRequestId,
        page_context: pageContext,
      }),
    }
  )
  return { messageId: response.message_id, runId: response.run_id }
}

export async function cancelAgentRun(
  projectId: string,
  runId: string
): Promise<AgentRun> {
  return mapRun(
    await apiRequest<RunResponse>(
      `${path(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST" }
    )
  )
}

export async function rewindAgentConversation(
  projectId: string,
  conversationId: string,
  messageId: string,
  clientRequestId = crypto.randomUUID()
): Promise<AgentConversationDetail> {
  return mapDetail(
    await apiRequest<DetailResponse>(
      `${path(projectId)}/conversations/${encodeURIComponent(conversationId)}/rewind`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message_id: messageId,
          client_request_id: clientRequestId,
        }),
      }
    )
  )
}

export async function editAgentMessage(
  projectId: string,
  conversationId: string,
  messageId: string,
  content: string,
  clientRequestId = crypto.randomUUID()
): Promise<{ messageId: string; runId: string }> {
  const response = await apiRequest<{ message_id: string; run_id: string }>(
    `${path(projectId)}/conversations/${encodeURIComponent(conversationId)}/edit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message_id: messageId,
        content,
        client_request_id: clientRequestId,
      }),
    }
  )
  return { messageId: response.message_id, runId: response.run_id }
}
