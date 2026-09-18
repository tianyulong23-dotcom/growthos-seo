import { useEffect, useRef, useState } from "react"
import { CheckCircle2, ClipboardCheck, Clock3, MailWarning, RefreshCw, Send, Square } from "lucide-react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { DraftReviewPanel } from "./draft-review-panel"
import {
  confirmSendBatch,
  previewSendBatch,
  readSendBatches,
  readBatchMonitoring,
  revokeSendBatch,
  type SendBatch,
  type SendPreviewInput,
  type BatchMonitoring,
} from "./api"

const labels: Record<string, string> = {
  preview: "待确认",
  queued: "已排队",
  running: "处理中",
  completed: "本批已获服务商接受",
  paused: "暂停，待核查",
  needs_review: "部分发送失败，待核查",
  revoked: "已撤销",
  cancelled: "已取消",
  PENDING: "未提交",
  SUBMITTING: "提交结果待核实",
  READY: "等待发送",
  DISPATCHING: "发送中",
  PROVIDER_ACCEPTED: "服务商已接受",
  DELIVERY_UNKNOWN: "发送结果未知",
  FAILED_RETRYABLE: "等待原任务重试",
  FAILED_FINAL: "发送失败",
  CANCELLED: "已取消",
  REJECTED: "已拒绝",
}

export function SendBatchPanel({
  project,
  consent,
  draftIds,
  gmailConnectionId,
}: {
  project: string
  consent: string
  draftIds: string[]
  gmailConnectionId: string
}) {
  const [items, setItems] = useState<SendBatch[]>([])
  const [monitoring, setMonitoring] = useState<BatchMonitoring | null>(null)
  const [monitorError, setMonitorError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [revokeConfirmed, setRevokeConfirmed] = useState(false)
  const [pending, setPending] = useState<SendPreviewInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const alive = useRef(true)
  const locked = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const result = await readBatchMonitoring(project, consent, controller.signal)
        if (!controller.signal.aborted) {
          setMonitoring(result)
          setMonitorError(false)
        }
      } catch {
        if (!controller.signal.aborted) setMonitorError(true)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 15_000)
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [project, consent])
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
        const result = await readSendBatches(
          project,
          consent,
          controller.signal
        )
        if (controller.signal.aborted) return
        setItems(result.items)
        setReadError(null)
        timer = setTimeout(() => void load(), 5000)
      } catch (failure) {
        if (!controller.signal.aborted)
          setReadError(failure instanceof Error ? failure.message : "读取失败")
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [project, consent, busy, revision])
  const batch = items.find((item) => item.id === selected) ?? items[0]
  const accepted = batch?.items.filter((item) => item.state === "PROVIDER_ACCEPTED").length ?? 0
  const waiting = batch?.items.filter((item) =>
    ["PENDING", "SUBMITTING", "READY", "DISPATCHING", "FAILED_RETRYABLE"].includes(item.state)
  ).length ?? 0
  const attention = batch?.items.filter((item) =>
    ["DELIVERY_UNKNOWN", "FAILED_FINAL", "REJECTED"].includes(item.state)
  ).length ?? 0
  const blocked = busy || loading || !!readError
  async function mutate(action: () => Promise<SendBatch>) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      if (!alive.current) return
      setSelected(result.id)
      setItems((values) => [
        result,
        ...values.filter((value) => value.id !== result.id),
      ])
      setConfirmed(false)
      setRevokeConfirmed(false)
      setPending(null)
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : "请求结果待核实")
    } finally {
      locked.current = false
      if (alive.current) {
        setLoading(true)
        setBusy(false)
      }
    }
  }
  function preview() {
    if (locked.current) return
    const request = pending ?? {
      request_id: crypto.randomUUID(),
      draft_ids: chosen,
      gmail_connection_id: gmailConnectionId,
    }
    setPending(request)
    void mutate(() => previewSendBatch(project, consent, request))
  }
  return (
    <section aria-label="批次发送" className="mail-send-batch min-w-0 space-y-3 border-t pt-4">
      <header className="flex items-center justify-between gap-3">
        <h3 className="automation-section-title"><Send className="size-4" />发送结果</h3>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新发送批次"
          title="刷新发送批次"
          disabled={busy || loading}
          onClick={() => {
            setLoading(true)
            setError(null)
            setRevision((v) => v + 1)
          }}
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>
      <div className="automation-send-summary" aria-label="本批发送概览">
        <div className="is-success"><CheckCircle2 className="size-4" /><strong>{loading || readError ? "—" : accepted}</strong><span>已发送 · 服务商已接受</span></div>
        <div><Clock3 className="size-4" /><strong>{loading || readError ? "—" : waiting}</strong><span>等待或正在发送</span></div>
        <div className={attention > 0 ? "is-warning" : ""}><MailWarning className="size-4" /><strong>{loading || readError ? "—" : attention}</strong><span>需要核查</span></div>
      </div>
      {!loading && !readError && !batch ? <p className="automation-empty">暂无发送记录</p> : null}
      {error || readError ? (
        <p role="alert" className="text-sm break-all text-destructive">
          {error ?? readError}
        </p>
      ) : null}
      {draftIds.length > 0 || pending ? <details className="automation-disclosure automation-manual-send" open={pending ? true : undefined}>
      <summary>手动选择草稿并提交发送</summary>
      <fieldset disabled={blocked || !!pending} className="space-y-2">
        <legend className="mb-2 text-sm">
          本次草稿（最多 20 封，须已审批）
        </legend>
        {draftIds.map((id) => (
          <label key={id} className="flex min-w-0 items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={chosen.includes(id)}
              onChange={(event) =>
                setChosen((values) =>
                  event.target.checked
                    ? [...values, id]
                    : values.filter((v) => v !== id)
                )
              }
            />
            <span className="break-all">{id}</span>
            <Link
              className="shrink-0 text-primary"
              to={`/projects/${encodeURIComponent(project)}/backlinks/drafts/${encodeURIComponent(id)}`}
            >
              查看草稿
            </Link>
          </label>
        ))}
      </fieldset>
      <Button
        variant="outline"
        disabled={
          blocked || (!pending && (chosen.length === 0 || chosen.length > 20))
        }
        onClick={preview}
      >
        <ClipboardCheck className="size-4" />
        {pending ? "重试原预览请求" : "预检并预览本批"}
      </Button>
      {pending ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setPending(null)
            setError(null)
          }}
        >
          放弃本次预览
        </Button>
      ) : null}
      </details> : null}
      {items.length > 0 ? (
        <label className="block text-sm">
          发送批次
          <select
            aria-label="发送批次"
            className="mt-1 h-9 w-full min-w-0 rounded-md border bg-background px-2"
            value={batch?.id ?? ""}
            disabled={busy}
            onChange={(event) => {
              setSelected(event.target.value)
              setConfirmed(false)
              setRevokeConfirmed(false)
              setError(null)
            }}
          >
            {items.map((item, index) => (
              <option key={item.id} value={item.id}>
                批次 {items.length - index} · {item.items.length} 封 · {labels[item.state] ?? item.state}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {batch ? (
        <>
          <p role="status" className="text-sm">
            {labels[batch.state] ?? batch.state}
          </p>
          <p className="text-xs text-muted-foreground">
            提交授权到期 {new Date(batch.expires_at).toLocaleString()}
            {batch.state === "preview" && batch.confirmation_expires_at && <>
              {" · "}预览确认截止 {new Date(batch.confirmation_expires_at).toLocaleString()}
            </>}
          </p>
          <details className="automation-disclosure">
            <summary>批次详情</summary>
            <p className="text-xs break-all text-muted-foreground">批次编号：{batch.id}</p>
            {batch.run_id ? <p className="text-xs break-all text-muted-foreground">任务编号：{batch.run_id}</p> : null}
          </details>
          {batch.reason ? (
            <p className="text-sm break-all">{batch.reason}</p>
          ) : null}
          {batch.revoked_at ? (
            <p className="text-sm">授权已撤销；已经入队的邮件仍可能发送。</p>
          ) : null}
          <ul className="automation-receipts divide-y">
            {batch.items.map((item) => (
              <li key={item.target.draftId} className="space-y-2 py-3">
                <div className="automation-receipt-heading">
                  <p className="text-sm font-semibold break-all">{item.preview.recipient}</p>
                  <span className={`automation-status ${item.state === "PROVIDER_ACCEPTED" ? "is-success" : ""}`}>{labels[item.state] ?? item.state}</span>
                </div>
                <p className="text-sm font-medium break-words">
                  {item.preview.subject}
                </p>
                <p className="text-xs break-all text-muted-foreground">发件人：{item.preview.sender}</p>
                <details className="text-sm">
                  <summary className="cursor-pointer">邮件正文</summary>
                  <p className="mt-2 break-words whitespace-pre-wrap">
                    {item.preview.body}
                  </p>
                </details>
                {item.sendIntentId && <div className="space-y-1 text-xs" role="status">
                  {(() => {
                    const observed = monitoring?.items.find((value) => value.draft_id === item.target.draftId)
                    const sync = monitoring?.connections[item.target.gmailConnectionId]
                    const uncertain = monitorError || !sync || sync.unavailable || sync.lastError
                      || sync.killSwitchOpen || sync.state !== "POLLING" || !sync.lastSuccessfulSyncAt
                      || Date.now() - Date.parse(sync.lastSuccessfulSyncAt) > 900_000
                    return <>
                      {observed && <p>发送核验：{labels[observed.state] ?? observed.state}</p>}
                      <p>{observed?.reply_state === "OPPORTUNITY_REPLY_FOUND"
                        ? "该机会已有后续来信"
                        : uncertain || monitoring?.mail_unavailable
                          ? "回复状态待核实，邮箱同步未就绪"
                          : "最近邮件中暂未发现该机会的新回复"}</p>
                      {sync?.lastSuccessfulSyncAt && <p>最近同步：{new Date(sync.lastSuccessfulSyncAt).toLocaleString()}</p>}
                      {observed?.replies?.map((reply) => <p key={reply.id} className="break-words">
                        {reply.subject} · {new Date(reply.receivedAt).toLocaleString()}
                      </p>)}
                      {monitoring?.partial && <p>仅展示近期邮件，结果不完整</p>}
                    </>
                  })()}
                </div>}
                {item.sendIntentId ? (
                  <Link
                    className="text-xs text-primary"
                    to={`/projects/${encodeURIComponent(project)}/backlinks/drafts/${encodeURIComponent(item.target.draftId)}`}
                  >
                    查看发送记录
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
          {batch.state === "preview" && !batch.revoked_at ? (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对本批发件账号、收件人及正文，确认将这{" "}
                {batch.items.length} 封邮件提交发送。
              </label>
              <Button
                disabled={blocked || !confirmed}
                onClick={() => {
                  if (Date.parse(batch.confirmation_expires_at ?? batch.expires_at) <= Date.now()) {
                    setError("本批预检已过期，请重新预览。")
                    return
                  }
                  void mutate(() => confirmSendBatch(project, consent, batch))
                }}
              >
                <Send className="size-4" />
                确认并提交本批
              </Button>
            </>
          ) : null}
          {!batch.revoked_at &&
          ["preview", "queued", "running"].includes(batch.state) ? (
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={revokeConfirmed}
                  disabled={busy}
                  onChange={(event) => setRevokeConfirmed(event.target.checked)}
                />
                停止后续提交；已入队的邮件不受此操作撤回。
              </label>
              <Button
                variant="outline"
                disabled={blocked || !revokeConfirmed}
                onClick={() =>
                  void mutate(() => revokeSendBatch(project, consent, batch.id))
                }
              >
                <Square className="size-4" />
                撤销本批授权
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
      <DraftReviewPanel key={`${project}:${consent}`} project={project} consent={consent} />
    </section>
  )
}
