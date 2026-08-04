import * as React from "react"
import {
  Bot,
  Check,
  CircleStop,
  CircleX,
  FileSearch,
  Globe2,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  RefreshCw,
  Send,
  Undo2,
  X,
} from "lucide-react"
import { useLocation, useParams } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { modules } from "@/data/mock-data"
import { AgentActionCard } from "@/features/agent/agent-action-card"
import { useAgentConversation } from "@/features/agent/use-agent-conversation"
import { useProjects } from "@/features/projects/project-context"
import type { Project } from "@/features/projects/types"
import type {
  AgentRunStep,
  AgentRuntime,
  AgentRuntimeMessage,
  AgentRuntimeTool,
} from "@/features/agent/types"

type AgentDockContentProps = {
  onClose?: () => void
}

function getPageContext(pathname: string) {
  const [, , , moduleId, viewId] = pathname.split("/")
  const currentModule =
    modules.find((item) => item.id === moduleId) ?? modules[0]
  const currentView = currentModule.tabs.find((item) => item.id === viewId)

  return {
    module: currentModule.id,
    view: currentView?.id,
    label: currentView?.label ?? currentModule.label,
  }
}

const understandingSteps = [
  "项目创建完成",
  "分析网站入口",
  "发现站内页面",
  "抓取并提取重要页面",
  "整理业务相关页面",
  "生成业务资料",
]

function getUnderstandingStep(project: Project) {
  if (
    (project.understandingStatus === "completed" ||
      project.understandingStatus === "partial") &&
    project.siteProfile
  ) {
    return 5
  }
  if (
    project.understandingStage === "generating_profile" ||
    project.understandingStage === "completed"
  ) {
    return 5
  }
  if (project.understandingStage === "selecting_pages") {
    return 4
  }
  if (project.understandingStage === "extracting_pages") {
    return 3
  }
  if (project.understandingStage === "discovering_pages") {
    return 2
  }
  if (project.understandingStage === "analyzing_site") {
    return 1
  }
  return 0
}

function BusinessUnderstandingProgress({
  project,
  onRetry,
}: {
  project: Project
  onRetry: () => Promise<unknown>
}) {
  const failed = project.understandingStatus === "failed"
  const partial = project.understandingStatus === "partial"
  const activeStep = getUnderstandingStep(project)
  const message =
    project.understandingMessage ||
    (failed ? "网站业务识别未完成" : `正在分析 ${project.domain}`)
  const [retrying, setRetrying] = React.useState(false)
  const [retryError, setRetryError] = React.useState("")

  async function retry() {
    setRetrying(true)
    setRetryError("")
    try {
      await onRetry()
    } catch (error) {
      setRetryError(
        error instanceof Error ? error.message : "重新识别网站业务失败"
      )
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="rounded-md border bg-muted/20">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Globe2 className="size-3.5 text-muted-foreground" />
          网站业务识别
        </div>
        <Badge
          variant={failed ? "destructive" : partial ? "secondary" : "outline"}
          className="h-5 rounded-sm font-normal"
        >
          {failed ? "未完成" : partial ? "部分完成" : "进行中"}
        </Badge>
      </div>
      <div className="space-y-3 p-3">
        {failed ? (
          <div className="space-y-2 text-xs">
            <div className="font-medium text-destructive">失败原因</div>
            <div className="leading-5 text-muted-foreground">{message}</div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {retrying ? "正在重试" : "重新识别"}
            </Button>
            {retryError && <div className="text-destructive">{retryError}</div>}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs">
            {partial ? (
              <Check className="size-3.5 text-amber-600" />
            ) : (
              <LoaderCircle className="size-3.5 animate-spin" />
            )}
            <span>{message}</span>
          </div>
        )}
        <div className="space-y-2">
          {understandingSteps.map((step, index) => {
            const completed =
              !failed &&
              (index < activeStep || (partial && index === activeStep))
            const active = !failed && !partial && index === activeStep
            return (
              <div
                key={step}
                className={
                  completed || active
                    ? "flex items-center gap-2 text-xs"
                    : "flex items-center gap-2 text-xs text-muted-foreground"
                }
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {completed ? (
                    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <span
                      className={
                        active
                          ? "size-2 rounded-full bg-primary"
                          : "size-1.5 rounded-full bg-border"
                      }
                    />
                  )}
                </span>
                <span>{step}</span>
              </div>
            )
          })}
        </div>
        <Progress
          value={partial ? 100 : project.understandingProgress}
          className="h-1"
        />
        <div className="text-[11px] text-muted-foreground">
          第 {project.understandingAttempt} 次
          {project.understandingStartedAt
            ? ` · ${project.understandingElapsedSeconds.toFixed(1)} 秒`
            : ""}
        </div>
      </div>
    </div>
  )
}

function AgentDockContent({ onClose }: AgentDockContentProps) {
  const location = useLocation()
  const { projects, getProject, refreshBusinessProfile } = useProjects()
  const { projectId = projects[0]?.id ?? "" } = useParams()
  const project = getProject(projectId)
  const showUnderstandingProgress =
    project.understandingStatus === "queued" ||
    project.understandingStatus === "running" ||
    project.understandingStatus === "partial" ||
    project.understandingStatus === "failed"
  const context = getPageContext(location.pathname)
  const agent = useAgentConversation(project.id)
  const [draft, setDraft] = React.useState("")
  const [attachedContext, setAttachedContext] = React.useState<{
    projectId: string
    label: string
  } | null>(null)
  const [sending, setSending] = React.useState(false)
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(
    null
  )
  const [editingDraft, setEditingDraft] = React.useState("")
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const messages = React.useMemo(
    () => agent.detail?.messages ?? [],
    [agent.detail?.messages]
  )
  const run = agent.detail?.run
  const runtime = agent.detail?.runtime
  const steps = run?.steps ?? []
  const isRunActive =
    run?.status === "queued" ||
    run?.status === "running" ||
    run?.status === "executing" ||
    run?.status === "verifying"
  const isThinking =
    sending ||
    run?.status === "queued" ||
    run?.status === "running" ||
    run?.status === "executing" ||
    run?.status === "verifying"
  const isStreaming = messages.some(
    (message) => message.role === "assistant" && message.streaming
  )
  const activeAttachedContext =
    attachedContext?.projectId === project.id ? attachedContext.label : null

  React.useEffect(() => {
    viewportRef.current?.scrollTo?.({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages, isThinking, runtime?.lastEventType])

  async function sendMessage(preset?: string, includeContext = false) {
    const content = (preset ?? draft).trim()
    if (!content || isRunActive || sending) {
      return
    }
    setDraft("")
    setSending(true)
    agent.setError("")
    try {
      await agent.send(
        content,
        includeContext || activeAttachedContext
          ? { module: context.module, view: context.view }
          : undefined
      )
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "发送失败")
    } finally {
      setSending(false)
    }
  }

  async function resetConversation() {
    setAttachedContext(null)
    try {
      await agent.create()
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "新建对话失败")
    }
  }

  async function stopTask() {
    try {
      await agent.cancel()
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "停止任务失败")
    }
  }

  async function undoMessage(messageId: string) {
    try {
      await agent.rewind(messageId)
      setEditingMessageId(null)
      setEditingDraft("")
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "撤销失败")
    }
  }

  function cancelEditing() {
    setEditingMessageId(null)
    setEditingDraft("")
  }

  async function saveEditedMessage(messageId: string, original: string) {
    const content = editingDraft.trim()
    if (!content || sending) return
    if (content === original.trim()) {
      cancelEditing()
      return
    }
    setSending(true)
    try {
      await agent.edit(messageId, content)
      cancelEditing()
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "编辑失败")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-sm font-semibold">AI Agent</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title="新建对话"
          aria-label="新建对话"
          onClick={() => void resetConversation()}
        >
          <MessageSquarePlus />
        </Button>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="关闭"
            aria-label="关闭 AI Agent"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </div>

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {showUnderstandingProgress && (
          <BusinessUnderstandingProgress
            project={project}
            onRetry={() => refreshBusinessProfile(project.id)}
          />
        )}

        {!agent.loading && messages.length === 0 && (
          <div className="text-sm leading-6 text-muted-foreground">
            我会读取当前项目的真实数据，并直接执行平台允许的 SEO 操作。
          </div>
        )}

        {messages.map((message) =>
          message.role === "user" && editingMessageId === message.id ? (
            <div
              key={message.id}
              className="flex flex-col items-end gap-1.5 pl-8 sm:pl-16"
            >
              <Textarea
                autoFocus
                rows={Math.min(
                  6,
                  Math.max(2, editingDraft.split("\n").length)
                )}
                value={editingDraft}
                onChange={(event) => setEditingDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    void saveEditedMessage(message.id, message.content)
                  }
                  if (event.key === "Escape") {
                    event.preventDefault()
                    cancelEditing()
                  }
                }}
                aria-label="编辑消息内容"
                className="w-full max-w-xl resize-y text-sm"
              />
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={sending}
                  onClick={cancelEditing}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="xs"
                  disabled={
                    sending ||
                    !editingDraft.trim() ||
                    editingDraft.trim() === message.content.trim()
                  }
                  onClick={() =>
                    void saveEditedMessage(message.id, message.content)
                  }
                >
                  保存并重新执行
                </Button>
              </div>
            </div>
          ) : message.role === "user" ? (
            <div key={message.id} className="group flex justify-end gap-1">
              <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="编辑消息"
                  aria-label="编辑消息"
                  onClick={() => {
                    setEditingDraft(message.content)
                    setEditingMessageId(message.id)
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="撤销到此消息之前"
                  aria-label="撤销到此消息之前"
                  onClick={() => void undoMessage(message.id)}
                >
                  <Undo2 />
                </Button>
              </div>
              <div className="max-w-[88%] rounded-md bg-muted px-3 py-2 text-sm leading-6">
                {message.content}
              </div>
            </div>
          ) : (
            <div
              key={message.id}
              className="text-sm leading-6"
              aria-live={message.streaming ? "polite" : undefined}
            >
              <p className="whitespace-pre-wrap break-words">
                {message.content}
              </p>
              {message.streamError && (
                <p className="mt-1 text-xs text-muted-foreground">
                  正在恢复最终回答...
                </p>
              )}
            </div>
          )
        )}

        {agent.detail?.action && (
          <AgentActionCard action={agent.detail.action} />
        )}

        {runtime && runtime.runId === run?.id && isRunActive && (
          <AgentRuntimeProgress runtime={runtime} />
        )}

        {steps.length > 0 && (
          <div className="space-y-2 border-l pl-3" aria-label="执行步骤">
            {steps.map((step) => (
              <AgentStepRow key={step.sequence} step={step} />
            ))}
          </div>
        )}

        {(agent.loading || isThinking) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            {isStreaming ? "正在生成回答..." : runStatusLabel(run?.status)}
          </div>
        )}
        {agent.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {agent.error}
          </div>
        )}
        {run?.status === "failed" && run.errorMessage && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs leading-5 text-destructive">
            {run.errorMessage}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t bg-background p-3">
        <div className="mb-2 no-scrollbar flex gap-1 overflow-x-auto">
          {["分析当前页面", "寻找增长机会", "生成本周周报"].map(
            (suggestion) => (
              <Button
                key={suggestion}
                variant="ghost"
                size="xs"
                className="shrink-0 rounded-md border bg-background font-normal"
                onClick={() => {
                  if (suggestion === "分析当前页面") {
                    setAttachedContext({
                      projectId: project.id,
                      label: context.label,
                    })
                    void sendMessage(suggestion, true)
                    return
                  }
                  void sendMessage(suggestion)
                }}
                disabled={isRunActive || sending}
              >
                {suggestion}
              </Button>
            )
          )}
        </div>
        {activeAttachedContext ? (
          <div className="mb-2 flex min-w-0 items-center gap-1">
            <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-muted px-2 text-xs text-muted-foreground">
              <FileSearch className="size-3.5 shrink-0" />
              <span className="truncate">已引用：{activeAttachedContext}</span>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              title="移除页面引用"
              aria-label="移除页面引用"
              onClick={() => setAttachedContext(null)}
            >
              <X />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            className="mb-2 font-normal text-muted-foreground"
            onClick={() =>
              setAttachedContext({ projectId: project.id, label: context.label })
            }
          >
            <FileSearch />
            引用当前页面
          </Button>
        )}
        <div className="rounded-md border bg-background p-2 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault()
                void sendMessage()
              }
            }}
            placeholder={`询问 ${project.domain} 的 SEO 数据...`}
            className="min-h-14 resize-none rounded-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon-xs"
              title="添加附件"
              aria-label="添加附件"
            >
              <Paperclip />
            </Button>
            <div className="flex items-center gap-1">
              {isRunActive && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="停止任务"
                  aria-label="停止任务"
                  onClick={() => void stopTask()}
                >
                  <CircleStop />
                </Button>
              )}
              <Button
                size="icon-sm"
                className="rounded-md"
                onClick={() => void sendMessage()}
                disabled={
                  !draft.trim() ||
                  sending ||
                  isRunActive
                }
                title="发送"
                aria-label="发送"
              >
                <Send />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentRuntimeProgress({ runtime }: { runtime: AgentRuntime }) {
  const decision = [...runtime.messages]
    .reverse()
    .find((message) => message.phase === "decision")
  const tools = latestToolAttempts(runtime.tools)

  return (
    <div className="space-y-2 border-l border-primary/30 pl-3" aria-label="实时执行进度">
      <div className="flex items-center gap-2 text-xs font-medium">
        <LoaderCircle className="size-3.5 animate-spin text-primary" />
        {runtime.activeRound === null
          ? "Agent 正在处理任务"
          : `第 ${runtime.activeRound} 轮`}
      </div>
      {decision && <AgentRuntimeMessageRow message={decision} />}
      {tools.map((tool) => (
        <AgentRuntimeToolRow
          key={`${tool.toolCallId}:${tool.attempt}`}
          tool={tool}
        />
      ))}
    </div>
  )
}

function AgentRuntimeMessageRow({ message }: { message: AgentRuntimeMessage }) {
  const label = runtimeMessageLabel(message)
  const failed = message.status === "error" || message.status === "invalid"
  const completed = message.status === "completed" || message.status === "recovered"
  return (
    <div className="flex gap-2 text-xs">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {failed ? (
          <CircleX className="size-3.5 text-destructive" />
        ) : completed ? (
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <LoaderCircle className="size-3.5 animate-spin text-primary" />
        )}
      </span>
      <div className="min-w-0 break-words leading-5 text-muted-foreground">
        {label}
      </div>
    </div>
  )
}

function AgentRuntimeToolRow({ tool }: { tool: AgentRuntimeTool }) {
  const active = ["claimed", "running", "writing", "verifying", "retrying"].includes(
    tool.stage
  )
  return (
    <div className="flex gap-2 text-xs">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {active ? (
          <LoaderCircle className="size-3.5 animate-spin text-primary" />
        ) : tool.isError ? (
          <CircleX className="size-3.5 text-destructive" />
        ) : (
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium leading-5">{tool.toolName}</div>
        <div className="break-words leading-5 text-muted-foreground">
          {tool.summary || runtimeToolStageLabel(tool.stage)}
          {tool.attempt > 1 ? `（第 ${tool.attempt} 次尝试）` : ""}
        </div>
      </div>
    </div>
  )
}

function latestToolAttempts(tools: AgentRuntimeTool[]) {
  const latest = new Map<string, AgentRuntimeTool>()
  for (const tool of tools) {
    const existing = latest.get(tool.toolCallId)
    if (!existing || tool.attempt >= existing.attempt) latest.set(tool.toolCallId, tool)
  }
  return [...latest.values()].slice(-8)
}

function runtimeMessageLabel(message: AgentRuntimeMessage) {
  if (message.status === "invalid") return "模型返回格式不正确，正在重新生成"
  if (message.status === "error") return "模型输出中断"
  if (message.status === "recovered") return "已恢复上次生成的工具调用"
  if (message.toolCalls.some((toolCall) => toolCall.status === "streaming")) {
    return "正在生成工具调用"
  }
  if (message.toolCalls.length > 0) return "工具调用已生成"
  if (message.status === "completed") return "本轮模型输出已完成"
  return message.text ? "正在接收模型输出" : "正在等待模型输出"
}

function runtimeToolStageLabel(stage: AgentRuntimeTool["stage"]) {
  return {
    claimed: "已接收工具调用",
    running: "正在执行",
    writing: "正在写入项目数据",
    verifying: "正在重新读取并校验结果",
    retrying: "临时故障，正在重试",
    completed: "执行完成",
    failed: "执行失败",
    rejected: "平台已阻止执行",
    cancelled: "已取消",
    recovered: "已从上次执行结果恢复",
  }[stage]
}

function AgentStepRow({ step }: { step: AgentRunStep }) {
  const detail = step.errorMessage ?? step.summary
  return (
    <div className="flex gap-2 text-xs">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {step.status === "running" ? (
          <LoaderCircle className="size-3.5 animate-spin text-primary" />
        ) : step.status === "completed" ? (
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <CircleX className="size-3.5 text-destructive" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-5">{step.label}</div>
        {detail && (
          <div className="break-words leading-5 text-muted-foreground">{detail}</div>
        )}
      </div>
      {step.durationMs !== null && step.status !== "running" && (
        <span className="shrink-0 leading-5 text-muted-foreground">
          {(step.durationMs / 1000).toFixed(1)} 秒
        </span>
      )}
    </div>
  )
}

function runStatusLabel(status?: string) {
  return (
    {
      queued: "等待 Agent 服务接收任务...",
      running: "正在读取并分析项目数据...",
      executing: "正在执行平台允许的操作...",
      verifying: "正在校验执行结果...",
    }[status ?? ""] ?? "正在加载 Agent 对话..."
  )
}

export function AgentDock() {
  return (
    <aside className="sticky top-0 hidden h-svh w-80 shrink-0 overflow-hidden border-r xl:block 2xl:w-[340px]">
      <AgentDockContent />
    </aside>
  )
}

export function MobileAgentSheet() {
  const [open, setOpen] = React.useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="xl:hidden"
            aria-label="打开 AI Agent"
          />
        }
      >
        <Bot />
        <span className="hidden sm:inline">AI Agent</span>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="p-0 data-[side=left]:w-full data-[side=left]:sm:max-w-[420px]"
        showCloseButton={false}
      >
        <SheetTitle className="sr-only">AI Agent</SheetTitle>
        <SheetDescription className="sr-only">
          当前项目的常驻 SEO Agent 工作区
        </SheetDescription>
        <AgentDockContent onClose={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  )
}
