import * as React from "react"
import {
  Archive,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Pause,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Sparkles,
  UserSearch,
} from "lucide-react"
import { useParams } from "react-router"

import { defaultProject } from "@/app/project-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  getBacklinksGatewayHealth,
  type BacklinkAssessmentComponent,
  type BacklinkAssessmentRunStatus,
  type BacklinkAssessmentView,
  type BacklinkEvidenceValue,
  type BacklinkPlacementCandidate,
  type BacklinkPublicAssessment,
  type RecommendationScoreComponentId,
} from "@/features/outreach/api/client"
import { GmailSafetyPanel } from "@/features/outreach/gmail/gmail-safety-panel"
import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"
import { linksApi } from "@/features/outreach/links/api"
import { LinksWorkspace } from "@/features/outreach/links/links-workspace"
import { MailSyncStatusPanel } from "@/features/outreach/mail/mail-sync-status-panel"
import {
  createAssessmentView,
  createDisabledDraftFoundation,
  createDomainPlacementCandidate,
  createLocalDemoDraftFoundation,
  initialOpportunities,
  initialRecommendations,
  type DraftFoundation,
  type Opportunity,
  type OpportunityBusinessStage,
  type OpportunityFulfillmentStatus,
  type OpportunityManagementStatus,
  type OpportunityOutcomeStatus,
  type Recommendation,
} from "@/features/outreach/mock-data"
import { ProjectWorkspace } from "@/features/projects/project-workspace"

const stageMeta: Record<
  OpportunityBusinessStage,
  {
    label: string
    variant: "default" | "secondary" | "outline" | "destructive"
  }
> = {
  JOINED: { label: "已加入", variant: "outline" },
  CONTACT_PREPARING: { label: "准备联系人", variant: "destructive" },
  READY_TO_CONTACT: { label: "可联系", variant: "secondary" },
  OUTREACH_ACTIVE: { label: "外联中", variant: "secondary" },
  NEGOTIATING: { label: "洽谈中", variant: "default" },
  AGREED: { label: "已达成", variant: "default" },
  WAITING_PLACEMENT: { label: "等待投放", variant: "secondary" },
  RELATIONSHIP_ACTIVE: { label: "合作活跃", variant: "default" },
  CLOSED: { label: "已关闭", variant: "outline" },
}
const managementMeta: Record<
  OpportunityManagementStatus,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  ACTIVE: { label: "进行中", variant: "secondary" },
  PAUSED: { label: "已暂停", variant: "outline" },
  ARCHIVED: { label: "已归档", variant: "destructive" },
}
const outcomeLabels: Record<OpportunityOutcomeStatus, string> = {
  OPEN: "开放",
  WON: "成功",
  LOST: "失败",
}
const fulfillmentLabels: Record<OpportunityFulfillmentStatus, string> = {
  NOT_EXPECTED: "未预期",
  PENDING: "待履约",
  PARTIAL: "部分履约",
  FULFILLED: "已履约",
}
const assessmentComponentLabels: Record<
  RecommendationScoreComponentId,
  string
> = {
  graph_authority_diversity: "图谱权威与多样性",
  topic_content_editorial_quality: "主题与内容质量",
  outbound_commercialization: "外链商业化",
  network_risk: "网络风险",
  technical_health: "技术健康",
}
const evidenceSourceLabels: Record<string, string> = {
  dataforseo: "DataForSEO",
  shared_crawler_site_audit: "站点审计",
  shared_crawler_page_check: "页面直检",
  project_promotion_target: "项目目标",
  legacy_snapshot: "历史快照",
  manual: "人工录入",
  crawler_discovery: "Crawler 发现",
  search_discovery: "搜索发现",
  import: "导入",
}
const assessmentRunMeta: Record<
  BacklinkAssessmentRunStatus,
  {
    label: string
    variant: "default" | "secondary" | "outline" | "destructive"
  }
> = {
  QUEUED: { label: "排队中", variant: "outline" },
  RUNNING: { label: "评估中", variant: "secondary" },
  SUCCEEDED: { label: "已完成", variant: "secondary" },
  FAILED: { label: "运行失败", variant: "destructive" },
  CANCELLED: { label: "已取消", variant: "outline" },
}
const draftStatusLabels: Record<DraftFoundation["status"], string> = {
  not_created: "尚未创建",
  generating: "生成中",
  draft: "草稿",
  approved: "已审批",
  rejected: "已拒绝",
  sent: "已发送",
}

function formatEvidenceTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function evidenceSourceLabel(value: string) {
  return evidenceSourceLabels[value] ?? value
}

function assessmentCoverage(assessment: BacklinkPublicAssessment) {
  const available = assessment.components.filter(
    (component) => component.availability !== "unavailable" && !component.stale
  ).length
  return `${available}/${assessment.components.length}`
}

function assessmentSources(assessment: BacklinkPublicAssessment) {
  return [
    ...new Set(
      assessment.components.map((component) =>
        evidenceSourceLabel(component.sourceType)
      )
    ),
  ].join(" + ")
}

function latestDirectCrawl(assessment: BacklinkPublicAssessment) {
  const observed = assessment.components
    .filter(
      (component) =>
        component.sourceType.startsWith("shared_crawler_") &&
        component.availability !== "unavailable"
    )
    .map((component) => component.observedAt)
    .sort()
    .at(-1)
  return observed ? formatEvidenceTime(observed) : "不可用"
}

function componentScore(component: BacklinkAssessmentComponent) {
  return component.points === null ? "不可用" : component.points.toFixed(1)
}

function evidenceDisplay<T>(evidence: BacklinkEvidenceValue<T>) {
  if (evidence.availability === "unavailable") return "不可用"
  if (evidence.stale) return "已过期"
  if (Array.isArray(evidence.value)) {
    return evidence.value.length > 0 ? evidence.value.join(", ") : "已观察"
  }
  if (typeof evidence.value === "boolean") {
    return evidence.value ? "通过" : "未通过"
  }
  return String(evidence.value)
}

function AssessmentEvidence({
  assessment,
  assessmentRun,
}: {
  assessment: BacklinkPublicAssessment
  assessmentRun: BacklinkAssessmentView
}) {
  const runMeta = assessmentRunMeta[assessmentRun.run.status]
  const result = assessmentRun.result

  return (
    <section className="space-y-3 border-y py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Assessment 证据</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {assessment.readOnly
              ? "历史评分只读保留；缺失证据不会显示为 0"
              : `生成于 ${formatEvidenceTime(assessment.generatedAt)}`}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge variant={runMeta.variant}>{runMeta.label}</Badge>
          <Badge
            variant={
              assessment.availability !== "available" ||
              assessment.freshness === "stale"
                ? "destructive"
                : "secondary"
            }
          >
            {assessment.availability !== "available" ||
            assessment.freshness === "stale"
              ? "证据不足"
              : "证据完整"}
          </Badge>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y py-3 text-sm">
        <span className="text-muted-foreground">运行尝试</span>
        <span className="text-right">{assessmentRun.run.attemptCount}</span>
        <span className="text-muted-foreground">结果快照</span>
        <span className="truncate text-right">
          {result ? `v${result.snapshotVersion}` : "无成功快照"}
        </span>
        <span className="text-muted-foreground">快照归属</span>
        <span className="text-right">
          {result?.isCurrent
            ? "当前运行"
            : result
              ? "保留的历史成功结果"
              : "不可用"}
        </span>
        <span className="text-muted-foreground">错误代码</span>
        <span className="truncate text-right">
          {assessmentRun.run.errorCode ?? "无"}
        </span>
      </div>
      {result && !result.isCurrent && (
        <div className="text-xs text-amber-700 dark:text-amber-400">
          最新运行未成功，当前展示的是上一份成功快照，不会把失败状态标记为成功。
        </div>
      )}
      <div className="divide-y rounded-md border">
        {assessment.components.map((component) => (
          <div
            key={component.id}
            className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2.5 text-sm"
          >
            <div>
              <div className="font-medium">
                {assessmentComponentLabels[component.id]}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {evidenceSourceLabel(component.sourceType)} ·{" "}
                {component.sourceReleaseId}
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono font-medium">
                {componentScore(component)}
                {component.points === null ? "" : ` / ${component.weight}`}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {component.availability === "unavailable"
                  ? "不可用"
                  : component.stale
                    ? "已过期"
                    : "可用"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function DraftFoundationPanel({ draft }: { draft: DraftFoundation }) {
  const adapterLabel =
    draft.providerMode === "fake" ? "本地 Fake Adapter" : "真实 Provider 未启用"

  return (
    <section className="space-y-3 border-b pb-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">开发信 Draft 基础状态</div>
          <div className="mt-1 text-xs text-muted-foreground">
            证据快照、Prompt 与输出契约均按版本记录
          </div>
        </div>
        <Badge
          variant={draft.status === "not_created" ? "outline" : "secondary"}
        >
          {draftStatusLabels[draft.status]}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <span className="text-muted-foreground">当前版本</span>
        <span className="text-right">
          {draft.currentVersion === null
            ? "尚无版本"
            : `v${draft.currentVersion}`}
        </span>
        <span className="text-muted-foreground">证据快照</span>
        <span
          className="truncate text-right font-mono text-xs"
          title={draft.evidenceSnapshotId ?? undefined}
        >
          {draft.evidenceSnapshotId ?? "尚未冻结"}
        </span>
        <span className="text-muted-foreground">Prompt 契约</span>
        <span className="truncate text-right">{draft.promptVersion}</span>
        <span className="text-muted-foreground">输出契约</span>
        <span className="truncate text-right">{draft.outputSchemaVersion}</span>
        <span className="text-muted-foreground">执行模式</span>
        <span className="text-right">{adapterLabel}</span>
        <span className="text-muted-foreground">模型</span>
        <span className="truncate text-right">{draft.modelId ?? "未配置"}</span>
        <span className="text-muted-foreground">人工审批</span>
        <span className="text-right">
          {draft.requiresHumanApproval ? "必须" : "未要求"}
        </span>
        <span className="text-muted-foreground">自动发送</span>
        <span className="text-right">
          {draft.canAutoSend ? "允许" : "关闭"}
        </span>
      </div>
    </section>
  )
}

function PlacementEvidence({
  candidate,
}: {
  candidate: BacklinkPlacementCandidate | null
}) {
  if (!candidate) {
    return (
      <section className="space-y-1 border-b pb-4">
        <div className="text-sm font-medium">Placement 候选</div>
        <div className="text-xs text-muted-foreground">尚无候选证据</div>
      </section>
    )
  }

  const requiresPageEvidence =
    candidate.sourcePageUrl.availability === "unavailable" ||
    candidate.anchorText.availability === "unavailable" ||
    candidate.rel.availability === "unavailable" ||
    candidate.verification === null

  return (
    <section className="space-y-3 border-b pb-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Placement 候选</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {requiresPageEvidence
              ? "域级线索不能直接晋升，仍需来源页与直接核验"
              : "页面证据已满足晋升前置条件"}
          </div>
        </div>
        <Badge variant={requiresPageEvidence ? "outline" : "secondary"}>
          {requiresPageEvidence ? "需要页面证据" : "可进入审核"}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <span className="text-muted-foreground">候选来源</span>
        <span className="text-right">
          {evidenceSourceLabel(candidate.sourceType)}
        </span>
        <span className="text-muted-foreground">来源页</span>
        <span className="truncate text-right">
          {evidenceDisplay(candidate.sourcePageUrl)}
        </span>
        <span className="text-muted-foreground">目标页</span>
        <span className="truncate text-right">
          {evidenceDisplay(candidate.targetUrl)}
        </span>
        <span className="text-muted-foreground">锚文本</span>
        <span className="truncate text-right">
          {evidenceDisplay(candidate.anchorText)}
        </span>
        <span className="text-muted-foreground">rel</span>
        <span className="truncate text-right">
          {evidenceDisplay(candidate.rel)}
        </span>
        <span className="text-muted-foreground">直接核验</span>
        <span className="text-right">
          {candidate.verification?.method === "direct_page_check"
            ? evidenceDisplay(candidate.verification.result)
            : "不可用"}
        </span>
      </div>
    </section>
  )
}

function DomainCell({ domain }: { domain: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
        {domain.slice(0, 1).toUpperCase()}
      </span>
      <span className="font-medium">{domain}</span>
    </div>
  )
}

function Notice({ message }: { message: string }) {
  return (
    <div className="mb-5 flex items-center gap-2 rounded-xl border border-emerald-600/20 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
      <Check className="size-4" />
      {message}
    </div>
  )
}

function CoreStatus() {
  const [status, setStatus] = React.useState<
    "checking" | "connected" | "unavailable"
  >("checking")

  async function check() {
    setStatus("checking")
    try {
      await getBacklinksGatewayHealth()
      setStatus("connected")
    } catch {
      setStatus("unavailable")
    }
  }

  React.useEffect(() => {
    let active = true
    void getBacklinksGatewayHealth().then(
      () => {
        if (active) setStatus("connected")
      },
      () => {
        if (active) setStatus("unavailable")
      }
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="mb-4 flex min-h-8 items-center gap-2 border-b pb-3 text-sm">
      <Server className="size-4 text-muted-foreground" />
      <span className="font-medium">Backlinks Core</span>
      <Badge
        variant={
          status === "connected"
            ? "secondary"
            : status === "unavailable"
              ? "destructive"
              : "outline"
        }
      >
        {
          {
            checking: "检查中",
            connected: "已连接",
            unavailable: "未连接",
          }[status]
        }
      </Badge>
      <Button
        className="ml-auto"
        variant="ghost"
        size="icon-xs"
        title="重新检查 Core 连接"
        aria-label="重新检查 Core 连接"
        disabled={status === "checking"}
        onClick={() => void check()}
      >
        <RefreshCw className={status === "checking" ? "animate-spin" : ""} />
      </Button>
    </div>
  )
}

export function OutreachWorkspace({ view }: { view: string }) {
  const { projectId = defaultProject.id } = useParams<{ projectId: string }>()
  const gmailConnection = useGmailConnection(projectId, view === "email")
  const [recommendations, setRecommendations] = React.useState(
    initialRecommendations
  )
  const [opportunities, setOpportunities] = React.useState(initialOpportunities)
  const [search, setSearch] = React.useState("")
  const [stageFilter, setStageFilter] = React.useState<
    OpportunityBusinessStage | "ALL"
  >("ALL")
  const [managementFilter, setManagementFilter] = React.useState<
    OpportunityManagementStatus | "ALL"
  >("ALL")
  const [outcomeFilter, setOutcomeFilter] = React.useState<
    OpportunityOutcomeStatus | "ALL"
  >("ALL")
  const [fulfillmentFilter, setFulfillmentFilter] = React.useState<
    OpportunityFulfillmentStatus | "ALL"
  >("ALL")
  const [opportunityPage, setOpportunityPage] = React.useState(0)
  const [managementReason, setManagementReason] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [refreshing, setRefreshing] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selectedOpportunity = opportunities.find(
    (item) => item.id === selectedId
  )

  function showNotice(message: string) {
    setNotice(message)
    window.setTimeout(() => setNotice(""), 2200)
  }

  function joinOpportunity(item: Recommendation) {
    const opportunityId = crypto.randomUUID()
    setRecommendations((items) => items.filter((row) => row.id !== item.id))
    setOpportunities((items) => [
      ...items,
      {
        id: opportunityId,
        domain: item.domain,
        joinSequence:
          Math.max(0, ...items.map((opportunity) => opportunity.joinSequence)) +
          1,
        businessStage: "JOINED",
        managementStatus: "ACTIVE",
        outcomeStatus: "OPEN",
        fulfillmentStatus: "NOT_EXPECTED",
        version: 1,
        emailStatus: "not_started",
        contact: "—",
        assessment: item.assessment,
        assessmentRun: createAssessmentView(opportunityId, item.assessment),
        draftFoundation: createDisabledDraftFoundation(),
        placementCandidate: createDomainPlacementCandidate(
          `placement-candidate-${opportunityId}`,
          opportunityId,
          item.domain
        ),
        nextStep: "补充联系人",
        updated: "刚刚",
      },
    ])
    showNotice(`${item.domain} 已加入外链机会`)
  }

  function updateOpportunity(
    id: string,
    changes: Partial<Omit<Opportunity, "id">>
  ) {
    setOpportunities((items) =>
      items.map((item) =>
        item.id === id ? { ...item, ...changes, updated: "刚刚" } : item
      )
    )
  }

  function updateManagementStatus(status: OpportunityManagementStatus) {
    if (!selectedOpportunity || !managementReason.trim()) return
    updateOpportunity(selectedOpportunity.id, {
      managementStatus: status,
      version: selectedOpportunity.version + 1,
    })
    const action =
      status === "ACTIVE"
        ? "恢复为进行中"
        : status === "PAUSED"
          ? "暂停"
          : "归档"
    showNotice(`${selectedOpportunity.domain} 已${action}，业务版本已更新`)
    setManagementReason("")
  }

  if (view === "projects") {
    return (
      <div>
        <CoreStatus />
        <ProjectWorkspace />
      </div>
    )
  }

  if (view === "recommendations") {
    const rows = recommendations.filter((item) =>
      item.domain.toLowerCase().includes(search.toLowerCase())
    )

    return (
      <div>
        <CoreStatus />
        {notice && <Notice message={notice} />}
        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["精选推荐", "18", "本周新增 6 个"],
            ["高匹配", "9", "匹配度 ≥ 85"],
            ["可直接联系", "7", "已有公开入口"],
            ["等待评估", "4", "后台任务运行中"],
          ].map(([label, value, detail]) => (
            <Card key={label} size="sm">
              <CardContent>
                <div className="text-sm text-muted-foreground">{label}</div>
                <div className="mt-2 text-2xl font-semibold">{value}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {detail}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setOpportunityPage(0)
                }}
                placeholder="搜索推荐网站..."
                className="pl-9 sm:max-w-sm"
              />
            </div>
            <Badge variant="outline">DataForSEO + 站点审计</Badge>
            <Button
              variant="outline"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true)
                window.setTimeout(() => {
                  setRefreshing(false)
                  showNotice("推荐刷新完成，新增 6 个高匹配网站")
                }, 1000)
              }}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "刷新中" : "刷新推荐"}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>推荐网站</TableHead>
                  <TableHead className="text-right">综合评分</TableHead>
                  <TableHead>证据来源</TableHead>
                  <TableHead>可用性 / 新鲜度</TableHead>
                  <TableHead>五维评分</TableHead>
                  <TableHead>主题相关性</TableHead>
                  <TableHead>可联络性</TableHead>
                  <TableHead className="w-36" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <DomainCell domain={item.domain} />
                    </TableCell>
                    <TableCell className="text-right font-semibold text-primary">
                      {item.score}
                    </TableCell>
                    <TableCell className="min-w-52">
                      <div className="text-sm">
                        {assessmentSources(item.assessment)}
                      </div>
                      <div
                        className="mt-1 max-w-52 truncate font-mono text-xs text-muted-foreground"
                        title={item.assessment.sourceReleaseIds.join(", ")}
                      >
                        {item.assessment.sourceReleaseIds.join(" · ")}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-40">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            item.assessment.availability !== "available" ||
                            item.assessment.freshness === "stale"
                              ? "outline"
                              : "secondary"
                          }
                        >
                          {item.assessment.readOnly
                            ? "历史只读"
                            : `${assessmentCoverage(item.assessment)} 可用`}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        最近直检：{latestDirectCrawl(item.assessment)}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-64">
                      <div className="space-y-1 text-xs">
                        {item.assessment.components.map((component) => (
                          <div
                            key={component.id}
                            className="flex items-center justify-between gap-3"
                          >
                            <span className="text-muted-foreground">
                              {assessmentComponentLabels[component.id]}
                            </span>
                            <span className="font-mono">
                              {componentScore(component)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{item.relevance}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.contactability}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" onClick={() => joinOpportunity(item)}>
                        加入机会
                        <ArrowRight />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    )
  }

  if (view === "links") {
    return (
      <div>
        <CoreStatus />
        <LinksWorkspace client={linksApi} websiteProjectKey={projectId} />
      </div>
    )
  }

  if (view === "opportunities") {
    const rows = [...opportunities]
      .sort(
        (left, right) =>
          left.joinSequence - right.joinSequence ||
          left.id.localeCompare(right.id)
      )
      .filter(
        (item) =>
          item.domain.toLowerCase().includes(search.toLowerCase()) &&
          (stageFilter === "ALL" || item.businessStage === stageFilter) &&
          (managementFilter === "ALL" ||
            item.managementStatus === managementFilter) &&
          (outcomeFilter === "ALL" || item.outcomeStatus === outcomeFilter) &&
          (fulfillmentFilter === "ALL" ||
            item.fulfillmentStatus === fulfillmentFilter)
      )
    const pageSize = 4
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
    const currentPage = Math.min(opportunityPage, pageCount - 1)
    const visibleRows = rows.slice(
      currentPage * pageSize,
      currentPage * pageSize + pageSize
    )

    return (
      <div>
        <CoreStatus />
        {notice && <Notice message={notice} />}
        <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            [
              "活跃机会",
              opportunities
                .filter((item) => item.managementStatus === "ACTIVE")
                .length.toString(),
              "管理状态为进行中",
            ],
            [
              "待补联系人",
              opportunities
                .filter((item) =>
                  ["JOINED", "CONTACT_PREPARING"].includes(item.businessStage)
                )
                .length.toString(),
              "需要今天处理",
            ],
            [
              "可写信 / 草稿",
              opportunities
                .filter((item) => item.businessStage === "READY_TO_CONTACT")
                .length.toString(),
              "可以继续推进",
            ],
            [
              "回复与洽谈",
              opportunities
                .filter((item) => item.businessStage === "NEGOTIATING")
                .length.toString(),
              "包含 1 个报价",
            ],
          ].map(([label, value, detail]) => (
            <Card key={label} size="sm">
              <CardContent>
                <div className="text-sm text-muted-foreground">{label}</div>
                <div className="mt-2 text-2xl font-semibold">{value}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {detail}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b p-4 xl:flex-row xl:items-center">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setOpportunityPage(0)
                }}
                placeholder="搜索外链机会..."
                className="pl-9 sm:max-w-sm"
              />
            </div>
            <div className="grid w-full gap-2 sm:grid-cols-2 xl:w-auto xl:grid-cols-4">
              <Select
                value={stageFilter}
                onValueChange={(value) => {
                  setStageFilter(
                    (value ?? "ALL") as OpportunityBusinessStage | "ALL"
                  )
                  setOpportunityPage(0)
                }}
              >
                <SelectTrigger className="w-full xl:w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部阶段</SelectItem>
                  {Object.entries(stageMeta).map(([value, meta]) => (
                    <SelectItem key={value} value={value}>
                      {meta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={managementFilter}
                onValueChange={(value) => {
                  setManagementFilter(
                    (value ?? "ALL") as OpportunityManagementStatus | "ALL"
                  )
                  setOpportunityPage(0)
                }}
              >
                <SelectTrigger className="w-full xl:w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部管理</SelectItem>
                  {Object.entries(managementMeta).map(([value, meta]) => (
                    <SelectItem key={value} value={value}>
                      {meta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={outcomeFilter}
                onValueChange={(value) => {
                  setOutcomeFilter(
                    (value ?? "ALL") as OpportunityOutcomeStatus | "ALL"
                  )
                  setOpportunityPage(0)
                }}
              >
                <SelectTrigger className="w-full xl:w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部结果</SelectItem>
                  {Object.entries(outcomeLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={fulfillmentFilter}
                onValueChange={(value) => {
                  setFulfillmentFilter(
                    (value ?? "ALL") as OpportunityFulfillmentStatus | "ALL"
                  )
                  setOpportunityPage(0)
                }}
              >
                <SelectTrigger className="w-full xl:w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部履约</SelectItem>
                  {Object.entries(fulfillmentLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">序号</TableHead>
                  <TableHead>网站</TableHead>
                  <TableHead>当前阶段</TableHead>
                  <TableHead>管理状态</TableHead>
                  <TableHead>联系人</TableHead>
                  <TableHead>下一步</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="w-44" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      #{item.joinSequence}
                    </TableCell>
                    <TableCell>
                      <DomainCell domain={item.domain} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={stageMeta[item.businessStage].variant}>
                        {stageMeta[item.businessStage].label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={managementMeta[item.managementStatus].variant}
                      >
                        {managementMeta[item.managementStatus].label}
                      </Badge>
                    </TableCell>
                    <TableCell>{item.contact}</TableCell>
                    <TableCell className="font-medium">
                      {item.nextStep}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.updated}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedId(item.id)}
                        >
                          详情
                        </Button>
                        {["JOINED", "CONTACT_PREPARING"].includes(
                          item.businessStage
                        ) && (
                          <Button
                            size="sm"
                            disabled={item.managementStatus !== "ACTIVE"}
                            onClick={() => {
                              updateOpportunity(item.id, {
                                businessStage: "READY_TO_CONTACT",
                                emailStatus: "ready",
                                contact: `editor@${item.domain}`,
                                nextStep: "生成开发信",
                                version: item.version + 1,
                              })
                              showNotice(`${item.domain} 联系人已补充`)
                            }}
                          >
                            <UserSearch />
                            补联系人
                          </Button>
                        )}
                        {item.businessStage === "READY_TO_CONTACT" &&
                          item.emailStatus === "ready" && (
                            <Button
                              size="sm"
                              disabled={item.managementStatus !== "ACTIVE"}
                              onClick={() => {
                                updateOpportunity(item.id, {
                                  emailStatus: "draft",
                                  draftFoundation:
                                    createLocalDemoDraftFoundation(),
                                  nextStep: "确认发送",
                                })
                                showNotice(
                                  `${item.domain} 本地演示草稿已生成，未调用真实 AI`
                                )
                              }}
                            >
                              <Sparkles />
                              生成演示草稿
                            </Button>
                          )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {visibleRows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="h-32 text-center text-muted-foreground"
                    >
                      没有符合当前筛选条件的外链机会
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 border-t px-4 py-2 text-sm">
            <span className="text-muted-foreground">
              {rows.length} 个结果 · 按加入序号稳定排序
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-xs"
                title="上一页"
                aria-label="上一页"
                disabled={currentPage === 0}
                onClick={() =>
                  setOpportunityPage((page) => Math.max(0, page - 1))
                }
              >
                <ChevronLeft />
              </Button>
              <span className="min-w-16 text-center">
                {currentPage + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon-xs"
                title="下一页"
                aria-label="下一页"
                disabled={currentPage >= pageCount - 1}
                onClick={() =>
                  setOpportunityPage((page) =>
                    Math.min(pageCount - 1, page + 1)
                  )
                }
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </Card>

        <Sheet
          open={Boolean(selectedOpportunity)}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedId(null)
              setManagementReason("")
            }
          }}
        >
          <SheetContent className="sm:max-w-lg">
            {selectedOpportunity && (
              <>
                <SheetHeader>
                  <SheetTitle>{selectedOpportunity.domain}</SheetTitle>
                  <SheetDescription>
                    外链机会详情与唯一主生命周期状态
                  </SheetDescription>
                </SheetHeader>
                <div className="space-y-5 overflow-y-auto px-6">
                  <Badge
                    variant={
                      stageMeta[selectedOpportunity.businessStage].variant
                    }
                  >
                    {stageMeta[selectedOpportunity.businessStage].label}
                  </Badge>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      ["加入序号", `#${selectedOpportunity.joinSequence}`],
                      ["联系人", selectedOpportunity.contact],
                      [
                        "综合评分",
                        selectedOpportunity.assessment.score ?? "不可用",
                      ],
                      [
                        "证据来源",
                        assessmentSources(selectedOpportunity.assessment),
                      ],
                      [
                        "来源版本",
                        selectedOpportunity.assessment.sourceReleaseIds.join(
                          " · "
                        ),
                      ],
                      [
                        "证据覆盖",
                        assessmentCoverage(selectedOpportunity.assessment),
                      ],
                      [
                        "最近直检",
                        latestDirectCrawl(selectedOpportunity.assessment),
                      ],
                      ["业务版本", `v${selectedOpportunity.version}`],
                      [
                        "管理状态",
                        managementMeta[selectedOpportunity.managementStatus]
                          .label,
                      ],
                      [
                        "结果状态",
                        outcomeLabels[selectedOpportunity.outcomeStatus],
                      ],
                      [
                        "履约状态",
                        fulfillmentLabels[
                          selectedOpportunity.fulfillmentStatus
                        ],
                      ],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-muted p-4">
                        <div className="text-xs text-muted-foreground">
                          {label}
                        </div>
                        <div className="mt-1 font-medium">{value}</div>
                      </div>
                    ))}
                  </div>
                  <AssessmentEvidence
                    assessment={selectedOpportunity.assessment}
                    assessmentRun={selectedOpportunity.assessmentRun}
                  />
                  <PlacementEvidence
                    candidate={selectedOpportunity.placementCandidate}
                  />
                  <DraftFoundationPanel
                    draft={selectedOpportunity.draftFoundation}
                  />
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>生命周期</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {[
                        "加入机会",
                        stageMeta[selectedOpportunity.businessStage].label,
                      ].map((label, index) => (
                        <div key={label} className="flex items-center gap-3">
                          <span className="size-2 rounded-full bg-primary" />
                          <span className="text-sm">{label}</span>
                          {index === 1 && (
                            <Badge variant="outline" className="ml-auto">
                              当前
                            </Badge>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  <section className="space-y-3 border-y py-4">
                    <div>
                      <div className="text-sm font-medium">管理状态操作</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        暂停、归档或恢复不会改写业务阶段、结果或履约状态
                      </div>
                    </div>
                    <Textarea
                      value={managementReason}
                      onChange={(event) =>
                        setManagementReason(event.target.value)
                      }
                      className="min-h-20"
                      maxLength={500}
                      placeholder="填写本次状态调整原因"
                    />
                    <div className="flex flex-wrap gap-2">
                      {selectedOpportunity.managementStatus !== "PAUSED" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!managementReason.trim()}
                          onClick={() => updateManagementStatus("PAUSED")}
                        >
                          <Pause />
                          暂停
                        </Button>
                      )}
                      {selectedOpportunity.managementStatus !== "ARCHIVED" && (
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={!managementReason.trim()}
                          onClick={() => updateManagementStatus("ARCHIVED")}
                        >
                          <Archive />
                          归档
                        </Button>
                      )}
                      {selectedOpportunity.managementStatus !== "ACTIVE" && (
                        <Button
                          size="sm"
                          disabled={!managementReason.trim()}
                          onClick={() => updateManagementStatus("ACTIVE")}
                        >
                          <RotateCcw />
                          恢复
                        </Button>
                      )}
                    </div>
                  </section>
                </div>
                <SheetFooter>
                  <Button
                    disabled={selectedOpportunity.managementStatus !== "ACTIVE"}
                    onClick={() => {
                      showNotice(`准备处理：${selectedOpportunity.nextStep}`)
                      setSelectedId(null)
                    }}
                  >
                    {selectedOpportunity.nextStep}
                    <ArrowRight />
                  </Button>
                </SheetFooter>
              </>
            )}
          </SheetContent>
        </Sheet>
      </div>
    )
  }

  return (
    <div>
      <CoreStatus />
      <GmailSafetyPanel controller={gmailConnection} />
      <MailSyncStatusPanel controller={gmailConnection} />
    </div>
  )
}
