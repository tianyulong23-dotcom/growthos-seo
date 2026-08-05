import * as React from "react"

import {
  cancelAgentRun,
  createAgentConversation,
  editAgentMessage,
  getAgentConversation,
  listAgentConversations,
  rewindAgentConversation,
  sendAgentMessage,
  subscribeAgentConversation,
} from "@/api/agent"
import { ApiError } from "@/api/client"
import type {
  AgentAssistantMessageEvent,
  AgentConversationDetail,
  AgentMessage,
  AgentRuntime,
  AgentRuntimeMessage,
  AgentRuntimeTool,
  AgentStreamEvent,
} from "@/features/agent/types"

const activeStatuses = new Set([
  "queued",
  "running",
  "executing",
  "verifying",
])

export function mergeAgentStreamEvent(
  current: AgentConversationDetail | null,
  event: AgentStreamEvent
): AgentConversationDetail | null {
  if (event.type === "snapshot") {
    if (!current) return event.detail
    const persistedIds = new Set(event.detail.messages.map((item) => item.id))
    const activeRunId = event.detail.run?.id
    const streaming = current.messages.filter(
      (item) =>
        (item.streaming || item.streamError) &&
        item.runId === activeRunId &&
        !persistedIds.has(item.id)
    )
    return {
      ...event.detail,
      messages: [...event.detail.messages, ...streaming],
      runtime:
        current.runtime?.runId === activeRunId ? current.runtime : undefined,
    }
  }
  if (!current || current.conversation.id !== event.conversationId) return current
  if (current.run?.id !== event.runId) return current
  const runtime = currentRuntime(current.runtime, event.runId)
  runtime.lastEventType = event.type

  if (event.type === "agent_start") {
    runtime.agentStatus = "running"
    return { ...current, runtime }
  }
  if (event.type === "agent_end") {
    runtime.agentStatus = event.status
    runtime.activeRound = null
    return { ...current, runtime }
  }
  if (event.type === "turn_start") {
    runtime.activeRound = event.round
    return { ...current, runtime }
  }
  if (event.type === "turn_end") {
    if (runtime.activeRound === event.round) runtime.activeRound = null
    return { ...current, runtime }
  }
  if (isMessageStreamEvent(event)) {
    const messages = [...current.messages]
    const runtimeMessage = upsertRuntimeMessage(runtime, event)
    if (event.type === "message_start") {
      resetRuntimeMessage(runtimeMessage)
      if (event.phase === "final") {
        upsertStreamingChatMessage(messages, event)
      }
    } else if (event.type === "message_update") {
      applyAssistantUpdate(runtimeMessage, event.assistantMessageEvent)
      if (
        event.phase === "final" &&
        event.assistantMessageEvent.kind === "text_delta"
      ) {
        appendStreamingChatDelta(
          messages,
          event.messageId,
          event.assistantMessageEvent.delta
        )
      }
    } else {
      runtimeMessage.status = runtimeMessageStatus(event.status)
      if (event.phase === "final") {
        finishStreamingChatMessage(
          messages,
          event.messageId,
          event.status === "error" ? event.message || "回答生成中断" : null
        )
      }
    }
    runtime.messages = runtime.messages.slice(-24)
    return { ...current, messages, runtime }
  }

  const tool = upsertRuntimeTool(runtime, event)
  if (event.type === "tool_execution_start") {
    tool.toolName = event.toolName
    tool.stage = "claimed"
    tool.isError = false
    tool.summary = ""
    tool.errorCode = ""
    tool.retryable = false
  } else if (event.type === "tool_execution_update") {
    tool.stage = event.stage
  } else {
    tool.stage = event.status
    tool.isError = event.isError
    tool.summary = event.summary
    tool.errorCode = event.errorCode
    tool.retryable = event.retryable
  }
  runtime.tools = runtime.tools.slice(-40)
  return { ...current, runtime }
}

export function agentStreamEventKey(event: AgentStreamEvent): string {
  if (event.type === "snapshot") return ""
  return event.eventKey || event.eventId || `${event.runId}:${event.sequence}`
}

function currentRuntime(runtime: AgentRuntime | undefined, runId: string): AgentRuntime {
  if (runtime?.runId === runId) {
    return {
      ...runtime,
      messages: runtime.messages.map((message) => ({
        ...message,
        toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
      })),
      tools: runtime.tools.map((tool) => ({ ...tool })),
    }
  }
  return {
    runId,
    agentStatus: "running",
    activeRound: null,
    messages: [],
    tools: [],
    lastEventType: "agent_start",
  }
}

type MessageStreamEvent = Extract<
  AgentStreamEvent,
  { type: "message_start" | "message_update" | "message_end" }
>

type ToolStreamEvent = Extract<
  AgentStreamEvent,
  {
    type:
      | "tool_execution_start"
      | "tool_execution_update"
      | "tool_execution_end"
  }
>

function isMessageStreamEvent(event: AgentStreamEvent): event is MessageStreamEvent {
  return (
    event.type === "message_start" ||
    event.type === "message_update" ||
    event.type === "message_end"
  )
}

function upsertRuntimeMessage(
  runtime: AgentRuntime,
  event: MessageStreamEvent
): AgentRuntimeMessage {
  let message = runtime.messages.find((item) => item.id === event.messageId)
  if (!message) {
    message = {
      id: event.messageId,
      phase: event.phase,
      attempt: event.attempt,
      round: event.round,
      status: "streaming",
      text: "",
      thinking: "",
      toolCalls: [],
    }
    runtime.messages.push(message)
  }
  return message
}

function resetRuntimeMessage(message: AgentRuntimeMessage) {
  message.status = "streaming"
  message.text = ""
  message.thinking = ""
  message.toolCalls = []
}

function applyAssistantUpdate(
  message: AgentRuntimeMessage,
  event: AgentAssistantMessageEvent
) {
  if (event.kind === "text_delta") {
    message.text += event.delta
    return
  }
  if (event.kind === "thinking_delta") {
    message.thinking += event.delta
    return
  }
  if (event.kind === "toolcall_start") {
    const existing = message.toolCalls.find((item) => item.index === event.index)
    if (existing) {
      existing.toolCallId = event.toolCallId
      existing.toolName = event.toolName
      existing.argumentsText = ""
      existing.status = "streaming"
    } else {
      message.toolCalls.push({
        index: event.index,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argumentsText: "",
        status: "streaming",
      })
    }
    return
  }
  if (event.kind === "toolcall_delta") {
    let toolCall = message.toolCalls.find((item) => item.index === event.index)
    if (!toolCall) {
      toolCall = {
        index: event.index,
        toolCallId: "",
        toolName: "",
        argumentsText: "",
        status: "streaming",
      }
      message.toolCalls.push(toolCall)
    }
    toolCall.toolCallId += event.idDelta
    toolCall.toolName += event.nameDelta
    toolCall.argumentsText += event.argumentsDelta
    return
  }
  if (event.kind === "toolcall_end") {
    const toolCall = message.toolCalls.find((item) => item.index === event.index)
    if (toolCall) {
      toolCall.toolCallId = event.toolCallId || toolCall.toolCallId
      toolCall.toolName = event.toolName || toolCall.toolName
      toolCall.status = "completed"
    }
  }
}

function runtimeMessageStatus(
  status: Extract<AgentStreamEvent, { type: "message_end" }>['status']
): AgentRuntimeMessage["status"] {
  if (
    status === "completed" ||
    status === "invalid" ||
    status === "error" ||
    status === "recovered"
  ) {
    return status
  }
  return status === "failed" || status === "cancelled" ? "error" : "completed"
}

function upsertStreamingChatMessage(
  messages: AgentMessage[],
  event: Extract<AgentStreamEvent, { type: "message_start" }>
) {
  const index = messages.findIndex((item) => item.id === event.messageId)
  if (index >= 0) {
    if (messages[index].streaming || messages[index].streamError) {
      messages[index] = {
        ...messages[index],
        content: "",
        streaming: true,
        streamError: null,
      }
    }
    return
  }
  messages.push({
    id: event.messageId,
    runId: event.runId,
    role: "assistant",
    content: "",
    metadata: { partId: event.partId },
    sequence: Math.max(0, ...messages.map((item) => item.sequence)) + 1,
    createdAt: event.createdAt,
    streaming: true,
    streamError: null,
  })
}

function appendStreamingChatDelta(
  messages: AgentMessage[],
  messageId: string,
  delta: string
) {
  const index = messages.findIndex((item) => item.id === messageId)
  if (index < 0 || !messages[index].streaming) return
  messages[index] = {
    ...messages[index],
    content: messages[index].content + delta,
    streamError: null,
  }
}

function finishStreamingChatMessage(
  messages: AgentMessage[],
  messageId: string,
  error: string | null
) {
  const index = messages.findIndex((item) => item.id === messageId)
  if (index < 0) return
  messages[index] = {
    ...messages[index],
    streaming: false,
    streamError: error,
  }
}

function upsertRuntimeTool(
  runtime: AgentRuntime,
  event: ToolStreamEvent
): AgentRuntimeTool {
  let tool = runtime.tools.find(
    (item) =>
      item.toolCallId === event.toolCallId && item.attempt === event.attempt
  )
  if (!tool) {
    tool = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      attempt: event.attempt,
      stage: "claimed",
      isError: false,
      summary: "",
      errorCode: "",
      retryable: false,
    }
    runtime.tools.push(tool)
  }
  return tool
}

export function useAgentConversation(projectId: string) {
  const [detail, setDetail] = React.useState<AgentConversationDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [streamFallbackKey, setStreamFallbackKey] = React.useState("")
  const streamFailures = React.useRef({ key: "", count: 0 })
  const seenStreamEvents = React.useRef(new Set<string>())
  const conversationId = detail?.conversation.id ?? ""
  const runId = detail?.run?.id ?? ""
  const runStatus = detail?.run?.status ?? ""
  const streamKey = `${conversationId}:${runId}`
  const streamFallback = Boolean(runId && streamFallbackKey === streamKey)

  const refresh = React.useCallback(async () => {
    if (!projectId || !conversationId) return
    const next = await getAgentConversation(projectId, conversationId)
    setDetail(next)
  }, [conversationId, projectId])

  const create = React.useCallback(async () => {
    if (!projectId) return
    setError("")
    const conversation = await createAgentConversation(projectId)
    setDetail(await getAgentConversation(projectId, conversation.id))
  }, [projectId])

  React.useEffect(() => {
    let active = true
    if (!projectId) {
      return
    }
    void listAgentConversations(projectId)
      .then(async (conversations) => {
        const conversation =
          conversations[0] ?? (await createAgentConversation(projectId))
        return getAgentConversation(projectId, conversation.id)
      })
      .then((next) => active && setDetail(next))
      .catch((reason) => active && setError(errorMessage(reason)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [projectId])

  React.useEffect(() => {
    if (!runId || !activeStatuses.has(runStatus)) {
      return
    }
    streamFailures.current = { key: streamKey, count: 0 }
    seenStreamEvents.current.clear()
    return subscribeAgentConversation(
      projectId,
      conversationId,
      (event) => {
        if (streamFailures.current.key !== streamKey) return
        streamFailures.current.count = 0
        setStreamFallbackKey((current) =>
          current === streamKey ? "" : current
        )
        const dedupeKey = agentStreamEventKey(event)
        if (dedupeKey && seenStreamEvents.current.has(dedupeKey)) return
        if (dedupeKey) seenStreamEvents.current.add(dedupeKey)
        setDetail((current) => mergeAgentStreamEvent(current, event))
        if (
          event.type === "agent_end" ||
          (event.type === "message_end" &&
            event.phase === "final" &&
            event.outcome === "persisted")
        ) {
          void getAgentConversation(projectId, conversationId)
            .then((next) => setDetail(next))
            .catch((reason) => setError(errorMessage(reason)))
        }
      },
      () => {
        if (streamFailures.current.key !== streamKey) return
        streamFailures.current.count += 1
        if (streamFailures.current.count >= 3) setStreamFallbackKey(streamKey)
      }
    )
  }, [conversationId, projectId, runId, runStatus, streamKey])

  React.useEffect(() => {
    if (!streamFallback || !runId || !activeStatuses.has(runStatus)) {
      return
    }
    const timer = window.setInterval(() => {
      void refresh().catch((reason) => setError(errorMessage(reason)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [refresh, runId, runStatus, streamFallback])

  const send = React.useCallback(
    async (content: string, pageContext?: { module: string; view?: string }) => {
      if (!projectId || !detail) return
      setError("")
      const clientRequestId = crypto.randomUUID()
      try {
        await sendAgentMessage(
          projectId,
          detail.conversation.id,
          content,
          pageContext,
          clientRequestId
        )
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 503) throw reason
        await sendAgentMessage(
          projectId,
          detail.conversation.id,
          content,
          pageContext,
          clientRequestId
        )
      } finally {
        setDetail(
          await getAgentConversation(projectId, detail.conversation.id)
        )
      }
    },
    [detail, projectId]
  )

  const cancel = React.useCallback(async () => {
    if (!projectId || !runId) return
    setError("")
    await cancelAgentRun(projectId, runId)
    await refresh()
  }, [projectId, refresh, runId])

  const rewind = React.useCallback(
    async (messageId: string) => {
      if (!projectId || !conversationId) return
      setError("")
      const next = await rewindAgentConversation(
        projectId,
        conversationId,
        messageId
      )
      setDetail(next)
    },
    [conversationId, projectId]
  )

  const edit = React.useCallback(
    async (messageId: string, content: string) => {
      if (!projectId || !conversationId) return
      setError("")
      const clientRequestId = crypto.randomUUID()
      try {
        await editAgentMessage(
          projectId,
          conversationId,
          messageId,
          content,
          clientRequestId
        )
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 503) throw reason
        await editAgentMessage(
          projectId,
          conversationId,
          messageId,
          content,
          clientRequestId
        )
      } finally {
        setDetail(await getAgentConversation(projectId, conversationId))
      }
    },
    [conversationId, projectId]
  )

  return {
    detail,
    loading,
    error,
    setError,
    create,
    send,
    cancel,
    rewind,
    edit,
    refresh,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Agent 请求失败"
}
