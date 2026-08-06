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
  const isConnected =
    controller.connection?.connectionStatus === "CONNECTED" &&
    controller.connection.mailSyncCapability
  const needsAuthorization =
    controller.connection === null ||
    controller.connection.connectionStatus !== "CONNECTED" ||
    !controller.connection.mailSyncCapability

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-muted/20 px-4 py-3 lg:flex-row lg:items-center">
      <span
        className={
          isConnected
            ? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : controller.status === "error"
              ? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive"
              : "flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
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
          <span className="text-sm font-medium">
            {isLoading
              ? "正在检查 Gmail 连接"
              : isConnected
                ? controller.connection?.primaryEmail
                : controller.status === "error"
                  ? "暂时无法获取 Gmail 状态"
                  : "连接 Gmail 后开始管理邮件"}
          </span>
          {isConnected && <Badge variant="secondary">已连接</Badge>}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {isConnected
            ? "新邮件和需要确认的回复会集中显示在下方。"
            : controller.status === "error"
              ? "你仍可查看当前邮件列表，稍后可重新检查连接。"
              : "连接后可查看往来邮件，并人工确认未匹配的回复。"}
        </p>
      </div>

      <GmailAccountSelector
        controller={controller}
        className="w-full lg:w-auto"
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
                ? "授权新账号"
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
      {controller.connection?.recentErrorCategory && (
        <div className="text-xs text-destructive lg:max-w-40">
          最近错误：{controller.connection.recentErrorCategory}
        </div>
      )}
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
