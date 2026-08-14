import * as React from "react"

import {
  cancelAgentRun,
  createAgentConversation,
  editAgentMessage,
  getAgentConversation,
  listAgentConversations,
  retryProjectOnboardingStep,
  rewindAgentConversation,
  sendAgentMessage,
  subscribeAgentConversation,
  syncProjectOnboarding,
} from "@/api/agent"
import { ApiError } from "@/api/client"
import type {
  AgentAssistantMessageEvent,
  AgentConversation,
  AgentConversationDetail,
  AgentRuntime,
  AgentRuntimeMessage,
  AgentRuntimeTool,
  AgentStreamEvent,
} from "@/features/agent/types"
import type { Project } from "@/features/projects/types"

const activeStatuses = new Set(["queued", "running", "executing", "verifying"])

export function mergeAgentStreamEvent(
  current: AgentConversationDetail | null,
  event: AgentStreamEvent
): AgentConversationDetail | null {
  if (event.type === "snapshot") {
    if (!current) return event.detail
    const persistedIds = new Set(event.detail.messages.map((item) => item.id))
    const activeRunId = event.detail.run?.id
    const runIsActive = Boolean(
      activeRunId && activeStatuses.has(event.detail.run?.status ?? "")
    )
    const streaming = current.messages.filter(
      (item) =>
        runIsActive &&
        (item.streaming || item.streamError) &&
        item.runId === activeRunId &&
        !persistedIds.has(item.id)
    )
    return {
      ...event.detail,
      messages: [...event.detail.messages, ...streaming],
      timeline: event.detail.timeline ?? [],
      runtime:
        runIsActive && current.runtime?.runId === activeRunId
          ? current.runtime
          : undefined,
    }
  }
  if (!current || current.conversation.id !== event.conversationId)
    return current
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
    for (const tool of runtime.tools) {
      if (
        ["claimed", "running", "writing", "verifying", "retrying"].includes(
          tool.stage
        )
      ) {
        tool.stage = event.status === "cancelled" ? "cancelled" : "failed"
        tool.isError = event.status !== "cancelled"
      }
    }
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
    const runtimeMessage = upsertRuntimeMessage(runtime, event)
    if (event.type === "message_start") {
      resetRuntimeMessage(runtimeMessage)
    } else if (event.type === "message_update") {
      applyAssistantUpdate(runtimeMessage, event.assistantMessageEvent)
    } else {
      runtimeMessage.status = runtimeMessageStatus(event.status)
      if (event.phase === "final" && event.outcome === "discarded") {
        const index = runtime.messages.findIndex(
          (item) => item.id === runtimeMessage.id
        )
        if (runtimeMessage.text.trim()) {
          runtime.messages[index] = {
            ...runtimeMessage,
            id: `${runtimeMessage.id}:decision:${event.round}:${event.attempt}`,
            phase: "decision",
            status: "completed",
          }
        } else if (index >= 0) {
          runtime.messages.splice(index, 1)
        }
      }
    }
    return { ...current, runtime }
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
  return { ...current, runtime }
}

export function agentStreamEventKey(event: AgentStreamEvent): string {
  if (event.type === "snapshot") return ""
  return event.eventKey || event.eventId || `${event.runId}:${event.sequence}`
}

function currentRuntime(
  runtime: AgentRuntime | undefined,
  runId: string
): AgentRuntime {
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
      "tool_execution_start" | "tool_execution_update" | "tool_execution_end"
  }
>

function isMessageStreamEvent(
  event: AgentStreamEvent
): event is MessageStreamEvent {
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
      order: event.sequence,
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
    const existing = message.toolCalls.find(
      (item) => item.index === event.index
    )
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
    const toolCall = message.toolCalls.find(
      (item) => item.index === event.index
    )
    if (toolCall) {
      toolCall.toolCallId = event.toolCallId || toolCall.toolCallId
      toolCall.toolName = event.toolName || toolCall.toolName
      toolCall.status = "completed"
    }
  }
}

function runtimeMessageStatus(
  status: Extract<AgentStreamEvent, { type: "message_end" }>["status"]
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

function upsertRuntimeTool(
  runtime: AgentRuntime,
  event: ToolStreamEvent
): AgentRuntimeTool {
  let tool = runtime.tools.find(
    (item) =>
      item.toolCallId === event.toolCallId && item.attempt === event.attempt
  )
  if (!tool) {
    const original = runtime.tools.find(
      (item) => item.toolCallId === event.toolCallId
    )
    tool = {
      toolCallId: event.toolCallId,
      order: original?.order ?? event.sequence,
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

export function useAgentConversation(
  projectId: string,
  understandingStatus?: Project["understandingStatus"]
) {
  const [detail, setDetail] = React.useState<AgentConversationDetail | null>(
    null
  )
  const [conversations, setConversations] = React.useState<AgentConversation[]>(
    []
  )
  const [loadedProjectId, setLoadedProjectId] = React.useState("")
  const [historyState, setHistoryState] = React.useState({
    projectId: "",
    loading: false,
  })
  const [errorState, setErrorState] = React.useState({
    projectId: "",
    message: "",
  })
  const [pendingRun, setPendingRun] = React.useState<{
    projectId: string
    conversationId: string
    runId: string
  } | null>(null)
  const [streamFallbackKey, setStreamFallbackKey] = React.useState("")
  const streamFailures = React.useRef({ key: "", count: 0 })
  const seenStreamEvents = React.useRef(new Set<string>())
  const onboardingActivity = React.useRef({ projectId: "", active: false })
  const currentDetail =
    detail?.conversation.projectId === projectId ? detail : null
  const currentConversations = conversations.filter(
    (conversation) => conversation.projectId === projectId
  )
  const loading = Boolean(projectId && loadedProjectId !== projectId)
  const historyLoading =
    historyState.projectId === projectId && historyState.loading
  const error = errorState.projectId === projectId ? errorState.message : ""
  const setError = React.useCallback(
    (message: string) => setErrorState({ projectId, message }),
    [projectId]
  )
  const conversationId = currentDetail?.conversation.id ?? ""
  const runId = currentDetail?.run?.id ?? ""
  const streamKey = conversationId
  const streamFallback = Boolean(
    conversationId && streamFallbackKey === streamKey
  )
  const awaitingRun = Boolean(
    pendingRun &&
    pendingRun.projectId === projectId &&
    pendingRun.conversationId === conversationId &&
    pendingRun.runId !== runId
  )
  const timelineOnboardingActive = Boolean(
    currentDetail?.timeline.some(
      (event) =>
        (event.status === "running" || event.status === "waiting") &&
        (event.metadata.source === "onboarding" ||
          event.metadata.source === "site_understanding" ||
          event.metadata.source === "site_profile")
    )
  )

  const settlePendingRun = React.useCallback(
    (next: AgentConversationDetail) => {
      setPendingRun((current) => {
        if (
          current?.projectId === next.conversation.projectId &&
          current.conversationId === next.conversation.id &&
          current.runId === next.run?.id
        ) {
          return null
        }
        return current
      })
    },
    []
  )

  const refresh = React.useCallback(async () => {
    if (!projectId || !conversationId) return
    const next = await getAgentConversation(projectId, conversationId)
    settlePendingRun(next)
    setDetail(next)
  }, [conversationId, projectId, settlePendingRun])

  const create = React.useCallback(async () => {
    if (!projectId) return
    setError("")
    setPendingRun(null)
    const conversation = await createAgentConversation(projectId)
    const next = await getAgentConversation(projectId, conversation.id)
    setConversations((current) => [
      conversation,
      ...current.filter((item) => item.id !== conversation.id),
    ])
    setDetail(next)
  }, [projectId, setError])

  const loadConversations = React.useCallback(async () => {
    if (!projectId) return
    setHistoryState({ projectId, loading: true })
    setError("")
    try {
      setConversations(await listAgentConversations(projectId))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setHistoryState({ projectId, loading: false })
    }
  }, [projectId, setError])

  const selectConversation = React.useCallback(
    async (nextConversationId: string) => {
      if (!projectId || nextConversationId === conversationId) return
      setError("")
      setPendingRun(null)
      setDetail(await getAgentConversation(projectId, nextConversationId))
    },
    [conversationId, projectId, setError]
  )

  React.useEffect(() => {
    let active = true
    streamFailures.current = { key: "", count: 0 }
    seenStreamEvents.current.clear()
    if (!projectId) {
      return
    }
    void syncProjectOnboarding(projectId)
      .catch(() => undefined)
      .then(() => listAgentConversations(projectId))
      .then(async (conversations) => {
        if (!active) return null
        setConversations(conversations)
        const conversation =
          conversations[0] ?? (await createAgentConversation(projectId))
        return getAgentConversation(projectId, conversation.id)
      })
      .then((next) => {
        if (!active || !next) return
        setError("")
        setDetail(next)
      })
      .catch((reason) => active && setError(errorMessage(reason)))
      .finally(() => active && setLoadedProjectId(projectId))
    return () => {
      active = false
    }
  }, [projectId, setError])

  React.useEffect(() => {
    if (!projectId || !conversationId) return
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
        if (event.type === "snapshot") settlePendingRun(event.detail)
        setDetail((current) => mergeAgentStreamEvent(current, event))
        if (
          event.type === "agent_end" ||
          (event.type === "message_end" &&
            event.phase === "final" &&
            event.outcome === "persisted")
        ) {
          void getAgentConversation(projectId, conversationId)
            .then((next) => {
              settlePendingRun(next)
              setDetail(next)
            })
            .catch((reason) => setError(errorMessage(reason)))
        }
      },
      () => {
        if (streamFailures.current.key !== streamKey) return
        streamFailures.current.count += 1
        if (streamFailures.current.count >= 3) setStreamFallbackKey(streamKey)
      }
    )
  }, [conversationId, projectId, setError, settlePendingRun, streamKey])

  React.useEffect(() => {
    if (!streamFallback) return
    const timer = window.setInterval(() => {
      void refresh().catch((reason) => setError(errorMessage(reason)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [refresh, setError, streamFallback])

  React.useEffect(() => {
    const onboardingIsActive =
      understandingStatus === "queued" ||
      understandingStatus === "running" ||
      timelineOnboardingActive
    const onboardingWasActive =
      onboardingActivity.current.projectId === projectId &&
      onboardingActivity.current.active
    onboardingActivity.current = { projectId, active: onboardingIsActive }

    if (
      !projectId ||
      !conversationId ||
      (!onboardingIsActive && !onboardingWasActive)
    ) {
      return
    }

    let active = true
    let timer = 0

    async function reconcile() {
      try {
        await syncProjectOnboarding(projectId)
        const next = await getAgentConversation(projectId, conversationId)
        if (active) setDetail(next)
      } catch {
        // Keep the current timeline visible and retry on the next project poll.
      }
    }

    if (!onboardingIsActive) {
      void reconcile()
      return () => {
        active = false
      }
    }

    async function poll() {
      await reconcile()
      if (active) {
        timer = window.setTimeout(() => {
          void poll()
        }, 1200)
      }
    }

    timer = window.setTimeout(() => {
      void poll()
    }, 1200)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [conversationId, projectId, timelineOnboardingActive, understandingStatus])

  React.useEffect(() => {
    if (
      !pendingRun ||
      pendingRun.projectId !== projectId ||
      pendingRun.conversationId !== conversationId
    ) {
      return
    }
    if (pendingRun.runId === runId) return
    const timer = window.setInterval(() => {
      void refresh().catch((reason) => setError(errorMessage(reason)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [conversationId, pendingRun, projectId, refresh, runId, setError])

  const send = React.useCallback(
    async (
      content: string,
      pageContext?: { module: string; view?: string }
    ) => {
      if (!projectId || !currentDetail) return
      setError("")
      setPendingRun(null)
      const clientRequestId = crypto.randomUUID()
      let accepted: { messageId: string; runId: string }
      try {
        accepted = await sendAgentMessage(
          projectId,
          currentDetail.conversation.id,
          content,
          pageContext,
          clientRequestId
        )
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 503) throw reason
        accepted = await sendAgentMessage(
          projectId,
          currentDetail.conversation.id,
          content,
          pageContext,
          clientRequestId
        )
      }
      setPendingRun({
        projectId,
        conversationId: currentDetail.conversation.id,
        runId: accepted.runId,
      })
      try {
        const next = await getAgentConversation(
          projectId,
          currentDetail.conversation.id
        )
        settlePendingRun(next)
        setDetail(next)
      } catch (reason) {
        setError(errorMessage(reason))
      }
    },
    [currentDetail, projectId, setError, settlePendingRun]
  )

  const cancel = React.useCallback(async () => {
    if (!projectId || !runId) return
    setError("")
    await cancelAgentRun(projectId, runId)
    await refresh()
  }, [projectId, refresh, runId, setError])

  const retryOnboardingStep = React.useCallback(
    async (stepKey: string) => {
      if (!projectId) return
      setError("")
      await retryProjectOnboardingStep(projectId, stepKey)
      await refresh()
    },
    [projectId, refresh, setError]
  )

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
    [conversationId, projectId, setError]
  )

  const edit = React.useCallback(
    async (messageId: string, content: string) => {
      if (!projectId || !conversationId) return
      setError("")
      setPendingRun(null)
      const clientRequestId = crypto.randomUUID()
      let accepted: { messageId: string; runId: string }
      try {
        accepted = await editAgentMessage(
          projectId,
          conversationId,
          messageId,
          content,
          clientRequestId
        )
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 503) throw reason
        accepted = await editAgentMessage(
          projectId,
          conversationId,
          messageId,
          content,
          clientRequestId
        )
      }
      setPendingRun({ projectId, conversationId, runId: accepted.runId })
      try {
        const next = await getAgentConversation(projectId, conversationId)
        settlePendingRun(next)
        setDetail(next)
      } catch (reason) {
        setError(errorMessage(reason))
      }
    },
    [conversationId, projectId, setError, settlePendingRun]
  )

  return {
    detail: currentDetail,
    conversations: currentConversations,
    loading,
    historyLoading,
    awaitingRun,
    error,
    setError,
    create,
    loadConversations,
    selectConversation,
    send,
    cancel,
    rewind,
    edit,
    retryOnboardingStep,
    refresh,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Agent 请求失败"
}
