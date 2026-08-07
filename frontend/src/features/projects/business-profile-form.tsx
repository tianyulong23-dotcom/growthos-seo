import * as React from "react"
import {
  Check,
  ChevronDown,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react"

import { listBusinessProfileRuns } from "@/api/projects"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type {
  BusinessProfileInput,
  BusinessProfileRun,
  Project,
} from "@/features/projects/types"

type BusinessProfileFormProps = {
  project: Project
  onSave: (input: BusinessProfileInput) => Promise<unknown>
  submitLabel?: string
  onSaved?: () => void
  onRefresh?: () => Promise<unknown>
  refreshing?: boolean
}

function linesToValues(value: string) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()))].filter(
    Boolean
  )
}

function valuesToLines(values: string[]) {
  return values.join("\n")
}

const recognitionStatusLabels: Record<BusinessProfileRun["status"], string> = {
  queued: "等待中",
  running: "识别中",
  partial: "部分完成",
  completed: "已完成",
  failed: "失败",
}

const profileFieldLabels: Record<string, string> = {
  business_name: "企业 / 品牌名称",
  business_type: "业务类型",
  business_summary: "公司简介",
  target_audiences: "目标客户",
  products_services: "产品与服务",
  value_propositions: "选择理由",
  use_cases: "典型用途",
  target_markets: "目标市场",
  languages: "语言",
  content_topics: "内容主题",
  conversion_actions: "转化动作",
  key_pages: "关键页面",
}

function FieldSource({
  field,
  overriddenFields,
}: {
  field: string
  overriddenFields: string[]
}) {
  const userConfirmed = overriddenFields.includes(field)
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {userConfirmed ? "人工确认" : "AI 识别"}
    </Badge>
  )
}

function formatElapsed(seconds: number) {
  if (seconds < 1) {
    return "< 1 秒"
  }
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} 秒`
}

export function BusinessProfileForm({
  project,
  onSave,
  submitLabel = "保存更改",
  onSaved,
  onRefresh,
  refreshing = false,
}: BusinessProfileFormProps) {
  const profile = project.siteProfile
  const [businessName, setBusinessName] = React.useState(
    profile?.businessName || project.name
  )
  const [businessType, setBusinessType] = React.useState(
    profile?.businessType ?? ""
  )
  const [businessSummary, setBusinessSummary] = React.useState(
    profile?.businessSummary ?? ""
  )
  const [targetAudiences, setTargetAudiences] = React.useState(
    valuesToLines(profile?.targetAudiences ?? [])
  )
  const [productsServices, setProductsServices] = React.useState(
    valuesToLines(profile?.productsServices ?? [])
  )
  const [valuePropositions, setValuePropositions] = React.useState(
    valuesToLines(profile?.valuePropositions ?? [])
  )
  const [aiContentRules, setAiContentRules] = React.useState(
    profile?.aiContentRules ?? ""
  )
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState("")
  const [startingRefresh, setStartingRefresh] = React.useState(false)
  const [history, setHistory] = React.useState<BusinessProfileRun[]>([])
  const [historyLoading, setHistoryLoading] = React.useState(true)
  const syncedProjectId = React.useRef(project.id)
  const syncedRunId = React.useRef(
    project.understandingStatus === "completed" ||
      project.understandingStatus === "partial"
      ? project.understandingRunId
      : null
  )
  const busy = saving || refreshing || startingRefresh
  const recognitionStatus =
    project.understandingStatus === "partial"
      ? "部分完成"
      : project.understandingStatus === "completed"
        ? "已完成"
        : project.understandingStatus === "failed"
          ? "识别失败"
          : "识别中"
  const showRecognitionMessage =
    Boolean(project.understandingMessage) &&
    project.understandingStatus !== "completed"

  React.useEffect(() => {
    const projectChanged = syncedProjectId.current !== project.id
    const recognitionFinished =
      (project.understandingStatus === "completed" ||
        project.understandingStatus === "partial") &&
      syncedRunId.current !== project.understandingRunId

    if (!projectChanged && !recognitionFinished) {
      return
    }

    setBusinessName(profile?.businessName || project.name)
    setBusinessType(profile?.businessType ?? "")
    setBusinessSummary(profile?.businessSummary ?? "")
    setTargetAudiences(valuesToLines(profile?.targetAudiences ?? []))
    setProductsServices(valuesToLines(profile?.productsServices ?? []))
    setValuePropositions(valuesToLines(profile?.valuePropositions ?? []))
    setAiContentRules(profile?.aiContentRules ?? "")
    setSaved(false)
    setError("")
    syncedProjectId.current = project.id
    syncedRunId.current =
      project.understandingStatus === "completed" ||
      project.understandingStatus === "partial"
        ? project.understandingRunId
        : null
  }, [
    profile,
    project.id,
    project.name,
    project.understandingRunId,
    project.understandingStatus,
  ])

  React.useEffect(() => {
    let active = true
    void listBusinessProfileRuns(project.id)
      .then((runs) => {
        if (active) {
          setHistory(runs)
        }
      })
      .catch(() => {
        if (active) {
          setHistory([])
        }
      })
      .finally(() => {
        if (active) {
          setHistoryLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [
    project.id,
    project.understandingFinishedAt,
    project.understandingRunId,
    project.understandingStatus,
  ])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setSaved(false)
    setError("")

    try {
      await onSave({
        businessName: businessName.trim(),
        businessType: businessType.trim(),
        businessSummary: businessSummary.trim(),
        targetAudiences: linesToValues(targetAudiences),
        productsServices: linesToValues(productsServices),
        valuePropositions: linesToValues(valuePropositions),
        aiContentRules: aiContentRules.trim(),
      })
      setSaved(true)
      onSaved?.()
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存业务资料失败"
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleRefresh() {
    if (!onRefresh) {
      return
    }
    setStartingRefresh(true)
    setError("")
    try {
      await onRefresh()
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "重新识别网站业务失败"
      )
    } finally {
      setStartingRefresh(false)
    }
  }

  return (
    <form className="max-w-4xl" onSubmit={handleSubmit}>
      <section className="space-y-6 border-b pb-8">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">业务信息</h2>
            <Badge
              variant={
                project.understandingStatus === "failed"
                  ? "destructive"
                  : project.understandingStatus === "partial"
                    ? "secondary"
                    : "outline"
              }
            >
              {recognitionStatus}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{project.domain}</p>
          <p className="text-xs text-muted-foreground">
            第 {project.understandingAttempt} 次识别
            {project.understandingStartedAt
              ? ` · 用时 ${formatElapsed(project.understandingElapsedSeconds)}`
              : ""}
          </p>
          {showRecognitionMessage && (
            <p className="text-sm text-muted-foreground">
              {project.understandingMessage}
            </p>
          )}
        </div>

        <label className="block max-w-xl space-y-2 text-sm">
          <span className="flex items-center gap-2 font-medium">
            企业 / 品牌名称
            <FieldSource
              field="business_name"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </span>
          <Input
            aria-label="企业 / 品牌名称"
            value={businessName}
            onChange={(event) => setBusinessName(event.target.value)}
            disabled={busy}
            required
          />
        </label>

        <label className="block max-w-xl space-y-2 text-sm">
          <span className="flex items-center gap-2 font-medium">
            业务类型
            <FieldSource
              field="business_type"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </span>
          <Input
            aria-label="业务类型"
            value={businessType}
            onChange={(event) => setBusinessType(event.target.value)}
            disabled={busy}
            required
          />
        </label>

        <label className="block space-y-2 text-sm">
          <span className="flex items-center gap-2 font-medium">
            公司简介
            <FieldSource
              field="business_summary"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </span>
          <Textarea
            aria-label="公司简介"
            value={businessSummary}
            onChange={(event) => setBusinessSummary(event.target.value)}
            className="min-h-28 resize-y"
            disabled={busy}
          />
        </label>

        <div className="grid gap-6 lg:grid-cols-2">
          <label className="block space-y-2 text-sm">
            <span className="flex items-center gap-2 font-medium">
              目标客户
              <FieldSource
                field="target_audiences"
                overriddenFields={profile?.userOverriddenFields ?? []}
              />
            </span>
            <Textarea
              aria-label="目标客户"
              value={targetAudiences}
              onChange={(event) => setTargetAudiences(event.target.value)}
              className="min-h-40 resize-y"
              disabled={busy}
            />
          </label>

          <label className="block space-y-2 text-sm">
            <span className="flex items-center gap-2 font-medium">
              产品与服务
              <FieldSource
                field="products_services"
                overriddenFields={profile?.userOverriddenFields ?? []}
              />
            </span>
            <Textarea
              aria-label="产品与服务"
              value={productsServices}
              onChange={(event) => setProductsServices(event.target.value)}
              className="min-h-40 resize-y"
              disabled={busy}
            />
          </label>
        </div>

        <label className="block space-y-2 text-sm">
          <span className="flex items-center gap-2 font-medium">
            客户为什么选择您
            <FieldSource
              field="value_propositions"
              overriddenFields={profile?.userOverriddenFields ?? []}
            />
          </span>
          <Textarea
            aria-label="客户为什么选择您"
            value={valuePropositions}
            onChange={(event) => setValuePropositions(event.target.value)}
            className="min-h-36 resize-y"
            disabled={busy}
          />
        </label>
      </section>

      {profile && profile.evidence.length > 0 && (
        <section className="space-y-3 border-b py-8">
          <h2 className="text-lg font-semibold">资料依据</h2>
          <div className="divide-y border-y">
            {profile.evidence.map((item, index) => (
              <details
                key={`${item.field}-${item.value}-${item.sourceUrl}-${index}`}
                className="group"
              >
                <summary className="grid cursor-pointer list-none grid-cols-[minmax(96px,0.35fr)_minmax(0,1fr)_20px] items-center gap-3 py-3 text-sm [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 font-medium break-words">
                    {profileFieldLabels[item.field] ?? item.field}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {item.value}
                  </span>
                  <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-3 pb-4 pl-0 text-sm sm:pl-[calc(35%+12px)]">
                  {item.quote && (
                    <blockquote className="border-l-2 pl-3 leading-6 text-foreground">
                      {item.quote}
                    </blockquote>
                  )}
                  <a
                    href={item.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex max-w-full items-center gap-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <span className="truncate">{item.sourceUrl}</span>
                    <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-4 pt-8">
        <div>
          <h2 className="text-lg font-semibold">内容要求</h2>
        </div>
        <Textarea
          aria-label="内容要求"
          value={aiContentRules}
          onChange={(event) => setAiContentRules(event.target.value)}
          className="min-h-44 resize-y"
          disabled={busy}
        />
      </section>

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t pt-6">
        <Button
          type="submit"
          disabled={busy || !businessName.trim() || !businessType.trim()}
        >
          {saving ? (
            <LoaderCircle className="animate-spin" />
          ) : saved ? (
            <Check />
          ) : null}
          {saving ? "保存中..." : saved ? "已保存" : submitLabel}
        </Button>
        {onRefresh && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={handleRefresh}
          >
            {refreshing || startingRefresh ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {refreshing || startingRefresh ? "正在重新识别" : "重新识别"}
          </Button>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-semibold">识别记录</h2>
        {historyLoading ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取
          </div>
        ) : history.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">暂无识别记录</p>
        ) : (
          <div className="mt-3 divide-y border-y">
            {history.map((run) => (
              <div
                key={run.runId}
                className="grid gap-1 py-3 text-sm sm:grid-cols-[88px_96px_88px_1fr] sm:items-center sm:gap-3"
              >
                <span className="font-medium">第 {run.attempt} 次</span>
                <span>{recognitionStatusLabels[run.status]}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatElapsed(run.elapsedSeconds)}
                </span>
                <span className="truncate text-muted-foreground">
                  {run.message || "无补充说明"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </form>
  )
}
