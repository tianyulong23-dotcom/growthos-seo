import { Mail } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { GmailConnectionView } from "@/features/outreach/gmail/types"
import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

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
  return account.connectionStatus === "CONNECTING" ? "连接中" : "已断开"
}

export function GmailAccountSelector({
  controller,
  className,
}: {
  controller: GmailConnectionController
  className?: string
}) {
  if (controller.accounts.length === 0) return null

  return (
    <div className={className}>
      <div className="mb-1 text-xs font-medium text-muted-foreground">
        当前项目发件账号
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
