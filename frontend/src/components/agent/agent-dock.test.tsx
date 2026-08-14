import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  AgentAssistantMessage,
  AgentBusinessProgress,
  AgentFailureNotice,
  AgentMessageContent,
  AgentRuntimeProgress,
  AgentTimelineItem,
} from "@/components/agent/agent-dock"
import {
  conversationTimelineItems,
  hasVisibleAssistantReply,
  messageDisplayParts,
  runStatusLabel,
  shouldShowAgentWelcomeFallback,
  shouldShowRunError,
} from "@/components/agent/agent-dock-utils"
import type {
  AgentMessage,
  AgentRuntime,
  AgentTimelineEvent,
} from "@/features/agent/types"

afterEach(cleanup)

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    runId: "run-1",
    agentStatus: "running",
    activeRound: 2,
    messages: [],
    tools: [],
    lastEventType: "agent_start",
    ...overrides,
  }
}

function timelineEvent(
  overrides: Partial<AgentTimelineEvent> = {}
): AgentTimelineEvent {
  return {
    id: "timeline-1",
    eventKey: "foundation:event",
    conversationId: "conversation-1",
    sequence: 1,
    kind: "task",
    status: "running",
    title: "通用时间线事件",
    content: null,
    action: {},
    metadata: {},
    createdAt: "2026-08-12T08:00:01Z",
    updatedAt: "2026-08-12T08:00:01Z",
    ...overrides,
  }
}

describe("durable Agent timeline", () => {
  it("does not duplicate the fallback welcome once onboarding events exist", () => {
    const items = conversationTimelineItems([], [timelineEvent()])

    expect(shouldShowAgentWelcomeFallback(false, items)).toBe(false)
    expect(shouldShowAgentWelcomeFallback(false, [])).toBe(true)
    expect(shouldShowAgentWelcomeFallback(true, [])).toBe(false)
  })

  it("orders persisted messages and events by time with stable tie breakers", () => {
    const messages: AgentMessage[] = [
      {
        id: "message-2",
        runId: null,
        role: "assistant",
        content: "后面的消息",
        metadata: {},
        sequence: 2,
        createdAt: "2026-08-12T08:00:02.000Z",
      },
      {
        id: "message-1",
        runId: null,
        role: "user",
        content: "同时刻的消息",
        metadata: {},
        sequence: 1,
        createdAt: "2026-08-12T08:00:01+00:00",
      },
    ]
    const events = [
      timelineEvent({
        id: "timeline-2",
        sequence: 2,
        createdAt: "2026-08-12T08:00:01.000Z",
      }),
      timelineEvent({
        id: "timeline-1",
        sequence: 1,
        createdAt: "2026-08-12T08:00:00Z",
      }),
    ]

    expect(
      conversationTimelineItems(messages, events).map((item) => item.id)
    ).toEqual(["timeline-1", "timeline-2", "message-1", "message-2"])
    expect(conversationTimelineItems([], [])).toEqual([])
  })

  it("keeps backfilled onboarding stages in their logical order", () => {
    const events = [
      timelineEvent({
        id: "business",
        sequence: 2,
        metadata: { onboarding_order: 4 },
        createdAt: "2026-08-12T08:00:00Z",
      }),
      timelineEvent({
        id: "site-entry",
        sequence: 5,
        metadata: { onboarding_order: 1 },
        createdAt: "2026-08-12T09:00:00Z",
      }),
    ]

    expect(
      conversationTimelineItems([], events).map((item) => item.id)
    ).toEqual(["site-entry", "business"])
  })

  it.each([
    ["running", "进行中"],
    ["waiting", "等待确认"],
    ["completed", "已完成"],
    ["failed", "未完成"],
    ["cancelled", "已取消"],
  ] as const)("renders the %s task state", (status, label) => {
    render(<AgentTimelineItem event={timelineEvent({ status })} />)

    expect(screen.getByLabelText(label)).toBeTruthy()
    expect(screen.getByText("通用时间线事件")).toBeTruthy()
  })

  it("labels a usable partial onboarding result as partially completed", () => {
    render(
      <AgentTimelineItem
        event={timelineEvent({
          title: "关键词库",
          status: "completed",
          metadata: { source_status: "partial" },
        })}
      />
    )

    expect(screen.getByLabelText("关键词库，部分完成")).toBeTruthy()
    expect(screen.getByText("部分完成")).toBeTruthy()
  })

  it("shows the confirmation action only while the event is waiting", () => {
    const navigate = vi.fn()
    const action = {
      label: "确认业务资料",
      href: "/projects/project-1/settings/business",
    }
    const { rerender } = render(
      <AgentTimelineItem
        event={timelineEvent({ kind: "action", status: "waiting", action })}
        onNavigate={navigate}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "确认业务资料" }))
    expect(navigate).toHaveBeenCalledWith(
      "/projects/project-1/settings/business"
    )

    rerender(
      <AgentTimelineItem
        event={timelineEvent({
          kind: "action",
          status: "completed",
          action: {},
        })}
        onNavigate={navigate}
      />
    )
    expect(screen.queryByRole("button", { name: "确认业务资料" })).toBeNull()
  })

  it("retries failed website understanding from the failed timeline step", async () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    render(
      <AgentTimelineItem
        event={timelineEvent({
          status: "failed",
          title: "读取核心页面",
          metadata: { source: "site_understanding" },
        })}
        onRetry={retry}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "重新识别" }))

    expect(retry).toHaveBeenCalledOnce()
  })

  it("does not offer website recognition retry for unrelated failures", () => {
    render(
      <AgentTimelineItem
        event={timelineEvent({
          status: "failed",
          metadata: { source: "technical_audit" },
        })}
        onRetry={vi.fn()}
      />
    )

    expect(screen.queryByRole("button", { name: "重新识别" })).toBeNull()
  })

  it("only offers downstream retry when the backend marks it retryable", () => {
    const retry = vi.fn()
    const { rerender } = render(
      <AgentTimelineItem
        event={timelineEvent({
          status: "failed",
          metadata: {
            source: "onboarding",
            onboarding_step: "content_plan",
            retryable: false,
          },
        })}
        onRetry={retry}
      />
    )

    expect(screen.queryByRole("button", { name: "重试任务" })).toBeNull()

    rerender(
      <AgentTimelineItem
        event={timelineEvent({
          status: "failed",
          metadata: {
            source: "onboarding",
            onboarding_step: "content_plan",
            retryable: true,
          },
        })}
        onRetry={retry}
      />
    )

    expect(screen.getByRole("button", { name: "重试任务" })).toBeTruthy()
  })

  it("groups task findings separately from the compact status badge", () => {
    render(
      <AgentTimelineItem
        event={timelineEvent({
          status: "completed",
          title: "业务理解",
          content: "我目前对这个网站的判断：\n\n- **业务定位**：SEO 软件",
        })}
      />
    )

    expect(screen.getByLabelText("业务理解，已完成")).toBeTruthy()
    expect(
      screen.getByText("已完成").closest('[data-slot="badge"]')
    ).toBeTruthy()
    expect(screen.getByLabelText("业务理解结果")).toBeTruthy()
    expect(screen.getByText("业务定位")).toBeTruthy()
  })

  it("allows internal and safe external actions but hides unsafe targets", () => {
    const navigate = vi.fn()
    const { rerender } = render(
      <AgentTimelineItem
        event={timelineEvent({
          kind: "action",
          status: "waiting",
          action: { label: "打开内部页面", href: "/projects/project-1" },
        })}
        onNavigate={navigate}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "打开内部页面" }))
    expect(navigate).toHaveBeenCalledWith("/projects/project-1")

    rerender(
      <AgentTimelineItem
        event={timelineEvent({
          kind: "action",
          status: "waiting",
          action: { label: "打开外部页面", href: "https://example.com/report" },
        })}
      />
    )
    expect(
      screen.getByRole("link", { name: "打开外部页面" }).getAttribute("href")
    ).toBe("https://example.com/report")

    for (const href of [
      "javascript:alert(1)",
      "//example.com/phishing",
      "https://user:password@example.com/report",
    ]) {
      rerender(
        <AgentTimelineItem
          event={timelineEvent({
            kind: "action",
            status: "waiting",
            action: { label: "不安全操作", href },
          })}
        />
      )
      expect(screen.queryByRole("button", { name: "不安全操作" })).toBeNull()
      expect(screen.queryByRole("link", { name: "不安全操作" })).toBeNull()
    }
  })
})

describe("AgentMessageContent", () => {
  it("renders a readable Markdown hierarchy including GFM tables", () => {
    render(
      <AgentMessageContent
        content={[
          "# 直接结论",
          "",
          "正文说明。",
          "",
          "## 关键数据",
          "",
          "| 指标 | 结果 |",
          "| --- | --- |",
          "| 业务定位 | SEO 软件 |",
          "",
          "> 这项判断需要确认。",
        ].join("\n")}
      />
    )

    expect(
      screen.getByRole("heading", { level: 1, name: "直接结论" })
    ).toBeTruthy()
    expect(
      screen.getByRole("heading", { level: 2, name: "关键数据" })
    ).toBeTruthy()
    expect(screen.getByRole("table")).toBeTruthy()
    expect(
      screen.getByText("这项判断需要确认。").closest("blockquote")
    ).toBeTruthy()
  })
})

describe("AgentRuntimeProgress", () => {
  it("keeps unfinished Markdown headings at the normal chat size", () => {
    const { container } = render(
      <AgentRuntimeProgress
        runtime={runtime({
          messages: [
            {
              id: "message-streaming",
              order: 1,
              phase: "final",
              attempt: 0,
              round: 1,
              status: "streaming",
              text: "# 技术审核",
              thinking: "",
              toolCalls: [],
            },
          ],
        })}
      />
    )

    const heading = container.querySelector("h1")
    expect(heading?.textContent).toBe("技术审核")
    expect(heading?.className).toContain("text-sm")
    expect(heading?.className).not.toContain("text-base")
  })

  it("keeps completed runtime headings stable until the persisted reply replaces them", () => {
    const { container } = render(
      <AgentRuntimeProgress
        runtime={runtime({
          messages: [
            {
              id: "message-completed-runtime",
              order: 1,
              phase: "final",
              attempt: 0,
              round: 1,
              status: "completed",
              text: "# 技术审核",
              thinking: "",
              toolCalls: [],
            },
          ],
        })}
      />
    )

    const heading = container.querySelector("h1")
    expect(heading?.textContent).toBe("技术审核")
    expect(heading?.className).toContain("text-sm")
    expect(heading?.className).not.toContain("text-base")
  })

  it("renders settled final text as Markdown", () => {
    const { container } = render(
      <AgentRuntimeProgress
        runtime={runtime({
          messages: [
            {
              id: "message-completed",
              order: 1,
              phase: "final",
              attempt: 0,
              round: 1,
              status: "completed",
              text: "## 技术审核",
              thinking: "",
              toolCalls: [],
            },
          ],
        })}
      />
    )

    expect(container.querySelector("h2")?.textContent).toBe("技术审核")
  })

  it("shows one real tool action without internal orchestration details", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          tools: [
            {
              toolCallId: "tool-1",
              toolName: "get_latest_audit",
              attempt: 2,
              stage: "running",
              isError: false,
              summary: "读取了很多内部数据，这段摘要不应展示",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.getByText("正在读取技术审核...")).toBeTruthy()
    expect(screen.queryByText("第 2 轮")).toBeNull()
    expect(screen.queryByText(/内部数据/)).toBeNull()
    expect(screen.queryByText(/第 2 次尝试/)).toBeNull()
    expect(screen.queryByText("get_latest_audit")).toBeNull()
  })

  it("does not invent a business milestone for an internal tool", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          tools: [
            {
              toolCallId: "tool-internal",
              toolName: "compact_tool_history",
              attempt: 1,
              stage: "completed",
              isError: false,
              summary: "内部上下文整理完成",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.queryByText("任务已完成")).toBeNull()
    expect(screen.queryByText("内部上下文整理完成")).toBeNull()
    expect(screen.getByText("正在处理任务...")).toBeTruthy()
  })

  it("does not duplicate a typing indicator beside visible tool progress", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          messages: [
            {
              id: "message-1",
              phase: "final",
              attempt: 0,
              round: null,
              status: "streaming",
              text: "",
              thinking: "",
              toolCalls: [],
            },
          ],
          tools: [
            {
              toolCallId: "tool-1",
              toolName: "get_project_profile",
              attempt: 1,
              stage: "completed",
              isError: false,
              summary: "项目资料已读取",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.getByText("项目资料已读取")).toBeTruthy()
    expect(screen.queryByText(/Aris 正在/)).toBeNull()
  })

  it("does not add a continuation spinner after a visible tool milestone", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          tools: [
            {
              toolCallId: "tool-1",
              toolName: "get_project_profile",
              attempt: 1,
              stage: "completed",
              isError: false,
              summary: "项目资料已读取",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.getByText("项目资料已读取")).toBeTruthy()
    expect(screen.queryByText(/Aris 正在/)).toBeNull()
  })

  it("shows tool progress and final text without temporary model narration", () => {
    const { container } = render(
      <AgentRuntimeProgress
        runtime={runtime({
          messages: [
            {
              id: "message-progress",
              order: 1,
              phase: "decision",
              attempt: 0,
              round: 1,
              status: "completed",
              text: "我先读取项目资料。",
              thinking: "内部推理不展示",
              toolCalls: [],
            },
            {
              id: "message-final",
              order: 5,
              phase: "final",
              attempt: 0,
              round: 2,
              status: "streaming",
              text: "资料准确，但还不完整。",
              thinking: "内部推理不展示",
              toolCalls: [],
            },
          ],
          tools: [
            {
              toolCallId: "tool-1",
              order: 3,
              toolName: "get_project_profile",
              attempt: 1,
              stage: "completed",
              isError: false,
              summary: "原始工具输出不展示",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(container.textContent).toBe("项目资料已读取资料准确，但还不完整。")
    expect(container.textContent).not.toContain("我先读取项目资料")
    expect(container.textContent).not.toContain("内部推理")
    expect(container.textContent).not.toContain("原始工具输出")
    expect(screen.queryByText(/Aris 正在/)).toBeNull()
  })

  it("shows a fixed business failure label without leaking tool output", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          agentStatus: "failed",
          tools: [
            {
              toolCallId: "tool-failed",
              toolName: "get_latest_audit",
              attempt: 1,
              stage: "failed",
              isError: true,
              summary: "SQLSTATE connection password=secret internal failure",
              errorCode: "database_error",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.getByText("技术审核读取未完成")).toBeTruthy()
    expect(screen.queryByText(/SQLSTATE|password|internal failure/)).toBeNull()
  })

  it("does not present a cancelled tool as completed", () => {
    const { container } = render(
      <AgentRuntimeProgress
        runtime={runtime({
          agentStatus: "cancelled",
          tools: [
            {
              toolCallId: "tool-cancelled",
              toolName: "get_latest_audit",
              attempt: 1,
              stage: "cancelled",
              isError: false,
              summary: "",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.getByText("任务已取消")).toBeTruthy()
    expect(container.querySelector(".text-emerald-600")).toBeNull()
  })

  it("describes business-profile refresh as started rather than finished", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          tools: [
            {
              toolCallId: "tool-refresh",
              toolName: "refresh_business_profile",
              attempt: 1,
              stage: "completed",
              isError: false,
              summary: "",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.getByText("网站业务识别已启动")).toBeTruthy()
    expect(screen.queryByText("网站业务已重新识别")).toBeNull()
  })

  it("keeps separate calls to the same business tool in execution order", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          tools: [
            {
              toolCallId: "tool-1",
              toolName: "get_project_profile",
              attempt: 1,
              stage: "completed",
              isError: false,
              summary: "",
              errorCode: "",
              retryable: false,
            },
            {
              toolCallId: "tool-2",
              toolName: "get_project_profile",
              attempt: 1,
              stage: "completed",
              isError: false,
              summary: "",
              errorCode: "",
              retryable: false,
            },
          ],
        })}
      />
    )

    expect(screen.getAllByText("项目资料已读取")).toHaveLength(2)
  })

  it("keeps every visible tool part from the current run", () => {
    render(
      <AgentRuntimeProgress
        runtime={runtime({
          tools: Array.from({ length: 10 }, (_, index) => ({
            toolCallId: `tool-${index}`,
            order: index,
            toolName: "get_project_profile",
            attempt: 1,
            stage: "completed",
            isError: false,
            summary: "",
            errorCode: "",
            retryable: false,
          })),
        })}
      />
    )

    expect(screen.getAllByText("项目资料已读取")).toHaveLength(10)
  })
})

describe("AgentAssistantMessage", () => {
  function assistantMessage(
    metadata: Record<string, unknown>,
    content = "最终结论"
  ): AgentMessage {
    return {
      id: "assistant-1",
      runId: "run-1",
      role: "assistant",
      content,
      metadata,
      sequence: 2,
      createdAt: "2026-08-12T08:00:00Z",
    }
  }

  it("keeps persisted text and tools in document order", () => {
    const message = assistantMessage({
      display_parts: [
        { type: "text", text: "我先读取项目资料。" },
        {
          type: "tool",
          tool_call_id: "profile-1",
          tool: "get_project_profile",
          label: "项目资料已读取",
          status: "completed",
        },
        { type: "text", text: "资料准确，但还不完整。" },
      ],
    })
    const { container } = render(<AgentAssistantMessage message={message} />)

    expect(container.textContent).toBe(
      "我先读取项目资料。项目资料已读取资料准确，但还不完整。"
    )
  })

  it("falls back to legacy progress followed by message content", () => {
    const message = assistantMessage({
      business_progress: [
        {
          tool_call_id: "profile-1",
          tool: "get_project_profile",
          label: "项目资料已读取",
          status: "completed",
        },
      ],
    })

    expect(messageDisplayParts(message)).toEqual([
      {
        type: "tool",
        toolCallId: "profile-1",
        tool: "get_project_profile",
        label: "项目资料已读取",
        status: "completed",
      },
      { type: "text", text: "最终结论" },
    ])
  })
})

describe("AgentBusinessProgress", () => {
  it("keeps business milestones visible after the answer is persisted", () => {
    render(
      <AgentBusinessProgress
        items={[
          {
            tool: "get_project_profile",
            label: "项目资料已读取",
            status: "completed",
          },
          {
            tool: "get_latest_audit",
            label: "技术审核读取未完成",
            status: "failed",
          },
        ]}
      />
    )

    expect(screen.getByText("项目资料已读取")).toBeTruthy()
    expect(screen.getByText("技术审核读取未完成")).toBeTruthy()
    expect(screen.getByLabelText("任务进度")).toBeTruthy()
  })

  it("keeps repeated persisted milestones when they are separate calls", () => {
    render(
      <AgentBusinessProgress
        items={[
          {
            toolCallId: "tool-1",
            tool: "get_project_profile",
            label: "项目资料已读取",
            status: "completed",
          },
          {
            toolCallId: "tool-2",
            tool: "get_project_profile",
            label: "项目资料已读取",
            status: "completed",
          },
        ]}
      />
    )

    expect(screen.getAllByText("项目资料已读取")).toHaveLength(2)
  })
})

describe("runStatusLabel", () => {
  it("shows an immediate acknowledgement before the accepted run is visible", () => {
    expect(runStatusLabel(undefined, true)).toBe("正在接收任务...")
  })

  it("uses the real run status after the run becomes visible", () => {
    expect(runStatusLabel("running", false)).toBe("正在处理任务...")
  })
})

describe("shouldShowRunError", () => {
  const failedRun = {
    id: "run-1",
    status: "failed" as const,
    errorMessage: "工作流异常关闭",
  }

  it("hides the fallback error when the run has a structured assistant reply", () => {
    expect(
      shouldShowRunError(failedRun, [
        {
          id: "assistant-1",
          role: "assistant",
          runId: "run-1",
          content: "本次任务没有完成。",
          metadata: {},
          sequence: 2,
          createdAt: "2026-08-12T00:00:00Z",
        },
      ])
    ).toBe(false)
  })

  it("shows the fallback error when no assistant reply was saved", () => {
    expect(
      shouldShowRunError(failedRun, [
        {
          id: "user-1",
          role: "user",
          runId: "run-1",
          content: "检查网站",
          metadata: {},
          sequence: 1,
          createdAt: "2026-08-12T00:00:00Z",
        },
      ])
    ).toBe(true)
  })

  it("shows the fallback error when the saved assistant reply is empty", () => {
    expect(
      shouldShowRunError(failedRun, [
        {
          id: "assistant-empty",
          role: "assistant",
          runId: "run-1",
          content: "",
          metadata: {},
          sequence: 2,
          createdAt: "2026-08-12T00:00:00Z",
        },
      ])
    ).toBe(true)
  })

  it("does not treat another run's assistant reply as the current failure reply", () => {
    expect(
      shouldShowRunError(failedRun, [
        {
          id: "assistant-previous",
          role: "assistant",
          runId: "run-previous",
          content: "上一轮回答",
          metadata: {},
          sequence: 2,
          createdAt: "2026-08-12T00:00:00Z",
        },
      ])
    ).toBe(true)
  })
})

describe("AgentFailureNotice", () => {
  it("does not expose an internal request error", () => {
    render(
      <AgentFailureNotice
        requestError="provider_authentication_failed: api_key=secret"
        run={null}
        messages={[]}
      />
    )

    expect(screen.getByText("本次任务没有完成，请稍后重试。")).toBeTruthy()
    expect(screen.queryByText(/provider_authentication_failed/)).toBeNull()
    expect(screen.queryByText(/api_key/)).toBeNull()
  })

  it("does not duplicate the notice when both failure sources exist", () => {
    render(
      <AgentFailureNotice
        requestError="内部请求错误"
        run={{ id: "run-1", status: "failed", errorMessage: "工作流异常关闭" }}
        messages={[]}
      />
    )

    expect(screen.getAllByText("本次任务没有完成，请稍后重试。")).toHaveLength(
      1
    )
  })
})

describe("hasVisibleAssistantReply", () => {
  const assistantMessage = (runId: string, content: string): AgentMessage => ({
    id: `assistant-${runId}`,
    runId,
    role: "assistant",
    content,
    metadata: {},
    sequence: 2,
    createdAt: "2026-08-12T08:00:00Z",
  })

  it("recognizes a persisted reply for the active run", () => {
    expect(
      hasVisibleAssistantReply([assistantMessage("run-1", "最终回答")], "run-1")
    ).toBe(true)
  })

  it("does not hide activity for another run or an empty reply", () => {
    expect(
      hasVisibleAssistantReply([assistantMessage("run-old", "旧回答")], "run-1")
    ).toBe(false)
    expect(
      hasVisibleAssistantReply([assistantMessage("run-1", "")], "run-1")
    ).toBe(false)
  })
})

describe("AgentMessageContent", () => {
  it("renders short paragraphs and lists as Markdown", () => {
    const { container } = render(
      <AgentMessageContent
        content={[
          "总体上准确，但还不完整。",
          "",
          "**已确认**",
          "",
          "- 核心业务定位准确",
          "- 受众与价值主张一致",
        ].join("\n")}
      />
    )

    expect(container.querySelectorAll("p")).toHaveLength(2)
    expect(container.querySelector("strong")?.textContent).toBe("已确认")
    expect(container.querySelectorAll("li")).toHaveLength(2)
  })

  it("keeps a one-line answer compact", () => {
    const { container } = render(
      <AgentMessageContent content="目前资料准确。" />
    )

    expect(container.querySelectorAll("p")).toHaveLength(1)
    expect(screen.getByText("目前资料准确。")).toBeTruthy()
  })

  it("does not render raw HTML from an assistant answer", () => {
    const { container } = render(
      <AgentMessageContent content={'<img src="x" onerror="alert(1)">'} />
    )

    expect(container.querySelector("img")).toBeNull()
    expect(screen.getByText(/<img/)).toBeTruthy()
  })
})
