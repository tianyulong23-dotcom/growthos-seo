import { Mail } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import type { GmailConnectionView } from "@/features/outreach/gmail/types"
import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

const connectingTimedOut = (account: GmailConnectionView): boolean => {
  const connectedAt = Date.parse(account.connectedAt)
  return (
    account.connectionStatus === "CONNECTING" &&
    Number.isFinite(connectedAt) &&
    connectedAt <= Date.now() - 10 * 60_000
  )
}

const accountStatus = (account: GmailConnectionView) => {
  if (account.connectionStatus === "CONNECTED") {
    return account.sendAvailability === "AVAILABLE" ? "可用" : "发送暂停"
  }
  if (
    account.connectionStatus === "REAUTH_REQUIRED" ||
    account.connectionStatus === "TOKEN_REVOKED"
  ) {
    return "需重新授权"
  }
  if (account.connectionStatus === "CONNECTING") {
    return connectingTimedOut(account) ? "连接未完成" : "连接中"
  }
  return "已断开"
}

export function GmailAccountSelector({
  controller,
  className,
}: {
  controller: GmailConnectionController
  className?: string
}) {
  if (controller.accounts.length === 0) return null

  const sendCapable =
    controller.connection?.connectionStatus === "CONNECTED" &&
    controller.connection.sendAvailability === "AVAILABLE"
  const syncCapable =
    controller.connection?.connectionStatus === "CONNECTED" &&
    controller.connection.mailSyncCapability

  return (
    <div className={className}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <div className="mr-auto text-xs font-medium text-muted-foreground">
          当前项目发件账号
        </div>
        {controller.connection && (
          <>
            <Badge variant={sendCapable ? "secondary" : "outline"}>
              Send {sendCapable ? "可用" : "暂停"}
            </Badge>
            <Badge variant={syncCapable ? "secondary" : "outline"}>
              Sync {syncCapable ? "可用" : "暂停"}
            </Badge>
          </>
        )}
      </div>
      <Select
        value={controller.connection?.connectionId ?? null}
        onValueChange={(value) => {
          if (value) void controller.select(value)
        }}
        disabled={controller.busyAction !== null}
      >
        <SelectTrigger
          className="w-full rounded-md border-border bg-background sm:min-w-64"
          aria-label="当前项目发件账号"
        >
          <Mail className="text-muted-foreground" />
          <SelectValue>
            {controller.connection?.primaryEmail ?? "选择组织已有 Gmail 账号"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {controller.accounts.map((account) => (
            <SelectItem key={account.connectionId} value={account.connectionId}>
              <span>{account.primaryEmail}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {accountStatus(account)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="mt-1 text-xs text-muted-foreground">
        组织可用账号 {controller.accounts.length} 个；选择已有账号不会再次打开
        Google 授权。
      </div>
    </div>
  )
}
