import * as React from "react"
import {
  ChevronDown,
  CircleAlert,
  Globe2,
  LoaderCircle,
  Play,
  SlidersHorizontal,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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

  return (
    <section
      className={cn(
        "max-w-4xl overflow-hidden rounded-md border bg-card",
        contained && "flex max-h-[90dvh] w-full flex-col"
      )}
    >
      <div
        className={cn(
          "p-6 sm:p-8",
          contained && "min-h-0 overflow-y-auto overscroll-contain"
        )}
      >
        <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Globe2 className="size-5" />
        </div>
        <h2 className="mt-5 text-xl font-semibold">
          {mode === "first" ? "开始首次网站审计" : "新建网站审计"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "first"
            ? "网站地址和默认抓取策略已准备好，可以直接开始。"
            : "确认本次抓取范围和分析选项后开始新的审计。"}
        </p>

        <div className="mt-7 grid gap-5 sm:grid-cols-[minmax(0,1fr)_180px]">
          <div>
            <div className="text-sm font-medium">网站</div>
            <div className="mt-2 flex h-10 items-center gap-2 rounded-md border bg-muted/30 px-3 text-sm">
              <Globe2 className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{project.domain}</span>
            </div>
          </div>
          <label className="block">
            <span className="text-sm font-medium">最大抓取页面</span>
            <div className="relative mt-2">
              <Input
                type="number"
                min={1}
                max={maxAuditPages}
                step={1}
                value={pageLimit}
                onChange={(event) => setPageLimit(event.target.value)}
                disabled={busy}
                aria-invalid={pageLimitInvalid}
                className="h-10 pr-10"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground">
                页
              </span>
            </div>
            {pageLimitInvalid && (
              <span className="mt-1.5 block text-xs text-destructive">
                请输入 1 到 5,000 之间的整数
              </span>
            )}
          </label>
        </div>

        <div className="mt-6 grid gap-3 border-y py-4 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">页面发现</div>
            <div className="mt-1 font-medium">首页 + Sitemap</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">抓取策略</div>
            <div className="mt-1 font-medium">自动限速 · Mobile Bot</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">JS 渲染</div>
            <div className="mt-1 font-medium">{renderingLabels[rendering]}</div>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          className="mt-3 -ml-3"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          disabled={busy}
        >
          <SlidersHorizontal />
          高级设置
          <ChevronDown
            className={cn(
              "ml-1 transition-transform",
              advancedOpen && "rotate-180"
            )}
          />
        </Button>

        {advancedOpen && (
          <div className="mt-3 border-t pt-6">
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
                    <SelectItem value="subdomains">包含所有子域名</SelectItem>
                    <SelectItem value="directory">仅指定目录</SelectItem>
                  </SelectContent>
                </Select>
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

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
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

            <label className="mt-5 block">
              <span className="text-sm font-medium">忽略的 URL 参数</span>
              <Textarea
                value={ignoredParameters}
                onChange={(event) => setIgnoredParameters(event.target.value)}
                disabled={busy}
                aria-invalid={ignoredParametersInvalid}
                className="mt-2 min-h-28 font-mono text-xs"
              />
              {ignoredParametersInvalid && (
                <span className="mt-1.5 block text-xs text-destructive">
                  参数仅支持字母、数字、点、横线、下划线及末尾通配符 *
                </span>
              )}
            </label>

            <label className="mt-5 block">
              <span className="text-sm font-medium">只排除审计问题的 URL</span>
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

            <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
              <label className="flex items-center justify-between gap-4 rounded-md border p-4">
                <span>
                  <span className="block text-sm font-medium">
                    重复内容检查
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    比较 Title、Description、H1 和页面词数。
                  </span>
                </span>
                <Switch
                  checked={enableDuplicationCheck}
                  onCheckedChange={setEnableDuplicationCheck}
                  disabled={busy}
                />
              </label>

              <label className="block">
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
                  disabled={busy || !enableDuplicationCheck}
                  aria-invalid={duplicationThresholdInvalid}
                  className="mt-2 h-10"
                />
                {duplicationThresholdInvalid && (
                  <span className="mt-1.5 block text-xs text-destructive">
                    请输入 0 到 1 之间的数值
                  </span>
                )}
              </label>
            </div>

            <label className="mt-5 flex items-center justify-between gap-4 rounded-md border p-4">
              <span>
                <span className="block text-sm font-medium">
                  PageSpeed 分析
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  抓取完成后分析移动端和桌面端性能，耗时会更长。
                </span>
              </span>
              <Switch
                checked={enablePageSpeed}
                onCheckedChange={setEnablePageSpeed}
                disabled={busy}
              />
            </label>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t bg-muted/20 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
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
      </div>
    </section>
  )
}
