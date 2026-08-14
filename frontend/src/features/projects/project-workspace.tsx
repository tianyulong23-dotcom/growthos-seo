import * as React from "react"
import {
  Archive,
  Database,
  Globe2,
  Plus,
  RotateCcw,
  ShieldCheck,
  Workflow,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

type WebsiteProject = {
  id: number
  name: string
  domain: string
  market: string
  keywords: string
  completeness: number
  archived: boolean
}

const initialProjects: WebsiteProject[] = [
  {
    id: 1,
    name: "ElephTV",
    domain: "elephtv.com",
    market: "美国 · 英语",
    keywords: "free streaming · smart TV",
    completeness: 84,
    archived: false,
  },
  {
    id: 2,
    name: "Solar Reviews",
    domain: "solarreviews.com",
    market: "美国 · 英语",
    keywords: "solar panels · installers",
    completeness: 76,
    archived: false,
  },
  {
    id: 3,
    name: "Legacy Media",
    domain: "legacy-media.example",
    market: "英国 · 英语",
    keywords: "home media",
    completeness: 62,
    archived: true,
  },
]

const runtimeMilestones = [
  {
    icon: Database,
    title: "联系人证据与确认",
    detail:
      "Candidate、Evidence、Contact 持久化，人工确认受项目范围、权限和版本控制",
  },
  {
    icon: ShieldCheck,
    title: "Opportunity 四轴状态",
    detail: "业务阶段、管理、结果与履约独立保存，邮件和 Placement 不冒充主阶段",
  },
  {
    icon: Workflow,
    title: "幂等创建与项目编号",
    detail:
      "Recommendation 只创建一个 Opportunity，项目 Counter 并发分配连续序号",
  },
  {
    icon: Globe2,
    title: "公开 Opportunity 读写 API",
    detail:
      "FastAPI Gateway 聚合 Transition、Management、列表与详情，查询按项目隔离并使用稳定 Cursor",
  },
] as const

export function ProjectWorkspace() {
  const [items, setItems] = React.useState(initialProjects)
  const [open, setOpen] = React.useState(false)
  const [domain, setDomain] = React.useState("")
  const [name, setName] = React.useState("")
  const [archived, setArchived] = React.useState(false)
  const visibleItems = items.filter((item) => item.archived === archived)

  function createProject() {
    if (!domain.trim()) return
    setItems((current) => [
      ...current,
      {
        id: Date.now(),
        name: name.trim() || domain.trim(),
        domain: domain.trim().replace(/^https?:\/\//, ""),
        market: "美国 · 英语",
        keywords: "等待补充核心关键词",
        completeness: 28,
        archived: false,
      },
    ])
    setDomain("")
    setName("")
    setOpen(false)
  }

  return (
    <div className="space-y-5">
      <Card className="border-primary/20 bg-primary/[0.035]">
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Globe2 className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium">当前网站项目：ElephTV</div>
            <div className="mt-1 text-sm text-muted-foreground">
              elephtv.com · 推荐池、外链机会、邮件与报告共享同一项目上下文
            </div>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus />
            新建网站项目
          </Button>
        </CardContent>
      </Card>

      <section className="border-y py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-medium">联系人与外链机会运行底座</div>
            <div className="mt-1 text-sm text-muted-foreground">
              截至 BL-AI-080 的本地实现、公开合同与集成验收
            </div>
          </div>
          <Badge variant="secondary">BL-AI-071-080 合格</Badge>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {runtimeMilestones.map(({ icon: Icon, title, detail }) => (
            <div key={title} className="border-l-2 border-primary/25 pl-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 text-primary" />
                {title}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {detail}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 text-xs text-muted-foreground">
          真实 DataForSEO、外部抓取与 Gmail 保持关闭；当前交互数据仍为本地演示，
          公开 Opportunity 读写 API 已进入 Gateway
          合同，但不伪造登录态或真实发送结果。
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl bg-muted p-1">
          <Button
            size="sm"
            variant={archived ? "ghost" : "secondary"}
            onClick={() => setArchived(false)}
          >
            进行中
          </Button>
          <Button
            size="sm"
            variant={archived ? "secondary" : "ghost"}
            onClick={() => setArchived(true)}
          >
            已归档
          </Button>
        </div>
        <span className="text-sm text-muted-foreground">
          {archived ? "查看和恢复已归档项目" : "管理外链工作区关联的网站"}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {visibleItems.map((item) => (
          <Card key={item.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{item.name}</CardTitle>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {item.domain}
                  </div>
                </div>
                <Badge variant={item.archived ? "outline" : "secondary"}>
                  {item.archived ? "已归档" : "进行中"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-muted p-3">
                  <div className="text-xs text-muted-foreground">目标市场</div>
                  <div className="mt-1 font-medium">{item.market}</div>
                </div>
                <div className="rounded-xl bg-muted p-3">
                  <div className="text-xs text-muted-foreground">核心主题</div>
                  <div className="mt-1 truncate font-medium">
                    {item.keywords}
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-2 flex justify-between text-xs">
                  <span>资料完整度</span>
                  <span className="text-muted-foreground">
                    {item.completeness}%
                  </span>
                </div>
                <Progress value={item.completeness} />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1">
                  编辑资料
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setItems((current) =>
                      current.map((row) =>
                        row.id === item.id
                          ? { ...row, archived: !row.archived }
                          : row
                      )
                    )
                  }
                >
                  {item.archived ? <RotateCcw /> : <Archive />}
                  {item.archived ? "恢复" : "归档"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}

        {!archived && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(true)}
            className="h-auto min-h-64 w-full flex-col rounded-4xl border-dashed bg-card p-8 text-center whitespace-normal hover:border-primary/40 hover:bg-primary/[0.025]"
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-muted">
              <Plus className="size-5" />
            </span>
            <span className="mt-4 font-medium">创建另一个网站项目</span>
            <span className="mt-1 text-muted-foreground">
              原型支持创建、切换、归档和恢复状态
            </span>
          </Button>
        )}
      </div>

      <Sheet open={open} onOpenChange={(nextOpen) => setOpen(nextOpen)}>
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>新建网站项目</SheetTitle>
            <SheetDescription>
              创建后会准备推荐池、外链机会和项目报告的本地 mock 状态。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-6">
            <Label className="block space-y-2 text-sm">
              <span className="font-medium">项目名称</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 ElephTV"
              />
            </Label>
            <Label className="block space-y-2 text-sm">
              <span className="font-medium">网站域名</span>
              <Input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="example.com"
              />
            </Label>
            <Label className="block space-y-2 text-sm">
              <span className="font-medium">目标市场</span>
              <Input defaultValue="美国 · 英语" />
            </Label>
            <Label className="block space-y-2 text-sm">
              <span className="font-medium">核心关键词</span>
              <Input defaultValue="free streaming, smart TV" />
            </Label>
          </div>
          <SheetFooter>
            <Button disabled={!domain.trim()} onClick={createProject}>
              创建项目并准备推荐
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  )
}
