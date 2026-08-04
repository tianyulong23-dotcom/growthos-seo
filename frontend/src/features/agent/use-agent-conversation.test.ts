import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"

const agentApi = vi.hoisted(() => ({
  cancelAgentRun: vi.fn(),
  createAgentConversation: vi.fn(),
  editAgentMessage: vi.fn(),
  getAgentConversation: vi.fn(),
  listAgentConversations: vi.fn(),
  rewindAgentConversation: vi.fn(),
  sendAgentMessage: vi.fn(),
  subscribeAgentConversation: vi.fn(),
}))

vi.mock("@/api/agent", () => agentApi)

import {
  agentStreamEventKey,
  mergeAgentStreamEvent,
  useAgentConversation,
} from "@/features/agent/use-agent-conversation"
import type {
  AgentAssistantMessageEvent,
  AgentConversationDetail,
  AgentStreamEvent,
} from "@/features/agent/types"

function detail(): AgentConversationDetail {
  return {
    conversation: {
      id: "conversation-1",
      projectId: "project-1",
      title: "Agent conversation",
      createdAt: "2026-07-31T08:00:00Z",
      updatedAt: "2026-07-31T08:00:00Z",
    },
    messages: [{
      id: "user-1",
      runId: "run-1",
      role: "user",
      content: "总结最新审计",
      metadata: {},
      sequence: 1,
      createdAt: "2026-07-31T08:00:00Z",
    }],
    run: {
      id: "run-1",
      conversationId: "conversation-1",
      status: "verifying",
      currentStep: 2,
      errorCode: null,
      errorMessage: null,
      action: null,
      finalMessageId: null,
      steps: [],
      createdAt: "2026-07-31T08:00:00Z",
      updatedAt: "2026-07-31T08:00:00Z",
    },
    action: null,
  }
}

type MessageEventBase = Omit<
  Extract<AgentStreamEvent, { type: "message_start" }>,
  "type"
>

const base: MessageEventBase = {
  eventId: "1-0",
  eventKey: "run-1:final:start",
  sequence: 1,
  projectId: "project-1",
  conversationId: "conversation-1",
  runId: "run-1",
  messageId: "assistant-final",
  partId: "assistant-final:text",
  phase: "final",
  attempt: 0,
  round: null,
  createdAt: "2026-07-31T08:00:01Z",
}

function messageStart(extra: Partial<typeof base> = {}): AgentStreamEvent {
  return { ...base, ...extra, type: "message_start" }
}

function messageUpdate(
  assistantMessageEvent: AgentAssistantMessageEvent,
  extra: Partial<typeof base> = {}
): AgentStreamEvent {
  return { ...base, ...extra, type: "message_update", assistantMessageEvent }
}

function messageEnd(
  status: "completed" | "error" = "completed",
  extra: Partial<typeof base> & { message?: string; outcome?: string } = {}
): AgentStreamEvent {
  return {
    ...base,
    ...extra,
    type: "message_end",
    status,
    code: status === "error" ? "model_provider_unavailable" : "",
    message: extra.message ?? "",
    outcome: extra.outcome ?? "",
  }
}

function merge(
  current: AgentConversationDetail,
  event: AgentStreamEvent
): AgentConversationDetail {
  const result = mergeAgentStreamEvent(current, event)
  if (!result) throw new Error("expected conversation detail")
  return result
}

let streamEvent: ((event: AgentStreamEvent) => void) | undefined
let streamError: (() => void) | undefined
let closeStream: ReturnType<typeof vi.fn>

beforeEach(() => {
  const current = detail()
  streamEvent = undefined
  streamError = undefined
  closeStream = vi.fn()
  agentApi.listAgentConversations.mockResolvedValue([current.conversation])
  agentApi.createAgentConversation.mockResolvedValue(current.conversation)
  agentApi.getAgentConversation.mockResolvedValue(current)
  agentApi.subscribeAgentConversation.mockImplementation(
    (
      _projectId: string,
      _conversationId: string,
      onEvent: (event: AgentStreamEvent) => void,
      onError: () => void
    ) => {
      streamEvent = onEvent
      streamError = onError
      return closeStream
    }
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("mergeAgentStreamEvent", () => {
  it("creates one final chat message and appends only text deltas", () => {
    let current = merge(detail(), messageStart())
    current = merge(current, messageUpdate({ kind: "text_start" }))
    current = merge(current, messageUpdate(
      { kind: "text_delta", delta: "审计" },
      { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
    ))
    current = merge(current, messageUpdate(
      { kind: "text_delta", delta: "已完成" },
      { eventId: "3-0", eventKey: "run-1:final:update:2", sequence: 3 }
    ))

    const message = current.messages.at(-1)
    expect(message?.id).toBe("assistant-final")
    expect(message?.content).toBe("审计已完成")
    expect(message?.streaming).toBe(true)
    expect(current.runtime?.messages.at(-1)?.text).toBe("审计已完成")
  })

  it("rebuilds two interleaved tool calls by index without exposing them as chat", () => {
    const decisionBase = {
      ...base,
      messageId: "assistant-decision",
      partId: "assistant-decision:assistant",
      phase: "decision" as const,
      round: 2,
    }
    let current = merge(detail(), messageStart(decisionBase))
    current = merge(current, messageUpdate(
      { kind: "toolcall_start", index: 0, toolCallId: "", toolName: "" },
      decisionBase
    ))
    current = merge(current, messageUpdate(
      { kind: "toolcall_start", index: 1, toolCallId: "", toolName: "" },
      decisionBase
    ))
    current = merge(current, messageUpdate({
      kind: "toolcall_delta", index: 0, idDelta: "call-", nameDelta: "get_", argumentsDelta: "{\"a\":"
    }, decisionBase))
    current = merge(current, messageUpdate({
      kind: "toolcall_delta", index: 1, idDelta: "call-2", nameDelta: "search", argumentsDelta: "{}"
    }, decisionBase))
    current = merge(current, messageUpdate({
      kind: "toolcall_delta", index: 0, idDelta: "1", nameDelta: "audit", argumentsDelta: "1}"
    }, decisionBase))
    current = merge(current, messageUpdate(
      { kind: "toolcall_end", index: 0, toolCallId: "call-1", toolName: "get_audit" },
      decisionBase
    ))

    expect(current.messages).toHaveLength(1)
    expect(current.runtime?.messages[0].toolCalls).toEqual([
      {
        index: 0,
        toolCallId: "call-1",
        toolName: "get_audit",
        argumentsText: "{\"a\":1}",
        status: "completed",
      },
      {
        index: 1,
        toolCallId: "call-2",
        toolName: "search",
        argumentsText: "{}",
        status: "streaming",
      },
    ])
  })

  it("keeps an unpersisted final stream across database snapshots", () => {
    let current = merge(detail(), messageStart())
    current = merge(current, messageUpdate(
      { kind: "text_delta", delta: "半段回答" },
      { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
    ))
    current = merge(current, { type: "snapshot", detail: detail(), eventId: "" })

    expect(current.messages.at(-1)?.content).toBe("半段回答")
    expect(current.messages.at(-1)?.streaming).toBe(true)
    expect(current.runtime?.messages.at(-1)?.text).toBe("半段回答")
  })

  it("keeps interrupted content until the persisted message arrives", () => {
    let current = merge(detail(), messageStart())
    current = merge(current, messageUpdate(
      { kind: "text_delta", delta: "半段回答" },
      { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
    ))
    current = merge(current, messageEnd("error", {
      eventId: "3-0",
      eventKey: "run-1:final:end:error",
      sequence: 3,
      message: "回答生成中断",
    }))
    current = merge(current, { type: "snapshot", detail: detail(), eventId: "" })

    expect(current.messages.at(-1)?.content).toBe("半段回答")
    expect(current.messages.at(-1)?.streaming).toBe(false)
    expect(current.messages.at(-1)?.streamError).toBe("回答生成中断")
  })

  it("does not duplicate text when persisted message_end follows stream message_end", () => {
    let current = merge(detail(), messageStart())
    current = merge(current, messageUpdate(
      { kind: "text_delta", delta: "最终回答" },
      { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
    ))
    current = merge(current, messageEnd("completed", {
      eventId: "3-0", eventKey: "run-1:final:end:completed", sequence: 3,
    }))
    current = merge(current, messageEnd("completed", {
      eventId: "4-0", eventKey: "run-1:final:end:persisted", sequence: 4,
    }))

    expect(current.messages.at(-1)?.content).toBe("最终回答")
    expect(current.messages.filter((item) => item.id === "assistant-final")).toHaveLength(1)
    expect(current.runtime?.messages.at(-1)?.status).toBe("completed")
  })

  it("replaces the temporary message with the same persisted message id", () => {
    let current = merge(detail(), messageStart())
    current = merge(current, messageUpdate(
      { kind: "text_delta", delta: "临时文本" },
      { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
    ))
    const persisted = detail()
    persisted.messages.push({
      id: "assistant-final",
      runId: "run-1",
      role: "assistant",
      content: "数据库最终回答",
      metadata: {},
      sequence: 2,
      createdAt: "2026-07-31T08:00:02Z",
    })
    current = merge(current, { type: "snapshot", detail: persisted, eventId: "" })

    expect(current.messages.filter((item) => item.id === "assistant-final")).toHaveLength(1)
    expect(current.messages.at(-1)?.content).toBe("数据库最终回答")
    expect(current.messages.at(-1)?.streaming).toBeUndefined()
  })

  it("tracks turn and agent lifecycle independently from messages", () => {
    let current = merge(detail(), {
      ...base,
      type: "turn_start",
      round: 3,
    })
    expect(current.runtime?.activeRound).toBe(3)
    current = merge(current, {
      ...base,
      type: "turn_end",
      round: 3,
      outcome: "tool_results",
      toolResultCount: 2,
      errorCode: "",
    })
    expect(current.runtime?.activeRound).toBeNull()
    current = merge(current, {
      ...base,
      type: "agent_end",
      status: "completed",
      errorCode: "",
    })
    expect(current.runtime?.agentStatus).toBe("completed")
  })

  it("ignores stream events for another run or conversation", () => {
    const current = detail()
    expect(mergeAgentStreamEvent(current, messageStart({ runId: "run-other" }))).toBe(current)
    expect(mergeAgentStreamEvent(
      current,
      messageStart({ conversationId: "conversation-other" })
    )).toBe(current)
  })
})

describe("agentStreamEventKey", () => {
  it("prefers stable event keys, then Redis ids, then run sequence", () => {
    expect(agentStreamEventKey(messageStart())).toBe("run-1:final:start")
    expect(agentStreamEventKey(messageStart({ eventKey: "" }))).toBe("1-0")
    expect(agentStreamEventKey(messageStart({
      eventKey: "", eventId: "", sequence: 7,
    }))).toBe("run-1:7")
    expect(agentStreamEventKey({ type: "snapshot", detail: detail(), eventId: "" })).toBe("")
  })
})

describe("useAgentConversation stream recovery", () => {
  it("keeps SSE reconnecting during polling fallback and stops polling after recovery", async () => {
    renderHook(() => useAgentConversation("project-1"))

    await waitFor(() => {
      expect(agentApi.subscribeAgentConversation).toHaveBeenCalledTimes(1)
    })
    expect(streamError).toBeDefined()
    expect(streamEvent).toBeDefined()

    vi.useFakeTimers()
    act(() => {
      streamError?.()
      streamError?.()
      streamError?.()
    })

    expect(closeStream).not.toHaveBeenCalled()
    const callsBeforePolling = agentApi.getAgentConversation.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(agentApi.getAgentConversation.mock.calls.length).toBeGreaterThan(
      callsBeforePolling
    )

    act(() => {
      streamEvent?.({ type: "snapshot", detail: detail(), eventId: "5-0" })
    })
    const callsAfterRecovery = agentApi.getAgentConversation.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(
      callsAfterRecovery
    )
    expect(closeStream).not.toHaveBeenCalled()
  })

  it("refreshes after the final answer is persisted, not after its first message_end", async () => {
    renderHook(() => useAgentConversation("project-1"))

    await waitFor(() => {
      expect(agentApi.subscribeAgentConversation).toHaveBeenCalledTimes(1)
    })
    const initialReads = agentApi.getAgentConversation.mock.calls.length

    act(() => {
      streamEvent?.(messageEnd("completed", {
        eventId: "3-0",
        eventKey: "run-1:final:end:completed",
        sequence: 3,
      }))
    })
    expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(initialReads)

    act(() => {
      streamEvent?.(messageEnd("completed", {
        eventId: "4-0",
        eventKey: "run-1:final:end:persisted",
        sequence: 4,
        outcome: "persisted",
      }))
    })
    await waitFor(() => {
      expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(initialReads + 1)
    })
  })

  it("retries an edit once with the same request id after a 503", async () => {
    const originalRandomUUID = crypto.randomUUID
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: vi.fn(() => "edit-request-id"),
    })
    const unavailable = new ApiError(503, "temporarily unavailable")
    agentApi.editAgentMessage
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce({ messageId: "replacement-1", runId: "run-2" })

    const { result } = renderHook(() => useAgentConversation("project-1"))
    await waitFor(() => expect(result.current.detail).not.toBeNull())

    await act(async () => {
      await result.current.edit("user-1", "修改后的问题")
    })

    expect(agentApi.editAgentMessage).toHaveBeenCalledTimes(2)
    expect(agentApi.editAgentMessage.mock.calls[0]).toEqual(
      agentApi.editAgentMessage.mock.calls[1]
    )
    expect(agentApi.editAgentMessage).toHaveBeenCalledWith(
      "project-1",
      "conversation-1",
      "user-1",
      "修改后的问题",
      "edit-request-id"
    )
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: originalRandomUUID,
    })
  })
})
