import * as React from "react"
import {
  Braces,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Globe2,
  LoaderCircle,
  Play,
  ScanSearch,
  SlidersHorizontal,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  defaultIgnoredParameters,
  defaultIssueExclusionPatterns,
  type AuditRendering,
  type AuditScope,
  type AuditSettings,
} from "@/features/audit/audit-settings"
import type { Project } from "@/features/projects/types"
import { cn } from "@/lib/utils"

const scopeLabels: Record<string, string> = {
  domain: "当前域名",
  subdomains: "包含所有子域名",
  directory: "仅指定目录",
}

const renderingLabels: Record<string, string> = {
  auto: "自动",
  off: "关闭",
  all: "全部渲染",
}

type AdvancedSection = "crawl" | "rules" | "checks"

type AuditSetupProps = {
  project: Project
  running: boolean
  onStart: (settings: AuditSettings) => Promise<void>
  onSuccess?: () => void
  mode?: "first" | "new"
  contained?: boolean
}

const pathPattern = /^\//
const parameterPattern = /^[A-Za-z0-9_.-]+\*?$/
const maxAuditPages = 5000

export function AuditSetup({
  project,
  running,
  onStart,
  onSuccess,
  mode = "first",
  contained = false,
}: AuditSetupProps) {
  const [submitting, setSubmitting] = React.useState(false)
  const [submitError, setSubmitError] = React.useState("")
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [advancedSection, setAdvancedSection] =
    React.useState<AdvancedSection>("crawl")
  const [pageLimit, setPageLimit] = React.useState("1000")
  const [scope, setScope] = React.useState<AuditScope>("domain")
  const [rendering, setRendering] = React.useState<AuditRendering>("auto")
  const [directory, setDirectory] = React.useState("")
  const [allowedPaths, setAllowedPaths] = React.useState("")
  const [excludedPaths, setExcludedPaths] = React.useState("")
  const [ignoredParameters, setIgnoredParameters] = React.useState(
    defaultIgnoredParameters.join("\n")
  )
  const [issueExclusionPatterns, setIssueExclusionPatterns] = React.useState(
    defaultIssueExclusionPatterns.join("\n")
  )
  const [enableDuplicationCheck, setEnableDuplicationCheck] =
    React.useState(true)
  const [duplicationThreshold, setDuplicationThreshold] = React.useState("0.85")
  const [enablePageSpeed, setEnablePageSpeed] = React.useState(false)

  const parsedPageLimit = Number(pageLimit)
  const pageLimitInvalid =
    !Number.isInteger(parsedPageLimit) ||
    parsedPageLimit < 1 ||
    parsedPageLimit > maxAuditPages
  const lines = (value: string) =>
    Array.from(
      new Set(
        value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      )
    )
  const allowedPathValues = lines(allowedPaths)
  const excludedPathValues = lines(excludedPaths)
  const ignoredParameterValues = lines(ignoredParameters)
  const issueExclusionValues = lines(issueExclusionPatterns)
  const directoryValue = directory.trim()
  const directoryError =
    scope !== "directory"
      ? ""
      : !directoryValue
        ? "请输入要审计的目录"
        : directoryValue.length > 2048
          ? "目录不能超过 2,048 个字符"
          : !pathPattern.test(directoryValue)
            ? "目录必须以 / 开头"
            : ""
  const allowedPathsInvalid =
    allowedPathValues.length > 100 ||
    allowedPathValues.some(
      (value) => value.length > 2048 || !pathPattern.test(value)
    )
  const excludedPathsInvalid =
    excludedPathValues.length > 100 ||
    excludedPathValues.some(
      (value) => value.length > 2048 || !pathPattern.test(value)
    )
  const ignoredParametersInvalid =
    ignoredParameterValues.length > 100 ||
    ignoredParameterValues.some(
      (value) => value.length > 100 || !parameterPattern.test(value)
    )
  const issueExclusionsInvalid =
    issueExclusionValues.length > 250 ||
    issueExclusionValues.some((value) => value.length > 2048)
  const parsedDuplicationThreshold = Number(duplicationThreshold)
  const duplicationThresholdInvalid =
    !Number.isFinite(parsedDuplicationThreshold) ||
    parsedDuplicationThreshold < 0 ||
    parsedDuplicationThreshold > 1
  const busy = running || submitting
  const startDisabled =
    busy ||
    pageLimitInvalid ||
    Boolean(directoryError) ||
    allowedPathsInvalid ||
    excludedPathsInvalid ||
    ignoredParametersInvalid ||
    issueExclusionsInvalid ||
    duplicationThresholdInvalid

  async function handleStart() {
    setSubmitting(true)
    setSubmitError("")
    try {
      await onStart({
        maxPages: parsedPageLimit,
        scope,
        rendering,
        directory: directoryValue,
        allowedPaths: allowedPathValues,
        excludedPaths: excludedPathValues,
        ignoredParameters: ignoredParameterValues,
        issueExclusionPatterns: issueExclusionValues,
        enableDuplicationCheck,
        duplicationThreshold: parsedDuplicationThreshold,
        enablePageSpeed,
      })
      onSuccess?.()
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "启动审计失败")
    } finally {
      setSubmitting(false)
    }
  }

  function openAdvanced(section: AdvancedSection) {
    setAdvancedSection(section)
    setAdvancedOpen(true)
  }

  const enabledCheckCount =
    Number(enableDuplicationCheck) + Number(enablePageSpeed)

  return (
    <Card
      className={cn(
        "max-w-5xl gap-0 overflow-hidden py-0 shadow-none ring-1 ring-border",
        contained && "flex max-h-[90dvh] w-full max-w-none flex-col"
      )}
    >
      <CardHeader
        className={cn(
          "grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0 border-b px-6 py-6 sm:px-8",
          contained && "shrink-0"
        )}
      >
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Globe2 className="size-5" />
        </div>
        <div className="min-w-0 self-center">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">
              {mode === "first" ? "开始首次网站审计" : "新建网站审计"}
            </h2>
            {mode === "first" && <Badge variant="secondary">尚未审计</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "first"
              ? "确认审计目标和抓取上限，其他设置已使用推荐值。"
              : "确认本次抓取范围和分析选项后开始新的审计。"}
          </p>
        </div>
      </CardHeader>

      <CardContent
        className={cn(
          "space-y-6 px-6 py-6 sm:px-8",
          contained && "min-h-0 overflow-y-auto overscroll-contain"
        )}
      >
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_220px]">
          <div>
            <label className="text-sm font-medium" htmlFor="audit-domain">
              审计网站
            </label>
            <InputGroup className="mt-2 h-10">
              <InputGroupAddon>
                <Globe2 />
              </InputGroupAddon>
              <InputGroupInput
                id="audit-domain"
                value={project.domain}
                readOnly
                aria-readonly="true"
              />
              <InputGroupAddon align="inline-end">
                <Badge variant="outline">{scopeLabels[scope]}</Badge>
              </InputGroupAddon>
            </InputGroup>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="audit-page-limit">
              最大抓取页面
            </label>
            <InputGroup className="mt-2 h-10">
              <InputGroupInput
                id="audit-page-limit"
                type="number"
                min={1}
                max={maxAuditPages}
                step={1}
                value={pageLimit}
                onChange={(event) => setPageLimit(event.target.value)}
                disabled={busy}
                aria-invalid={pageLimitInvalid}
              />
              <InputGroupAddon align="inline-end">页</InputGroupAddon>
            </InputGroup>
            {pageLimitInvalid ? (
              <span className="mt-1.5 block text-xs text-destructive">
                请输入 1 到 5,000 之间的整数
              </span>
            ) : (
              <span className="mt-1.5 block text-xs text-muted-foreground">
                达到上限后停止发现新页面
              </span>
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-3xl border">
          <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-3">
            <div>
              <div className="text-sm font-medium">本次审计配置</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                使用推荐值，可按需调整
              </div>
            </div>
            <Badge variant="secondary">推荐配置</Badge>
          </div>
          <div className="divide-y">
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start rounded-none px-4 py-3 text-left whitespace-normal"
              onClick={() => openAdvanced("crawl")}
              disabled={busy}
              aria-label={`调整抓取范围，当前为${scopeLabels[scope]}`}
            >
              <Globe2 className="text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">抓取范围</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  从首页和 Sitemap 发现页面
                </span>
              </span>
              <span className="shrink-0 text-sm font-normal text-muted-foreground">
                {scopeLabels[scope]}
              </span>
              <ChevronRight className="text-muted-foreground" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start rounded-none px-4 py-3 text-left whitespace-normal"
              onClick={() => openAdvanced("crawl")}
              disabled={busy}
              aria-label={`调整 JS 渲染，当前为${renderingLabels[rendering]}`}
            >
              <Braces className="text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">JS 渲染</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  处理依赖 JavaScript 的页面内容
                </span>
              </span>
              <span className="shrink-0 text-sm font-normal text-muted-foreground">
                {renderingLabels[rendering]}
              </span>
              <ChevronRight className="text-muted-foreground" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start rounded-none px-4 py-3 text-left whitespace-normal"
              onClick={() => openAdvanced("rules")}
              disabled={busy}
              aria-label="调整 URL 规则"
            >
              <SlidersHorizontal className="text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">URL 规则</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  允许、排除及问题过滤规则
                </span>
              </span>
              <span className="shrink-0 text-sm font-normal text-muted-foreground">
                忽略 {ignoredParameterValues.length} 个参数
              </span>
              <ChevronRight className="text-muted-foreground" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start rounded-none px-4 py-3 text-left whitespace-normal"
              onClick={() => openAdvanced("checks")}
              disabled={busy}
              aria-label="调整附加检查"
            >
              <ScanSearch className="text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">附加检查</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  重复内容和 PageSpeed 分析
                </span>
              </span>
              <span className="shrink-0 text-sm font-normal text-muted-foreground">
                已开启 {enabledCheckCount} 项
              </span>
              <ChevronRight className="text-muted-foreground" />
            </Button>
          </div>
        </div>

        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          disabled={busy}
        >
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="outline"
                className="w-full justify-between"
              />
            }
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontal />
              高级设置
              <span className="hidden font-normal text-muted-foreground sm:inline">
                · 范围、URL 规则、检查项
              </span>
            </span>
            <ChevronDown
              className={cn(
                "transition-transform",
                advancedOpen && "rotate-180"
              )}
            />
          </CollapsibleTrigger>

          <CollapsibleContent className="pt-4">
            <Tabs
              value={advancedSection}
              onValueChange={(value) =>
                setAdvancedSection((value ?? "crawl") as AdvancedSection)
              }
            >
              <TabsList className="grid h-auto w-full grid-cols-3">
                <TabsTrigger value="crawl">范围与渲染</TabsTrigger>
                <TabsTrigger value="rules">URL 规则</TabsTrigger>
                <TabsTrigger value="checks">检查项</TabsTrigger>
              </TabsList>

              <TabsContent value="crawl" className="pt-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-sm font-medium">抓取范围</span>
                    <Select
                      value={scope}
                      onValueChange={(value) =>
                        setScope((value ?? "domain") as AuditScope)
                      }
                      disabled={busy}
                    >
                      <SelectTrigger className="mt-2 h-10 w-full">
                        <SelectValue>{scopeLabels[scope]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="domain">当前域名</SelectItem>
                        <SelectItem value="subdomains">
                          包含所有子域名
                        </SelectItem>
                        <SelectItem value="directory">仅指定目录</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="mt-1.5 block text-xs text-muted-foreground">
                      决定本次审计允许访问的网站范围
                    </span>
                  </label>

                  <label className="block">
                    <span className="text-sm font-medium">JS 渲染</span>
                    <Select
                      value={rendering}
                      onValueChange={(value) =>
                        setRendering((value ?? "auto") as AuditRendering)
                      }
                      disabled={busy}
                    >
                      <SelectTrigger className="mt-2 h-10 w-full">
                        <SelectValue>{renderingLabels[rendering]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动</SelectItem>
                        <SelectItem value="off">关闭</SelectItem>
                        <SelectItem value="all">全部渲染</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="mt-1.5 block text-xs text-muted-foreground">
                      自动模式仅在页面需要时使用浏览器渲染
                    </span>
                  </label>
                </div>

                {scope === "directory" && (
                  <label className="mt-5 block">
                    <span className="text-sm font-medium">指定目录</span>
                    <Input
                      value={directory}
                      onChange={(event) => setDirectory(event.target.value)}
                      placeholder="/blog/"
                      disabled={busy}
                      aria-invalid={Boolean(directoryError)}
                      className="mt-2 h-10"
                    />
                    {directoryError && (
                      <span className="mt-1.5 block text-xs text-destructive">
                        {directoryError}
                      </span>
                    )}
                  </label>
                )}
              </TabsContent>

              <TabsContent value="rules" className="space-y-5 pt-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-sm font-medium">允许抓取的目录</span>
                    <Textarea
                      value={allowedPaths}
                      onChange={(event) => setAllowedPaths(event.target.value)}
                      placeholder={"/products/\n/blog/"}
                      disabled={busy}
                      aria-invalid={allowedPathsInvalid}
                      className="mt-2 min-h-24"
                    />
                    {allowedPathsInvalid && (
                      <span className="mt-1.5 block text-xs text-destructive">
                        每行填写一个以 / 开头的目录，最多 100 个
                      </span>
                    )}
                  </label>
                  <label className="block">
                    <span className="text-sm font-medium">排除抓取的目录</span>
                    <Textarea
                      value={excludedPaths}
                      onChange={(event) => setExcludedPaths(event.target.value)}
                      placeholder={"/account/\n/cart/"}
                      disabled={busy}
                      aria-invalid={excludedPathsInvalid}
                      className="mt-2 min-h-24"
                    />
                    {excludedPathsInvalid && (
                      <span className="mt-1.5 block text-xs text-destructive">
                        每行填写一个以 / 开头的目录，最多 100 个
                      </span>
                    )}
                  </label>
                </div>

                <label className="block">
                  <span className="text-sm font-medium">忽略的 URL 参数</span>
                  <Textarea
                    value={ignoredParameters}
                    onChange={(event) =>
                      setIgnoredParameters(event.target.value)
                    }
                    disabled={busy}
                    aria-invalid={ignoredParametersInvalid}
                    className="mt-2 min-h-28 font-mono text-xs"
                  />
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    每行一个参数，可在末尾使用 * 通配符
                  </span>
                  {ignoredParametersInvalid && (
                    <span className="mt-1.5 block text-xs text-destructive">
                      参数仅支持字母、数字、点、横线、下划线及末尾通配符 *
                    </span>
                  )}
                </label>

                <label className="block">
                  <span className="text-sm font-medium">不产生问题的 URL</span>
                  <Textarea
                    value={issueExclusionPatterns}
                    onChange={(event) =>
                      setIssueExclusionPatterns(event.target.value)
                    }
                    disabled={busy}
                    aria-invalid={issueExclusionsInvalid}
                    className="mt-2 min-h-40 font-mono text-xs"
                  />
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    页面仍会抓取和保存，但匹配这些通配符的 URL 不产生审计问题。
                  </span>
                  {issueExclusionsInvalid && (
                    <span className="mt-1.5 block text-xs text-destructive">
                      每行一个规则，最多 250 个，每个规则最多 2,048 个字符
                    </span>
                  )}
                </label>
              </TabsContent>

              <TabsContent value="checks" className="space-y-3 pt-5">
                <div className="rounded-3xl border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <label htmlFor="duplication-check" className="min-w-0">
                      <span className="block text-sm font-medium">
                        重复内容检查
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        比较 Title、Description、H1 和页面词数
                      </span>
                    </label>
                    <Switch
                      id="duplication-check"
                      checked={enableDuplicationCheck}
                      onCheckedChange={setEnableDuplicationCheck}
                      disabled={busy}
                    />
                  </div>
                  {enableDuplicationCheck && (
                    <label className="mt-4 block border-t pt-4">
                      <span className="text-sm font-medium">相似度阈值</span>
                      <Input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={duplicationThreshold}
                        onChange={(event) =>
                          setDuplicationThreshold(event.target.value)
                        }
                        disabled={busy}
                        aria-invalid={duplicationThresholdInvalid}
                        className="mt-2 h-10 max-w-48"
                      />
                      {duplicationThresholdInvalid && (
                        <span className="mt-1.5 block text-xs text-destructive">
                          请输入 0 到 1 之间的数值
                        </span>
                      )}
                    </label>
                  )}
                </div>

                <div className="flex items-start justify-between gap-4 rounded-3xl border p-4">
                  <label htmlFor="pagespeed-check" className="min-w-0">
                    <span className="block text-sm font-medium">
                      PageSpeed 分析
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      抓取完成后分析移动端和桌面端性能，耗时会更长
                    </span>
                  </label>
                  <Switch
                    id="pagespeed-check"
                    checked={enablePageSpeed}
                    onCheckedChange={setEnablePageSpeed}
                    disabled={busy}
                  />
                </div>
              </TabsContent>
            </Tabs>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <CardFooter className="flex shrink-0 flex-col gap-3 rounded-none border-t bg-muted/20 px-6 py-4 sm:flex-row sm:justify-between sm:px-8">
        <div className="min-w-0">
          {submitError ? (
            <div
              role="alert"
              className="flex items-start gap-2 text-xs text-destructive"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{submitError}</span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              robots.txt 明确禁止的页面将被跳过
            </span>
          )}
        </div>
        <Button
          size="lg"
          onClick={() => void handleStart()}
          disabled={startDisabled}
          className="w-full sm:w-auto"
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Play />}
          {submitting ? "正在启动..." : running ? "正在审计..." : "开始审计"}
        </Button>
      </CardFooter>
    </Card>
  )
}
