import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  History,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

import { isLinksApiStatus } from "./api"
import type {
  BacklinkInventoryDirectObservationsResponse,
  BacklinkInventoryResponse,
  BacklinkProfileResponse,
  LinksClient,
} from "./types"

const inventoryPageSize = 20
const destructiveBadgeClass =
  "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
const terminalJobStatuses = new Set([
  "completed",
  "partial",
  "waiting_provider",
  "failed",
])

type LoadState = "loading" | "ready" | "error" | "forbidden"
type InventoryStatus = "all" | "live" | "lost" | "unknown"
type InventorySource = "all" | "DATAFORSEO" | "USER_IMPORTED"
type InventorySort = "last_seen_desc" | "rank_desc" | "spam_desc"
type InventoryItem = BacklinkInventoryResponse["items"][number]
type DirectObservation =
  BacklinkInventoryDirectObservationsResponse["items"][number]

const numberFormat = new Intl.NumberFormat("zh-CN")

function count(value: number | null | undefined) {
  return value === null || value === undefined ? "不可用" : numberFormat.format(value)
}

function dateTime(value: string | null | undefined) {
  if (!value) return "未记录"
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function percentage(value: number | null | undefined) {
  return value === null || value === undefined
    ? "不可用"
    : `${Math.round(value * 100)}%`
}

function cost(value: number) {
  return `${numberFormat.format(value)} μ`
}

function directStatusVariant(
  status: InventoryItem["directValidationStatus"]
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "LOST" || status === "CHANGED") return "destructive"
  if (status === "VALID" || status === "RECOVERED") return "secondary"
  return "outline"
}

function numericEntries(value: unknown): Array<[string, number]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return []
  }
  return Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
}

function Distribution({
  label,
  value,
}: {
  label: string
  value: unknown
}) {
  const entries = numericEntries(value)
  const maximum = Math.max(1, ...entries.map((entry) => entry[1]))
  return (
    <div className="min-w-0 border-l-2 pl-3">
      <div className="text-xs font-medium">{label}</div>
      {entries.length === 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">暂无可用分布</div>
      ) : (
        <div className="mt-2 space-y-2">
          {entries.map(([name, valueCount]) => (
            <div key={name}>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate" title={name}>
                  {name}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {numberFormat.format(valueCount)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.max(4, (valueCount / maximum) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="min-w-0 border-l-2 px-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  )
}

function HealthComponents({
  components,
}: {
  components: BacklinkProfileResponse["health"] extends infer Health
    ? Health extends { components: infer Components }
      ? Components
      : never
    : never
}) {
  return (
    <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {components.map((component, index) => {
        const label =
          typeof component.label === "string"
            ? component.label
            : typeof component.id === "string"
              ? component.id
              : `component-${index + 1}`
        const score =
          typeof component.score === "number" ? component.score : null
        return (
          <div key={`${label}-${index}`} className="min-w-0">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate" title={label}>
                {label}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {score === null ? "不可用" : score.toFixed(1)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden bg-muted">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.max(0, Math.min(100, score ?? 0))}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function BacklinkProfilePanel({
  websiteProjectKey,
  client,
}: {
  websiteProjectKey: string
  client: LinksClient
}) {
  const [profile, setProfile] = useState<BacklinkProfileResponse | null>(null)
  const [inventory, setInventory] =
    useState<BacklinkInventoryResponse | null>(null)
  const [profileState, setProfileState] = useState<LoadState>("loading")
  const [inventoryState, setInventoryState] = useState<LoadState>("loading")
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<InventoryStatus>("all")
  const [source, setSource] = useState<InventorySource>("all")
  const [sort, setSort] = useState<InventorySort>("last_seen_desc")
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [sourceUrl, setSourceUrl] = useState("")
  const [targetUrl, setTargetUrl] = useState("")
  const [anchorText, setAnchorText] = useState("")
  const [notes, setNotes] = useState("")
  const [managed, setManaged] = useState(true)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [busyItems, setBusyItems] = useState<ReadonlySet<string>>(new Set())
  const [historyItemId, setHistoryItemId] = useState<string | null>(null)
  const [historyState, setHistoryState] =
    useState<"idle" | "loading" | "ready" | "error">("idle")
  const [historyItems, setHistoryItems] = useState<DirectObservation[]>([])

  const loadProfile = useCallback(
    async (signal?: AbortSignal) => {
      setProfileState("loading")
      try {
        const result = await client.getBacklinkProfile(
          websiteProjectKey,
          signal
        )
        setProfile(result)
        setProfileState("ready")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        setProfileState(isLinksApiStatus(error, 403) ? "forbidden" : "error")
      }
    },
    [client, websiteProjectKey]
  )

  const loadInventory = useCallback(
    async (signal?: AbortSignal) => {
      setInventoryState("loading")
      try {
        const result = await client.listBacklinkInventory(
          websiteProjectKey,
          {
            page,
            pageSize: inventoryPageSize,
            sort,
            ...(query.trim() ? { query: query.trim() } : {}),
            ...(status === "all" ? {} : { status }),
            ...(source === "all" ? {} : { source }),
          },
          signal
        )
        setInventory(result)
        setInventoryState("ready")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        setInventoryState(isLinksApiStatus(error, 403) ? "forbidden" : "error")
      }
    },
    [client, page, query, sort, source, status, websiteProjectKey]
  )

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void loadProfile(controller.signal)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadProfile])

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void loadInventory(controller.signal)
    }, 200)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [loadInventory])

  const runSync = async () => {
    setSyncing(true)
    setSyncMessage(null)
    try {
      const started = await client.requestBacklinkProfileSync(
        websiteProjectKey,
        crypto.randomUUID()
      )
      if (started.providerInputRequired || started.status === "waiting_provider") {
        setSyncMessage("Provider 配置或预算不足，已保留当前快照。")
        await loadProfile()
        return
      }
      let job = await client.getBacklinkProfileSyncJob(
        websiteProjectKey,
        started.jobId
      )
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (terminalJobStatuses.has(job.status)) break
        await new Promise((resolve) => window.setTimeout(resolve, 1_500))
        job = await client.getBacklinkProfileSyncJob(
          websiteProjectKey,
          started.jobId
        )
      }
      setSyncMessage(
        job.status === "completed" || job.status === "partial"
          ? `同步完成：${numberFormat.format(job.pulledCount)} 条库存`
          : job.status === "waiting_provider"
            ? "Provider 配置或预算不足，已保留当前快照。"
            : `同步状态：${job.status}`
      )
      await Promise.all([loadProfile(), loadInventory()])
    } catch {
      setSyncMessage("同步请求失败，请稍后重试。")
    } finally {
      setSyncing(false)
    }
  }

  const setItemBusy = (inventoryItemId: string, busy: boolean) => {
    setBusyItems((current) => {
      const next = new Set(current)
      if (busy) next.add(inventoryItemId)
      else next.delete(inventoryItemId)
      return next
    })
  }

  const importInventoryItem = async () => {
    if (!sourceUrl.trim() || !targetUrl.trim()) {
      setActionMessage("来源 URL 和 Target URL 均为必填项。")
      return
    }
    setImporting(true)
    setActionMessage(null)
    try {
      const result = await client.importBacklinkInventoryItem(
        websiteProjectKey,
        {
          sourceUrl: sourceUrl.trim(),
          targetUrl: targetUrl.trim(),
          ...(anchorText.trim() ? { anchorText: anchorText.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          managed,
        }
      )
      setActionMessage(
        result.replayed
          ? "该来源与 Target 已存在，已返回原库存记录。"
          : `已导入库存并分配 Tier ${result.tier} 监控策略。`
      )
      setSourceUrl("")
      setTargetUrl("")
      setAnchorText("")
      setNotes("")
      setPage(1)
      await Promise.all([loadInventory(), loadProfile()])
    } catch (error) {
      setActionMessage(
        isLinksApiStatus(error, 403)
          ? "无权导入当前项目库存。"
          : "库存导入失败，请检查 URL 后重试。"
      )
    } finally {
      setImporting(false)
    }
  }

  const updateInventoryPolicy = async (
    item: InventoryItem,
    input: Readonly<{
      important: boolean
      monitoringStatus: "enabled" | "paused"
    }>
  ) => {
    setItemBusy(item.inventoryItemId, true)
    setActionMessage(null)
    try {
      const result = await client.updateBacklinkInventoryPolicy(
        websiteProjectKey,
        item.inventoryItemId,
        {
          expectedVersion: item.policyRevision,
          ...input,
        }
      )
      setActionMessage(
        `监控策略已更新：Tier ${result.tier} · ${result.monitoringStatus}。`
      )
      await loadInventory()
    } catch (error) {
      setActionMessage(
        isLinksApiStatus(error, 409)
          ? "策略已被其他操作更新，库存已重新加载。"
          : "监控策略更新失败。"
      )
      await loadInventory()
    } finally {
      setItemBusy(item.inventoryItemId, false)
    }
  }

  const requestInventoryCheck = async (item: InventoryItem) => {
    setItemBusy(item.inventoryItemId, true)
    setActionMessage(null)
    try {
      const result = await client.requestBacklinkInventoryCheck(
        websiteProjectKey,
        item.inventoryItemId,
        crypto.randomUUID()
      )
      setActionMessage(
        result.replayed
          ? "已存在相同的耐久检查请求。"
          : `直接验证已进入耐久任务：${result.workflowId}。`
      )
      await loadInventory()
    } catch {
      setActionMessage("直接验证请求失败；暂停的策略需要先恢复。")
    } finally {
      setItemBusy(item.inventoryItemId, false)
    }
  }

  const toggleHistory = async (item: InventoryItem) => {
    if (historyItemId === item.inventoryItemId) {
      setHistoryItemId(null)
      setHistoryItems([])
      setHistoryState("idle")
      return
    }
    setHistoryItemId(item.inventoryItemId)
    setHistoryItems([])
    setHistoryState("loading")
    try {
      const result = await client.listBacklinkInventoryDirectObservations(
        websiteProjectKey,
        item.inventoryItemId,
        20
      )
      setHistoryItems(result.items)
      setHistoryState("ready")
    } catch {
      setHistoryState("error")
    }
  }

  const distributions = profile?.snapshot?.distributions ?? {}
  const coverage = profile?.snapshot?.inventoryCoverage
  const health = profile?.health
  const statusBadges = useMemo(() => {
    if (!profile) return []
    return [
      ...(profile.sync.providerInputRequired
        ? [{ label: "Provider required", variant: "destructive" as const }]
        : []),
      ...(profile.sync.stale
        ? [{ label: "Stale", variant: "secondary" as const }]
        : []),
      ...(profile.sync.partial
        ? [{ label: "Partial", variant: "outline" as const }]
        : []),
    ]
  }, [profile])

  return (
    <section className="border-b py-5" aria-labelledby="backlink-profile-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            <h3 id="backlink-profile-title" className="text-sm font-semibold">
              Backlink Profile
            </h3>
            {statusBadges.map((badge) => (
              <Badge
                key={badge.label}
                variant={badge.variant}
                className={
                  badge.variant === "destructive"
                    ? destructiveBadgeClass
                    : undefined
                }
              >
                {badge.label}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {profile?.canonicalDomain ?? websiteProjectKey} · provider 总量与可分页库存分开计算
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {profile && (
            <span className="text-xs text-muted-foreground">
              上次 {dateTime(profile.sync.lastSyncAt)} · 下次{" "}
              {dateTime(profile.sync.nextSyncAt)}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={syncing}
            onClick={() => void runSync()}
          >
            {syncing ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            立即同步
          </Button>
          <Button
            size="sm"
            variant={importOpen ? "secondary" : "outline"}
            onClick={() => setImportOpen((current) => !current)}
          >
            <Plus />
            导入现有链接
          </Button>
        </div>
      </div>

      {syncMessage && (
        <div className="mt-3 flex items-center gap-2 text-xs" role="status">
          <AlertTriangle className="size-4 text-muted-foreground" />
          {syncMessage}
        </div>
      )}
      {actionMessage && (
        <div className="mt-3 text-xs text-muted-foreground" role="status">
          {actionMessage}
        </div>
      )}

      {profileState === "loading" ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
      ) : profileState !== "ready" || profile === null ? (
        <div className="mt-5 border-y py-6 text-center text-sm text-muted-foreground">
          {profileState === "forbidden"
            ? "无权读取当前项目的 Backlink Profile。"
            : "Backlink Profile 读取失败。"}
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
            <Metric
              label="Backlinks"
              value={count(profile.snapshot?.totalBacklinks)}
              detail={`库存 ${count(profile.snapshot?.inventoryPulledCount)}`}
            />
            <Metric
              label="Referring domains"
              value={count(profile.snapshot?.referringDomains)}
            />
            <Metric
              label="Dofollow"
              value={count(profile.snapshot?.dofollow)}
              detail={`Nofollow ${count(profile.snapshot?.nofollow)}`}
            />
            <Metric
              label="New / Lost"
              value={`${count(profile.snapshot?.newBacklinks)} / ${count(
                profile.snapshot?.lostBacklinks
              )}`}
            />
            <Metric
              label="Inventory coverage"
              value={percentage(coverage)}
              detail={profile.snapshot?.completeness ?? "unavailable"}
            />
            <Metric
              label="本次成本"
              value={cost(profile.snapshot?.costMicros ?? 0)}
              detail={`预估 ${cost(profile.sync.estimatedCostMicros)}`}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.65fr)]">
            <div>
              <div className="mb-3 flex items-center gap-2">
                <span className="text-xs font-medium">Profile health</span>
                <Badge variant={health?.score === null ? "outline" : "secondary"}>
                  {health?.grade ?? "INSUFFICIENT_DATA"}
                  {health?.score === null || health?.score === undefined
                    ? ""
                    : ` · ${health.score}`}
                </Badge>
                {health && (
                  <span className="text-xs text-muted-foreground">
                    {health.modelVersion}
                  </span>
                )}
              </div>
              {health && health.components.length > 0 ? (
                <HealthComponents components={health.components} />
              ) : (
                <div className="border-y py-5 text-xs text-muted-foreground">
                  库存覆盖不足，健康度保持 insufficient data。
                </div>
              )}
              {health && (health.risks.length > 0 || health.positives.length > 0) && (
                <div className="mt-4 grid gap-4 text-xs sm:grid-cols-2">
                  <div>
                    <div className="font-medium">风险</div>
                    <div className="mt-1 text-muted-foreground">
                      {health.risks.join(" · ") || "无确定性风险"}
                    </div>
                  </div>
                  <div>
                    <div className="font-medium">正向信号</div>
                    <div className="mt-1 text-muted-foreground">
                      {health.positives.join(" · ") || "证据不足"}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="grid gap-5 sm:grid-cols-3 lg:grid-cols-1">
              <Distribution label="Anchor" value={distributions.anchors} />
              <Distribution label="Country" value={distributions.countries} />
              <Distribution
                label="Source domain"
                value={distributions.sourceDomains}
              />
            </div>
          </div>
        </>
      )}

      {importOpen && (
        <div className="mt-6 border-y bg-muted/20 px-3 py-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium">
              来源页面 URL
              <Input
                type="url"
                placeholder="https://publisher.example/article"
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Target URL
              <Input
                type="url"
                placeholder="https://example.com/target"
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              Anchor
              <Input
                placeholder="可选"
                value={anchorText}
                onChange={(event) => setAnchorText(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              备注
              <Textarea
                className="min-h-9 resize-y"
                placeholder="可选"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={managed}
                onCheckedChange={(checked) => setManaged(checked === true)}
              />
              作为 Managed Placement Candidate 纳入 Tier A
            </label>
            <Button
              size="sm"
              disabled={importing}
              onClick={() => void importInventoryItem()}
            >
              {importing ? <LoaderCircle className="animate-spin" /> : <Plus />}
              导入库存
            </Button>
          </div>
        </div>
      )}

      <div className="mt-7 flex flex-col gap-3 border-t pt-4 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索 Backlink Inventory"
            className="pl-9"
            placeholder="搜索来源域名、URL 或 anchor"
            value={query}
            onChange={(event) => {
              setPage(1)
              setQuery(event.target.value)
            }}
          />
        </div>
        <Select
          value={status}
          onValueChange={(value) => {
            setPage(1)
            setStatus(value as InventoryStatus)
          }}
        >
          <SelectTrigger className="w-full lg:w-36" aria-label="库存状态">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="live">Live</SelectItem>
            <SelectItem value="lost">Lost</SelectItem>
            <SelectItem value="unknown">Unknown</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={source}
          onValueChange={(value) => {
            setPage(1)
            setSource(value as InventorySource)
          }}
        >
          <SelectTrigger className="w-full lg:w-40" aria-label="库存来源">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部来源</SelectItem>
            <SelectItem value="DATAFORSEO">DataForSEO</SelectItem>
            <SelectItem value="USER_IMPORTED">User imported</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(value) => {
            setPage(1)
            setSort(value as InventorySort)
          }}
        >
          <SelectTrigger className="w-full lg:w-40" aria-label="库存排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last_seen_desc">最近发现</SelectItem>
            <SelectItem value="rank_desc">Rank</SelectItem>
            <SelectItem value="spam_desc">Spam</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 overflow-hidden border">
        {inventoryState === "loading" ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-10" />
            ))}
          </div>
        ) : inventoryState !== "ready" || inventory === null ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {inventoryState === "forbidden"
              ? "无权读取当前项目库存。"
              : "Backlink Inventory 读取失败。"}
          </div>
        ) : inventory.items.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            当前筛选条件下没有库存记录。
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>来源页面</TableHead>
                <TableHead>Target / Anchor</TableHead>
                <TableHead>Provider 证据</TableHead>
                <TableHead>Direct 验证</TableHead>
                <TableHead>质量</TableHead>
                <TableHead>监控策略</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventory.items.map((item) => {
                const itemBusy = busyItems.has(item.inventoryItemId)
                const providerOnly = item.monitoringStatus === "provider_only"
                const itemLabel = item.sourceDomain ?? item.sourceUrl
                return (
                  <Fragment key={item.inventoryItemId}>
                    <TableRow>
                      <TableCell className="max-w-64 whitespace-normal">
                        <a
                          className="inline-flex max-w-full items-center gap-1 font-medium hover:underline"
                          href={item.sourceUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <span className="truncate">{itemLabel}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {item.sourceUrl}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {item.placementId && (
                            <Badge variant="outline">Placement</Badge>
                          )}
                          {item.opportunityId && (
                            <Badge variant="outline">Opportunity</Badge>
                          )}
                          {item.managed && <Badge variant="outline">Managed</Badge>}
                          {item.pinned && <Badge variant="outline">Pinned</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-72 whitespace-normal">
                        <div className="truncate text-xs" title={item.targetUrl}>
                          {item.targetUrl}
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {item.anchorText || "无 anchor"} ·{" "}
                          {item.relAttributes.join(", ") || "rel unavailable"}
                        </div>
                        {item.userNotes && (
                          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {item.userNotes}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={
                            item.providerStatus === "lost"
                              ? "destructive"
                              : item.providerStatus === "live"
                                ? "secondary"
                                : "outline"
                          }
                          className={
                            item.providerStatus === "lost"
                              ? destructiveBadgeClass
                              : undefined
                          }
                        >
                          Provider {item.providerStatus}
                        </Badge>
                        <div className="mt-1 text-muted-foreground">
                          {item.sourceType} · {item.provider}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          首次 {dateTime(item.firstSeenAt)}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          最近 {dateTime(item.lastSeenAt)}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge
                          variant={directStatusVariant(
                            item.directValidationStatus
                          )}
                          className={
                            item.directValidationStatus === "LOST" ||
                            item.directValidationStatus === "CHANGED"
                              ? destructiveBadgeClass
                              : undefined
                          }
                        >
                          Direct {item.directValidationStatus}
                        </Badge>
                        <div className="mt-1 text-muted-foreground">
                          {item.directHealthStatus}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          上次 {dateTime(item.lastDirectCheckedAt)}
                        </div>
                        {item.restrictionReason && (
                          <div className="mt-1 max-w-48 text-amber-700 dark:text-amber-300">
                            受限：{item.restrictionReason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        <div>Rank {item.rank ?? "—"}</div>
                        <div className="mt-1 text-muted-foreground">
                          Spam {item.spamScore ?? "—"}
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          HTTP {item.sourceHttpStatus ?? "—"} /{" "}
                          {item.targetHttpStatus ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell className="min-w-48 text-xs">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant="secondary">Tier {item.tier}</Badge>
                          <Badge variant="outline">{item.monitoringStatus}</Badge>
                          {item.importance === "important" && (
                            <Badge variant="outline">Important</Badge>
                          )}
                        </div>
                        <div className="mt-2 text-muted-foreground">
                          下次 {dateTime(item.nextCheckAt)}
                        </div>
                        {item.providerOnlyReason && (
                          <div className="mt-1 text-muted-foreground">
                            {item.providerOnlyReason}
                          </div>
                        )}
                        <div className="mt-2 flex items-center gap-1">
                          <Button
                            aria-label={`${item.importance === "important" ? "取消重要" : "标记重要"} ${itemLabel}`}
                            size="icon-xs"
                            title={
                              item.importance === "important"
                                ? "取消重要"
                                : "标记重要"
                            }
                            variant="ghost"
                            disabled={itemBusy}
                            onClick={() =>
                              void updateInventoryPolicy(item, {
                                important: item.importance !== "important",
                                monitoringStatus:
                                  item.monitoringStatus === "paused"
                                    ? "paused"
                                    : "enabled",
                              })
                            }
                          >
                            <Star
                              className={
                                item.importance === "important"
                                  ? "fill-current"
                                  : undefined
                              }
                            />
                          </Button>
                          <Button
                            aria-label={`${item.monitoringStatus === "paused" ? "恢复监控" : "暂停监控"} ${itemLabel}`}
                            size="icon-xs"
                            title={
                              item.monitoringStatus === "paused"
                                ? "恢复监控"
                                : "暂停监控"
                            }
                            variant="ghost"
                            disabled={itemBusy || providerOnly}
                            onClick={() =>
                              void updateInventoryPolicy(item, {
                                important: item.importance === "important",
                                monitoringStatus:
                                  item.monitoringStatus === "paused"
                                    ? "enabled"
                                    : "paused",
                              })
                            }
                          >
                            {item.monitoringStatus === "paused" ? (
                              <Play />
                            ) : (
                              <Pause />
                            )}
                          </Button>
                          <Button
                            aria-label={`立即检查 ${itemLabel}`}
                            size="icon-xs"
                            title="立即检查"
                            variant="ghost"
                            disabled={
                              itemBusy || item.monitoringStatus !== "enabled"
                            }
                            onClick={() => void requestInventoryCheck(item)}
                          >
                            {itemBusy ? (
                              <LoaderCircle className="animate-spin" />
                            ) : (
                              <RefreshCw />
                            )}
                          </Button>
                          <Button
                            aria-label={`查看历史 ${itemLabel}`}
                            size="icon-xs"
                            title="查看直接验证历史"
                            variant={
                              historyItemId === item.inventoryItemId
                                ? "secondary"
                                : "ghost"
                            }
                            onClick={() => void toggleHistory(item)}
                          >
                            <History />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {historyItemId === item.inventoryItemId && (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/20 p-4">
                          <div className="text-xs font-medium">
                            Direct validation history
                          </div>
                          {historyState === "loading" ? (
                            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                              <LoaderCircle className="size-4 animate-spin" />
                              正在读取不可变证据
                            </div>
                          ) : historyState === "error" ? (
                            <div className="mt-3 text-xs text-muted-foreground">
                              直接验证历史读取失败。
                            </div>
                          ) : historyItems.length === 0 ? (
                            <div className="mt-3 text-xs text-muted-foreground">
                              尚无直接验证 Observation。
                            </div>
                          ) : (
                            <div className="mt-3 divide-y border-y">
                              {historyItems.map((observation) => (
                                <div
                                  key={observation.observationId}
                                  className="grid gap-2 py-3 text-xs lg:grid-cols-[160px_180px_minmax(0,1fr)]"
                                >
                                  <div>
                                    <div className="font-medium">
                                      {observation.directValidationStatus}
                                    </div>
                                    <div className="mt-1 text-muted-foreground">
                                      {observation.result} ·{" "}
                                      {dateTime(observation.observedAt)}
                                    </div>
                                  </div>
                                  <div className="text-muted-foreground">
                                    {observation.restrictionReason ??
                                      observation.failureCode ??
                                      "无访问限制"}
                                  </div>
                                  <details>
                                    <summary className="cursor-pointer font-medium">
                                      Evidence snapshot
                                    </summary>
                                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
                                      {JSON.stringify(
                                        observation.evidenceSnapshot,
                                        null,
                                        2
                                      )}
                                    </pre>
                                  </details>
                                </div>
                              ))}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        )}
        {inventory && (
          <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {numberFormat.format(inventory.totalCount)} 条 · 第 {inventory.page} /{" "}
              {Math.max(1, inventory.totalPages)} 页
            </span>
            <div className="flex gap-1">
              <Button
                aria-label="上一页 Backlink Inventory"
                size="icon-xs"
                title="上一页"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ArrowLeft />
              </Button>
              <Button
                aria-label="下一页 Backlink Inventory"
                size="icon-xs"
                title="下一页"
                variant="ghost"
                disabled={page >= inventory.totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                <ArrowRight />
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
