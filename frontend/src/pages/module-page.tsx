import * as React from "react"
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Download,
  ExternalLink,
  FilePlus2,
  Filter,
  Link2,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
} from "lucide-react"
import { Navigate, useNavigate, useParams } from "react-router"

import { PageHeader } from "@/components/shared/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  auditRows,
  backlinkRows,
  contentRows,
  keywordRows,
  modules,
  projects,
} from "@/data/mock-data"

function StatusBadge({ value }: { value: string }) {
  const style =
    value === "错误" || value === "待联系"
      ? "destructive"
      : value === "已发布" || value === "已获得" || value === "已回复"
        ? "default"
        : value === "警告" || value === "跟进中" || value === "待审核"
          ? "secondary"
          : "outline"
  return <Badge variant={style}>{value}</Badge>
}

function Toolbar({
  search,
  setSearch,
  filter,
  setFilter,
  options,
}: {
  search: string
  setSearch: (value: string) => void
  filter: string
  setFilter: (value: string) => void
  options: string[]
}) {
  return (
    <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索当前列表..."
          className="w-full pl-9 sm:max-w-sm"
        />
      </div>
      <Select
        value={filter}
        onValueChange={(value) => setFilter(value ?? "全部")}
      >
        <SelectTrigger className="w-full sm:w-36">
          <Filter className="text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm">
        <Download />
        导出
      </Button>
    </div>
  )
}

function AuditContent({ view }: { view: string }) {
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState("全部")
  const rows = auditRows.filter(
    (row) =>
      row.item.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "全部" || row.type === filter)
  )

  if (view === "overview") {
    return (
      <div className="grid gap-6 xl:grid-cols-[1fr_1.3fr]">
        <Card>
          <CardHeader>
            <CardTitle>审计健康度</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between">
              <div className="text-5xl font-semibold">86</div>
              <Badge className="bg-emerald-600">良好</Badge>
            </div>
            <Progress value={86} className="mt-4" />
            <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border text-center">
              {[
                ["29", "错误"],
                ["76", "警告"],
                ["143", "提示"],
              ].map(([value, label]) => (
                <div key={label} className="bg-background p-3">
                  <div className="text-xl font-semibold tabular-nums">
                    {value}
                  </div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>问题分布</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              ["索引与抓取", 73, 18],
              ["页面元素", 58, 31],
              ["性能体验", 42, 26],
              ["站内链接", 81, 11],
              ["结构化数据", 89, 7],
            ].map(([label, score, count]) => (
              <div key={label}>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="text-muted-foreground">{count} 个问题</span>
                </div>
                <Progress value={Number(score)} className="h-2" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <Card className="overflow-hidden">
      <Toolbar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        options={["全部", "错误", "警告", "提示"]}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox aria-label="选择全部" />
              </TableHead>
              <TableHead>{view === "pages" ? "页面问题" : "问题"}</TableHead>
              <TableHead>类型</TableHead>
              <TableHead className="text-right">受影响</TableHead>
              <TableHead className="text-right">变化</TableHead>
              <TableHead>负责人</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.item}>
                <TableCell>
                  <Checkbox aria-label={`选择 ${row.item}`} />
                </TableCell>
                <TableCell className="font-medium">{row.item}</TableCell>
                <TableCell>
                  <StatusBadge value={row.type} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.count}
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${
                    row.change.startsWith("+")
                      ? "text-destructive"
                      : "text-emerald-600"
                  }`}
                >
                  {row.change}
                </TableCell>
                <TableCell>{row.owner}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" title="查看详情">
                    <ArrowRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function KeywordsContent({ view }: { view: string }) {
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState("全部")
  const rows = keywordRows.filter(
    (row) =>
      row.keyword.includes(search.toLowerCase()) &&
      (filter === "全部" || row.intent === filter)
  )

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-px border-b bg-border sm:grid-cols-3">
        {[
          [view === "opportunities" ? "可争取机会" : "跟踪关键词", "420"],
          ["前 10 名", "286"],
          ["本周上升", "78"],
        ].map(([label, value]) => (
          <div key={label} className="bg-card p-4">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>
      <Toolbar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        options={["全部", "商业", "信息"]}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox aria-label="选择全部" />
              </TableHead>
              <TableHead>关键词</TableHead>
              <TableHead>意图</TableHead>
              <TableHead className="text-right">搜索量</TableHead>
              <TableHead className="text-right">排名</TableHead>
              <TableHead className="text-right">变化</TableHead>
              <TableHead>目标页面</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.keyword}>
                <TableCell>
                  <Checkbox aria-label={`选择 ${row.keyword}`} />
                </TableCell>
                <TableCell className="font-medium">{row.keyword}</TableCell>
                <TableCell>
                  <Badge variant="outline">{row.intent}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.volume}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.position}
                </TableCell>
                <TableCell className="text-right">
                  <span
                    className={`inline-flex items-center ${
                      row.change.startsWith("+")
                        ? "text-emerald-600"
                        : row.change.startsWith("-")
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}
                  >
                    {row.change.startsWith("+") && (
                      <ArrowUp className="size-3" />
                    )}
                    {row.change.startsWith("-") && (
                      <ArrowDown className="size-3" />
                    )}
                    {row.change}
                  </span>
                </TableCell>
                <TableCell className="max-w-60 truncate text-muted-foreground">
                  {row.url}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function ContentContent({ view }: { view: string }) {
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState("全部")
  const rows = contentRows.filter(
    (row) =>
      row.title.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "全部" || row.status === filter)
  )

  if (view === "opportunities") {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[
          ["solar tax credit 2026", "高", "6,600", "预计 +1,240 点击/月"],
          ["solar battery payback", "高", "3,600", "预计 +680 点击/月"],
          ["solaredge vs enphase", "中", "2,900", "预计 +420 点击/月"],
          ["best solar companies florida", "中", "2,400", "预计 +350 点击/月"],
        ].map(([keyword, priority, volume, impact]) => (
          <Card key={keyword}>
            <CardContent className="flex items-center gap-4 p-5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate font-medium">{keyword}</h3>
                  <Badge variant={priority === "高" ? "default" : "secondary"}>
                    {priority}优先级
                  </Badge>
                </div>
                <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                  <span>搜索量 {volume}</span>
                  <span>{impact}</span>
                </div>
              </div>
              <Button variant="outline" size="sm">
                创建简报
                <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <Card className="overflow-hidden">
      <Toolbar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        options={["全部", "草稿", "撰写中", "待审核", "已发布"]}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>内容</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>目标关键词</TableHead>
              <TableHead className="text-right">SEO 评分</TableHead>
              <TableHead>最后更新</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.title}>
                <TableCell className="max-w-80 font-medium">
                  {row.title}
                </TableCell>
                <TableCell>
                  <StatusBadge value={row.status} />
                </TableCell>
                <TableCell>{row.keyword}</TableCell>
                <TableCell className="text-right">
                  <span
                    className={
                      row.score >= 80 ? "text-emerald-600" : "text-amber-600"
                    }
                  >
                    {row.score}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.updated}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" title="打开内容">
                    <ExternalLink />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function BacklinksContent({ view }: { view: string }) {
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState("全部")
  const rows = backlinkRows.filter(
    (row) =>
      row.domain.includes(search.toLowerCase()) &&
      (filter === "全部" || row.status === filter)
  )

  return (
    <Card className="overflow-hidden">
      <Toolbar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        options={["全部", "待联系", "跟进中", "已回复", "已获得"]}
      />
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>目标域名</TableHead>
              <TableHead className="text-right">权威度</TableHead>
              <TableHead>相关性</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>联系人</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.domain}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    <Link2 className="size-4 text-muted-foreground" />
                    {row.domain}
                  </span>
                </TableCell>
                <TableCell className="text-right">{row.authority}</TableCell>
                <TableCell>{row.relevance}</TableCell>
                <TableCell>
                  <StatusBadge value={row.status} />
                </TableCell>
                <TableCell>{row.contact}</TableCell>
                <TableCell>
                  <Button variant="outline" size="sm">
                    {view === "monitor" ? <RefreshCw /> : <Send />}
                    {view === "monitor" ? "检查" : "联系"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function PerformanceContent({ view }: { view: string }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 xl:grid-cols-4">
        {[
          [view === "search" ? "自然点击" : "内容点击", "12,648", "+18.4%"],
          ["转化", "486", "+9.2%"],
          ["转化率", "3.84%", "+0.3%"],
          ["预估价值", "¥86,420", "+14.8%"],
        ].map(([label, value, change]) => (
          <div key={label} className="bg-card p-4">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold">{value}</div>
            <div className="mt-1 text-xs text-emerald-600">{change}</div>
          </div>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{view === "search" ? "渠道表现" : "内容贡献"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {[
            ["Google 自然搜索", 68, "8,598"],
            ["Bing 自然搜索", 21, "2,656"],
            ["AI 搜索引用", 7, "885"],
            ["其他搜索引擎", 4, "509"],
          ].map(([label, value, clicks]) => (
            <div
              key={label}
              className="grid gap-2 sm:grid-cols-[180px_1fr_70px] sm:items-center"
            >
              <span className="text-sm">{label}</span>
              <Progress value={Number(value)} />
              <span className="text-right text-sm text-muted-foreground tabular-nums">
                {clicks}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function SettingsContent({ view }: { view: string }) {
  const [saved, setSaved] = React.useState(false)

  if (view === "sources") {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[
          ["Google Search Console", "已连接", true],
          ["Google Analytics 4", "已连接", true],
          ["WordPress", "等待授权", false],
          ["DataForSEO", "已连接", true],
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

  if (view === "notifications") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>通知规则</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {[
            ["审计完成", "每次网站审计完成后通知", true],
            ["严重问题", "发现新的高优先级技术问题时通知", true],
            ["排名波动", "关键词排名单日变化超过 5 位时通知", true],
            ["内容到期", "内容进入计划更新日期时通知", false],
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
            <Input defaultValue="Solar Reviews" />
          </label>
          <label className="space-y-2 text-sm">
            <span className="font-medium">网站域名</span>
            <Input defaultValue="https://solarreviews.com" />
          </label>
        </div>
        <label className="block space-y-2 text-sm">
          <span className="font-medium">项目说明</span>
          <Textarea
            defaultValue="面向美国市场的太阳能评测和安装商平台。"
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

function ModuleBody({ moduleId, view }: { moduleId: string; view: string }) {
  if (moduleId === "audit") return <AuditContent view={view} />
  if (moduleId === "keywords") return <KeywordsContent view={view} />
  if (moduleId === "content") return <ContentContent view={view} />
  if (moduleId === "backlinks") return <BacklinksContent view={view} />
  if (moduleId === "performance") return <PerformanceContent view={view} />
  if (moduleId === "settings") return <SettingsContent view={view} />
  return null
}

export function ModulePage() {
  const navigate = useNavigate()
  const { projectId = projects[0].id, module = "", view } = useParams()
  const currentModule = modules.find((item) => item.id === module)
  const [running, setRunning] = React.useState(false)
  const [actionCount, setActionCount] = React.useState(0)

  if (!currentModule || currentModule.id === "overview") {
    return <Navigate to={`/projects/${projectId}/overview`} replace />
  }

  const moduleConfig = currentModule
  const activeView = view ?? moduleConfig.tabs[0]?.id
  if (!activeView) {
    return <Navigate to={`/projects/${projectId}/overview`} replace />
  }
  if (!moduleConfig.tabs.some((tab) => tab.id === activeView)) {
    return (
      <Navigate
        to={`/projects/${projectId}/${moduleConfig.id}/${moduleConfig.tabs[0].id}`}
        replace
      />
    )
  }

  function handleAction() {
    if (moduleConfig.id === "audit") {
      setRunning(true)
      window.setTimeout(() => setRunning(false), 2200)
      return
    }
    setActionCount((count) => count + 1)
  }

  const actionIcon =
    moduleConfig.id === "audit" ? (
      running ? (
        <LoaderCircle className="animate-spin" />
      ) : (
        <Play />
      )
    ) : moduleConfig.id === "content" ? (
      <FilePlus2 />
    ) : moduleConfig.id === "backlinks" ? (
      <Link2 />
    ) : moduleConfig.id === "performance" ? (
      <Download />
    ) : (
      <Plus />
    )

  return (
    <div className="min-w-0">
      <PageHeader
        module={moduleConfig}
        actionLabel={
          running
            ? "扫描中..."
            : actionCount > 0
              ? `已添加 ${actionCount} 项`
              : moduleConfig.action
        }
        actionIcon={actionIcon}
        onAction={handleAction}
        actionDisabled={running}
      />
      <div className="border-b px-4 sm:px-6 lg:px-8">
        <Tabs
          value={activeView}
          onValueChange={(nextView) =>
            navigate(`/projects/${projectId}/${module}/${nextView}`)
          }
        >
          <TabsList
            variant="line"
            className="h-11 max-w-full justify-start overflow-x-auto"
          >
            {moduleConfig.tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="p-4 sm:p-6 lg:p-8">
        {running && (
          <div className="mb-5 rounded-md border bg-muted/40 p-4">
            <div className="flex items-center gap-3">
              <LoaderCircle className="size-4 animate-spin text-primary" />
              <div className="flex-1">
                <div className="text-sm font-medium">正在扫描网站页面</div>
                <div className="text-xs text-muted-foreground">
                  当前为前端演示，任务将在几秒后完成
                </div>
              </div>
            </div>
            <Progress value={68} className="mt-3 h-1.5" />
          </div>
        )}
        <ModuleBody moduleId={moduleConfig.id} view={activeView} />
      </div>
    </div>
  )
}
