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
  syncProjectOnboarding: vi.fn(),
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
    messages: [
      {
        id: "user-1",
        runId: "run-1",
        role: "user",
        content: "总结最新审计",
        metadata: {},
        sequence: 1,
        createdAt: "2026-07-31T08:00:00Z",
      },
    ],
    timeline: [],
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

function toolStart(
  toolCallId: string,
  attempt: number,
  sequence: number
): AgentStreamEvent {
  return {
    eventId: `${sequence}-0`,
    eventKey: `run-1:tool:${toolCallId}:${attempt}:start`,
    sequence,
    projectId: "project-1",
    conversationId: "conversation-1",
    runId: "run-1",
    createdAt: "2026-07-31T08:00:01Z",
    type: "tool_execution_start",
    toolCallId,
    toolName: "get_project_profile",
    attempt,
    args: {},
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
  agentApi.syncProjectOnboarding.mockResolvedValue(undefined)
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
  it("keeps final text in ordered runtime parts until it is persisted", () => {
    let current = merge(detail(), messageStart())
    current = merge(current, messageUpdate({ kind: "text_start" }))
    current = merge(
      current,
      messageUpdate(
        { kind: "text_delta", delta: "审计" },
        { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
      )
    )
    current = merge(
      current,
      messageUpdate(
        { kind: "text_delta", delta: "已完成" },
        { eventId: "3-0", eventKey: "run-1:final:update:2", sequence: 3 }
      )
    )

    expect(current.messages).toHaveLength(1)
    expect(current.runtime?.messages.at(-1)).toMatchObject({
      id: "assistant-final",
      order: 1,
      phase: "final",
      status: "streaming",
      text: "审计已完成",
    })
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
    current = merge(
      current,
      messageUpdate(
        { kind: "toolcall_start", index: 0, toolCallId: "", toolName: "" },
        decisionBase
      )
    )
    current = merge(
      current,
      messageUpdate(
        { kind: "toolcall_start", index: 1, toolCallId: "", toolName: "" },
        decisionBase
      )
    )
    current = merge(
      current,
      messageUpdate(
        {
          kind: "toolcall_delta",
          index: 0,
          idDelta: "call-",
          nameDelta: "get_",
          argumentsDelta: '{"a":',
        },
        decisionBase
      )
    )
    current = merge(
      current,
      messageUpdate(
        {
          kind: "toolcall_delta",
          index: 1,
          idDelta: "call-2",
          nameDelta: "search",
          argumentsDelta: "{}",
        },
        decisionBase
      )
    )
    current = merge(
      current,
      messageUpdate(
        {
          kind: "toolcall_delta",
          index: 0,
          idDelta: "1",
          nameDelta: "audit",
          argumentsDelta: "1}",
        },
        decisionBase
      )
    )
    current = merge(
      current,
      messageUpdate(
        {
          kind: "toolcall_end",
          index: 0,
          toolCallId: "call-1",
          toolName: "get_audit",
        },
        decisionBase
      )
    )

    expect(current.messages).toHaveLength(1)
    expect(current.runtime?.messages[0].toolCalls).toEqual([
      {
        index: 0,
        toolCallId: "call-1",
        toolName: "get_audit",
        argumentsText: '{"a":1}',
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
    current = merge(
      current,
      messageUpdate(
        { kind: "text_delta", delta: "半段回答" },
        { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
      )
    )
    current = merge(current, {
      type: "snapshot",
      detail: detail(),
      eventId: "",
    })

    expect(current.messages).toHaveLength(1)
    expect(current.runtime?.messages.at(-1)).toMatchObject({
      status: "streaming",
      text: "半段回答",
    })
  })

  it("does not duplicate timeline events when the same snapshot repeats", () => {
    const snapshot = detail()
    snapshot.timeline = [
      {
        id: "timeline-1",
        eventKey: "foundation:task",
        conversationId: "conversation-1",
        sequence: 1,
        kind: "task",
        status: "running",
        title: "通用任务",
        content: null,
        action: {},
        metadata: {},
        createdAt: "2026-07-31T08:00:01Z",
        updatedAt: "2026-07-31T08:00:01Z",
      },
    ]

    let current = merge(detail(), {
      type: "snapshot",
      detail: snapshot,
      eventId: "",
    })
    current = merge(current, {
      type: "snapshot",
      detail: snapshot,
      eventId: "",
    })

    expect(current.timeline.map((event) => event.id)).toEqual(["timeline-1"])
  })

  it("keeps interrupted content until the persisted message arrives", () => {
    let current = merge(detail(), messageStart())
    current = merge(
      current,
      messageUpdate(
        { kind: "text_delta", delta: "半段回答" },
        { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
      )
    )
    current = merge(
      current,
      messageEnd("error", {
        eventId: "3-0",
        eventKey: "run-1:final:end:error",
        sequence: 3,
        message: "回答生成中断",
      })
    )
    current = merge(current, {
      type: "snapshot",
      detail: detail(),
      eventId: "",
    })

    expect(current.messages).toHaveLength(1)
    expect(current.runtime?.messages.at(-1)).toMatchObject({
      status: "error",
      text: "半段回答",
    })
  })

  it("drops an interrupted temporary answer after a terminal failure snapshot", () => {
    let current = merge(detail(), messageStart())
    current = merge(
      current,
      messageUpdate(
        { kind: "text_delta", delta: "半段回答" },
        { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
      )
    )
    current = merge(
      current,
      messageEnd("error", {
        eventId: "3-0",
        eventKey: "run-1:final:end:error",
        sequence: 3,
        message: "回答生成中断",
      })
    )
    current = merge(current, {
      ...base,
      type: "agent_end",
      status: "failed",
      errorCode: "model_provider_unavailable",
    })
    const failed = detail()
    failed.run = {
      ...failed.run!,
      status: "failed",
      errorCode: "model_provider_unavailable",
      errorMessage: "模型服务暂时不可用",
    }
    failed.messages.push({
      id: "assistant-failure",
      runId: "run-1",
      role: "assistant",
      content: "本次任务没有完成。\n\n**下一步**\n\n- 稍后重试。",
      metadata: {},
      sequence: 2,
      createdAt: "2026-07-31T08:00:02Z",
    })
    current = merge(current, { type: "snapshot", detail: failed, eventId: "" })

    expect(current.messages.map((item) => item.id)).toEqual([
      "user-1",
      "assistant-failure",
    ])
    expect(current.runtime).toBeUndefined()
  })

  it("does not duplicate runtime text when persisted message_end repeats", () => {
    let current = merge(detail(), messageStart())
    current = merge(
      current,
      messageUpdate(
        { kind: "text_delta", delta: "最终回答" },
        { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
      )
    )
    current = merge(
      current,
      messageEnd("completed", {
        eventId: "3-0",
        eventKey: "run-1:final:end:completed",
        sequence: 3,
      })
    )
    current = merge(
      current,
      messageEnd("completed", {
        eventId: "4-0",
        eventKey: "run-1:final:end:persisted",
        sequence: 4,
      })
    )

    expect(current.messages).toHaveLength(1)
    expect(current.runtime?.messages).toHaveLength(1)
    expect(current.runtime?.messages.at(-1)?.text).toBe("最终回答")
    expect(current.runtime?.messages.at(-1)?.status).toBe("completed")
  })

  it("replaces the temporary message with the same persisted message id", () => {
    let current = merge(detail(), messageStart())
    current = merge(
      current,
      messageUpdate(
        { kind: "text_delta", delta: "临时文本" },
        { eventId: "2-0", eventKey: "run-1:final:update:1", sequence: 2 }
      )
    )
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
    current = merge(current, {
      type: "snapshot",
      detail: persisted,
      eventId: "",
    })

    expect(
      current.messages.filter((item) => item.id === "assistant-final")
    ).toHaveLength(1)
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

  it("updates retries for one tool call in its original display position", () => {
    let current = merge(detail(), toolStart("tool-1", 1, 2))
    current = merge(current, toolStart("tool-2", 1, 3))
    current = merge(current, toolStart("tool-1", 2, 4))

    expect(current.runtime?.tools).toEqual([
      expect.objectContaining({
        toolCallId: "tool-1",
        attempt: 1,
        order: 2,
      }),
      expect.objectContaining({
        toolCallId: "tool-2",
        attempt: 1,
        order: 3,
      }),
      expect.objectContaining({
        toolCallId: "tool-1",
        attempt: 2,
        order: 2,
      }),
    ])
  })

  it("settles every active tool when the agent reaches a terminal state", () => {
    let current = merge(detail(), toolStart("tool-1", 1, 2))
    current = merge(current, toolStart("tool-2", 1, 3))
    current = merge(current, {
      ...base,
      type: "agent_end",
      status: "failed",
      errorCode: "agent_run_failed",
    })

    expect(current.runtime?.tools).toEqual([
      expect.objectContaining({ stage: "failed", isError: true }),
      expect.objectContaining({ stage: "failed", isError: true }),
    ])
  })

  it("keeps the complete ordered runtime part list", () => {
    let current = detail()
    for (let index = 1; index <= 45; index += 1) {
      current = merge(current, toolStart(`tool-${index}`, 1, index))
    }

    expect(current.runtime?.tools).toHaveLength(45)
    expect(current.runtime?.tools[0]).toEqual(
      expect.objectContaining({ toolCallId: "tool-1", order: 1 })
    )
    expect(current.runtime?.tools.at(-1)).toEqual(
      expect.objectContaining({ toolCallId: "tool-45", order: 45 })
    )
  })

  it("ignores stream events for another run or conversation", () => {
    const current = detail()
    expect(
      mergeAgentStreamEvent(current, messageStart({ runId: "run-other" }))
    ).toBe(current)
    expect(
      mergeAgentStreamEvent(
        current,
        messageStart({ conversationId: "conversation-other" })
      )
    ).toBe(current)
  })
})

describe("agentStreamEventKey", () => {
  it("prefers stable event keys, then Redis ids, then run sequence", () => {
    expect(agentStreamEventKey(messageStart())).toBe("run-1:final:start")
    expect(agentStreamEventKey(messageStart({ eventKey: "" }))).toBe("1-0")
    expect(
      agentStreamEventKey(
        messageStart({
          eventKey: "",
          eventId: "",
          sequence: 7,
        })
      )
    ).toBe("run-1:7")
    expect(
      agentStreamEventKey({ type: "snapshot", detail: detail(), eventId: "" })
    ).toBe("")
  })
})

describe("useAgentConversation history", () => {
  it("clears the previous project immediately while the next project loads", async () => {
    let resolveNextProject: ((value: AgentConversationDetail) => void) | undefined
    const nextProjectDetail = {
      ...detail(),
      conversation: {
        ...detail().conversation,
        id: "conversation-2",
        projectId: "project-2",
      },
      messages: [],
      run: null,
    }
    agentApi.listAgentConversations.mockImplementation(
      async (projectId: string) => [
        projectId === "project-1"
          ? detail().conversation
          : nextProjectDetail.conversation,
      ]
    )
    agentApi.getAgentConversation.mockImplementation(
      async (projectId: string) => {
        if (projectId === "project-1") return detail()
        return new Promise<AgentConversationDetail>((resolve) => {
          resolveNextProject = resolve
        })
      }
    )

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useAgentConversation(projectId),
      { initialProps: { projectId: "project-1" } }
    )
    await waitFor(() => expect(result.current.detail).toEqual(detail()))

    rerender({ projectId: "project-2" })

    expect(result.current.detail).toBeNull()
    expect(result.current.conversations).toEqual([])
    expect(result.current.loading).toBe(true)

    await waitFor(() =>
      expect(agentApi.getAgentConversation).toHaveBeenCalledWith(
        "project-2",
        "conversation-2"
      )
    )
    resolveNextProject?.(nextProjectDetail)
    await waitFor(() => expect(result.current.detail).toEqual(nextProjectDetail))
  })

  it("reconciles onboarding before loading the first conversation", async () => {
    renderHook(() => useAgentConversation("project-1"))

    await waitFor(() =>
      expect(agentApi.getAgentConversation).toHaveBeenCalled()
    )

    expect(agentApi.syncProjectOnboarding).toHaveBeenCalledWith("project-1")
    expect(
      agentApi.syncProjectOnboarding.mock.invocationCallOrder[0]
    ).toBeLessThan(agentApi.listAgentConversations.mock.invocationCallOrder[0])
  })

  it("still loads conversations when onboarding reconciliation fails", async () => {
    agentApi.syncProjectOnboarding.mockRejectedValueOnce(
      new Error("onboarding unavailable")
    )

    const { result } = renderHook(() => useAgentConversation("project-1"))

    await waitFor(() => expect(result.current.detail).toEqual(detail()))
    expect(result.current.error).toBe("")
  })

  it("creates a conversation and makes it the current conversation", async () => {
    const createdConversation = {
      ...detail().conversation,
      id: "conversation-2",
      title: "New conversation",
    }
    const createdDetail = {
      ...detail(),
      conversation: createdConversation,
      messages: [],
      run: null,
    }
    agentApi.createAgentConversation.mockResolvedValue(createdConversation)
    agentApi.getAgentConversation.mockImplementation(
      async (_projectId: string, conversationId: string) =>
        conversationId === createdConversation.id ? createdDetail : detail()
    )

    const { result } = renderHook(() => useAgentConversation("project-1"))
    await waitFor(() => expect(result.current.detail).not.toBeNull())

    await act(async () => {
      await result.current.create()
    })

    expect(agentApi.createAgentConversation).toHaveBeenCalledWith("project-1")
    expect(agentApi.getAgentConversation).toHaveBeenCalledWith(
      "project-1",
      "conversation-2"
    )
    expect(result.current.detail).toEqual(createdDetail)
    expect(result.current.conversations[0]).toEqual(createdConversation)
  })

  it("loads history and selects a historical conversation", async () => {
    const historicalConversation = {
      ...detail().conversation,
      id: "conversation-2",
      title: "Historical conversation",
    }
    const historicalDetail = {
      ...detail(),
      conversation: historicalConversation,
      run: null,
    }
    const { result } = renderHook(() => useAgentConversation("project-1"))
    await waitFor(() => expect(result.current.detail).not.toBeNull())

    agentApi.listAgentConversations.mockResolvedValue([
      detail().conversation,
      historicalConversation,
    ])
    agentApi.getAgentConversation.mockResolvedValue(historicalDetail)

    await act(async () => {
      await result.current.loadConversations()
    })
    await act(async () => {
      await result.current.selectConversation(historicalConversation.id)
    })

    expect(agentApi.listAgentConversations).toHaveBeenLastCalledWith(
      "project-1"
    )
    expect(agentApi.getAgentConversation).toHaveBeenLastCalledWith(
      "project-1",
      "conversation-2"
    )
    expect(result.current.conversations).toEqual([
      detail().conversation,
      historicalConversation,
    ])
    expect(result.current.detail).toEqual(historicalDetail)
  })
})

describe("useAgentConversation pending run", () => {
  it("stays visibly pending until the accepted run appears in conversation detail", async () => {
    const idleDetail = { ...detail(), run: null }
    const acceptedRun = {
      ...detail().run!,
      id: "run-2",
      status: "queued" as const,
    }
    agentApi.getAgentConversation.mockResolvedValue(idleDetail)
    agentApi.sendAgentMessage.mockResolvedValue({
      messageId: "user-2",
      runId: acceptedRun.id,
    })

    const { result } = renderHook(() => useAgentConversation("project-1"))
    await waitFor(() => expect(result.current.detail).toEqual(idleDetail))

    await act(async () => {
      await result.current.send("业务资料准确吗")
    })

    expect(result.current.awaitingRun).toBe(true)

    agentApi.getAgentConversation.mockResolvedValue({
      ...idleDetail,
      run: acceptedRun,
    })
    await act(async () => {
      await result.current.refresh()
    })

    await waitFor(() => expect(result.current.awaitingRun).toBe(false))
  })
})

describe("useAgentConversation stream recovery", () => {
  it("reconciles an active onboarding timeline while SSE remains healthy", async () => {
    const runningDetail = { ...detail(), run: null }
    const completedTimeline = [
      {
        id: "onboarding-core-pages",
        eventKey: "onboarding:core-pages:understanding-1",
        conversationId: "conversation-1",
        sequence: 1,
        kind: "task" as const,
        status: "completed" as const,
        title: "核心页面读取",
        content: "已读取核心页面。",
        action: {},
        metadata: {},
        createdAt: "2026-08-12T08:00:00Z",
        updatedAt: "2026-08-12T08:01:00Z",
      },
    ]
    const completedDetail = {
      ...runningDetail,
      timeline: completedTimeline,
    }
    agentApi.getAgentConversation.mockResolvedValue(runningDetail)

    const { result, rerender } = renderHook(
      ({ status }: { status: "running" | "completed" | null }) =>
        useAgentConversation("project-1", status),
      {
        initialProps: {
          status: null as "running" | "completed" | null,
        },
      }
    )
    await waitFor(() => expect(result.current.detail).toEqual(runningDetail))
    expect(agentApi.subscribeAgentConversation).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    rerender({ status: "running" })
    const syncsBeforePolling = agentApi.syncProjectOnboarding.mock.calls.length
    const readsBeforePolling = agentApi.getAgentConversation.mock.calls.length
    agentApi.getAgentConversation.mockResolvedValue(completedDetail)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })

    expect(agentApi.syncProjectOnboarding).toHaveBeenCalledTimes(
      syncsBeforePolling + 1
    )
    expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(
      readsBeforePolling + 1
    )
    expect(result.current.detail?.timeline).toEqual(completedTimeline)

    const syncsBeforeCompletion =
      agentApi.syncProjectOnboarding.mock.calls.length
    const readsBeforeCompletion =
      agentApi.getAgentConversation.mock.calls.length
    rerender({ status: "completed" })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(agentApi.syncProjectOnboarding).toHaveBeenCalledTimes(
      syncsBeforeCompletion + 1
    )
    expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(
      readsBeforeCompletion + 1
    )
    const syncsAfterCompletion =
      agentApi.syncProjectOnboarding.mock.calls.length
    const readsAfterCompletion = agentApi.getAgentConversation.mock.calls.length

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2400)
    })
    expect(agentApi.syncProjectOnboarding).toHaveBeenCalledTimes(
      syncsAfterCompletion
    )
    expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(
      readsAfterCompletion
    )
  })

  it("subscribes to onboarding timeline updates without an Agent run", async () => {
    const idleDetail = { ...detail(), run: null }
    agentApi.getAgentConversation.mockResolvedValue(idleDetail)

    const { result } = renderHook(() => useAgentConversation("project-1"))

    await waitFor(() => {
      expect(result.current.detail).toEqual(idleDetail)
      expect(agentApi.subscribeAgentConversation).toHaveBeenCalledWith(
        "project-1",
        "conversation-1",
        expect.any(Function),
        expect.any(Function)
      )
    })

    const timeline = [
      {
        id: "onboarding-1",
        eventKey: "onboarding:business-confirmation",
        conversationId: "conversation-1",
        sequence: 1,
        kind: "action" as const,
        status: "waiting" as const,
        title: "确认业务资料",
        content: "请确认业务资料。",
        action: {
          label: "确认业务资料",
          href: "/projects/project-1/settings/business",
        },
        metadata: {},
        createdAt: "2026-08-12T08:00:00Z",
        updatedAt: "2026-08-12T08:00:00Z",
      },
    ]
    act(() => {
      streamEvent?.({
        type: "snapshot",
        detail: { ...idleDetail, timeline },
        eventId: "5-0",
      })
    })

    expect(result.current.detail?.timeline).toEqual(timeline)
  })

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
      streamEvent?.(
        messageEnd("completed", {
          eventId: "3-0",
          eventKey: "run-1:final:end:completed",
          sequence: 3,
        })
      )
    })
    expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(initialReads)

    act(() => {
      streamEvent?.(
        messageEnd("completed", {
          eventId: "4-0",
          eventKey: "run-1:final:end:persisted",
          sequence: 4,
          outcome: "persisted",
        })
      )
    })
    await waitFor(() => {
      expect(agentApi.getAgentConversation).toHaveBeenCalledTimes(
        initialReads + 1
      )
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
