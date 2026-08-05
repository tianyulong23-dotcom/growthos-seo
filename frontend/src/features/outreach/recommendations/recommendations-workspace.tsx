import * as React from "react"
import {
  CirclePlus,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Mail,
  RefreshCw,
  ScanSearch,
  Search,
  Sparkles,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { backlinksProjectQueries } from "@/features/outreach/api/project-query"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

import {
  addPublicContactCandidate,
  createOpportunity,
  getContactEnrichmentJob,
  retryContactEnrichment,
  startContactEnrichment,
  type ContactEnrichmentJob,
  type PublicContactRole,
  type RecommendationItem,
} from "./api"
import {
  type RecommendationRefillState,
  useRecommendationRefill,
} from "./use-recommendation-refill"
import { useRecommendations } from "./use-recommendations"

type ContactFilter = "all" | RecommendationItem["contactStatus"]

const activeJobStatuses = new Set<ContactEnrichmentJob["status"]>([
  "pending",
  "running",
  "retry_scheduled",
])

const contactStatusMeta: Record<
  RecommendationItem["contactStatus"],
  {
    label: string
    variant: "default" | "secondary" | "outline" | "destructive"
  }
> = {
  contactable: { label: "可联系", variant: "default" },
  running: { label: "抓取中", variant: "secondary" },
  review: { label: "需复核", variant: "outline" },
  not_found: { label: "暂无联系人", variant: "destructive" },
}

const roleLabels: Record<PublicContactRole, string> = {
  press: "媒体",
  editorial: "编辑",
  partnerships: "合作",
  advertising: "广告",
  support: "支持",
  general: "通用",
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

function RecommendationRefillView({
  project,
  refill,
  onStart,
  onRefresh,
}: {
  project: Project
  refill: RecommendationRefillState
  onStart: () => void
  onRefresh: () => void
}) {
  const running = refill.status === "running"
  const canStart = ["idle", "failed", "timed_out"].includes(refill.status)
  const title =
    refill.status === "idle"
      ? "当前项目还没有推荐网站"
      : refill.status === "failed"
        ? "推荐补池任务未提交"
        : refill.status === "timed_out"
          ? "推荐补池仍未返回足够结果"
          : `正在为 ${project.name} 生成推荐`

  return (
    <div
      className="flex min-h-64 flex-col items-center justify-center border-y bg-muted/20 px-4 py-8 text-center"
      role={refill.status === "failed" ? "alert" : "status"}
      aria-busy={running || undefined}
    >
      {running ? (
        <LoaderCircle className="mb-3 size-5 animate-spin text-muted-foreground" />
      ) : (
        <Sparkles className="mb-3 size-5 text-muted-foreground" />
      )}
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
        将依据 {project.domain}、{project.targetMarket}、
        {project.keywords.join("、")} 与当前项目产品资料生成个性化外链网站。
        页面刷新只恢复同一任务，不会重新提交 Provider 调用。
      </p>
      {refill.status !== "idle" && (
        <div className="mt-5 grid w-full max-w-2xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
          {[
            ["阶段", refill.phase],
            ["已耗时", formatElapsed(refill.elapsedMs)],
            ["轮询次数", String(refill.pollCount)],
            ["最后查询", formatQueryTime(refill.lastQueryAt)],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 border-l-2 pl-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 truncate text-sm font-medium">{value}</div>
            </div>
          ))}
        </div>
      )}
      {refill.error && (
        <p className="mt-4 text-sm text-destructive">{refill.error}</p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {canStart && (
          <Button onClick={onStart}>
            <Sparkles />
            {refill.status === "idle" ? "生成推荐" : "重新提交"}
          </Button>
        )}
        <Button variant="outline" onClick={onRefresh}>
          <RefreshCw />
          重新读取
        </Button>
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
  const refill = useRecommendationRefill(project, query.poll)
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState<ContactFilter>("all")
  const [selectedContacts, setSelectedContacts] = React.useState<
    Record<string, string>
  >({})
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [manualId, setManualId] = React.useState<string | null>(null)
  const [manualEmail, setManualEmail] = React.useState("")
  const [manualSource, setManualSource] = React.useState("")
  const [manualRole, setManualRole] =
    React.useState<PublicContactRole>("editorial")

  const selectedContact = React.useCallback(
    (item: RecommendationItem) =>
      selectedContacts[item.id] ??
      item.recommendedContactCandidateId ??
      item.contacts.find((contact) => contact.eligible)?.id ??
      "",
    [selectedContacts]
  )

  async function pollJob(job: ContactEnrichmentJob) {
    let current = job
    for (
      let attempt = 0;
      attempt < 90 && activeJobStatuses.has(current.status);
      attempt += 1
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 2_000))
      current = await getContactEnrichmentJob(
        websiteProjectKey,
        current.id,
        AbortSignal.timeout(10_000)
      )
    }
    await query.refresh()
  }

  async function discover(item: RecommendationItem) {
    if (busyId) return
    setBusyId(item.id)
    setError(null)
    try {
      const job = item.contactJob
        ? await retryContactEnrichment(websiteProjectKey, item.contactJob.id)
        : await startContactEnrichment(websiteProjectKey, item.id)
      await pollJob(job)
    } catch {
      setError("联系人抓取未完成，请查看当前状态后重试。")
    } finally {
      setBusyId(null)
    }
  }

  async function addManual(item: RecommendationItem) {
    if (!manualEmail.trim() || !manualSource.trim() || busyId) return
    setBusyId(item.id)
    setError(null)
    try {
      await addPublicContactCandidate(websiteProjectKey, item.id, {
        normalizedEmail: manualEmail.trim(),
        contactRole: manualRole,
        sourceUrl: manualSource.trim(),
        reason: "User verified public contact evidence.",
      })
      setManualId(null)
      setManualEmail("")
      setManualSource("")
      await query.refresh()
    } catch {
      setError("人工联系人未保存。请检查邮箱格式和公开证据 URL。")
    } finally {
      setBusyId(null)
    }
  }

  async function addOpportunity(item: RecommendationItem) {
    const contactCandidateId = selectedContact(item)
    if (!contactCandidateId || busyId) return
    setBusyId(item.id)
    setError(null)
    try {
      const result = await createOpportunity(
        websiteProjectKey,
        item.id,
        contactCandidateId,
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
      setError("创建 Opportunity 失败。请刷新推荐，确认联系人仍有有效证据。")
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
      <RecommendationRefillView
        project={project}
        refill={refill}
        onStart={() => void refill.start()}
        onRefresh={() => void query.refresh()}
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
        onRetry={() => void query.refresh()}
        retryLabel="重新读取"
      />
    )
  }

  const counts = query.items.reduce(
    (result, item) => {
      result[item.contactStatus] += 1
      return result
    },
    { contactable: 0, running: 0, review: 0, not_found: 0 }
  )
  const rows = query.items.filter(
    (item) =>
      (filter === "all" || item.contactStatus === filter) &&
      item.hostname.toLowerCase().includes(search.trim().toLowerCase())
  )

  return (
    <div>
      {refill.status !== "idle" && (
        <div
          className="mb-4 flex flex-col gap-3 border-l-2 border-primary bg-muted/30 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          role="status"
          aria-busy={refill.status === "running" || undefined}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium">
              {refill.status === "running" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Clock3 className="size-4" />
              )}
              {refill.phase}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              已耗时 {formatElapsed(refill.elapsedMs)} · 轮询{" "}
              {refill.pollCount} 次 · 最后查询{" "}
              {formatQueryTime(refill.lastQueryAt)}
            </div>
          </div>
          {["failed", "timed_out"].includes(refill.status) && (
            <Button size="sm" onClick={() => void refill.start()}>
              <Sparkles />
              重新提交
            </Button>
          )}
        </div>
      )}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["推荐网站", query.items.length],
          ["可直接联系", counts.contactable],
          ["需要复核", counts.review],
          ["暂无联系人", counts.not_found],
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
                placeholder="搜索网站..."
                className="pl-9 sm:max-w-sm"
              />
            </div>
            <Button variant="outline" onClick={() => void query.refresh()}>
              <RefreshCw />
              刷新
            </Button>
            {query.items.length < refill.targetInventory &&
              project.inputRequired.length === 0 && (
                <Button
                  onClick={() => void refill.start()}
                  disabled={refill.status === "running"}
                >
                  {refill.status === "running" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  {refill.status === "running" ? "补充中" : "补充推荐"}
                </Button>
              )}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[
              ["all", "全部", query.items.length],
              ["contactable", "有联系人", counts.contactable],
              ["running", "抓取中", counts.running],
              ["review", "需复核", counts.review],
              ["not_found", "暂无联系人", counts.not_found],
            ].map(([value, label, count]) => (
              <Button
                key={value}
                size="sm"
                variant={filter === value ? "secondary" : "ghost"}
                onClick={() => setFilter(value as ContactFilter)}
              >
                {label} {count}
              </Button>
            ))}
          </div>
          {error && (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="divide-y">
          {rows.map((item) => {
            const eligibleContacts = item.contacts.filter(
              (contact) => contact.eligible
            )
            const selectedId = selectedContact(item)
            const selected = eligibleContacts.find(
              (contact) => contact.id === selectedId
            )
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
                    <Badge
                      variant={contactStatusMeta[item.contactStatus].variant}
                    >
                      {contactStatusMeta[item.contactStatus].label}
                    </Badge>
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
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">公开联系人</div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setManualId(manualId === item.id ? null : item.id)
                      }
                    >
                      <Mail />
                      人工补充
                    </Button>
                  </div>
                  {eligibleContacts.length > 0 ? (
                    <>
                      <Select
                        value={selectedId}
                        onValueChange={(value) =>
                          setSelectedContacts((current) => ({
                            ...current,
                            [item.id]: String(value),
                          }))
                        }
                      >
                        <SelectTrigger
                          aria-label="选择公开联系人"
                          className="w-full rounded-md border-border bg-background"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {eligibleContacts.map((contact) => (
                            <SelectItem key={contact.id} value={contact.id}>
                              {contact.normalizedEmail}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selected && (
                        <div className="space-y-2 rounded-md border p-3 text-xs">
                          <div className="font-medium break-all">
                            {selected.normalizedEmail}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                            <span>用途 {selected.inferredPurpose}</span>
                            <span>置信度 {selected.confidence}</span>
                            <span>
                              {selected.contactReviewRequired
                                ? "创建后需人工复核"
                                : "证据满足直接加入条件"}
                            </span>
                          </div>
                          {selected.evidence[0] && (
                            <a
                              href={selected.evidence[0].sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                            >
                              <span className="truncate">
                                查看公开证据 ·{" "}
                                {selected.evidence[0].extractionMethod}
                              </span>
                              <ExternalLink className="size-3 shrink-0" />
                            </a>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      未发现符合语法和证据门禁的公开邮箱。
                    </p>
                  )}
                  {manualId === item.id && (
                    <div className="space-y-2 border-t pt-3">
                      <Input
                        type="email"
                        value={manualEmail}
                        onChange={(event) => setManualEmail(event.target.value)}
                        placeholder="公开邮箱"
                      />
                      <Input
                        type="url"
                        value={manualSource}
                        onChange={(event) =>
                          setManualSource(event.target.value)
                        }
                        placeholder="公开证据 URL"
                      />
                      <Select
                        value={manualRole}
                        onValueChange={(value) =>
                          setManualRole(value as PublicContactRole)
                        }
                      >
                        <SelectTrigger className="w-full rounded-md border-border bg-background">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(roleLabels).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        onClick={() => void addManual(item)}
                        disabled={
                          isBusy || !manualEmail.trim() || !manualSource.trim()
                        }
                      >
                        保存公开联系人
                      </Button>
                    </div>
                  )}
                </section>

                <section className="flex min-w-0 flex-col justify-between gap-4">
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <div>
                      已访问 {item.contactJob?.pagesVisited ?? 0} 页，证据{" "}
                      {item.contactJob?.evidenceCount ?? 0} 条
                    </div>
                    {item.contactJob?.lastErrorCode && (
                      <div>最近错误：{item.contactJob.lastErrorCode}</div>
                    )}
                    {item.createBlockReason === "existing_opportunity" && (
                      <div>该域名已在当前项目的 Opportunity 中。</div>
                    )}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <Button
                      variant="outline"
                      onClick={() => void discover(item)}
                      disabled={
                        Boolean(busyId) || item.contactStatus === "running"
                      }
                    >
                      {isBusy ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <ScanSearch />
                      )}
                      {item.contactJob ? "重新抓取" : "发现联系人"}
                    </Button>
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
                          !selectedId
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
                  </div>
                </section>
              </article>
            )
          })}
          {rows.length === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              当前筛选条件下没有推荐网站。
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
