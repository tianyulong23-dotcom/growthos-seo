import { Clock3, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { gmailAuthFoundation } from "@/features/outreach/gmail/gmail-auth-foundation-model"

const authorizationFacts = [
  {
    icon: ShieldCheck,
    label: "OAuth state",
    value: "SHA-256 哈希 · 服务端一次性",
  },
  {
    icon: KeyRound,
    label: "PKCE",
    value: `${gmailAuthFoundation.pkceMethod} · Secret Reference`,
  },
  {
    icon: Clock3,
    label: "有效期",
    value: `${gmailAuthFoundation.expiresInSeconds / 60} 分钟`,
  },
] as const

export function GmailAuthFoundationPanel() {
  return (
    <section
      aria-labelledby="gmail-auth-foundation-title"
      className="border-y bg-muted/30 px-4 py-4"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="gmail-auth-foundation-title"
              className="text-sm font-semibold"
            >
              Gmail 授权基础
            </h2>
            <Badge variant="outline">未连接</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            真实 Google 授权未开放
          </p>
        </div>

        <dl className="grid min-w-0 gap-3 sm:grid-cols-3">
          {authorizationFacts.map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex min-w-0 items-start gap-2">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium break-words">{value}</dd>
              </div>
            </div>
          ))}
        </dl>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LockKeyhole className="size-4 shrink-0" />
          <span>连接与发送保持关闭</span>
        </div>
      </div>
    </section>
  )
}
