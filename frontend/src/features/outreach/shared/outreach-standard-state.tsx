import {
  CircleHelp,
  Clock3,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
  WifiOff,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type OutreachStandardState =
  | "loading"
  | "empty"
  | "error"
  | "forbidden"
  | "conflict"
  | "stale"
  | "offline"
  | "job-running"

const stateContent: Record<
  OutreachStandardState,
  { title: string; description: string }
> = {
  loading: {
    title: "正在加载",
    description: "正在读取服务端事实。",
  },
  empty: {
    title: "暂无数据",
    description: "当前条件下没有可显示的服务端记录。",
  },
  error: {
    title: "读取失败",
    description: "当前结果保持未知，请重试。",
  },
  forbidden: {
    title: "无权访问",
    description: "服务端拒绝了当前项目的访问。",
  },
  conflict: {
    title: "状态冲突",
    description: "服务端版本已变化，请刷新后重试。",
  },
  stale: {
    title: "数据需要刷新",
    description: "服务端已将当前证据标记为 stale。",
  },
  offline: {
    title: "当前处于离线状态",
    description: "不会使用本地数据推断服务端结果。",
  },
  "job-running": {
    title: "后台任务运行中",
    description: "页面将继续读取服务端任务状态。",
  },
}

const stateIcon = {
  loading: LoaderCircle,
  empty: CircleHelp,
  error: TriangleAlert,
  forbidden: ShieldAlert,
  conflict: RefreshCw,
  stale: Clock3,
  offline: WifiOff,
  "job-running": LoaderCircle,
} satisfies Record<OutreachStandardState, typeof LoaderCircle>

export function OutreachStandardStateView({
  state,
  title,
  description,
  onRetry,
  retryLabel = state === "empty" ? "刷新" : "重试",
  compact = false,
  className,
}: {
  state: OutreachStandardState
  title?: string
  description?: string
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
  className?: string
}) {
  const content = stateContent[state]
  const Icon = stateIcon[state]
  const isBusy = state === "loading" || state === "job-running"
  const isAlert =
    state === "error" ||
    state === "forbidden" ||
    state === "conflict" ||
    state === "offline"
  const isWarning = state === "stale" || state === "conflict"

  return (
    <div
      aria-busy={isBusy || undefined}
      aria-live={isBusy ? "polite" : "assertive"}
      className={cn(
        compact
          ? "flex items-start gap-2 border-l-2 px-3 py-2 text-sm"
          : "flex min-h-48 flex-col items-center justify-center border-y bg-muted/20 px-4 py-8 text-center",
        isWarning
          ? "border-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
          : isAlert
            ? "border-destructive/40"
            : "border-border",
        className
      )}
      role={isAlert ? "alert" : "status"}
      data-outreach-state={state}
    >
      <Icon
        className={cn(
          "size-5 shrink-0",
          compact ? "mt-0.5" : "mb-3",
          isBusy && "animate-spin",
          isAlert ? "text-destructive" : "text-muted-foreground"
        )}
      />
      <div className={compact ? "min-w-0" : undefined}>
        <div className="text-sm font-medium">{title ?? content.title}</div>
        <div
          className={cn(
            "text-xs leading-5 text-muted-foreground",
            compact ? "mt-0.5" : "mt-1 max-w-md"
          )}
        >
          {description ?? content.description}
        </div>
        {onRetry ? (
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={onRetry}
          >
            <RefreshCw data-icon="inline-start" />
            {retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
