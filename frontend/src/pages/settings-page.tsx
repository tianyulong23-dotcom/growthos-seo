import * as React from "react"
import { Check } from "lucide-react"

import { settingsNavigation } from "@/app/platform-navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ModulePage } from "@/pages/module-page"

function SettingsContent({ view }: { view: string }) {
  const [saved, setSaved] = React.useState(false)

  if (view === "sources") {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[
          ["Google Search Console", "已连接", true],
          ["Google Analytics 4", "已连接", true],
          ["Gmail", "Mock 已连接 · 不会真实发送", true],
          ["DataForSEO", "Mock 数据源 · 未调用 API", true],
          ["Temporal", "Mock 任务状态 · 未启动队列", false],
        ].map(([name, status, connected]) => (
          <Card key={String(name)}>
            <CardContent className="flex items-center gap-4 p-5">
              <div className="flex size-10 items-center justify-center rounded-md bg-muted font-semibold">
                {String(name).slice(0, 2)}
              </div>
              <div className="flex-1">
                <div className="font-medium">{name}</div>
                <div className="text-xs text-muted-foreground">{status}</div>
              </div>
              <Switch defaultChecked={Boolean(connected)} />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (view === "outreach") {
    return (
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>发送安全规则</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {[
              [
                "人工确认发送",
                "所有开发信必须由人工确认后才能进入已发送状态",
                true,
              ],
              [
                "每封间隔 60 秒",
                "原型仅展示节流规则，不会创建真实发送任务",
                true,
              ],
              ["24 小时滚动上限 50 封", "接近上限时暂停生成新的确认任务", true],
              ["禁止自动追发", "跟进邮件继续保留人工确认", true],
            ].map(([title, description, enabled]) => (
              <label
                key={String(title)}
                className="flex items-center gap-4 rounded-md border p-4"
              >
                <span className="flex-1">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    {description}
                  </span>
                </span>
                <Switch defaultChecked={Boolean(enabled)} />
              </label>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>验证与抑制</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-md bg-muted p-4">
              <div className="text-sm font-medium">渐进式联系人验证</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                先使用公开联系人和低成本规则验证；只有在准备写信时才进入更深验证。
              </div>
            </div>
            {[
              ["退订与明确拒绝", "自动加入项目抑制名单", true],
              ["退信地址", "停止后续发送并保留原因", true],
              ["重复域名", "同一项目避免重复开发", true],
              ["高风险网站", "禁止进入草稿和发送流程", true],
            ].map(([title, description, enabled]) => (
              <label key={String(title)} className="flex items-center gap-4">
                <span className="flex-1">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {description}
                  </span>
                </span>
                <Switch defaultChecked={Boolean(enabled)} />
              </label>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (view === "notifications") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>通知规则</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {[
            ["收到新回复", "智能邮箱识别到新的外联回复时通知", true],
            ["链接发生变化", "已获得链接的 URL 或 Anchor 变化时通知", true],
            ["链接丢失", "链接从 active 变为 lost 时创建高优先级通知", true],
            ["跟进到期", "待回复机会到达计划跟进时间时通知", true],
            ["客户报告就绪", "报告预览生成完成后通知", false],
          ].map(([title, description, enabled]) => (
            <label
              key={String(title)}
              className="flex items-center gap-4 py-4 first:pt-0 last:pb-0"
            >
              <span className="flex-1">
                <span className="block text-sm font-medium">{title}</span>
                <span className="block text-xs text-muted-foreground">
                  {description}
                </span>
              </span>
              <Switch defaultChecked={Boolean(enabled)} />
            </label>
          ))}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>项目资料</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="font-medium">项目名称</span>
            <Input defaultValue="ElephTV" />
          </label>
          <label className="space-y-2 text-sm">
            <span className="font-medium">网站域名</span>
            <Input defaultValue="https://elephtv.com" />
          </label>
        </div>
        <label className="block space-y-2 text-sm">
          <span className="font-medium">项目说明</span>
          <Textarea
            defaultValue="面向美国英语市场的免费流媒体和 Smart TV 产品。"
            className="min-h-24"
          />
        </label>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => {
              setSaved(true)
              window.setTimeout(() => setSaved(false), 1800)
            }}
          >
            {saved ? <Check /> : null}
            {saved ? "已保存" : "保存更改"}
          </Button>
          {saved && (
            <span className="text-xs text-emerald-600">
              项目资料已保存到本地状态
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function SettingsPage() {
  return (
    <ModulePage module={settingsNavigation}>
      {(activeView) => <SettingsContent view={activeView} />}
    </ModulePage>
  )
}
