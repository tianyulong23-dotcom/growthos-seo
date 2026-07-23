import * as React from "react"
import { Check, LoaderCircle, RefreshCw } from "lucide-react"

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
          <span className="font-medium">企业 / 品牌名称</span>
          <Input
            value={businessName}
            onChange={(event) => setBusinessName(event.target.value)}
            disabled={busy}
            required
          />
        </label>

        <label className="block space-y-2 text-sm">
          <span className="font-medium">公司简介</span>
          <Textarea
            value={businessSummary}
            onChange={(event) => setBusinessSummary(event.target.value)}
            className="min-h-28 resize-y"
            disabled={busy}
          />
        </label>

        <div className="grid gap-6 lg:grid-cols-2">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">目标客户</span>
            <Textarea
              value={targetAudiences}
              onChange={(event) => setTargetAudiences(event.target.value)}
              className="min-h-40 resize-y"
              disabled={busy}
            />
          </label>

          <label className="block space-y-2 text-sm">
            <span className="font-medium">产品与服务</span>
            <Textarea
              value={productsServices}
              onChange={(event) => setProductsServices(event.target.value)}
              className="min-h-40 resize-y"
              disabled={busy}
            />
          </label>
        </div>

        <label className="block space-y-2 text-sm">
          <span className="font-medium">客户为什么选择您</span>
          <Textarea
            value={valuePropositions}
            onChange={(event) => setValuePropositions(event.target.value)}
            className="min-h-36 resize-y"
            disabled={busy}
          />
        </label>
      </section>

      <section className="space-y-4 pt-8">
        <div>
          <h2 className="text-lg font-semibold">AI 内容规则</h2>
        </div>
        <Textarea
          aria-label="AI 内容规则"
          value={aiContentRules}
          onChange={(event) => setAiContentRules(event.target.value)}
          className="min-h-44 resize-y"
          disabled={busy}
        />
      </section>

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t pt-6">
        <Button type="submit" disabled={busy || !businessName.trim()}>
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
