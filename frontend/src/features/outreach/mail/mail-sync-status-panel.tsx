import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  Mail,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { GmailAccountSelector } from "@/features/outreach/gmail/gmail-account-selector"
import { GmailReadinessBlockers } from "@/features/outreach/gmail/gmail-readiness"
import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

import { MailCenter } from "./mail-center"
import { getWebsiteProjectKeyFromPathname } from "./project-key"

function ConnectionStatus({
  controller,
}: {
  controller: GmailConnectionController
}) {
  const isLoading =
    controller.status === "loading" || controller.status === "idle"
  const readiness = controller.readiness
  const isConnected = readiness?.connection.ready === true
  const isSendReady = readiness?.send.ready === true
  const isSyncReady = readiness?.sync.ready === true
  const needsAuthorization =
    controller.connection === null ||
    readiness?.blockers.some((item) =>
      [
        "GMAIL_OAUTH_CONNECTING",
        "GMAIL_REAUTH_REQUIRED",
        "GMAIL_TOKEN_REVOKED",
        "GMAIL_TOKEN_REFRESH_FAILED",
        "GMAIL_DISCONNECTED",
        "GMAIL_SEND_SCOPE_MISSING",
        "GMAIL_SYNC_SCOPE_MISSING",
      ].includes(item.code)
    ) === true
  const affectedProjectCount = controller.connection?.affectedProjectCount ?? 0
  const authorizationMessage =
    controller.connection?.connectionStatus === "REAUTH_REQUIRED"
      ? `组织 Gmail 授权已过期，重新连接一次可恢复 ${affectedProjectCount} 个项目`
      : controller.connection?.connectionStatus === "TOKEN_REVOKED"
        ? `组织 Gmail 授权已被撤销，需重新授权；重新连接一次可恢复 ${affectedProjectCount} 个项目`
        : null
  const readinessMessage =
    readiness?.send.state === "WAITING_FOR_SEND_CONTEXT"
      ? "Gmail 已连接；打开具体草稿并选择收件人后才会完成发送预检。"
      : readiness?.sync.state === "WAITING_FOR_ACCEPTED_SEND"
        ? "同步链路健康，正在等待第一封被 Gmail 接受的发送。"
        : isConnected && !isSendReady && !isSyncReady
          ? "Gmail 已连接，但发送和同步能力尚未就绪。"
          : isConnected && !isSendReady
            ? "Gmail 已连接，但发送能力尚未就绪。"
            : isConnected && !isSyncReady
              ? "Gmail 已连接，但同步能力尚未就绪；已保存邮件仍可读取。"
              : null

  return (
    <div className="rounded-lg border border-border/80 bg-background px-4 py-4 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
        <span
          className={
            isConnected
              ? "flex size-10 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : controller.status === "error"
                ? "flex size-10 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive"
                : "flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
          }
        >
          {isLoading ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : isConnected ? (
            <CheckCircle2 className="size-4" />
          ) : controller.status === "error" ? (
            <AlertCircle className="size-4" />
          ) : (
            <Mail className="size-4" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">
              {isLoading
                ? "正在检查 Gmail 连接"
                : isConnected
                  ? controller.connection?.primaryEmail
                  : controller.status === "error"
                    ? "暂时无法获取 Gmail 状态"
                    : (authorizationMessage ?? "连接 Gmail 后开始管理邮件")}
            </span>
            {!isLoading ? (
              <Badge
                className="rounded-md"
                variant={isConnected ? "secondary" : "outline"}
              >
                {isConnected ? "Gmail 已连接" : "Gmail 未连接"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {isConnected
              ? (readinessMessage ?? "新邮件和需要确认的回复会集中显示在下方。")
              : controller.status === "error"
                ? "你仍可查看当前邮件列表，稍后可重新检查连接。"
                : (authorizationMessage ??
                  "连接后可查看往来邮件，并人工确认未匹配的回复。")}
          </p>
        </div>

        <GmailAccountSelector
          controller={controller}
          className="w-full lg:w-72"
        />

        <div className="flex shrink-0 gap-2">
          {controller.status === "error" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void controller.refresh()}
            >
              重新检查
            </Button>
          ) : needsAuthorization && !isLoading ? (
            <Button
              size="sm"
              variant={controller.accounts.length > 0 ? "outline" : "default"}
              disabled={controller.busyAction === "connect"}
              onClick={() => void controller.connect()}
            >
              {controller.busyAction === "connect"
                ? "正在连接"
                : controller.accounts.length > 0
                  ? "重新连接 Gmail"
                  : "连接 Gmail"}
            </Button>
          ) : isConnected ? (
            <Button
              size="sm"
              variant="outline"
              disabled={controller.busyAction === "connect"}
              onClick={() => void controller.connect()}
            >
              <KeyRound data-icon="inline-start" />
              {controller.busyAction === "connect" ? "正在授权" : "重新授权"}
            </Button>
          ) : null}
        </div>
      </div>
      {controller.errorMessage ? (
        <div
          className="mt-4 flex items-start gap-2 border-t pt-3 text-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{controller.errorMessage}</span>
        </div>
      ) : null}
      <GmailReadinessBlockers
        controller={controller}
        className="mt-4 border-t pt-3"
      />
    </div>
  )
}

export function MailSyncStatusPanel({
  controller,
}: {
  controller: GmailConnectionController
}) {
  const websiteProjectKey =
    typeof window === "undefined"
      ? null
      : getWebsiteProjectKeyFromPathname(window.location.pathname)

  return (
    <section className="space-y-4" aria-label="邮件中心">
      <ConnectionStatus controller={controller} />
      {websiteProjectKey ? (
        <MailCenter
          websiteProjectKey={websiteProjectKey}
          connectionId={controller.connection?.connectionId ?? null}
          gmailSyncReady={controller.readiness?.sync.ready === true}
        />
      ) : (
        <div className="rounded-xl border px-4 py-8 text-center" role="alert">
          <div className="text-sm font-medium">当前项目无法打开邮件中心</div>
          <div className="mt-1 text-xs text-muted-foreground">
            请返回项目列表后重新进入。
          </div>
        </div>
      )}
    </section>
  )
}
