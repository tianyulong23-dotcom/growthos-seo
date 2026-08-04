import {
  Archive,
  Database,
  History,
  Inbox,
  LockKeyhole,
  MailCheck,
  RefreshCw,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

import { MailCenter } from "./mail-center"
import { getWebsiteProjectKeyFromPathname } from "./project-key"

const capabilityPresentation = (
  controller: GmailConnectionController
): {
  label: string
  detail: string
  variant: "secondary" | "outline" | "destructive"
} => {
  if (controller.status === "loading" || controller.status === "idle") {
    return {
      label: "读取中",
      detail: "正在读取服务端 Gmail 连接能力",
      variant: "outline",
    }
  }
  if (controller.status === "error") {
    return {
      label: "状态未知",
      detail: "没有公开状态时不推断为可同步",
      variant: "destructive",
    }
  }
  if (controller.connection === null) {
    return {
      label: "未连接",
      detail: "需要 Gmail 连接与只读邮件权限",
      variant: "outline",
    }
  }
  if (!controller.connection.mailSyncCapability) {
    return {
      label: "仅发送",
      detail: "现有连接未授予 gmail.readonly，邮件同步保持关闭",
      variant: "outline",
    }
  }
  if (controller.connection.connectionStatus !== "CONNECTED") {
    return {
      label: "不可同步",
      detail: "连接需要重新授权或已断开",
      variant: "destructive",
    }
  }
  return {
    label: "能力已授权",
    detail: "只确认服务端授权能力，不代表同步任务已运行",
    variant: "secondary",
  }
}

export function MailSyncStatusPanel({
  controller,
}: {
  controller: GmailConnectionController
}) {
  const capability = capabilityPresentation(controller)
  const websiteProjectKey =
    typeof window === "undefined"
      ? null
      : getWebsiteProjectKeyFromPathname(window.location.pathname)

  return (
    <section
      className="mb-5 border-y bg-muted/10 py-4"
      aria-label="邮件同步 BL-AI-124 至 BL-AI-139"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 xl:w-64 xl:shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <RefreshCw className="size-4 text-primary" />
            <span className="text-sm font-medium">邮件同步</span>
            <Badge variant={capability.variant}>{capability.label}</Badge>
          </div>
          <div className="mt-2 text-xs leading-5 text-muted-foreground">
            {capability.detail}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            运行状态读接口尚未开放，不显示为已同步。
          </div>
        </div>

        <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="border-l-2 border-primary/30 pl-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LockKeyhole className="size-3.5" />
              BL-AI-124
            </div>
            <div className="mt-1 text-sm font-medium">最小只读权限</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              新授权包含 gmail.readonly；旧发送连接保持兼容，不自动扩大权限。
            </div>
          </div>

          <div className="border-l-2 border-emerald-500/40 pl-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Database className="size-3.5" />
              BL-AI-125..127
            </div>
            <div className="mt-1 text-sm font-medium">隔离存储与关闭壳层</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              游标与 MIME 引用按项目隔离；Provider Adapter 默认关闭，前端不接触
              Token。
            </div>
          </div>

          <div className="border-l-2 border-amber-500/50 pl-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Archive className="size-3.5" />
              BL-AI-128..129
            </div>
            <div className="mt-1 text-sm font-medium">初始与增量同步</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              初始同步固定回看 7 天；后续按 Gmail History
              分页推进并最后提交游标。
            </div>
          </div>

          <div className="border-l-2 border-destructive/40 pl-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <History className="size-3.5" />
              BL-AI-130
            </div>
            <div className="mt-1 text-sm font-medium">过期游标受限修复</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              仅扫描 7 天、最多 10 页 / 1000
              条；成功后原子推进游标并写审计事件。
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-3">
        <div className="border-l-2 border-cyan-500/40 pl-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Archive className="size-3.5" />
            BL-AI-131..134
          </div>
          <div className="mt-1 text-sm font-medium">解析与正文安全</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            MIME 解析、正文净化与项目隔离对象读取均由服务端完成。
          </div>
        </div>
        <div className="border-l-2 border-violet-500/40 pl-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <MailCheck className="size-3.5" />
            BL-AI-135..138
          </div>
          <div className="mt-1 text-sm font-medium">回信匹配基线</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            规则候选展示证据与置信度；歧义结果只进入人工确认。
          </div>
        </div>
        <div className="border-l-2 border-emerald-500/40 pl-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Inbox className="size-3.5" />
            BL-AI-139
          </div>
          <div className="mt-1 text-sm font-medium">邮件读取接口</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            列表、分页、线程与匹配状态通过服务端安全 DTO 读取。
          </div>
        </div>
      </div>

      <div className="mt-5 bg-background pt-5">
        {websiteProjectKey ? (
          <MailCenter websiteProjectKey={websiteProjectKey} />
        ) : (
          <div
            className="border-y px-4 py-6 text-sm text-destructive"
            role="alert"
          >
            无法从当前项目路径解析 websiteProjectKey，Email Center 保持关闭。
          </div>
        )}
      </div>
    </section>
  )
}
