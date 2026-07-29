import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  ShieldAlert,
  ShieldCheck,
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
import type { GmailConnectionView } from "@/features/outreach/gmail/types"
import type { Opportunity } from "@/features/outreach/mock-data"

const sendableConnection = (connection: GmailConnectionView | null) =>
  connection?.connectionStatus === "CONNECTED" &&
  connection.sendAvailability === "AVAILABLE"

export function SendReviewSheet({
  open,
  onOpenChange,
  opportunity,
  connection,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  opportunity: Opportunity | null
  connection: GmailConnectionView | null
}) {
  const identityReady = sendableConnection(connection)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl">
        {opportunity && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <SheetTitle>发送前检查</SheetTitle>
                <Badge variant="outline">只读预览</Badge>
              </div>
              <SheetDescription>
                发送检查同步至 BL-AI-122；BL-AI-124..130
                邮件同步能力仅在邮箱页面只读展示。本地演示不可发送，不会创建
                Send Intent。
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-5 overflow-y-auto px-6 pb-6 text-sm">
              <section>
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <ShieldCheck className="size-4 text-primary" />
                  身份与邮件
                </div>
                <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 border-y py-3">
                  <dt className="text-muted-foreground">发送身份</dt>
                  <dd className="min-w-0 truncate font-medium">
                    {connection?.primaryEmail ?? "未连接 Gmail"}
                  </dd>
                  <dt className="text-muted-foreground">收件人</dt>
                  <dd className="min-w-0 truncate">{opportunity.contact}</dd>
                  <dt className="text-muted-foreground">Opportunity</dt>
                  <dd className="min-w-0 truncate">{opportunity.domain}</dd>
                  <dt className="text-muted-foreground">草稿版本</dt>
                  <dd>
                    v{opportunity.draftFoundation.currentVersion ?? "—"} ·
                    本地演示内容
                  </dd>
                  <dt className="text-muted-foreground">主题</dt>
                  <dd>Resource suggestion for your streaming guide</dd>
                </dl>
              </section>

              <section>
                <div className="mb-2 font-medium">后端前置检查</div>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    {identityReady ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    )}
                    <div>
                      <div className="font-medium">已验证 From 身份</div>
                      <div className="text-xs text-muted-foreground">
                        {identityReady
                          ? "当前连接 DTO 可用；最终仍由 SendIdentity 规则重新授权。"
                          : "连接不可用，发送必须阻断。"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Lock className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <div>
                      <div className="font-medium">Suppression 与配额</div>
                      <div className="text-xs text-muted-foreground">
                        邮箱只以 HMAC 查询；24h
                        配额使用原子预留。当前用量和抑制结果尚无公开读接口，不能显示为通过。
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Lock className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <div>
                      <div className="font-medium">渐进验证与 Kill Switch</div>
                      <div className="text-xs text-muted-foreground">
                        缺少信誉和异常率投影时按 NEW_CONNECTION 保守处理：5 /
                        24h、至少 300 秒；Kill Switch
                        仍由服务端统一门禁，不能在本地显示为已通过。
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Lock className="mt-0.5 size-4 shrink-0 text-amber-600" />
                    <div>
                      <div className="font-medium">人工确认与联系频率</div>
                      <div className="text-xs text-muted-foreground">
                        当前按首次联系预览；30
                        天去重、跟进间隔和拒绝后禁止跟进必须由服务端事务校验。
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <ShieldAlert className="size-4 text-destructive" />
                  投递反馈与抑制
                </div>
                <div className="border-y py-3 text-xs text-muted-foreground">
                  <p>
                    HARD_BOUNCE、COMPLAINT、UNSUBSCRIBE 会立即建立抑制；
                    SOFT_BOUNCE 在 30 天内累计 3 次后建立
                    SOFT_BOUNCE_THRESHOLD。
                  </p>
                  <p className="mt-2">
                    DELIVERY_UNKNOWN
                    保持待服务端对账或人工复核；普通用户不能解除 UNSUBSCRIBE
                    抑制。当前没有公开反馈或抑制结果读接口，因此不会显示为已通过。
                  </p>
                </div>
              </section>

              <section>
                <div className="mb-2 font-medium">正文预览</div>
                <div className="border-y py-3 whitespace-pre-line text-muted-foreground">
                  {`Hi there,

I enjoyed your streaming guide and thought ElephTV could be a useful addition for readers looking for free streaming options.

Would you be open to taking a look?`}
                </div>
              </section>
            </div>

            <SheetFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                返回草稿
              </Button>
              <Button disabled>
                <Lock />
                本地演示不可发送
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
