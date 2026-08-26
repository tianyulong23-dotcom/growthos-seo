import * as React from "react"
import {
  Bot,
  Check,
  CircleDot,
  CircleStop,
  CircleX,
  Ellipsis,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  Send,
  Undo2,
  X,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useNavigate, useParams } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AgentActionCard } from "@/features/agent/agent-action-card"
import {
  conversationTimelineItems,
  hasVisibleAssistantReply,
  messageDisplayParts,
  runStatusLabel,
  shouldShowAgentWelcomeFallback,
  shouldShowRunError,
  type BusinessProgressItem,
} from "@/components/agent/agent-dock-utils"
import { useAgentConversation } from "@/features/agent/use-agent-conversation"
import { ProjectFavicon } from "@/features/projects/project-favicon"
import { useProjects } from "@/features/projects/project-context"
import type {
  AgentDisplayPart,
  AgentMessage,
  AgentRun,
  AgentRuntime,
  AgentRuntimeTool,
  AgentTimelineEvent,
} from "@/features/agent/types"

type AgentDockContentProps = {
  onClose?: () => void
}

export function AgentMessageContent({
  content,
  streaming = false,
}: {
  content: string
  streaming?: boolean
}) {
  return (
    <div
      className={`min-w-0 break-words text-foreground/85 ${streaming ? "text-sm" : ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className={`mt-5 mb-2 font-semibold text-foreground first:mt-0 ${streaming ? "text-sm" : "text-base"}`}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-5 mb-2 text-sm font-semibold text-foreground first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-1.5 text-sm font-semibold text-foreground first:mt-0">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="my-2 leading-relaxed first:mt-0 last:mb-0">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="my-3 ml-5 list-disc space-y-1.5 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 ml-5 list-decimal space-y-1.5 marker:text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">
              {children}
            </strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-primary/30 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-4 border-border" />,
          code: ({ children, className }) =>
            typeof className === "string" &&
            className.startsWith("language-") ? (
              <code className={className}>{children}</code>
            ) : (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                {children}
              </code>
            ),
          pre: ({ children }) => (
            <pre className="my-3 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed text-foreground">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <Table className="my-3 border text-xs">{children}</Table>
          ),
          thead: ({ children }) => <TableHeader>{children}</TableHeader>,
          tbody: ({ children }) => <TableBody>{children}</TableBody>,
          tr: ({ children }) => <TableRow>{children}</TableRow>,
          th: ({ children }) => (
            <TableHead className="h-auto bg-muted/50 px-2 py-2 text-xs font-semibold whitespace-normal">
              {children}
            </TableHead>
          ),
          td: ({ children }) => (
            <TableCell className="px-2 py-2 align-top text-xs leading-relaxed whitespace-normal">
              {children}
            </TableCell>
          ),
          a: ({ href, children }) =>
            isSafeAgentLink(href) ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                {children}
              </a>
            ) : (
              <span className="underline decoration-dotted">{children}</span>
            ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function AgentDisplayTool({
  item,
}: {
  item: Extract<AgentDisplayPart, { type: "tool" }>
}) {
  const failed = item.status !== "completed"
  return (
    <Badge
      variant={failed ? "destructive" : "secondary"}
      className={
        failed
          ? "h-auto min-h-5 py-1 whitespace-normal"
          : "h-auto min-h-5 bg-emerald-500/10 py-1 text-emerald-700 dark:text-emerald-400"
      }
    >
      {failed ? <CircleX /> : <Check />}
      <span>{item.label}</span>
    </Badge>
  )
}

export function AgentAssistantMessage({ message }: { message: AgentMessage }) {
  return (
    <div className="space-y-2.5">
      {messageDisplayParts(message).map((part, index) =>
        part.type === "text" ? (
          <AgentMessageContent key={`text:${index}`} content={part.text} />
        ) : (
          <AgentDisplayTool
            key={part.toolCallId ?? `${part.tool}:${index}`}
            item={part}
          />
        )
      )}
    </div>
  )
}

export function AgentTimelineItem({
  event,
  onNavigate,
  onRetry,
}: {
  event: AgentTimelineEvent
  onNavigate?: (path: string) => void
  onRetry?: (event: AgentTimelineEvent) => Promise<unknown>
}) {
  const [retrying, setRetrying] = React.useState(false)
  const [retryError, setRetryError] = React.useState("")
  const actionLabel =
    typeof event.action.label === "string" ? event.action.label.trim() : ""
  const actionTarget =
    typeof event.action.href === "string" ? event.action.href.trim() : ""
  const internalTarget =
    actionTarget.startsWith("/") && !actionTarget.startsWith("//")
      ? actionTarget
      : ""
  const externalTarget = isSafeAgentLink(actionTarget) ? actionTarget : ""
  const isPartial =
    event.status === "completed" && event.metadata.source_status === "partial"
  const statusLabel =
    event.status === "running"
      ? "进行中"
      : event.status === "waiting"
        ? "等待确认"
        : event.status === "completed"
          ? isPartial
            ? "部分完成"
            : "已完成"
          : event.status === "cancelled"
            ? "已取消"
            : "未完成"
  const statusIcon =
    event.status === "running" ? (
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
    ) : event.status === "waiting" ? (
      <CircleDot className="size-3.5 shrink-0 text-primary" />
    ) : event.status === "completed" ? (
      <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
    ) : event.status === "cancelled" ? (
      <CircleStop className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <CircleX className="size-3.5 shrink-0 text-destructive" />
    )
  const retryable =
    event.status === "failed" &&
    (event.metadata.source === "site_understanding" ||
      event.metadata.retryable === true) &&
    Boolean(onRetry)
  const retryLabel =
    event.metadata.source === "site_understanding" ? "重新识别" : "重试任务"

  async function retry() {
    if (!onRetry || retrying) return
    setRetrying(true)
    setRetryError("")
    try {
      await onRetry(event)
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "任务重试失败")
    } finally {
      setRetrying(false)
    }
  }

  if (event.kind === "message") {
    return (
      <div className="text-sm leading-6">
        <AgentMessageContent
          content={[event.title, event.content].filter(Boolean).join("\n\n")}
        />
      </div>
    )
  }

  return (
    <section
      className="space-y-2.5 text-sm"
      aria-label={`${event.title}，${statusLabel}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div
          className={
            event.status === "failed"
              ? "min-w-0 font-semibold text-destructive"
              : "min-w-0 font-semibold text-foreground"
          }
        >
          {event.title}
        </div>
        <Badge
          aria-label={statusLabel}
          variant={event.status === "failed" ? "destructive" : "secondary"}
          className={
            event.status === "running"
              ? "bg-primary/10 text-primary"
              : event.status === "waiting"
                ? "border border-primary/25 bg-primary/5 text-primary"
                : event.status === "completed"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "text-muted-foreground"
          }
        >
          {statusIcon}
          {statusLabel}
        </Badge>
      </div>
      {event.content && (
        <div
          className={
            event.status === "waiting"
              ? "border-l-2 border-primary/30 pl-3"
              : "border-l-2 border-border pl-3"
          }
          aria-label={`${event.title}结果`}
        >
          <AgentMessageContent content={event.content} />
        </div>
      )}
      {event.kind === "action" &&
        event.status === "waiting" &&
        actionLabel &&
        internalTarget && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-3"
            onClick={() => onNavigate?.(internalTarget)}
          >
            {actionLabel}
          </Button>
        )}
      {event.kind === "action" &&
        event.status === "waiting" &&
        actionLabel &&
        externalTarget && (
          <a
            href={externalTarget}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({
              variant: "outline",
              size: "xs",
              className: "ml-3",
            })}
          >
            {actionLabel}
          </a>
        )}
      {retryable && (
        <div className="ml-3 space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying && <LoaderCircle className="animate-spin" />}
            {retrying ? "正在重试" : retryLabel}
          </Button>
          {retryError && (
            <div className="text-xs text-destructive">{retryError}</div>
          )}
        </div>
      )}
    </section>
  )
}

export function AgentBusinessProgress({
  items,
}: {
  items: BusinessProgressItem[]
}) {
  if (items.length === 0) return null
  return (
    <div className="mb-3 flex flex-wrap gap-1.5" aria-label="任务进度">
      {items.map((item, index) => (
        <Badge
          key={item.toolCallId ?? `${item.tool}:${index}`}
          variant={item.status === "completed" ? "secondary" : "destructive"}
          className={
            item.status === "completed"
              ? "h-auto min-h-5 bg-emerald-500/10 py-1 text-emerald-700 dark:text-emerald-400"
              : "h-auto min-h-5 py-1 whitespace-normal"
          }
        >
          {item.status === "completed" ? <Check /> : <CircleX />}
          <span>{item.label}</span>
        </Badge>
      ))}
    </div>
  )
}

function isSafeAgentLink(href: string | undefined): href is string {
  if (!href) return false
  try {
    const url = new URL(href)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function AgentDockContent({ onClose }: AgentDockContentProps) {
  const navigate = useNavigate()
  const { getProject, refreshBusinessProfile } = useProjects()
  const { projectId = "" } = useParams()
  const project = getProject(projectId)
  const agent = useAgentConversation(project.id, project.understandingStatus)
  const [draft, setDraft] = React.useState("")
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
  const timelineItems = React.useMemo(
    () => conversationTimelineItems(messages, agent.detail?.timeline ?? []),
    [agent.detail?.timeline, messages]
  )
  const run = agent.detail?.run
  const runtime = agent.detail?.runtime
  const isRunActive =
    run?.status === "queued" ||
    run?.status === "running" ||
    run?.status === "executing" ||
    run?.status === "verifying"
  const isThinking =
    sending ||
    agent.awaitingRun ||
    run?.status === "queued" ||
    run?.status === "running" ||
    run?.status === "executing" ||
    run?.status === "verifying"
  const isStreaming = messages.some(
    (message) => message.role === "assistant" && message.streaming
  )
  const hasPersistedReply = hasVisibleAssistantReply(messages, run?.id)
  React.useEffect(() => {
    viewportRef.current?.scrollTo?.({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [timelineItems, isThinking, runtime?.lastEventType])

  async function sendMessage() {
    const content = draft.trim()
    if (!content || isRunActive || agent.awaitingRun || sending) {
      return
    }
    setDraft("")
    setSending(true)
    agent.setError("")
    try {
      await agent.send(content)
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "发送失败")
    } finally {
      setSending(false)
    }
  }

  async function resetConversation() {
    try {
      await agent.create()
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "新建对话失败")
    }
  }

  async function openConversation(conversationId: string) {
    try {
      await agent.selectConversation(conversationId)
    } catch (error) {
      agent.setError(error instanceof Error ? error.message : "切换对话失败")
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
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <ProjectFavicon project={project} className="size-6" />
          <span className="truncate text-sm font-semibold">
            {project.domain}
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title="对话操作"
                aria-label="对话操作"
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-52" align="end" sideOffset={4}>
            <DropdownMenuItem
              disabled={isRunActive || agent.awaitingRun || sending}
              onClick={() => void resetConversation()}
            >
              <Plus />
              新建对话
            </DropdownMenuItem>
            <DropdownMenuSub
              onOpenChange={(open) => {
                if (open) void agent.loadConversations()
              }}
            >
              <DropdownMenuSubTrigger>
                <History />
                历史对话
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64" side="left">
                {agent.historyLoading && agent.conversations.length === 0 ? (
                  <DropdownMenuItem disabled>正在加载...</DropdownMenuItem>
                ) : agent.conversations.length === 0 ? (
                  <DropdownMenuItem disabled>暂无历史对话</DropdownMenuItem>
                ) : (
                  agent.conversations.map((conversation) => (
                    <DropdownMenuItem
                      key={conversation.id}
                      onClick={() => void openConversation(conversation.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {conversation.title}
                        </span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {formatConversationTime(conversation.updatedAt)}
                        </span>
                      </span>
                      {conversation.id === agent.detail?.conversation.id && (
                        <Check className="size-4" />
                      )}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
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
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-2xl"
      >
        {shouldShowAgentWelcomeFallback(agent.loading, timelineItems) && (
          <div className="text-sm leading-relaxed text-foreground/80">
            我是 Aris，负责当前项目的 SEO
            增长。我会读取真实数据，并直接执行平台允许的操作。
          </div>
        )}

        {timelineItems.map((item) =>
          item.type === "event" ? (
            <AgentTimelineItem
              key={`event:${item.id}`}
              event={item.event}
              onNavigate={navigate}
              onRetry={
                item.event.metadata.source === "site_understanding" &&
                project.understandingStatus === "failed"
                  ? () => refreshBusinessProfile(project.id)
                  : item.event.metadata.retryable === true &&
                      typeof item.event.metadata.onboarding_step === "string"
                    ? () =>
                        agent.retryOnboardingStep(
                          String(item.event.metadata.onboarding_step)
                        )
                    : undefined
              }
            />
          ) : item.message.role === "user" &&
            editingMessageId === item.message.id ? (
            <div
              key={item.message.id}
              className="flex flex-col items-end gap-1.5 pl-8 sm:pl-16"
            >
              <Textarea
                autoFocus
                rows={Math.min(6, Math.max(2, editingDraft.split("\n").length))}
                value={editingDraft}
                onChange={(event) => setEditingDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault()
                    void saveEditedMessage(
                      item.message.id,
                      item.message.content
                    )
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
                    editingDraft.trim() === item.message.content.trim()
                  }
                  onClick={() =>
                    void saveEditedMessage(
                      item.message.id,
                      item.message.content
                    )
                  }
                >
                  保存并重新执行
                </Button>
              </div>
            </div>
          ) : item.message.role === "user" ? (
            <div key={item.message.id} className="group flex justify-end gap-1">
              <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="编辑消息"
                  aria-label="编辑消息"
                  onClick={() => {
                    setEditingDraft(item.message.content)
                    setEditingMessageId(item.message.id)
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="撤销到此消息之前"
                  aria-label="撤销到此消息之前"
                  onClick={() => void undoMessage(item.message.id)}
                >
                  <Undo2 />
                </Button>
              </div>
              <div className="max-w-[88%] rounded-md bg-muted px-3 py-2 text-sm leading-6">
                {item.message.content}
              </div>
            </div>
          ) : (
            <div
              key={item.message.id}
              className="text-sm leading-relaxed"
              aria-live={item.message.streaming ? "polite" : undefined}
            >
              <AgentAssistantMessage message={item.message} />
              {item.message.streamError && (
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

        {(agent.loading || (isThinking && !hasPersistedReply)) &&
          (runtime && runtime.runId === run?.id && isRunActive ? (
            <AgentRuntimeProgress runtime={runtime} />
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              {isStreaming
                ? "正在整理回答..."
                : runStatusLabel(run?.status, sending || agent.awaitingRun)}
            </div>
          ))}
        <AgentFailureNotice
          requestError={agent.error}
          run={run}
          messages={messages}
        />
      </div>

      <div className="shrink-0 border-t bg-background p-3">
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
          <div className="mt-1 flex items-center justify-end">
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
                  !draft.trim() || sending || agent.awaitingRun || isRunActive
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

export function AgentRuntimeProgress({ runtime }: { runtime: AgentRuntime }) {
  const tools = latestBusinessToolAttempts(runtime.tools)
  const parts = [
    ...runtime.messages.flatMap((message) =>
      message.phase === "final" && message.text.trim()
        ? [{ type: "text" as const, order: message.order ?? 0, message }]
        : []
    ),
    ...tools.map((tool) => ({
      type: "tool" as const,
      order: tool.order ?? 0,
      tool,
    })),
  ].sort((left, right) => left.order - right.order)
  const showTyping = runtime.agentStatus === "running" && parts.length === 0

  return (
    <div className="space-y-1.5" aria-label="实时执行进度">
      {parts.map((part) =>
        part.type === "text" ? (
          <AgentMessageContent
            key={`message:${part.message.id}`}
            content={part.message.text}
            streaming
          />
        ) : (
          <AgentRuntimeToolProgress
            key={`${part.tool.toolCallId}:${part.tool.attempt}`}
            tool={part.tool}
          />
        )
      )}
      {showTyping && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin text-primary" />
          正在处理任务...
        </div>
      )}
    </div>
  )
}

function AgentRuntimeToolProgress({ tool }: { tool: AgentRuntimeTool }) {
  const active = isToolActive(tool)
  const cancelled = tool.stage === "cancelled"
  const failed =
    tool.isError || tool.stage === "failed" || tool.stage === "rejected"
  const label = runtimeToolLabel(tool)
  return (
    <Badge
      variant={failed ? "destructive" : "secondary"}
      className={
        active
          ? "h-auto min-h-5 bg-primary/10 py-1 text-primary"
          : failed
            ? "h-auto min-h-5 py-1 whitespace-normal"
            : cancelled
              ? "h-auto min-h-5 py-1 text-muted-foreground"
              : "h-auto min-h-5 bg-emerald-500/10 py-1 text-emerald-700 dark:text-emerald-400"
      }
    >
      {active ? (
        <LoaderCircle className="animate-spin" />
      ) : failed ? (
        <CircleX />
      ) : cancelled ? (
        <CircleStop />
      ) : (
        <Check />
      )}
      <span>{label}</span>
    </Badge>
  )
}

function latestToolAttempts(tools: AgentRuntimeTool[]) {
  const latest = new Map<string, AgentRuntimeTool>()
  for (const tool of tools) {
    const existing = latest.get(tool.toolCallId)
    if (!existing || tool.attempt >= existing.attempt)
      latest.set(tool.toolCallId, tool)
  }
  return [...latest.values()]
}

function latestBusinessToolAttempts(tools: AgentRuntimeTool[]) {
  return latestToolAttempts(tools).filter((tool) => tool.toolName in toolLabels)
}

function formatConversationTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function isToolActive(tool: AgentRuntimeTool) {
  return ["claimed", "running", "writing", "verifying", "retrying"].includes(
    tool.stage
  )
}

const toolLabels: Record<
  string,
  { running: string; done: string; failed: string }
> = {
  get_project_profile: {
    running: "正在读取项目资料...",
    done: "项目资料已读取",
    failed: "项目资料读取未完成",
  },
  search_project_memory: {
    running: "正在检索项目信息...",
    done: "项目信息已检索",
    failed: "项目信息检索未完成",
  },
  get_latest_audit: {
    running: "正在读取技术审核...",
    done: "技术审核已读取",
    failed: "技术审核读取未完成",
  },
  get_audit_status: {
    running: "正在检查技术审核进度...",
    done: "技术审核进度已检查",
    failed: "技术审核进度检查未完成",
  },
  get_audit_issues: {
    running: "正在读取技术审核问题...",
    done: "技术审核问题已读取",
    failed: "技术审核问题读取未完成",
  },
  get_audit_pages: {
    running: "正在读取技术审核页面...",
    done: "技术审核页面已读取",
    failed: "技术审核页面读取未完成",
  },
  update_project_memory: {
    running: "正在更新项目信息...",
    done: "项目信息已更新",
    failed: "项目信息更新未完成",
  },
  update_business_profile: {
    running: "正在更新业务资料...",
    done: "业务资料已更新",
    failed: "业务资料更新未完成",
  },
  refresh_business_profile: {
    running: "正在重新识别网站业务...",
    done: "网站业务识别已启动",
    failed: "网站业务识别启动未完成",
  },
  start_technical_audit: {
    running: "正在启动技术审核...",
    done: "技术审核已启动",
    failed: "技术审核启动未完成",
  },
  start_keyword_library: {
    running: "正在建立关键词库...",
    done: "关键词库已启动",
    failed: "关键词库启动未完成",
  },
  get_keyword_library_status: {
    running: "正在检查关键词库进度...",
    done: "关键词库进度已检查",
    failed: "关键词库进度检查未完成",
  },
  start_content_plan: {
    running: "正在生成 30 篇内容计划...",
    done: "内容计划已启动",
    failed: "内容计划启动未完成",
  },
  get_content_plan_status: {
    running: "正在检查内容计划进度...",
    done: "内容计划进度已检查",
    failed: "内容计划进度检查未完成",
  },
  start_articles: {
    running: "正在启动文章生成...",
    done: "文章生成已启动",
    failed: "文章生成启动未完成",
  },
  get_article_generation_status: {
    running: "正在检查文章生成进度...",
    done: "文章生成进度已检查",
    failed: "文章生成进度检查未完成",
  },
}

function runtimeToolLabel(tool: AgentRuntimeTool) {
  const labels = toolLabels[tool.toolName] ?? {
    running: "正在执行任务...",
    done: "任务已完成",
    failed: "任务未完成",
  }
  if (tool.stage === "retrying") return "任务暂时中断，正在重试..."
  if (tool.stage === "failed" || tool.stage === "rejected" || tool.isError) {
    return labels.failed
  }
  if (tool.stage === "cancelled") return "任务已取消"
  if (tool.stage === "completed" || tool.stage === "recovered") {
    return labels.done
  }
  return labels.running
}

export function AgentFailureNotice({
  requestError,
  run,
  messages,
}: {
  requestError: string
  run: Pick<AgentRun, "id" | "status" | "errorMessage"> | null | undefined
  messages: AgentMessage[]
}) {
  if (!requestError && !shouldShowRunError(run, messages)) return null
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs leading-5 text-destructive">
      本次任务没有完成，请稍后重试。
    </div>
  )
}

export function AgentDock() {
  return (
    <aside className="sticky top-0 hidden h-svh w-[364px] shrink-0 overflow-hidden border-r xl:block 2xl:w-[384px]">
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
