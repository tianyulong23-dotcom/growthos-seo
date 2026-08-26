import * as React from "react"
import { ArrowRight, LoaderCircle, RefreshCw } from "lucide-react"
import { useNavigate } from "react-router"

import { ApiError } from "@/api/client"
import {
  confirmPromotionTarget,
  getProjectOutreachReadiness,
} from "@/api/projects"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { OutreachProject } from "@/features/outreach/project"
import type {
  ProjectOutreachReadinessState,
  PromotionTargetVersion,
} from "@/features/projects/types"

import { getRecommendationInventory } from "./api"

const FORM_ACTIONS = new Set([
  "PUBLISH_PROMOTION_TARGET",
  "ADD_PROMOTION_TOPIC_OR_PUBLISHED_TARGET",
  "REPUBLISH_PROMOTION_TARGET",
])
const CORE_PROJECTION_ATTEMPTS = 20

function lines(value: string) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。"
}

export function RecommendationProjectGate({
  project,
  children,
}: {
  project: OutreachProject
  children: (readyProject: OutreachProject) => React.ReactNode
}) {
  const navigate = useNavigate()
  const [readiness, setReadiness] =
    React.useState<ProjectOutreachReadinessState | null>(null)
  const [readinessError, setReadinessError] = React.useState<string | null>(null)
  const [topics, setTopics] = React.useState(
    project.suggestedTopics.slice(0, 5).join("\n")
  )
  const [targetUrls, setTargetUrls] = React.useState(
    project.suggestedTargetUrls.join("\n")
  )
  const [formError, setFormError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [confirmedTarget, setConfirmedTarget] =
    React.useState<PromotionTargetVersion | null>(null)
  const [reloadVersion, setReloadVersion] = React.useState(0)
  const [coreStatus, setCoreStatus] = React.useState<
    "idle" | "checking" | "syncing" | "ready" | "error"
  >("idle")
  const [coreError, setCoreError] = React.useState<string | null>(null)
  const [coreRetryVersion, setCoreRetryVersion] = React.useState(0)

  React.useEffect(() => {
    const controller = new AbortController()

    getProjectOutreachReadiness(project.id, controller.signal)
      .then((result) => {
        setReadiness(result)
        setReadinessError(null)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setReadiness(null)
          setReadinessError(errorMessage(error))
        }
      })

    return () => controller.abort()
  }, [project.id, reloadVersion])

  React.useEffect(() => {
    if (readiness?.status !== "REFRESHING") return
    const timer = window.setTimeout(
      () => setReloadVersion((current) => current + 1),
      2_000
    )
    return () => window.clearTimeout(timer)
  }, [readiness?.fingerprint, readiness?.status])

  React.useEffect(() => {
    if (readiness?.status !== "READY") return

    let cancelled = false
    let timer: number | undefined
    let controller: AbortController | null = null

    const verifyProjection = async (attempt: number) => {
      controller = new AbortController()
      setCoreStatus(attempt === 0 ? "checking" : "syncing")
      setCoreError(null)
      try {
        await getRecommendationInventory(project.id, controller.signal)
        if (!cancelled) setCoreStatus("ready")
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        if (
          error instanceof ApiError &&
          error.status === 404 &&
          attempt + 1 < CORE_PROJECTION_ATTEMPTS
        ) {
          timer = window.setTimeout(
            () => void verifyProjection(attempt + 1),
            1_500
          )
          return
        }
        setCoreStatus("error")
        setCoreError(
          error instanceof ApiError && error.status === 404
            ? "推广目标已保存，但后台 Dispatcher 尚未把当前项目接入推荐服务。请确认 API、Worker 和 Dispatcher 正常后重试。"
            : errorMessage(error)
        )
      }
    }

    void verifyProjection(0)
    return () => {
      cancelled = true
      controller?.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [coreRetryVersion, project.id, readiness?.fingerprint, readiness?.status])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const confirmedTopics = lines(topics)
    const confirmedTargetUrls = lines(targetUrls)
    if (!confirmedTopics.length && !confirmedTargetUrls.length) {
      setFormError("请至少填写一个推广主题或一个推广目标页。")
      return
    }
    if (!readiness) return

    setSubmitting(true)
    setFormError(null)
    try {
      const result = await confirmPromotionTarget(project.id, {
        confirmedTopics,
        confirmedTargetUrls,
        expectedProjectContextVersion: project.contextVersion,
        expectedSiteProfileVersionId: readiness.siteProfileVersionId,
      })
      setConfirmedTarget(result)
      setReadiness(null)
      setReloadVersion((current) => current + 1)
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 409
          ? `${error.message} 请刷新当前项目后重新确认。`
          : errorMessage(error)
      setFormError(message)
    } finally {
      setSubmitting(false)
    }
  }

  if (readinessError) {
    return (
      <GateState
        title="无法读取外链准备状态"
        description={readinessError}
        actionLabel="重新读取"
        onAction={() => {
          setReadinessError(null)
          setReloadVersion((current) => current + 1)
        }}
      />
    )
  }

  if (!readiness) {
    return (
      <GateState
        busy
        title={
          confirmedTarget ? "推广目标已保存，正在接通推荐池" : "正在检查项目资料"
        }
        description="正在读取当前项目的正式推广目标和后台接入状态。"
      />
    )
  }

  if (
    readiness.status !== "READY" &&
    FORM_ACTIONS.has(readiness.primaryRecoveryAction)
  ) {
    return (
      <section className="border-y border-border bg-background px-5 py-8 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6">
            <h2 className="text-base font-semibold">设置本次外链推广目标</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              确认需要推广的主题和站内页面。保存后，系统会自动接通推荐发现和联系方式后处理。
            </p>
          </div>

          <form className="space-y-5" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="promotion-topics">推广关键词或主题</Label>
              <Textarea
                id="promotion-topics"
                className="min-h-28 resize-y rounded-md border-border bg-background"
                value={topics}
                onChange={(event) => setTopics(event.target.value)}
                placeholder="例如：激光电视评测&#10;家庭影院投影方案"
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                每行一个。已从项目资料带出候选内容，请确认或修改。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="promotion-target-urls">
                需要推广的产品页、文章页或落地页
              </Label>
              <Textarea
                id="promotion-target-urls"
                className="min-h-28 resize-y rounded-md border-border bg-background"
                value={targetUrls}
                onChange={(event) => setTargetUrls(event.target.value)}
                placeholder={`https://${project.domain}/your-product-page`}
                disabled={submitting}
                aria-invalid={Boolean(formError) || undefined}
              />
              <p className="text-xs text-muted-foreground">
                每行一个，必须属于 {project.domain} 或其子域名。建议主题和目标页都填写。
              </p>
            </div>

            {formError ? (
              <p className="text-sm text-destructive" role="alert">
                {formError}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                className="rounded-md"
                disabled={submitting}
              >
                {submitting ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <ArrowRight />
                )}
                保存并生成推荐
              </Button>
              <span className="text-xs text-muted-foreground">
                保存不会自动发送 Gmail 邮件。
              </span>
            </div>
          </form>
        </div>
      </section>
    )
  }

  if (readiness.status === "REFRESHING") {
    return (
      <GateState
        busy
        title="项目资料正在更新"
        description="更新完成后会自动继续检查推广目标，无需等待网站审计完成。"
      />
    )
  }

  if (readiness.status !== "READY") {
    return (
      <GateState
        title="当前项目资料还不能启动推荐"
        description={`仍需处理：${readiness.inputRequired.join("、") || "项目资料不完整"}`}
        actionLabel="前往项目资料"
        onAction={() => navigate(`/projects/${project.id}/settings/profile`)}
      />
    )
  }

  if (coreStatus === "checking" || coreStatus === "syncing") {
    return (
      <GateState
        busy
        title="正在接通推荐池"
        description="推广目标已就绪，后台正在同步项目并创建受预算控制的推荐任务。"
      />
    )
  }

  if (coreStatus === "error") {
    return (
      <GateState
        title="推荐后台尚未接通"
        description={coreError ?? "无法确认推荐后台状态。"}
        actionLabel="重新检查"
        onAction={() => {
          setCoreStatus("checking")
          setCoreError(null)
          setCoreRetryVersion((current) => current + 1)
        }}
      />
    )
  }

  if (coreStatus !== "ready") {
    return (
      <GateState
        busy
        title="正在检查推荐后台"
        description="正在确认当前项目已进入 Backlinks Core。"
      />
    )
  }

  const readyProject = confirmedTarget
    ? {
        ...project,
        targetUrls: confirmedTarget.targetUrls.length
          ? confirmedTarget.targetUrls
          : project.targetUrls,
        suggestedTopics: confirmedTarget.keywords,
      }
    : project
  return children(readyProject)
}

function GateState({
  title,
  description,
  busy = false,
  actionLabel,
  onAction,
}: {
  title: string
  description: string
  busy?: boolean
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <section
      className="flex min-h-48 flex-col items-center justify-center border-y border-border bg-muted/20 px-5 py-10 text-center"
      aria-live={busy ? "polite" : "assertive"}
      role={busy ? "status" : "alert"}
    >
      {busy ? (
        <LoaderCircle className="mb-3 size-5 animate-spin text-muted-foreground" />
      ) : (
        <RefreshCw className="mb-3 size-5 text-muted-foreground" />
      )}
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
        {description}
      </p>
      {actionLabel && onAction ? (
        <Button
          className="mt-4 rounded-md"
          size="sm"
          variant="outline"
          onClick={onAction}
        >
          <RefreshCw />
          {actionLabel}
        </Button>
      ) : null}
    </section>
  )
}
