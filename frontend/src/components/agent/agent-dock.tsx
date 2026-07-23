import * as React from "react"
import {
  Bot,
  Check,
  CircleStop,
  FileSearch,
  Globe2,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  RefreshCw,
  Send,
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
import { useProjects } from "@/features/projects/project-context"
import type { Project } from "@/features/projects/types"

type AgentMessage = {
  id: number
  role: "agent" | "user"
  content: string
  task?: boolean
}

type AgentDockContentProps = {
  onClose?: () => void
}

const initialMessages: AgentMessage[] = [
  {
    id: 1,
    role: "agent",
    content: "我会结合当前项目的数据协助分析，并在这里显示后台任务的实际进度。",
  },
]

function getPageContext(pathname: string) {
  const [, , , moduleId, viewId] = pathname.split("/")
  const currentModule =
    modules.find((item) => item.id === moduleId) ?? modules[0]
  const currentView = currentModule.tabs.find((item) => item.id === viewId)

  return currentView?.label ?? currentModule.label
}

function buildReply(prompt: string, context?: string | null) {
  if (prompt.includes("当前页面")) {
    return context
      ? `我正在基于“${context}”中的数据进行分析。当前优先级最高的是影响抓取和排名的异常项，我已经整理为一个三步执行计划。`
      : "请先引用当前页面，我就可以结合页面中的数据继续分析。"
  }
  if (prompt.includes("增长")) {
    return "我发现 4 个可快速推进的增长机会：修复高权重页面内链、更新排名 11-20 位的内容、补充商业意图关键词，以及跟进 3 个高相关外链目标。"
  }
  if (prompt.includes("周报")) {
    return "本周 SEO 周报已整理：自然点击增长 18.4%，前 10 名关键词增加 21 个，网站健康度提升 4 分。仍需重点关注新增的 4xx 内链问题。"
  }
  return context
    ? `我已经收到任务，并会结合“${context}”和当前项目数据继续分析。`
    : "我已经收到任务，并会结合当前项目数据继续分析。"
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
  const [histories, setHistories] = React.useState<
    Record<string, AgentMessage[]>
  >(() =>
    Object.fromEntries(
      projects.map((item) => [
        item.id,
        initialMessages.map((message) => ({ ...message })),
      ])
    )
  )
  const [draft, setDraft] = React.useState("")
  const [attachedContext, setAttachedContext] = React.useState<{
    projectId: string
    label: string
  } | null>(null)
  const [isThinking, setIsThinking] = React.useState(false)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const timerRef = React.useRef<number | null>(null)
  const messageIdRef = React.useRef(10)
  const messages = histories[project.id] ?? initialMessages
  const activeAttachedContext =
    attachedContext?.projectId === project.id ? attachedContext.label : null

  React.useEffect(() => {
    viewportRef.current?.scrollTo?.({
      top: viewportRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages, isThinking])

  React.useEffect(
    () => () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current)
      }
    },
    []
  )

  function replaceProjectMessages(nextMessages: AgentMessage[]) {
    setHistories((current) => ({
      ...current,
      [project.id]: nextMessages,
    }))
  }

  function sendMessage(preset?: string, contextOverride?: string | null) {
    const content = (preset ?? draft).trim()
    if (!content || isThinking) {
      return
    }
    const messageContext =
      contextOverride === undefined ? activeAttachedContext : contextOverride

    const userMessage: AgentMessage = {
      id: messageIdRef.current++,
      role: "user",
      content,
    }
    replaceProjectMessages([...messages, userMessage])
    setDraft("")
    setIsThinking(true)

    timerRef.current = window.setTimeout(() => {
      const reply: AgentMessage = {
        id: messageIdRef.current++,
        role: "agent",
        content: buildReply(content, messageContext),
      }
      setHistories((current) => ({
        ...current,
        [project.id]: [...(current[project.id] ?? []), reply],
      }))
      setIsThinking(false)
      timerRef.current = null
    }, 900)
  }

  function resetConversation() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setIsThinking(false)
    setAttachedContext(null)
    replaceProjectMessages([{ ...initialMessages[0] }])
  }

  function stopTask() {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setIsThinking(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-sm font-semibold">AI Agent</span>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            在线
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          title="新建对话"
          aria-label="新建对话"
          onClick={resetConversation}
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

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[88%] rounded-md bg-muted px-3 py-2 text-sm leading-6">
                {message.content}
              </div>
            </div>
          ) : (
            <div key={message.id} className="text-sm leading-6">
              {message.task && (
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <FileSearch className="size-3.5" />
                  分析结果
                </div>
              )}
              <p>{message.content}</p>
            </div>
          )
        )}

        {isThinking && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            正在分析项目数据...
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
                      label: context,
                    })
                    sendMessage(suggestion, context)
                    return
                  }
                  sendMessage(suggestion)
                }}
                disabled={isThinking}
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
              setAttachedContext({ projectId: project.id, label: context })
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
                sendMessage()
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
              {isThinking && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="停止任务"
                  aria-label="停止任务"
                  onClick={stopTask}
                >
                  <CircleStop />
                </Button>
              )}
              <Button
                size="icon-sm"
                className="rounded-md"
                onClick={() => sendMessage()}
                disabled={!draft.trim() || isThinking}
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
