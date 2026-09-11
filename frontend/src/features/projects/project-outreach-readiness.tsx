import * as React from "react"
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  RefreshCw,
} from "lucide-react"
import { useNavigate } from "react-router"

import { getProjectOutreachReadiness } from "@/api/projects"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  ProjectOutreachReadinessState,
  ProjectOutreachRecoveryAction,
} from "@/features/projects/types"

type ProjectOutreachReadinessProps = {
  projectId: string
}

const inputLabels: Record<string, string> = {
  "PROJECTS:restore_project": "项目已归档",
  "PROJECTS:complete_site_profile": "网站业务资料尚未完成",
  "PROJECTS:confirm_business_profile": "业务资料尚未确认",
  "PROJECTS:set_project_language_market": "国家、市场或语言信息不完整",
  "WEBSITE_PROJECT:publish_promotion_target": "缺少推广主题或已发布目标页",
  "WEBSITE_PROJECT:add_promotion_topic_or_publish_target":
    "缺少推广主题或已发布目标页",
  "WEBSITE_PROJECT:republish_promotion_target":
    "业务资料已更新，需要重新发布推广目标",
}

const statusConfig = {
  READY: {
    label: "已就绪",
    description: "当前项目资料和推广目标已形成一致的版本快照。",
    icon: CheckCircle2,
    badge: "secondary" as const,
  },
  INPUT_REQUIRED: {
    label: "需要补充",
    description: "补齐下列项目事实后才能形成可用的外链上下文。",
    icon: AlertCircle,
    badge: "outline" as const,
  },
  REFRESHING: {
    label: "更新中",
    description: "网站业务资料正在更新，当前读取不会发布新版本。",
    icon: RefreshCw,
    badge: "outline" as const,
  },
  STALE: {
    label: "需要重发",
    description: "Site Profile 已变化，当前推广目标不再匹配最新资料。",
    icon: Clock3,
    badge: "destructive" as const,
  },
}

function actionLabel(action: ProjectOutreachRecoveryAction): string | null {
  if (action === "OPEN_RECOMMENDATIONS") return "打开推荐池"
  if (
    action === "PUBLISH_PROMOTION_TARGET" ||
    action === "ADD_PROMOTION_TOPIC_OR_PUBLISHED_TARGET" ||
    action === "REPUBLISH_PROMOTION_TARGET"
  ) {
    return "前往准备推广主题"
  }
  if (
    action === "COMPLETE_SITE_PROFILE" ||
    action === "CONFIRM_BUSINESS_PROFILE" ||
    action === "SET_PROJECT_LANGUAGE_MARKET" ||
    action === "REVIEW_PROJECT_INPUTS"
  ) {
    return "检查业务资料"
  }
  return null
}

function VersionValue({ value }: { value: string | null }) {
  return (
    <dd className="mt-1 truncate font-mono text-xs text-foreground">
      {value ?? "未发布"}
    </dd>
  )
}

export function ProjectOutreachReadiness({
  projectId,
}: ProjectOutreachReadinessProps) {
  const navigate = useNavigate()
  const [readiness, setReadiness] =
    React.useState<ProjectOutreachReadinessState | null>(null)
  const [loadedProjectId, setLoadedProjectId] = React.useState<string | null>(
    null
  )
  const [error, setError] = React.useState("")
  const [reloadKey, setReloadKey] = React.useState(0)
  const currentReadiness = loadedProjectId === projectId ? readiness : null

  React.useEffect(() => {
    const controller = new AbortController()
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setError("")
      setLoadedProjectId(null)
      void getProjectOutreachReadiness(projectId, controller.signal)
        .then((response) => {
          if (!active) return
          if (response.websiteProjectId !== projectId) {
            setError("项目准备度响应与当前项目不一致")
            return
          }
          setReadiness(response)
          setLoadedProjectId(projectId)
        })
        .catch((requestError: unknown) => {
          if (!active || controller.signal.aborted) return
          setError(
            requestError instanceof Error
              ? requestError.message
              : "无法读取项目准备度"
          )
        })
    })

    return () => {
      active = false
      controller.abort()
    }
  }, [projectId, reloadKey])

  const runPrimaryAction = React.useCallback(() => {
    if (!currentReadiness) return
    const action = currentReadiness.primaryRecoveryAction
    if (action === "OPEN_RECOMMENDATIONS") {
      navigate(`/projects/${projectId}/backlinks/recommendations`)
      return
    }
    if (
      action === "PUBLISH_PROMOTION_TARGET" ||
      action === "ADD_PROMOTION_TOPIC_OR_PUBLISHED_TARGET" ||
      action === "REPUBLISH_PROMOTION_TARGET"
    ) {
      navigate(`/projects/${projectId}/keywords/list`)
      return
    }
    document
      .getElementById("business-profile-settings")
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [currentReadiness, navigate, projectId])

  if (error) {
    return (
      <section className="max-w-2xl border-b py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-medium">外链准备度</h2>
            <p className="mt-1 text-sm text-destructive">{error}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            <RefreshCw data-icon="inline-start" />
            重试
          </Button>
        </div>
      </section>
    )
  }

  if (!currentReadiness) {
    return (
      <section className="max-w-2xl border-b py-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" />
          正在读取外链准备度
        </div>
      </section>
    )
  }

  const config = statusConfig[currentReadiness.status]
  const StatusIcon = config.icon
  const primaryLabel = actionLabel(currentReadiness.primaryRecoveryAction)

  return (
    <section className="w-full border-t py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusIcon
              className={`size-4 ${
                currentReadiness.status === "REFRESHING" ? "animate-spin" : ""
              }`}
            />
            <h2 className="font-medium">外链准备度</h2>
            <Badge variant={config.badge}>{config.label}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {config.description}
          </p>
        </div>
        {primaryLabel ? (
          <Button
            type="button"
            size="sm"
            variant={
              currentReadiness.status === "READY" ? "default" : "outline"
            }
            onClick={runPrimaryAction}
          >
            {primaryLabel}
            <ArrowRight data-icon="inline-end" />
          </Button>
        ) : null}
      </div>

      {currentReadiness.inputRequired.length ? (
        <ul className="mt-4 space-y-1.5 text-sm">
          {currentReadiness.inputRequired.map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span className="mt-2 size-1 rounded-full bg-muted-foreground" />
              <span>{inputLabels[item] ?? item}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <details className="mt-4 text-sm text-muted-foreground">
        <summary className="w-fit cursor-pointer">版本详情</summary>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">网站资料版本</dt>
            <VersionValue value={currentReadiness.siteProfileVersionId} />
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">外联资料版本</dt>
            <VersionValue value={currentReadiness.outreachProfileVersionId} />
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">推广目标版本</dt>
            <VersionValue value={currentReadiness.promotionTargetVersionId} />
          </div>
        </dl>
        <p className="mt-3 font-mono text-[11px] break-all text-muted-foreground">
          {currentReadiness.fingerprint}
        </p>
      </details>
    </section>
  )
}
