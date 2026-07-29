import * as React from "react"
import {
  ArrowRight,
  Bot,
  Check,
  CircleStop,
  FileSearch,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Send,
  X,
} from "lucide-react"
import { useLocation, useNavigate, useParams } from "react-router"

import { allNavigation } from "@/app/platform-navigation"
import {
  defaultProject,
  getProject,
  projects,
} from "@/app/project-context"
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
import { useSidebar } from "@/components/ui/sidebar"
import { Textarea } from "@/components/ui/textarea"

type AgentMessage = {
  id: number
  role: "agent" | "user"
  content: string
  task?: boolean
}

type AgentDockContentProps = {
  onNavigate?: () => void
  onClose?: () => void
}

const initialMessages: AgentMessage[] = [
  {
    id: 1,
    role: "agent",
    content:
      "我可以读取当前项目的审计、关键词、内容和外链数据，并协助完成跨模块任务。",
  },
  {
    id: 2,
    role: "user",
    content: "先告诉我当前最值得优先处理的问题。",
  },
  {
    id: 3,
    role: "agent",
    content:
      "建议优先修复 11 个指向 4xx 页面的内部链接，其次处理 18 个重复标题。这两项会直接影响抓取效率和重要页面的权重传递。",
    task: true,
  },
]

function getPageContext(pathname: string) {
  const [, , , moduleId, viewId] = pathname.split("/")
  const currentModule =
    allNavigation.find((item) => item.id === moduleId) ?? allNavigation[0]
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

function AgentTaskCard({
  projectId,
  onNavigate,
}: {
  projectId: string
  onNavigate?: () => void
}) {
  const navigate = useNavigate()

  return (
    <div className="mt-3 rounded-md border bg-muted/20">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <FileSearch className="size-3.5 text-muted-foreground" />
          优先问题分析
        </div>
        <Badge variant="outline" className="h-5 rounded-sm font-normal">
          已完成
        </Badge>
      </div>
      <div className="space-y-2.5 p-3">
        {["读取最近一次网站审计", "评估问题影响范围", "生成修复优先级"].map(
          (step) => (
            <div key={step} className="flex items-center gap-2 text-xs">
              <span className="flex size-4 items-center justify-center text-emerald-600 dark:text-emerald-400">
                <Check className="size-3.5" />
              </span>
              <span>{step}</span>
            </div>
          )
        )}
        <Progress
          value={100}
          className="h-1 [&_[data-slot=progress-indicator]]:bg-emerald-500/70"
        />
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-between rounded-md bg-background"
          onClick={() => {
            navigate(`/projects/${projectId}/audit/issues`)
            onNavigate?.()
          }}
        >
          打开问题清单
          <ArrowRight />
        </Button>
      </div>
    </div>
  )
}

function AgentDockContent({ onNavigate, onClose }: AgentDockContentProps) {
  const location = useLocation()
  const { state: sidebarState, toggleSidebar } = useSidebar()
  const { projectId = defaultProject.id } = useParams()
  const project = getProject(projectId)
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
    viewportRef.current?.scrollTo({
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
    replaceProjectMessages([initialMessages[0]])
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden xl:inline-flex"
          title={sidebarState === "collapsed" ? "展开导航" : "收起导航"}
          aria-label={sidebarState === "collapsed" ? "展开导航" : "收起导航"}
          onClick={toggleSidebar}
        >
          {sidebarState === "collapsed" ? (
            <PanelLeftOpen />
          ) : (
            <PanelLeftClose />
          )}
        </Button>
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
              {message.task && (
                <AgentTaskCard projectId={project.id} onNavigate={onNavigate} />
              )}
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
    <aside className="sticky top-0 hidden h-svh w-[360px] shrink-0 border-r xl:block">
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
        <AgentDockContent
          onNavigate={() => setOpen(false)}
          onClose={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  )
}
