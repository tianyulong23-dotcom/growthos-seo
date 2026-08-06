import * as React from "react"
import {
  AlertTriangle,
  Gauge,
  Info,
  KeyRound,
  Mail,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unplug,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { GmailAccountSelector } from "@/features/outreach/gmail/gmail-account-selector"
import type { GmailConnectionController } from "@/features/outreach/gmail/use-gmail-connection"

const statusPresentation = (
  controller: GmailConnectionController
): {
  label: string
  detail: string
  variant: "secondary" | "outline" | "destructive"
} => {
  if (controller.status === "loading" || controller.status === "idle") {
    return {
      label: "读取中",
      detail: "正在从 Gateway 读取连接状态",
      variant: "outline",
    }
  }
  if (controller.status === "error") {
    return {
      label: "状态未知",
      detail: "未取得服务端状态，不视为已连接",
      variant: "destructive",
    }
  }
  if (controller.connection === null) {
    return {
      label: "未连接",
      detail:
        controller.accounts.length > 0
          ? "请为当前项目选择组织已有 Gmail 账号"
          : "组织内还没有可用于发送的 Gmail 身份",
      variant: "outline",
    }
  }
  if (
    controller.connection.connectionStatus === "CONNECTED" &&
    controller.connection.sendAvailability === "AVAILABLE"
  ) {
    return {
      label: "已连接",
      detail: "身份来自服务端连接记录",
      variant: "secondary",
    }
  }
  if (controller.connection.connectionStatus === "REAUTH_REQUIRED") {
    return {
      label: "需要重连",
      detail: "授权已过期或权限不再满足",
      variant: "destructive",
    }
  }
  if (controller.connection.connectionStatus === "TOKEN_REVOKED") {
    return {
      label: "需要重连",
      detail: "授权已被撤销，需重新授权",
      variant: "destructive",
    }
  }
  if (controller.connection.connectionStatus === "CONNECTING") {
    return {
      label: "连接中",
      detail: "等待 OAuth 回调完成",
      variant: "outline",
    }
  }
  if (
    controller.connection.connectionStatus === "CONNECTED" &&
    controller.connection.sendAvailability === "PAUSED"
  ) {
    return {
      label: "发送受限",
      detail: "Gmail 身份仍已连接，但发送已被服务端暂停",
      variant: "destructive",
    }
  }
  if (controller.connection.connectionStatus === "DISCONNECTED") {
    return {
      label: "已断开",
      detail: "没有可用于发送的 Gmail 身份",
      variant: "outline",
    }
  }
  return {
    label: "状态未知",
    detail: "未取得可识别的服务端连接状态，不视为已连接",
    variant: "destructive",
  }
}

const conservativeVerification = (
  controller: GmailConnectionController
): {
  level: "未评估" | "RESTRICTED" | "NEW_CONNECTION"
  limit: string
  interval: string
} => {
  if (controller.status !== "ready" || controller.connection === null) {
    return { level: "未评估", limit: "不可发送", interval: "不可发送" }
  }
  if (
    controller.connection.connectionStatus !== "CONNECTED" ||
    controller.connection.sendAvailability !== "AVAILABLE"
  ) {
    return { level: "RESTRICTED", limit: "1 / 24h", interval: "至少 900 秒" }
  }
  return {
    level: "NEW_CONNECTION",
    limit: "5 / 24h",
    interval: "至少 300 秒",
  }
}

const formatConnectedAt = (value: string | undefined) => {
  if (value === undefined) return "—"
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    : "—"
}

export function GmailSafetyPanel({
  controller,
}: {
  controller: GmailConnectionController
}) {
  const [disconnectOpen, setDisconnectOpen] = React.useState(false)
  const [policyOpen, setPolicyOpen] = React.useState(false)
  const status = statusPresentation(controller)
  const verification = conservativeVerification(controller)
  const canDisconnect =
    controller.connection !== null &&
    controller.connection.connectionStatus !== "DISCONNECTED"
  const needsReauthorization =
    controller.connection?.connectionStatus === "TOKEN_REVOKED" ||
    controller.connection?.connectionStatus === "REAUTH_REQUIRED"

  return (
    <>
      <section
        className="mb-5 border-y bg-muted/20"
        aria-label="Gmail 连接与发送安全状态"
      >
        <div className="flex flex-col gap-4 py-4 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Mail className="size-4 text-primary" />
              <span className="text-sm font-medium">Gmail 连接</span>
              <Badge variant={status.variant}>{status.label}</Badge>
              {controller.lastDisconnect && (
                <Badge variant="outline">
                  撤销：
                  {controller.lastDisconnect === "COMPLETED"
                    ? "已完成"
                    : "后台重试中"}
                </Badge>
              )}
            </div>
            <div className="mt-2 truncate text-sm">
              {controller.connection?.primaryEmail ?? "尚无已验证发送身份"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {status.detail} · 连接时间{" "}
              {formatConnectedAt(controller.connection?.connectedAt)}
            </div>
            <GmailAccountSelector
              controller={controller}
              className="mt-3 max-w-sm"
            />
            {controller.connection?.recentErrorCategory && (
              <div className="mt-2 text-xs text-destructive">
                最近错误：{controller.connection.recentErrorCategory}
              </div>
            )}
          </div>

          <div className="grid flex-[2] gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="border-l-2 border-primary/25 pl-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <KeyRound className="size-3.5" />
                身份与密钥
              </div>
              <div className="mt-1 text-sm font-medium">
                {controller.connection
                  ? `${controller.connection.grantedScopes.length} 个授权范围`
                  : "Token 不进入前端"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                仅接收公开连接 DTO，不展示授权码或 Token
              </div>
            </div>
            <div className="border-l-2 border-emerald-500/40 pl-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5" />
                渐进验证
              </div>
              <div className="mt-1 text-sm font-medium">
                {verification.level}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                保守投影：{verification.limit} · {verification.interval}
              </div>
            </div>
            <div className="border-l-2 border-amber-500/40 pl-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Gauge className="size-3.5" />
                发送约束
              </div>
              <div className="mt-1 text-sm font-medium">配额原子预留</div>
              <div className="mt-1 text-xs text-muted-foreground">
                抑制 HMAC、24h 配额；当前用量读接口尚未开放
              </div>
            </div>
            <div className="border-l-2 border-destructive/40 pl-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldAlert className="size-3.5" />
                投递反馈
              </div>
              <div className="mt-1 text-sm font-medium">反馈抑制规则</div>
              <div className="mt-1 text-xs text-muted-foreground">
                硬退信、投诉和退订立即抑制；软退信 30 天内累计 3 次后抑制
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              title="刷新 Gmail 状态"
              aria-label="刷新 Gmail 状态"
              disabled={controller.status === "loading"}
              onClick={() => void controller.refresh()}
            >
              <RefreshCw
                className={
                  controller.status === "loading" ? "animate-spin" : ""
                }
              />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPolicyOpen(true)}
            >
              <Info />
              升级条件
            </Button>
            <Button
              size="sm"
              variant={controller.accounts.length > 0 ? "outline" : "default"}
              disabled={controller.busyAction !== null}
              onClick={() => void controller.connect()}
            >
              <Mail />
              {needsReauthorization
                ? "重新授权当前账号"
                : controller.accounts.length > 0
                  ? "授权新账号"
                  : "连接 Gmail"}
            </Button>
            {canDisconnect && (
              <Button
                variant="destructive"
                size="icon-sm"
                title="断开 Gmail"
                aria-label="断开 Gmail"
                disabled={controller.busyAction !== null}
                onClick={() => setDisconnectOpen(true)}
              >
                <Unplug />
              </Button>
            )}
          </div>
        </div>

        {controller.errorMessage && (
          <div className="flex items-start gap-2 border-t py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {controller.errorMessage}
          </div>
        )}
      </section>

      <Sheet open={policyOpen} onOpenChange={setPolicyOpen}>
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Gmail 渐进验证条件</SheetTitle>
            <SheetDescription>
              级别由服务端依据连接时长、正常发送、信誉和异常率逐级评估，不能手工跳级。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 overflow-y-auto px-6 text-sm">
            <div className="border-l-2 border-primary/30 pl-3">
              <div className="font-medium">NEW_CONNECTION</div>
              <div className="mt-1 text-muted-foreground">
                新连接默认 5 / 24h，最小间隔 300 秒。
              </div>
            </div>
            <div className="border-l-2 border-primary/50 pl-3">
              <div className="font-medium">REPUTATION_BUILDING</div>
              <div className="mt-1 text-muted-foreground">
                连接满 7 天、至少 10
                次正常发送且信誉和异常率达标后，单次只提升到此级。
              </div>
            </div>
            <div className="border-l-2 border-emerald-500/60 pl-3">
              <div className="font-medium">STANDARD</div>
              <div className="mt-1 text-muted-foreground">
                连接满 21 天、至少 50 次正常发送并通过更严格信誉检查后，最多 50
                / 24h，最小间隔 60 秒。
              </div>
            </div>
            <div className="border-l-2 border-destructive/60 pl-3">
              <div className="font-medium">RESTRICTED</div>
              <div className="mt-1 text-muted-foreground">
                低信誉或高异常率会自动降级。受限后需完成 7
                天冷却和健康样本，只能恢复到 NEW_CONNECTION。
              </div>
            </div>
            <div className="text-xs leading-5 text-muted-foreground">
              当前界面尚未取得服务端验证状态读模型，因此只做保守投影，不会在本地保存或放宽权威级别。
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>断开 Gmail</SheetTitle>
            <SheetDescription>
              系统会先暂停发送，再撤销授权并删除本地 Token
              引用。撤销失败时保持可重试状态。
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 text-sm">
            当前身份：
            <span className="ml-1 font-medium">
              {controller.connection?.primaryEmail ?? "—"}
            </span>
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={() => setDisconnectOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={controller.busyAction !== null}
              onClick={async () => {
                await controller.disconnect()
                setDisconnectOpen(false)
              }}
            >
              <Unplug />
              确认断开
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
