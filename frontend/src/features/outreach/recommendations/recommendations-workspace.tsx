import * as React from "react"
import {
  CirclePlus,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Mail,
  RefreshCw,
  Search,
} from "lucide-react"
import { useNavigate } from "react-router"

import {
  type Project,
  useCurrentProject,
} from "@/app/project-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { backlinksProjectQueries } from "@/features/outreach/api/project-query"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

import {
  createOpportunity,
  getRecommendationInventory,
  retryUnpublishedContacts,
  type RecommendationInventoryStatus,
  type RecommendationItem,
} from "./api"
import {
  type RecommendationRefillState,
  useRecommendationRefill,
} from "./use-recommendation-refill"
import { useRecommendations } from "./use-recommendations"

const reasonLabels: Record<string, string> = {
  PUBLIC_EMAIL_FOUND: "公开邮箱已验证",
  CONTACT_FORM_ONLY: "仅发现联系表单",
  LOGIN_REQUIRED: "页面需要登录",
  CAPTCHA_OR_BOT_CHALLENGE: "触发人机验证",
  ROBOTS_DISALLOWED: "站点禁止自动访问",
  ACCESS_DENIED: "页面拒绝访问",
  NO_PUBLIC_EMAIL: "未发现公开邮箱",
  SITE_UNREACHABLE: "站点无法访问",
  UNSUPPORTED_CONTENT: "页面内容暂不支持",
  MANUAL_REVIEW_REQUIRED: "需要人工复核",
  COMPLETED_PARTIAL: "部分页面已完成",
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function metric(value: number | null) {
  return value === null ? "待补" : value.toFixed(1)
}

function formatElapsed(value: number) {
  const seconds = Math.max(0, Math.floor(value / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}分 ${remainder}秒` : `${remainder}秒`
}

function formatQueryTime(value: number | null) {
  if (value === null) return "尚未查询"
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function ContactBatchWaitView({
  project,
  wait,
  batch,
  error,
  retrying,
  onStart,
  onRetry,
  onRefresh,
}: {
  project: Project
  wait: RecommendationRefillState
  batch: RecommendationInventoryStatus["contactBatch"]
  error: string | null
  retrying: boolean
  onStart: () => void
  onRetry: () => void
  onRefresh: () => void
}) {
  const running = wait.status === "running"
  return (
    <div
      className="flex min-h-64 flex-col items-center justify-center border-y bg-muted/20 px-4 py-8 text-center"
      role={wait.status === "failed" ? "alert" : "status"}
      aria-busy={running || undefined}
    >
      {running ? (
        <LoaderCircle className="mb-3 size-5 animate-spin text-muted-foreground" />
      ) : (
        <Clock3 className="mb-3 size-5 text-muted-foreground" />
      )}
      <h2 className="text-sm font-medium">当前没有已发布的可联系推荐</h2>
      <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
        {project.name} 的候选网站会自动进入联系人发现批次。这里只显示具备公开证据、
        已冻结默认联系人并通过发布门禁的网站。
      </p>
      {wait.status !== "idle" && (
        <div className="mt-5 grid w-full max-w-2xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
          {[
            ["阶段", wait.phase],
            ["已耗时", formatElapsed(wait.elapsedMs)],
            ["轮询次数", String(wait.pollCount)],
            ["最后查询", formatQueryTime(wait.lastQueryAt)],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 border-l-2 pl-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 truncate text-sm font-medium">{value}</div>
            </div>
          ))}
        </div>
      )}
      {batch !== null && (
        <>
          <div className="mt-5 grid w-full max-w-2xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
            {[
              ["候选网站", batch.totalJobCount],
              ["已发布", batch.publishedCount],
              ["未发布", batch.unpublishedCount],
              ["已终态", `${batch.terminalJobCount}/${batch.totalJobCount}`],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 border-l-2 pl-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-sm font-medium">{value}</div>
              </div>
            ))}
          </div>
          {batch.reasonCounts.length > 0 && (
            <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
              {batch.reasonCounts.map((reason) => (
                <Badge key={reason.reasonCode} variant="outline">
                  {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
                  {reason.count}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
      {(wait.error || error) && (
        <p className="mt-4 text-sm text-destructive">
          {wait.error ?? error}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onStart} disabled={running}>
          {running ? <LoaderCircle className="animate-spin" /> : <Clock3 />}
          等待本批可联系推荐
        </Button>
        <Button variant="outline" onClick={onRefresh}>
          <RefreshCw />
          重新读取
        </Button>
        {batch !== null && batch.retryableUnpublishedCount > 0 && (
          <Button variant="outline" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={retrying ? "animate-spin" : undefined} />
            仅重试未发布
          </Button>
        )}
      </div>
    </div>
  )
}

function WebsiteIdentity({ item }: { item: RecommendationItem }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-xs font-semibold">
        {item.hostname.slice(0, 1).toUpperCase()}
        <img
          src={item.faviconUrl}
          alt=""
          className="absolute inset-0 size-full bg-background object-contain p-1.5"
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
        />
      </span>
      <div className="min-w-0">
        <a
          href={item.rootUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1 font-medium hover:underline"
        >
          <span className="truncate">{item.hostname}</span>
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {item.rootUrl}
        </div>
      </div>
    </div>
  )
}

function ProjectRecommendationsWorkspace({
  project,
}: {
  project: Project
}) {
  const websiteProjectKey = project.id
  const navigate = useNavigate()
  const query = useRecommendations(websiteProjectKey, true)
  const refreshRecommendations = query.refresh
  const pollInventory = React.useCallback(async () => {
    try {
      return await getRecommendationInventory(
        websiteProjectKey,
        AbortSignal.timeout(10_000)
      )
    } catch {
      return null
    }
  }, [websiteProjectKey])
  const wait = useRecommendationRefill(project, pollInventory)
  const [inventory, setInventory] =
    React.useState<Awaited<ReturnType<typeof pollInventory>>>(null)
  const [search, setSearch] = React.useState("")
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [retrying, setRetrying] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refreshAll = React.useCallback(async () => {
    const [, nextInventory] = await Promise.all([
      refreshRecommendations(),
      pollInventory(),
    ])
    setInventory(nextInventory)
  }, [pollInventory, refreshRecommendations])

  React.useEffect(() => {
    void pollInventory().then(setInventory)
  }, [pollInventory])

  React.useEffect(() => {
    if (wait.status !== "succeeded") return
    let active = true
    queueMicrotask(() => {
      if (active) void refreshAll()
    })
    return () => {
      active = false
    }
  }, [refreshAll, wait.status])

  async function retryUnpublished() {
    if (retrying) return
    setRetrying(true)
    setError(null)
    try {
      const result = await retryUnpublishedContacts(websiteProjectKey)
      wait.start(result.batchId)
    } catch {
      setError("未能重试本批未发布网站，请重新读取批次状态。")
    } finally {
      setRetrying(false)
    }
  }

  async function addOpportunity(item: RecommendationItem) {
    const contact = item.contacts.find(
      (candidate) =>
        candidate.id === item.recommendedContactCandidateId &&
        candidate.eligible
    )
    if (!contact || busyId) return
    setBusyId(item.id)
    setError(null)
    try {
      const result = await createOpportunity(
        websiteProjectKey,
        item.id,
        contact.id,
        item.version
      )
      if (result.websiteProjectId !== result.meta.websiteProjectId) {
        throw new Error("Opportunity project identity mismatch")
      }
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "recommendations",
      ])
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "opportunities",
      ])
      navigate(
        `/projects/${websiteProjectKey}/backlinks/opportunities?opportunityId=${result.opportunityId}`
      )
    } catch {
      setError("创建 Opportunity 失败。请刷新推荐，确认冻结联系人证据仍有效。")
    } finally {
      setBusyId(null)
    }
  }

  if (query.status === "loading") {
    return <OutreachStandardStateView state="loading" title="正在加载推荐池" />
  }
  if (query.status === "empty") {
    if (project.inputRequired.length > 0) {
      return (
        <OutreachStandardStateView
          state="empty"
          title="先完善当前项目资料"
          description={`缺少 ${project.inputRequired.join("、")}，服务端不会使用其他项目资料代替。`}
          onRetry={() =>
            navigate(`/projects/${websiteProjectKey}/settings/profile`)
          }
          retryLabel="完善项目资料"
        />
      )
    }
    return (
      <ContactBatchWaitView
        project={project}
        wait={wait}
        batch={wait.batch ?? inventory?.contactBatch ?? null}
        error={error}
        retrying={retrying}
        onStart={() => wait.start()}
        onRetry={() => void retryUnpublished()}
        onRefresh={() => void refreshAll()}
      />
    )
  }
  if (query.status !== "data") {
    return (
      <OutreachStandardStateView
        state={query.status}
        title={
          query.status === "forbidden"
            ? "当前账号无权查看该项目的推荐"
            : query.status === "offline"
              ? "推荐池当前离线"
              : "推荐池加载失败"
        }
        description="不会回退到演示数据或其他项目数据。"
        onRetry={() => void refreshAll()}
        retryLabel="重新读取"
      />
    )
  }

  const batch = wait.batch ?? inventory?.contactBatch ?? null
  const rows = query.items.filter((item) =>
    item.hostname.toLowerCase().includes(search.trim().toLowerCase())
  )

  return (
    <div>
      {wait.status !== "idle" && (
        <div
          className="mb-4 border-l-2 border-primary bg-muted/30 px-4 py-3 text-sm"
          role="status"
          aria-busy={wait.status === "running" || undefined}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium">
              {wait.status === "running" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Clock3 className="size-4" />
              )}
              {wait.phase}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              已耗时 {formatElapsed(wait.elapsedMs)} · 轮询 {wait.pollCount} 次 ·
              最后查询 {formatQueryTime(wait.lastQueryAt)}
            </div>
            {wait.error && (
              <div className="mt-1 text-xs text-destructive">{wait.error}</div>
            )}
          </div>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["可联系推荐", query.items.length],
          ["本批已发布", batch?.publishedCount ?? query.items.length],
          ["本批未发布", batch?.unpublishedCount ?? 0],
          [
            "本批终态",
            batch === null
              ? "待读取"
              : `${batch.terminalJobCount}/${batch.totalJobCount}`,
          ],
        ].map(([label, value]) => (
          <Card key={label} size="sm">
            <CardContent>
              <div className="text-sm text-muted-foreground">{label}</div>
              <div className="mt-2 text-2xl font-semibold">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground">当前项目</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="space-y-3 border-b p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索已发布网站..."
                className="pl-9 sm:max-w-sm"
              />
            </div>
            <Button onClick={() => wait.start()} disabled={wait.status === "running"}>
              {wait.status === "running" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Clock3 />
              )}
              等待本批可联系推荐
            </Button>
            {batch !== null && batch.retryableUnpublishedCount > 0 && (
              <Button
                variant="outline"
                onClick={() => void retryUnpublished()}
                disabled={retrying}
              >
                <RefreshCw className={retrying ? "animate-spin" : undefined} />
                仅重试未发布
              </Button>
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={() => void refreshAll()}
              title="重新读取"
              aria-label="重新读取"
            >
              <RefreshCw />
            </Button>
          </div>
          {batch !== null && batch.reasonCounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {batch.reasonCounts.map((reason) => (
                <Badge key={reason.reasonCode} variant="outline">
                  {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
                  {reason.count}
                </Badge>
              ))}
            </div>
          )}
          {error && (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="divide-y">
          {rows.map((item) => {
            const contact = item.contacts.find(
              (candidate) =>
                candidate.id === item.recommendedContactCandidateId &&
                candidate.eligible
            )
            const evidence = contact?.evidence[0]
            const isBusy = busyId === item.id
            return (
              <article
                key={item.id}
                className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(15rem,0.9fr)_minmax(16rem,1fr)]"
              >
                <section className="min-w-0 space-y-3">
                  <WebsiteIdentity item={item} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">评分 {item.score}</Badge>
                    <Badge>公开邮箱已验证</Badge>
                    <span className="text-xs text-muted-foreground">
                      获取于 {formatDate(item.acquiredAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.matchReasons.map((reason) => (
                      <Badge key={reason} variant="outline">
                        {reason}
                      </Badge>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">权威</span>
                      <div className="mt-1 font-medium">
                        {metric(item.seoMetrics.authority)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">编辑质量</span>
                      <div className="mt-1 font-medium">
                        {metric(item.seoMetrics.editorialQuality)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">技术健康</span>
                      <div className="mt-1 font-medium">
                        {metric(item.seoMetrics.technicalHealth)}
                      </div>
                    </div>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    来源：{item.dataSources.join("、") || "待补"}
                  </div>
                </section>

                <section className="min-w-0 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Mail className="size-4" />
                    冻结默认联系人
                  </div>
                  {contact && evidence ? (
                    <div className="space-y-2 rounded-md border p-3 text-xs">
                      <div className="font-medium break-all">
                        {contact.normalizedEmail}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                        <span>用途 {contact.inferredPurpose}</span>
                        <span>联系人置信度 {contact.confidence}</span>
                        <span>用途置信度 {contact.purposeConfidence}</span>
                      </div>
                      <a
                        href={evidence.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                      >
                        <span className="truncate">
                          查看公开证据 · {evidence.extractionMethod}
                        </span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    </div>
                  ) : (
                    <p className="text-sm text-destructive">
                      已发布记录缺少冻结联系人证据，请刷新后重试。
                    </p>
                  )}
                </section>

                <section className="flex min-w-0 flex-col justify-between gap-4">
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <div>
                      已访问 {item.contactJob?.pagesVisited ?? 0} 页，证据{" "}
                      {item.contactJob?.evidenceCount ?? 0} 条
                    </div>
                    <div>
                      方法 {item.contactJob?.method ?? "none"} · 终态{" "}
                      {item.contactJob?.terminalReasonCode ?? "待同步"}
                    </div>
                    {item.createBlockReason === "existing_opportunity" && (
                      <div>该域名已在当前项目的 Opportunity 中。</div>
                    )}
                  </div>
                  {item.existingOpportunityId ? (
                    <Button
                      onClick={() =>
                        navigate(
                          `/projects/${websiteProjectKey}/backlinks/opportunities?opportunityId=${item.existingOpportunityId}`
                        )
                      }
                    >
                      打开 Opportunity
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void addOpportunity(item)}
                      disabled={
                        Boolean(busyId) ||
                        !item.canCreateOpportunity ||
                        !contact
                      }
                    >
                      {isBusy ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <CirclePlus />
                      )}
                      加入 Opportunity
                    </Button>
                  )}
                </section>
              </article>
            )
          })}
          {rows.length === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              当前搜索条件下没有已发布网站。
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

export function RecommendationsWorkspace({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const { currentProject } = useCurrentProject()
  if (!currentProject || currentProject.id !== websiteProjectKey) {
    return (
      <OutreachStandardStateView
        state="forbidden"
        title="当前项目上下文不可用"
        description="页面不会读取或提交其他 Website Project 的推荐任务。"
      />
    )
  }
  return (
    <ProjectRecommendationsWorkspace
      key={`${currentProject.id}:${currentProject.profileVersionId}:${currentProject.contextVersion}`}
      project={currentProject}
    />
  )
}
