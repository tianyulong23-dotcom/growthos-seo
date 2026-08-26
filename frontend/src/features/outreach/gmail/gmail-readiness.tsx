import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  GmailReadinessBlockerCode,
  GmailReadinessRecoveryAction,
} from "@/features/outreach/gmail/types"
import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

const gmailReadinessBlockerLabels: Record<GmailReadinessBlockerCode, string> = {
  GMAIL_ACCOUNT_NOT_SELECTED: "当前项目未选择 Gmail 账号",
  GMAIL_OAUTH_CONNECTING: "Gmail 授权尚未完成",
  GMAIL_REAUTH_REQUIRED: "Gmail 授权已失效",
  GMAIL_TOKEN_REFRESH_FAILED: "Gmail 凭据暂时无法刷新",
  GMAIL_TOKEN_REVOKED: "Gmail 授权已撤销",
  GMAIL_DISCONNECTED: "Gmail 已断开",
  PROJECT_BINDING_MISSING: "项目与 Gmail 账号的绑定无效",
  GMAIL_SEND_SCOPE_MISSING: "缺少 Gmail 发送权限",
  GMAIL_SYNC_SCOPE_MISSING: "缺少 Gmail 只读同步权限",
  GMAIL_SEND_IDENTITY_UNVERIFIED: "没有已验证的发件身份",
  GMAIL_SECRET_UNRESOLVABLE: "Gmail 凭据无法从 Secret Store 解析",
  GMAIL_SEND_PAUSED: "Gmail 发送已暂停",
  GMAIL_SEND_RUNTIME_DISABLED: "当前运行环境未启用 Gmail 发送",
  GMAIL_SYNC_RUNTIME_DISABLED: "当前运行环境未启用 Gmail 同步",
  GMAIL_WORKER_UNAVAILABLE: "Gmail Worker 不可用",
  SEND_CONTEXT_REQUIRED: "需要具体草稿和收件人才能完成发送预检",
  APPROVED_SEND_SNAPSHOT_MISSING: "当前草稿和联系人版本尚未批准",
  SEND_SUPPRESSION_BLOCKED: "收件人被抑制规则阻止",
  SEND_QUOTA_UNAVAILABLE: "当前发送配额不可用",
  GMAIL_SYNC_KILL_SWITCH_CLOSED: "Gmail 同步开关已关闭",
  GMAIL_SYNC_STATUS_UNAVAILABLE: "未能读取 Gmail 同步状态",
  GMAIL_SYNC_CURSOR_MISSING: "Gmail 同步游标缺失",
}

const gmailRecoveryActionLabels: Record<GmailReadinessRecoveryAction, string> =
  {
    CONNECT_GMAIL: "连接 Gmail",
    COMPLETE_GMAIL_OAUTH: "完成 Gmail 授权",
    REAUTHORIZE_GMAIL: "重新授权 Gmail",
    SELECT_GMAIL_ACCOUNT: "为当前项目选择 Gmail 账号",
    REPAIR_PROJECT_BINDING: "由管理员修复项目账号绑定",
    GRANT_GMAIL_SEND_SCOPE: "重新授权并允许 Gmail 发送",
    GRANT_GMAIL_SYNC_SCOPE: "重新授权并允许 Gmail 同步",
    VERIFY_SEND_IDENTITY: "由管理员验证发件身份",
    REPAIR_GMAIL_SECRET: "由管理员修复 Gmail Secret 引用",
    RESUME_GMAIL_SEND: "由管理员恢复 Gmail 发送",
    ENABLE_GMAIL_SEND_RUNTIME: "由管理员启用 Gmail 发送运行时",
    ENABLE_GMAIL_SYNC_RUNTIME: "由管理员启用 Gmail 同步运行时",
    START_GMAIL_WORKER: "启动 Gmail Worker 后重新检查",
    OPEN_APPROVED_DRAFT: "打开已批准草稿并选择收件人",
    REAPPROVE_CURRENT_DRAFT: "重新批准当前草稿和联系人版本",
    CLEAR_SEND_SUPPRESSION: "由管理员核查并解除发送抑制",
    WAIT_FOR_SEND_QUOTA: "等待配额恢复后重新预检",
    OPEN_GMAIL_SYNC_KILL_SWITCH: "由管理员开启 Gmail 同步开关",
    REFRESH_GMAIL_READINESS: "重新读取 Gmail 状态",
    REPAIR_GMAIL_SYNC_CURSOR: "由系统修复同步游标后重新检查",
  }

const ownerLabels = {
  USER: "你可以处理",
  ADMIN: "需要管理员",
  SYSTEM: "需要系统恢复",
} as const

const oauthRecoveryActions = new Set<GmailReadinessRecoveryAction>([
  "CONNECT_GMAIL",
  "COMPLETE_GMAIL_OAUTH",
  "REAUTHORIZE_GMAIL",
  "GRANT_GMAIL_SEND_SCOPE",
  "GRANT_GMAIL_SYNC_SCOPE",
])

export function GmailReadinessBlockers({
  controller,
  className,
}: {
  controller: GmailConnectionController
  className?: string
}) {
  const readiness = controller.readiness
  if (readiness === null || readiness.blockers.length === 0) return null

  const primary = readiness.primaryBlocker
  const canStartOAuth =
    primary !== null && oauthRecoveryActions.has(primary.recoveryAction)
  const canRefresh =
    primary?.recoveryAction === "REFRESH_GMAIL_READINESS" ||
    primary?.recoveryAction === "START_GMAIL_WORKER" ||
    primary?.recoveryAction === "REPAIR_GMAIL_SYNC_CURSOR"

  return (
    <div className={className}>
      <div className="flex flex-col gap-3 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-3 sm:flex-row sm:items-center">
        <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">发送与同步尚未就绪</div>
          {primary ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {gmailReadinessBlockerLabels[primary.code]} ·{" "}
              {ownerLabels[primary.owner]}
            </div>
          ) : null}
        </div>
        {canStartOAuth ? (
          <Button
            size="sm"
            variant="outline"
            disabled={controller.busyAction !== null}
            onClick={() => void controller.connect()}
          >
            {gmailRecoveryActionLabels[primary.recoveryAction]}
          </Button>
        ) : null}
        {canRefresh ? (
          <Button
            size="sm"
            variant="outline"
            disabled={controller.status === "loading"}
            onClick={() => void controller.refresh()}
          >
            <RefreshCw />
            重新检查
          </Button>
        ) : null}
      </div>
      <details className="group mt-2 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground">
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          查看 {readiness.blockers.length} 项技术详情
        </summary>
        <div className="mt-1 divide-y rounded-md border bg-background px-3">
          {readiness.blockers.map((item, index) => (
            <div
              key={`${item.capability}:${item.code}:${index}`}
              className="grid gap-2 py-2.5 sm:grid-cols-[4rem_minmax(0,1fr)_auto]"
            >
              <Badge variant="outline" className="w-fit rounded-md">
                {item.capability}
              </Badge>
              <div className="min-w-0">
                <div className="font-medium">
                  {gmailReadinessBlockerLabels[item.code]}
                </div>
                <div className="mt-0.5 text-muted-foreground">
                  {gmailRecoveryActionLabels[item.recoveryAction]}
                </div>
              </div>
              <div className="text-muted-foreground sm:text-right">
                <div>{ownerLabels[item.owner]}</div>
                <div>{item.retrySafe ? "可安全重试" : "需先人工核查"}</div>
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
