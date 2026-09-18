import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, expect, it, vi } from "vitest"

import { AgentDock, AgentTimelineItem } from "./agent-dock"
import { cleanAgentMessageContent } from "./agent-dock-utils"
import type { AgentConversationDetail } from "@/features/agent/types"
import { AgentSessionProvider } from "@/features/agent/agent-session"

const state = vi.hoisted(() => ({
  detail: null as AgentConversationDetail | null,
}))

vi.mock("@/features/agent/use-agent-conversation", () => ({
  useAgentConversation: () => ({
    detail: state.detail,
    conversations: [],
    loading: false,
    historyLoading: false,
    awaitingRun: false,
    error: "",
  }),
}))

vi.mock("@/features/projects/project-context", () => ({
  useProjects: () => ({
    getProject: () => ({
      id: "project-1",
      domain: "example.com",
      understandingStatus: "completed",
      siteProfile: null,
    }),
  }),
}))

afterEach(cleanup)

it("renders the persisted onboarding welcome as paragraphs, not a badge", () => {
  render(
    <AgentTimelineItem
      event={{
        id: "welcome",
        eventKey: "onboarding:welcome",
        conversationId: "conversation-1",
        sequence: 0,
        kind: "message",
        status: "completed",
        title: "Welcome.\n\nPlease confirm the business profile.",
        content: "",
        action: {},
        metadata: { source: "onboarding", onboarding_order: 0 },
        createdAt: "",
        updatedAt: "",
      }}
    />
  )
  expect(screen.getByText("Welcome.").closest("p")).not.toBeNull()
  expect(screen.getByText("Welcome.").closest('[data-slot="badge"]')).toBeNull()
  expect(screen.getByText("Please confirm the business profile.")).toBeTruthy()
})

it.each([
  ["```text", "&nbsp;", "\\", "```"].join("\n"),
  ["~~~text", "&#x20;", "\\", "~~~"].join("\n"),
  ["```text", "&nbsp;"].join("\n"),
  ["    &nbsp;", "    \\"].join("\n"),
  ["`literal", "&nbsp;", "text`"].join("\n"),
  ["> ```text", "> &nbsp;", "> ```"].join("\n"),
])("preserves literal code content: %s", (content) => {
  expect(cleanAgentMessageContent(content)).toBe(content)
})

it("removes spacing noise outside code without changing literal code", () => {
  const code = ["```text", "&nbsp;", "\\", "```"].join("\n")
  expect(cleanAgentMessageContent(`Before\n\\\n${code}\n&#x20;\nAfter`)).toBe(
    `Before\n${code}\nAfter`
  )
})

it("follows successive runtime deltas, respects scroll-away, and resets for another conversation", () => {
  state.detail = {
    conversation: {
      id: "conversation-1",
      projectId: "project-1",
      title: "Test",
      createdAt: "",
      updatedAt: "",
    },
    messages: [],
    timeline: [],
    action: null,
    run: {
      id: "run-1",
      conversationId: "conversation-1",
      status: "running",
      currentStep: 1,
      errorCode: null,
      errorMessage: null,
      action: null,
      finalMessageId: null,
      steps: [],
      createdAt: "",
      updatedAt: "",
    },
    runtime: {
      runId: "run-1",
      agentStatus: "running",
      activeRound: 1,
      lastEventType: "message_update",
      tools: [],
      messages: [
        {
          id: "reply-1",
          phase: "final",
          round: 1,
          attempt: 1,
          status: "streaming",
          text: "First",
          thinking: "",
          toolCalls: [],
        },
      ],
    },
  }
  const ui = () => (
    <MemoryRouter>
      <AgentSessionProvider><AgentDock /></AgentSessionProvider>
    </MemoryRouter>
  )
  const { container, rerender } = render(ui())
  const viewport = container.querySelector<HTMLDivElement>(".overflow-y-auto")!
  const scrollTo = vi.fn()
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1000 },
    scrollTop: { configurable: true, writable: true, value: 600 },
    scrollTo: { configurable: true, value: scrollTo },
  })
  function delta(text: string) {
    const current = state.detail!
    state.detail = {
      ...current,
      runtime: {
        ...current.runtime!,
        messages: [{ ...current.runtime!.messages[0], text }],
      },
    }
    rerender(ui())
  }
  delta("First second")
  expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" })
  scrollTo.mockClear()
  delta("First second third")
  expect(scrollTo).toHaveBeenCalledOnce()
  viewport.scrollTop = 100
  fireEvent.scroll(viewport)
  scrollTo.mockClear()
  delta("First second third fourth")
  expect(scrollTo).not.toHaveBeenCalled()
  viewport.scrollTop = 600
  fireEvent.scroll(viewport)
  delta("First second third fourth fifth")
  expect(scrollTo).toHaveBeenCalledOnce()
  viewport.scrollTop = 100
  fireEvent.scroll(viewport)
  state.detail = {
    ...state.detail!,
    conversation: { ...state.detail!.conversation, id: "conversation-2" },
  }
  rerender(ui())
  expect(container.querySelector(".overflow-y-auto")).not.toBe(viewport)
})
