import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleHelp,
  Eye,
  ExternalLink,
  FileKey2,
  ListRestart,
  RefreshCw,
  ShieldAlert,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"

import { isLinksApiStatus, linksApi } from "./api"
import type {
  LifecycleEventsPage,
  LinkDetail,
  LinkDisplayState,
  LinkListItem,
  LinkPlacement,
  LinksClient,
  LinksPage,
  PlacementEvidence,
  PlacementLinkDetail,
  PlacementReverifyResult,
  ValidationEvidence,
} from "./types"

type LoadState = "loading" | "ready" | "empty" | "error" | "forbidden" | "conflict"
type DetailState =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "forbidden"
  | "conflict"
  | "not-found"
type ResourceState = "idle" | "loading" | "ready" | "error" | "forbidden" | "conflict"
type CommandState =
  | "idle"
  | "submitting"
  | "accepted"
  | "error"
  | "forbidden"
  | "conflict"
  | "not-found"

const pageSize = 25
const eventPageSize = 10

const views: ReadonlyArray<{
  value: LinkDisplayState
  label: string
  description: string
}> = [
  { value: "candidate", label: "Candidate", description: "不计成功 KPI" },
  { value: "confirmed", label: "Confirmed", description: "已确认放置" },
  { value: "changed", label: "Changed", description: "链接状态变化" },
  { value: "lost", label: "Lost", description: "已确认丢失" },
  { value: "recovered", label: "Recovered", description: "曾恢复的放置" },
]

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))

const resourceErrorState = (
  error: unknown
): Exclude<ResourceState, "idle" | "loading" | "ready"> => {
  if (isLinksApiStatus(error, 403)) return "forbidden"
  if (isLinksApiStatus(error, 409)) return "conflict"
  return "error"
}

const detailErrorState = (
  error: unknown
): Exclude<DetailState, "idle" | "loading" | "ready"> => {
  if (isLinksApiStatus(error, 403)) return "forbidden"
  if (isLinksApiStatus(error, 404)) return "not-found"
  if (isLinksApiStatus(error, 409)) return "conflict"
  return "error"
}

const commandErrorState = (
  error: unknown
): Exclude<CommandState, "idle" | "submitting" | "accepted"> => {
  if (isLinksApiStatus(error, 403)) return "forbidden"
  if (isLinksApiStatus(error, 404)) return "not-found"
  if (isLinksApiStatus(error, 409)) return "conflict"
  return "error"
}

const isJobRunning = (status: PlacementLinkDetail["latestMonitorRun"]["status"]) =>
  status === "scheduled" || status === "running" || status === "retry_wait"

function StateBadge({ state }: { state: LinkDisplayState }) {
  const variant =
    state === "candidate"
      ? "outline"
      : state === "lost"
        ? "destructive"
        : state === "changed" || state === "recovered"
          ? "secondary"
          : "default"
  return <Badge variant={variant}>{state}</Badge>
}

function StateNotice({
  state,
  retry,
}: {
  state: Exclude<LoadState, "ready">
  retry?: () => void
}) {
  if (state === "loading") {
    return (
      <div className="space-y-3 p-4" aria-label="Links 加载中">
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-14 w-full rounded-md" />
        <Skeleton className="h-14 w-full rounded-md" />
      </div>
    )
  }

  const forbidden = state === "forbidden"
  const conflict = state === "conflict"
  const empty = state === "empty"
  return (
    <div
      className="flex min-h-48 flex-col items-center justify-center px-4 py-8 text-center"
      role={empty ? "status" : "alert"}
    >
      {forbidden ? (
        <ShieldAlert className="mb-3 size-5 text-destructive" />
      ) : empty ? (
        <CircleHelp className="mb-3 size-5 text-muted-foreground" />
      ) : (
        <AlertTriangle className="mb-3 size-5 text-destructive" />
      )}
      <div className="text-sm font-medium">
        {forbidden
          ? "没有读取此项目 Links 的权限"
          : conflict
            ? "Links 状态发生冲突"
            : empty
              ? "当前状态下没有记录"
              : "Links 请求失败"}
      </div>
      <div className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
        {forbidden
          ? "服务端返回 403；不会回退到其他项目或缓存数据。"
          : conflict
            ? "服务端返回 409；请刷新后重新读取，不会将冲突推断为成功。"
            : empty
              ? "可切换状态或等待服务端同步。Candidate 不是成功状态。"
              : "结果保持未知。请重试读取。"}
      </div>
      {retry && !empty ? (
        <Button className="mt-4" size="sm" variant="outline" onClick={retry}>
          <RefreshCw data-icon="inline-start" />
          重试
        </Button>
      ) : null}
    </div>
  )
}

function DetailNotice({
  state,
  retry,
}: {
  state: Exclude<DetailState, "idle" | "ready">
  retry?: () => void
}) {
  if (state === "loading") {
    return (
      <div className="space-y-3 p-6" aria-label="Links 详情加载中">
        <Skeleton className="h-7 w-3/5 rounded-md" />
        <Skeleton className="h-20 w-full rounded-md" />
        <Skeleton className="h-20 w-full rounded-md" />
      </div>
    )
  }

  const forbidden = state === "forbidden"
  const missing = state === "not-found"
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center" role="alert">
      {forbidden ? (
        <ShieldAlert className="mb-3 size-5 text-destructive" />
      ) : (
        <AlertTriangle className="mb-3 size-5 text-destructive" />
      )}
      <div className="text-sm font-medium">
        {forbidden
          ? "没有读取此链接详情的权限"
          : missing
            ? "该链接已不存在"
            : state === "conflict"
              ? "详情与服务端状态冲突"
              : "读取链接详情失败"}
      </div>
      <div className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
        {missing
          ? "服务端返回 404；列表中的旧记录不会被当作当前事实。"
          : state === "conflict"
            ? "服务端返回 409；请刷新列表后重新选择。"
            : "当前详情保持未知，不展示推断出的证据或状态。"}
      </div>
      {retry ? (
        <Button className="mt-4" size="sm" variant="outline" onClick={retry}>
          <RefreshCw data-icon="inline-start" />
          重试
        </Button>
      ) : null}
    </div>
  )
}

function ResourceNotice({
  state,
  label,
  retry,
}: {
  state: Exclude<ResourceState, "idle" | "ready">
  label: string
  retry?: () => void
}) {
  if (state === "loading") {
    return <Skeleton className="mt-3 h-16 w-full rounded-md" />
  }

  const forbidden = state === "forbidden"
  return (
    <div className="mt-3 flex items-start gap-2 text-xs leading-5 text-muted-foreground" role="alert">
      {forbidden ? (
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      )}
      <div>
        <div className="font-medium text-foreground">
          {forbidden
            ? `没有读取${label}的权限`
            : state === "conflict"
              ? `${label}与服务端状态冲突`
              : `读取${label}失败`}
        </div>
        <div>
          {forbidden
            ? "服务端返回 403。"
            : state === "conflict"
              ? "服务端返回 409；请刷新详情。"
              : "当前内容保持未知。"}
        </div>
        {retry ? (
          <Button className="mt-2" size="xs" variant="outline" onClick={retry}>
            <RefreshCw data-icon="inline-start" />
            重试
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function UrlValue({
  label,
  value,
}: {
  label: string
  value: string | null
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {value ? (
        <a
          className="mt-1 flex min-w-0 items-center gap-1 text-sm break-all text-primary hover:underline"
          href={value}
          rel="noreferrer"
          target="_blank"
        >
          <span>{value}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
      ) : (
        <div className="mt-1 text-sm text-muted-foreground">服务端未提供</div>
      )}
    </div>
  )
}

function ValidationEvidenceBlock({
  title,
  evidence,
}: {
  title: string
  evidence: ValidationEvidence | null
}) {
  return (
    <section className="border-t px-6 py-5" aria-labelledby={`${title}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <FileKey2 className="size-4 text-primary" />
        <h3 className="text-sm font-semibold" id={`${title}-title`}>
          {title}
        </h3>
        {evidence ? <Badge variant="outline">{evidence.status}</Badge> : null}
      </div>
      {evidence ? (
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">验证运行</dt>
            <dd className="mt-1 break-all">{evidence.validationRunId}</dd>
          </div>
          {evidence.observedAt ? (
            <div>
              <dt className="text-muted-foreground">验证时间</dt>
              <dd className="mt-1">{dateTime(evidence.observedAt)}</dd>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">不可变快照哈希</dt>
            <dd className="mt-1 break-all font-mono text-[11px]">
              {evidence.evidenceSnapshotHash}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">证据契约</dt>
            <dd className="mt-1 break-all">{evidence.evidenceContractVersion}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">证据 schema</dt>
            <dd className="mt-1">{evidence.evidenceSchemaVersion}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          服务端尚未提供验证快照。界面不以页面抓取或 Browser 结果补造证据。
        </p>
      )}
    </section>
  )
}

function EvidenceReadBlock({
  evidence,
}: {
  evidence: PlacementEvidence
}) {
  return (
    <dl className="mt-3 grid gap-3 border-t pt-4 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">不可变性 / 哈希校验</dt>
        <dd className="mt-1">
          {evidence.immutable && evidence.hashVerified ? "immutable · hash verified" : "服务端未确认"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">证据新鲜度</dt>
        <dd className="mt-1">{evidence.freshness}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-muted-foreground">哈希</dt>
        <dd className="mt-1 break-all font-mono text-[11px]">{evidence.hash}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">抓取模式 / HTTP</dt>
        <dd className="mt-1">
          {evidence.source.fetchMode} · {evidence.source.httpStatus ?? "服务端未提供"}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">链接出现次数</dt>
        <dd className="mt-1">{evidence.link.occurrenceCount ?? "服务端未提供"}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-muted-foreground">最终 URL</dt>
        <dd className="mt-1 break-all">{evidence.source.finalUrl ?? "服务端未提供"}</dd>
      </div>
    </dl>
  )
}

function LatestObservationBlock({
  detail,
  evidence,
  evidenceState,
  readEvidence,
}: {
  detail: PlacementLinkDetail
  evidence: PlacementEvidence | null
  evidenceState: ResourceState
  readEvidence: (evidenceId: string) => void
}) {
  const observation = detail.latestObservation
  return (
    <section className="border-t px-6 py-5" aria-labelledby="latest-observation-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" id="latest-observation-title">
            最新 Observation
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            仅显示服务端投影的最新监控 Observation，不由 health 或时间戳推断。
          </p>
        </div>
        {observation ? (
          <Button
            disabled={evidenceState === "loading"}
            size="sm"
            variant="outline"
            onClick={() => readEvidence(observation.evidence.evidenceId)}
          >
            <FileKey2 data-icon="inline-start" />
            读取不可变证据
          </Button>
        ) : null}
      </div>
      {observation ? (
        <>
          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">结果 / 执行模式</dt>
              <dd className="mt-1">
                {observation.result} · {observation.executionMode}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Observation 时间</dt>
              <dd className="mt-1">{dateTime(observation.observedAt)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">新鲜度</dt>
              <dd className="mt-1">
                {observation.evidence.freshness === "stale" ? (
                  <Badge variant="destructive">stale</Badge>
                ) : (
                  <Badge variant="outline">{observation.evidence.freshness}</Badge>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">监控失败</dt>
              <dd className="mt-1">
                {observation.failure.status}
                {observation.failure.code ? ` · ${observation.failure.code}` : ""}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">不可变证据哈希</dt>
              <dd className="mt-1 break-all font-mono text-[11px]">
                {observation.evidence.hash}
              </dd>
            </div>
          </dl>
          {evidenceState === "ready" && evidence ? (
            <EvidenceReadBlock evidence={evidence} />
          ) : evidenceState === "loading" ||
            evidenceState === "error" ||
            evidenceState === "forbidden" ||
            evidenceState === "conflict" ? (
            <ResourceNotice
              label="不可变证据"
              retry={() => readEvidence(observation.evidence.evidenceId)}
              state={evidenceState}
            />
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          服务端尚未提供 Placement Observation；当前状态保持未知。
        </p>
      )}
    </section>
  )
}

function EventTimeline({
  events,
  state,
  loadMore,
  retry,
}: {
  events: LifecycleEventsPage | null
  state: ResourceState
  loadMore: () => void
  retry: () => void
}) {
  return (
    <section className="border-t px-6 py-5" aria-labelledby="event-history-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" id="event-history-title">
            状态变化和恢复事件
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            读取 Placement 生命周期事件。Recovered 只来自服务端 `placement.recovered` 或 `placement.restored` 事件。
          </p>
        </div>
        <ListRestart className="size-4 text-muted-foreground" />
      </div>
      {state === "ready" && events ? (
        events.items.length > 0 ? (
          <>
            <ol className="mt-3 space-y-3">
              {events.items.map((event) => (
                <li className="border-l-2 pl-3 text-xs" key={event.eventId}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={event.eventType.includes("lost") ? "destructive" : "outline"}>
                      {event.eventType}
                    </Badge>
                    <span className="text-muted-foreground">{dateTime(event.occurredAt)}</span>
                  </div>
                  <div className="mt-1">
                    {event.previousHealthStatus ?? "未提供"} → {event.nextHealthStatus ?? "未提供"} · v
                    {event.placementVersion}
                  </div>
                  {event.reason ? (
                    <div className="mt-1 text-muted-foreground">{event.reason}</div>
                  ) : null}
                </li>
              ))}
            </ol>
            {events.hasMore && events.nextCursor ? (
              <Button className="mt-4" size="sm" variant="outline" onClick={loadMore}>
                加载更多事件
              </Button>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            服务端未返回状态变化或恢复事件。
          </p>
        )
      ) : state === "loading" ||
        state === "error" ||
        state === "forbidden" ||
        state === "conflict" ? (
        <ResourceNotice label="事件时间线" retry={retry} state={state} />
      ) : null}
    </section>
  )
}

function ReverifyControl({
  detail,
  commandState,
  result,
  requestReverify,
}: {
  detail: LinkDetail
  commandState: CommandState
  result: PlacementReverifyResult | null
  requestReverify: (placement: LinkPlacement) => void
}) {
  const isPlacement = detail.recordType === "placement"
  const busy = commandState === "submitting"
  const accepted = commandState === "accepted"
  const currentRun = isPlacement ? detail.latestMonitorRun : null
  return (
    <section className="border-t px-6 py-5" aria-labelledby="verification-control-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" id="verification-control-title">
            服务器授权重新验证
          </h3>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            仅 Placement 调用冻结的 reverify 命令，并提交当前服务端版本和幂等键。客户端不执行 Browser 抓取。
          </p>
        </div>
        <Button
          disabled={!isPlacement || busy || accepted}
          size="sm"
          title={isPlacement ? "请求服务器重新验证" : "仅 Placement 可重新验证"}
          variant="outline"
          onClick={() => {
            if (isPlacement) requestReverify(detail)
          }}
        >
          <RefreshCw data-icon="inline-start" />
          {busy ? "提交中" : accepted ? "已接受" : "重新验证"}
        </Button>
      </div>

      {isPlacement && currentRun ? (
        <div className="mt-4 border-t pt-4 text-xs">
          <div className="font-medium">最新监控任务</div>
          <div className="mt-1 text-muted-foreground">
            {isJobRunning(currentRun.status) ? "job-running" : currentRun.status}
            {currentRun.monitorRunId ? ` · ${currentRun.monitorRunId}` : ""}
          </div>
          {currentRun.scheduledFor ? (
            <div className="mt-1 text-muted-foreground">
              计划时间 {dateTime(currentRun.scheduledFor)}
            </div>
          ) : null}
        </div>
      ) : null}

      {accepted && result ? (
        <div className="mt-4 border-t pt-4 text-xs" role="status">
          <div className="font-medium">
            {result.accepted ? "服务端已接受重新验证" : "服务端返回现有重新验证任务"}
          </div>
          <div className="mt-1 text-muted-foreground">
            {isJobRunning(result.monitorRun.status) ? "job-running" : result.monitorRun.status}
            {" · "}
            {result.monitorRun.monitorRunId}
            {" · "}
            {dateTime(result.monitorRun.scheduledFor)}
          </div>
          <div className="mt-1 text-muted-foreground">
            replayed: {String(result.replayed)} · browserFallbackAllowed: false
          </div>
        </div>
      ) : null}

      {commandState === "forbidden" || commandState === "conflict" || commandState === "error" || commandState === "not-found" ? (
        <div className="mt-4 border-t pt-4 text-xs" role="alert">
          <div className="font-medium">
            {commandState === "forbidden"
              ? "服务端拒绝重新验证权限"
              : commandState === "conflict"
                ? "重新验证与服务端版本或幂等键冲突"
                : commandState === "not-found"
                  ? "Placement 已不存在"
                  : "重新验证命令失败"}
          </div>
          <div className="mt-1 text-muted-foreground">
            {commandState === "conflict"
              ? "刷新详情以取得当前版本后再试。"
              : "未创建本地任务或推断任务状态。"}
          </div>
        </div>
      ) : null}
    </section>
  )
}

function DetailContent({
  detail,
  events,
  eventsState,
  evidence,
  evidenceState,
  commandState,
  reverifyResult,
  loadMoreEvents,
  readEvidence,
  reloadEvents,
  requestReverify,
}: {
  detail: LinkDetail
  events: LifecycleEventsPage | null
  eventsState: ResourceState
  evidence: PlacementEvidence | null
  evidenceState: ResourceState
  commandState: CommandState
  reverifyResult: PlacementReverifyResult | null
  loadMoreEvents: () => void
  readEvidence: (evidenceId: string) => void
  reloadEvents: () => void
  requestReverify: (placement: LinkPlacement) => void
}) {
  const isCandidate = detail.recordType === "candidate"
  return (
    <div className="min-w-0 overflow-y-auto">
      <SheetHeader className="border-b pr-14">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={detail.displayState} />
          <Badge variant="outline">
            {detail.countsTowardKpi ? "计入成功 KPI" : "不计入成功 KPI"}
          </Badge>
        </div>
        <SheetTitle className="mt-2 break-all">
          {isCandidate ? "Candidate 链接详情" : "Placement 链接详情"}
        </SheetTitle>
        <SheetDescription>
          版本 {detail.version} · 创建于 {dateTime(detail.createdAt)}
        </SheetDescription>
      </SheetHeader>

      <section className="grid gap-5 px-6 py-5">
        <UrlValue label="来源页面" value={detail.sourcePageUrl} />
        <UrlValue label="目标 URL" value={detail.targetUrl} />
        <UrlValue label="规范化来源 URL" value={detail.normalizedSourceUrl} />
        <UrlValue label="规范化目标 URL" value={detail.normalizedTargetUrl} />
        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <div>
            <div className="text-muted-foreground">URL 规范化版本</div>
            <div className="mt-1 break-all">{detail.urlNormalizationVersion}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Opportunity</div>
            <div className="mt-1 break-all">{detail.opportunityId || "服务端未提供"}</div>
          </div>
        </div>
      </section>

      {isCandidate ? (
        <ValidationEvidenceBlock title="最新验证" evidence={detail.latestValidation} />
      ) : (
        <>
          <ValidationEvidenceBlock title="首次验证" evidence={detail.initialValidation} />
          <LatestObservationBlock
            detail={detail}
            evidence={evidence}
            evidenceState={evidenceState}
            readEvidence={readEvidence}
          />
          <EventTimeline
            events={events}
            loadMore={loadMoreEvents}
            retry={reloadEvents}
            state={eventsState}
          />
        </>
      )}

      <ReverifyControl
        commandState={commandState}
        detail={detail}
        requestReverify={requestReverify}
        result={reverifyResult}
      />
    </div>
  )
}

function ListRows({
  items,
  openDetail,
}: {
  items: LinkListItem[]
  openDetail: (item: LinkListItem) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[760px] w-full text-left text-sm">
        <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">状态</th>
            <th className="px-4 py-3 font-medium">来源页面</th>
            <th className="px-4 py-3 font-medium">目标 URL</th>
            <th className="px-4 py-3 font-medium">验证 / 监控</th>
            <th className="px-4 py-3 font-medium">创建时间</th>
            <th aria-label="查看详情" className="px-4 py-3 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((item) => {
            const itemId = item.recordType === "candidate" ? item.candidateId : item.placementId
            const status =
              item.recordType === "candidate"
                ? `${item.validationStatus} · ${item.matchStatus}`
                : `${item.initialValidationStatus} · ${item.monitoringStatus}`
            return (
              <tr className="align-top hover:bg-muted/40" key={itemId}>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <StateBadge state={item.displayState} />
                    {item.countsTowardKpi ? null : (
                      <span className="text-[11px] text-muted-foreground">不计成功 KPI</span>
                    )}
                  </div>
                </td>
                <td className="max-w-72 px-4 py-3 text-xs break-all">
                  {item.sourcePageUrl || "服务端未提供"}
                </td>
                <td className="max-w-72 px-4 py-3 text-xs break-all">{item.targetUrl}</td>
                <td className="px-4 py-3 text-xs">{status}</td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  {dateTime(item.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <Button
                    aria-label={`查看 ${item.displayState} 链接详情`}
                    size="icon-xs"
                    title="查看详情"
                    variant="ghost"
                    onClick={() => openDetail(item)}
                  >
                    <Eye />
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function LinksWorkspace({
  websiteProjectKey,
  client = linksApi,
}: {
  websiteProjectKey: string
  client?: LinksClient
}) {
  const [view, setView] = useState<LinkDisplayState>("candidate")
  const [page, setPage] = useState<LinksPage | null>(null)
  const [state, setState] = useState<LoadState>("loading")
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [pageIndex, setPageIndex] = useState(0)
  const [selected, setSelected] = useState<LinkListItem | null>(null)
  const [detail, setDetail] = useState<LinkDetail | null>(null)
  const [detailState, setDetailState] = useState<DetailState>("idle")
  const [events, setEvents] = useState<LifecycleEventsPage | null>(null)
  const [eventsState, setEventsState] = useState<ResourceState>("idle")
  const [evidence, setEvidence] = useState<PlacementEvidence | null>(null)
  const [evidenceState, setEvidenceState] = useState<ResourceState>("idle")
  const [commandState, setCommandState] = useState<CommandState>("idle")
  const [reverifyResult, setReverifyResult] = useState<PlacementReverifyResult | null>(null)
  const currentCursor = cursors[pageIndex]

  const successCount = useMemo(
    () =>
      page?.items.filter(
        (item) => item.recordType === "placement" && item.countsTowardKpi
      ).length ?? 0,
    [page]
  )

  const resetDetailResources = () => {
    setEvents(null)
    setEventsState("idle")
    setEvidence(null)
    setEvidenceState("idle")
    setCommandState("idle")
    setReverifyResult(null)
  }

  const loadPage = async () => {
    setState("loading")
    setPage(null)
    try {
      const response = await client.listLinks(websiteProjectKey, {
        view,
        limit: pageSize,
        cursor: currentCursor,
      })
      setPage(response)
      setState(response.items.length === 0 ? "empty" : "ready")
    } catch (error) {
      setPage(null)
      setState(resourceErrorState(error))
    }
  }

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) {
        setState("loading")
        setPage(null)
      }
    })

    void client
      .listLinks(websiteProjectKey, {
        view,
        limit: pageSize,
        cursor: currentCursor,
      })
      .then((response) => {
        if (!active) return
        setPage(response)
        setState(response.items.length === 0 ? "empty" : "ready")
      })
      .catch((error: unknown) => {
        if (!active) return
        setPage(null)
        setState(resourceErrorState(error))
      })

    return () => {
      active = false
    }
  }, [client, currentCursor, view, websiteProjectKey])

  const loadPlacementEvents = async (placementId: string, cursor?: string, append = false) => {
    setEventsState("loading")
    if (!append) setEvents(null)
    try {
      const response = await client.listPlacementEvents(websiteProjectKey, placementId, {
        limit: eventPageSize,
        cursor,
      })
      setEvents((current) =>
        append && current
          ? {
              items: [...current.items, ...response.items],
              hasMore: response.hasMore,
              nextCursor: response.nextCursor,
            }
          : response
      )
      setEventsState("ready")
    } catch (error) {
      if (!append) setEvents(null)
      setEventsState(resourceErrorState(error))
    }
  }

  const openDetail = async (item: LinkListItem) => {
    setSelected(item)
    setDetail(null)
    setDetailState("loading")
    resetDetailResources()
    try {
      const response =
        item.recordType === "candidate"
          ? await client.getCandidateLink(websiteProjectKey, item.candidateId)
          : await client.getPlacementLink(websiteProjectKey, item.placementId)
      setDetail(response)
      setDetailState("ready")
      if (response.recordType === "placement") {
        void loadPlacementEvents(response.placementId)
      }
    } catch (error) {
      setDetail(null)
      setDetailState(detailErrorState(error))
    }
  }

  const readEvidence = async (evidenceId: string) => {
    setEvidence(null)
    setEvidenceState("loading")
    try {
      const response = await client.getPlacementEvidence(websiteProjectKey, evidenceId)
      setEvidence(response)
      setEvidenceState("ready")
    } catch (error) {
      setEvidence(null)
      setEvidenceState(resourceErrorState(error))
    }
  }

  const requestReverify = async (placement: LinkPlacement) => {
    setCommandState("submitting")
    setReverifyResult(null)
    try {
      const response = await client.reverifyPlacement(websiteProjectKey, placement.placementId, {
        expectedVersion: placement.version,
        idempotencyKey: crypto.randomUUID(),
      })
      setReverifyResult(response)
      setCommandState("accepted")
    } catch (error) {
      setCommandState(commandErrorState(error))
    }
  }

  const changeView = (nextView: LinkDisplayState) => {
    if (nextView === view) return
    setView(nextView)
    setCursors([undefined])
    setPageIndex(0)
    setSelected(null)
    setDetail(null)
    setDetailState("idle")
    resetDetailResources()
  }

  const nextPage = () => {
    const nextCursor = page?.nextCursor
    if (!page?.hasMore || !nextCursor) return
    setCursors((current) => [...current.slice(0, pageIndex + 1), nextCursor])
    setPageIndex((current) => current + 1)
    setSelected(null)
    setDetail(null)
    setDetailState("idle")
    resetDetailResources()
  }

  const previousPage = () => {
    if (pageIndex === 0) return
    setPageIndex((current) => current - 1)
    setSelected(null)
    setDetail(null)
    setDetailState("idle")
    resetDetailResources()
  }

  const selectedPlacementId =
    selected?.recordType === "placement" ? selected.placementId : null

  return (
    <section className="min-w-0" aria-labelledby="links-title">
      <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="size-5 text-primary" />
            <h2 className="text-base font-semibold" id="links-title">
              Links
            </h2>
            <Badge variant="outline">BL-AI-159</Badge>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            项目隔离的链接候选、确认和监控状态。Candidate 只表示候选，不是成功状态，且不计入成功 KPI。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline">当前页成功记录 {successCount}</Badge>
          <Button
            aria-label="刷新 Links 列表"
            size="icon-xs"
            title="刷新 Links 列表"
            variant="ghost"
            onClick={() => void loadPage()}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>

      <div
        className="mt-4 flex max-w-full gap-1 overflow-x-auto pb-1"
        aria-label="Links 状态筛选"
        role="tablist"
      >
        {views.map((item) => (
          <Button
            aria-controls="links-list-panel"
            aria-pressed={view === item.value}
            key={item.value}
            role="tab"
            size="sm"
            title={item.description}
            variant={view === item.value ? "secondary" : "ghost"}
            onClick={() => changeView(item.value)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      <div
        className="mt-3 overflow-hidden border"
        id="links-list-panel"
        role="tabpanel"
      >
        {state === "ready" ? (
          page ? (
            <>
              <ListRows items={page.items} openDetail={(item) => void openDetail(item)} />
              <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-muted-foreground">
                  第 {pageIndex + 1} 页 · seek pagination
                </div>
                <div className="flex gap-2">
                  <Button
                    aria-label="上一页"
                    disabled={pageIndex === 0}
                    size="sm"
                    title="上一页"
                    variant="outline"
                    onClick={previousPage}
                  >
                    <ArrowLeft />
                    上一页
                  </Button>
                  <Button
                    aria-label="下一页"
                    disabled={!page.hasMore || !page.nextCursor}
                    size="sm"
                    title="下一页"
                    variant="outline"
                    onClick={nextPage}
                  >
                    下一页
                    <ArrowRight />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <StateNotice state="loading" />
          )
        ) : (
          <StateNotice state={state} retry={() => void loadPage()} />
        )}
      </div>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (open) return
          setSelected(null)
          setDetail(null)
          setDetailState("idle")
          resetDetailResources()
        }}
      >
        <SheetContent className="w-full overflow-hidden p-0 sm:max-w-xl">
          {detailState === "ready" ? (
            detail ? (
              <DetailContent
                commandState={commandState}
                detail={detail}
                events={events}
                eventsState={eventsState}
                evidence={evidence}
                evidenceState={evidenceState}
                loadMoreEvents={() => {
                  if (selectedPlacementId && events?.nextCursor) {
                    void loadPlacementEvents(selectedPlacementId, events.nextCursor, true)
                  }
                }}
                readEvidence={(evidenceId) => void readEvidence(evidenceId)}
                reloadEvents={() => {
                  if (selectedPlacementId) void loadPlacementEvents(selectedPlacementId)
                }}
                requestReverify={(placement) => void requestReverify(placement)}
                reverifyResult={reverifyResult}
              />
            ) : null
          ) : detailState === "idle" ? null : (
            <DetailNotice
              retry={selected ? () => void openDetail(selected) : undefined}
              state={detailState}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  )
}
