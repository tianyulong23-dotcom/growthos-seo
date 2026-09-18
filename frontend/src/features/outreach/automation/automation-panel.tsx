import { useEffect, useRef, useState } from "react"
import {
  ExternalLink,
  FileCheck2,
  Globe,
  Play,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Square,
} from "lucide-react"
import { Link } from "react-router"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SendBatchPanel } from "./send-batch-panel"
import "./automation-workspace.css"

import {
  createConsent,
  readAutomation,
  revokeConsent,
  startExecution,
  type ConsentInput,
  type DraftParameters,
  type Execution,
} from "./api"

const stageLabels: Record<string, string> = {
  recommend: "等待推荐",
  publish: "发布推荐",
  next_batch: "等待下一批",
  refill: "补充推荐池",
  wait_refill: "等待补货完成",
  publish_refill: "发布补货批次",
  pin_refill: "核验新批次",
  page: "筛选网站",
  join: "加入机会",
  draft: "创建草稿任务",
  job: "等待草稿生成",
  verify: "核验草稿",
  quality: "修订与重新审核草稿",
  done: "草稿流程结束",
  paused: "已暂停，待核查",
}
const resultLabels: Record<string, string> = {
  VERIFIED_DRAFT: "草稿已核验",
  DRAFT_REQUIRES_REVIEW: "草稿待核查",
  JOB_FAILED: "生成失败",
  SKIPPED: "已跳过",
  EXISTING_DRAFT: "已有草稿",
}
const consentLabels = { active: "有效", expired: "已过期", revoked: "已撤销" }
const activeRuns = new Set(["queued", "running", "executing", "verifying"])

function errorText(error: unknown) {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR"
  const messages: Record<string, string> = {
    BACKLINKS_PROJECT_INPUTS_NOT_READY: "项目资料尚未就绪，请先完成项目确认。",
    BACKLINKS_AUTOMATION_ALREADY_RUNNING:
      "本项目已有自动化任务，未创建重复任务。",
    BACKLINKS_CONSENT_INACTIVE: "授权已过期或已撤销，不能启动。",
    BACKLINKS_CONSENT_PERMISSION_DENIED: "当前用户没有此操作权限。",
    BACKLINKS_AUTOMATION_REQUEST_CONFLICT:
      "此授权已有不同参数的任务，请刷新核查。",
  }
  return messages[code] ?? `请求未核实，请刷新核查或重试原请求。${code}`
}

export function AutomationPanel({
  websiteProjectKey,
  gmailConnectionId = null,
}: {
  websiteProjectKey: string
  gmailConnectionId?: string | null
}) {
  return (
    <ProjectAutomation
      key={websiteProjectKey}
      project={websiteProjectKey}
      gmailConnectionId={gmailConnectionId}
    />
  )
}

function ProjectAutomation({
  project,
  gmailConnectionId,
}: {
  project: string
  gmailConnectionId: string | null
}) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof readAutomation>
  > | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newGrant, setNewGrant] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [startConfirmed, setStartConfirmed] = useState(false)
  const [revokeConfirmed, setRevokeConfirmed] = useState(false)
  const [opportunities, setOpportunities] = useState("10")
  const [drafts, setDrafts] = useState("5")
  const [modelBudget, setModelBudget] = useState("2")
  const [paidBudget, setPaidBudget] = useState("0")
  const [hours, setHours] = useState("24")
  const [url, setUrl] = useState("")
  const [language, setLanguage] = useState("en")
  const [grantRequest, setGrantRequest] = useState<ConsentInput | null>(null)
  const [startRequest, setStartRequest] = useState<DraftParameters | null>(null)
  const alive = useRef(true)
  const mutationInFlight = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (busy) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const result = await readAutomation(
          project,
          selected,
          controller.signal
        )
        if (controller.signal.aborted) return
        if (result.execution) setStartRequest(null)
        setData(result)
        setReadError(null)
        if (
          result.consent?.state === "active" ||
          (result.execution && activeRuns.has(result.execution.status))
        ) {
          timer = setTimeout(() => void load(), 5000)
        }
      } catch (failure) {
        if (!controller.signal.aborted) setReadError(errorText(failure))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [project, selected, revision, busy])

  const consent = data?.consent
  const chatPolicy = consent?.policy.policy_version === "backlinks-chat-send.v1"
    ? consent.policy : null
  const campaignPolicy = consent?.policy.policy_version === "backlinks-chat-campaign.v1"
    ? consent.policy : null
  const senderId = campaignPolicy
    ? campaignPolicy.gmail_connection_id
    : chatPolicy?.targets.gmail_connection_id ?? gmailConnectionId
  const execution = data?.execution
  const canMutate = !busy && !loading && !readError && !error
  const active = consent?.state === "active"
  const showForm =
    newGrant || !!grantRequest || (data !== null && !consent)

  async function mutate(action: () => Promise<void>) {
    if (mutationInFlight.current) return
    mutationInFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      if (alive.current) setRevision((value) => value + 1)
    } catch (failure) {
      if (alive.current) setError(errorText(failure))
    } finally {
      mutationInFlight.current = false
      if (alive.current) {
        setLoading(true)
        setBusy(false)
      }
    }
  }

  function grant() {
    if (!confirmed || mutationInFlight.current) return
    // Keep the exact identity, expiry and policy after an uncertain POST response.
    const request = grantRequest ?? {
      request_id: crypto.randomUUID(),
      policy_version: "backlinks-drafts-only.v1",
      confirmed: true,
      expires_at: new Date(Date.now() + Number(hours) * 3600000).toISOString(),
      max_opportunities: Number(opportunities),
      max_drafts: Number(drafts),
      max_model_cost_usd: modelBudget,
      max_paid_tool_cost_usd: paidBudget,
    }
    setGrantRequest(request)
    void mutate(async () => {
      const created = await createConsent(project, request)
      if (!alive.current) return
      setGrantRequest(null)
      setSelected(created.id)
      setNewGrant(false)
      setConfirmed(false)
    })
  }

  function start() {
    if (
      !consent ||
      !active ||
      !startConfirmed ||
      execution ||
      mutationInFlight.current
    ) return
    if (Date.parse(consent.expires_at) <= Date.now()) {
      setError(errorText(new Error("BACKLINKS_CONSENT_INACTIVE")))
      setLoading(true)
      setRevision((value) => value + 1)
      return
    }
    const request = startRequest ?? { promotionTargetUrl: url, language }
    setStartRequest(request)
    void mutate(async () => {
      await startExecution(project, consent.id, request)
      if (!alive.current) return
      setStartRequest(null)
      setStartConfirmed(false)
    })
  }

  return (
    <section aria-label="外链自动化" className="mail-automation min-w-0 space-y-4 py-4">
      <header className="mail-view-toolbar flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4" />
          {chatPolicy || campaignPolicy ? "自动外联任务" : "草稿自动化"}
        </h2>
        <span className="text-xs text-muted-foreground">
          {chatPolicy || campaignPolicy?.send_authorized
            ? active ? "本批已获聊天发送授权" : "本批聊天发送授权已失效"
            : "草稿授权不包含发送"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          title="刷新自动化"
          aria-label="刷新自动化"
          disabled={loading || busy}
          onClick={() => {
            setError(null)
            setLoading(true)
            setRevision((value) => value + 1)
          }}
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </header>
      {execution ? (
        <ExecutionProgress execution={execution} project={project} campaign={!!campaignPolicy} />
      ) : null}
      <div className="mail-automation-columns">
      <div className="mail-automation-controls">
      <h3 className="automation-section-title"><SlidersHorizontal className="size-4" />任务与授权</h3>
      {loading && !data ? <p role="status">正在读取授权与进度...</p> : null}
      {error ? (
        <p role="alert" className="text-sm break-all text-destructive">
          {error}
        </p>
      ) : null}
      {readError ? (
        <p role="alert" className="text-sm break-all text-destructive">
          {readError}
        </p>
      ) : null}
      {data && data.items.length > 0 ? (
        <label className="block max-w-full text-sm">
          选择任务批次
          <select
            className="mt-1 block h-9 w-full min-w-0 rounded-md border bg-background px-2"
            aria-label="授权记录"
            value={consent?.id ?? ""}
            disabled={busy || !!startRequest || !!grantRequest}
            onChange={(event) => {
              setLoading(true)
              setSelected(event.target.value)
              setData(null)
              setStartConfirmed(false)
              setRevokeConfirmed(false)
              setNewGrant(false)
            }}
          >
            {data.items.map((item) => (
              <option key={item.id} value={item.id}>
                {new Date(item.created_at).toLocaleString()} ·{" "}
                {consentLabels[item.state]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {consent && !showForm ? (
        <div className="space-y-3 text-sm">
          <p>
            授权{consentLabels[consent.state]} · 到期{" "}
            {new Date(consent.expires_at).toLocaleString()}
          </p>
          {consent.state !== "active" ? (
            <p className="text-xs text-muted-foreground">
              后续操作已禁止，已提交的任务仍可能完成。
            </p>
          ) : null}
          {consent.policy.policy_version !== "backlinks-chat-send.v1" ? (
            <>
              <p>
                最多 {consent.policy.max_opportunities} 个机会，
                {consent.policy.max_drafts} 次草稿尝试
              </p>
              <p>
                预算上限：模型 ${consent.policy.max_model_cost_usd}，付费工具 $
                {consent.policy.max_paid_tool_cost_usd}
              </p>
              {campaignPolicy ? (
                <p>{campaignPolicy.send_authorized
                  ? `自动外联批次 · 最多发送 ${campaignPolicy.max_drafts} 封邮件`
                  : "自动外联批次 · 仅生成草稿"}</p>
              ) : null}
            </>
          ) : (
            <p>聊天发送批次 · {consent.policy.targets.items.length} 封邮件</p>
          )}
          <details className="automation-disclosure">
          <summary>管理授权</summary>
          {active ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={revokeConfirmed}
                  disabled={busy}
                  onChange={(event) => setRevokeConfirmed(event.target.checked)}
                />
                撤销授权并停止后续操作
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={!canMutate || !revokeConfirmed}
                onClick={() =>
                  void mutate(async () => {
                    await revokeConsent(project, consent.id)
                    if (alive.current) setRevokeConfirmed(false)
                  })
                }
              >
                <Square className="size-4" />
                撤销授权
              </Button>
            </div>
          ) : null}
          {!execution || !activeRuns.has(execution.status) ? (
            <Button
              variant="outline"
              disabled={!canMutate || !!startRequest}
              onClick={() => setNewGrant(true)}
            >
              新建草稿授权
            </Button>
          ) : null}
          </details>
        </div>
      ) : null}
      {showForm ? (
        <form
          className="space-y-4 border-y py-4"
          onSubmit={(event) => {
            event.preventDefault()
            grant()
          }}
        >
          <fieldset
            disabled={busy || !!grantRequest}
            className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            {(
              [
                [
                  "机会数量上限",
                  opportunities,
                  setOpportunities,
                  "1",
                  "100",
                  "1",
                ],
                ["草稿尝试上限", drafts, setDrafts, "1", opportunities, "1"],
                ["有效期（小时）", hours, setHours, "1", "168", "1"],
                [
                  "模型预算上限（USD）",
                  modelBudget,
                  setModelBudget,
                  "0.01",
                  "100",
                  "0.01",
                ],
                [
                  "付费工具预算上限（USD）",
                  paidBudget,
                  setPaidBudget,
                  "0",
                  "100",
                  "0.01",
                ],
              ] as const
            ).map(([label, value, setter, min, max, step]) => (
              <label key={label} className="min-w-0 text-sm">
                {label}
                <Input
                  type="number"
                  className="mt-1"
                  required
                  min={min}
                  max={max}
                  step={step}
                  value={value}
                  onChange={(event) => setter(event.target.value)}
                />
              </label>
            ))}
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={confirmed}
              disabled={busy || !!grantRequest}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            允许此项目在上述期限和限额内获取推荐、加入机会、生成草稿；不包括审批和发送。
          </label>
          <Button
            type="submit"
            disabled={busy || loading || !!readError || !confirmed}
          >
            <ShieldCheck className="size-4" />
            {grantRequest ? "重试原授权请求" : "确认草稿授权"}
          </Button>
        </form>
      ) : null}
      {consent && active && !execution && !showForm && consent.policy.policy_version === "backlinks-drafts-only.v1" ? (
        <form
          className="space-y-4 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault()
            start()
          }}
        >
          <fieldset
            className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]"
            disabled={busy || !!startRequest}
          >
            <label className="min-w-0 text-sm">
              推广目标 URL
              <Input
                className="mt-1"
                type="url"
                pattern="https?://.+"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <label className="text-sm">
              邮件语言
              <select
                className="mt-1 h-9 w-full rounded-md border bg-background px-2"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </label>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={startConfirmed}
              disabled={busy}
              onChange={(event) => setStartConfirmed(event.target.checked)}
            />
            确认现在启动推荐至草稿流程
          </label>
          <Button
            type="submit"
            disabled={
              busy ||
              loading ||
              !!readError ||
              !startConfirmed ||
              (!!error && !startRequest)
            }
          >
            <Play className="size-4" />
            {startRequest ? "重试原启动请求" : "启动草稿流程"}
          </Button>
        </form>
      ) : null}
      </div>
      {(execution || chatPolicy) && consent && senderId ? (
        <SendBatchPanel
          key={`${consent.id}:${senderId}`}
          project={project}
          consent={consent.id}
          gmailConnectionId={senderId}
          draftIds={[
            ...new Set(
              (execution?.checkpoint.results ?? [])
                .filter(
                  (item) => item.state === "VERIFIED_DRAFT" && item.draftId
                )
                .map((item) => item.draftId!)
            ),
          ]}
        />
      ) : null}
      </div>
    </section>
  )
}

function ExecutionProgress({
  execution,
  project,
  campaign = false,
}: {
  execution: Execution
  project: string
  campaign?: boolean
}) {
  const { checkpoint } = execution
  const verified = checkpoint.results.filter(
    (item) => item.state === "VERIFIED_DRAFT"
  ).length
  return (
    <div className="automation-progress min-w-0">
      <div className="automation-progress-heading">
      <span className={`automation-state-dot ${execution.status === "completed" ? "is-complete" : ""}`} />
      <h3 className="text-sm font-semibold" role="status">
        {execution.status === "cancelled"
          ? "任务已取消"
          : execution.status === "failed" && checkpoint.stage !== "paused"
            ? "任务失败，待核查"
            : execution.status === "queued"
              ? "任务已排队"
              : campaign && checkpoint.stage === "done"
                ? "自动外联流程结束"
                : (stageLabels[checkpoint.stage] ?? checkpoint.stage)}
      </h3>
      </div>
      <div className="automation-metrics">
        <div><Globe className="size-4" /><span>已处理合作机会</span><strong>{checkpoint.usage.opportunities}</strong></div>
        <div><FileCheck2 className="size-4" /><span>已核验草稿</span><strong>{verified}</strong></div>
        <div><ShieldCheck className="size-4" /><span>草稿生成次数</span><strong>{checkpoint.usage.drafts}</strong></div>
      </div>
      {checkpoint.reason ? (
        <p className="text-sm break-all" role="status">
          停止原因：{checkpoint.reason}
        </p>
      ) : null}
      <details className="automation-disclosure automation-run-details">
      <summary>处理记录与费用</summary>
      <p className="text-xs break-all text-muted-foreground">
        任务 {execution.run_id} · {execution.status}
      </p>
      <p className="text-xs text-muted-foreground">
        保守预算预留，非实际扣费：模型 ${checkpoint.usage.model_usd}，付费工具 $
        {checkpoint.usage.paid_usd}
      </p>
      <ul aria-label="自动化结果" className="divide-y">
        {checkpoint.results.map((item) => (
          <li
            key={item.feedItemId}
            className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3 text-sm"
          >
            <div className="min-w-0 flex-1 break-all">
              <p>{resultLabels[item.state] ?? item.state}</p>
              <p className="text-xs text-muted-foreground">
                {item.opportunityId ?? item.feedItemId}
              </p>
              {item.reason ? <p className="text-xs">{item.reason}</p> : null}
              {item.quality && <p className="text-xs">
                {item.quality.state === "PASSED" ? "AI 审核通过" : "AI 审核未通过"}
                {" · "}{item.quality.reasons.join("；")}
              </p>}
            </div>
            {item.draftId ? (
              <Link
                className="flex shrink-0 items-center gap-1 text-primary hover:underline"
                to={`/projects/${encodeURIComponent(project)}/backlinks/drafts/${encodeURIComponent(item.draftId)}`}
              >
                {item.state === "VERIFIED_DRAFT" ? "审批与发送" : "核查草稿"}
                <ExternalLink className="size-3" />
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      </details>
    </div>
  )
}
