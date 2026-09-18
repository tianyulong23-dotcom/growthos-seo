import { useEffect, useRef, useState } from "react"
import { CheckCheck, RefreshCw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { aiReviewDrafts, approveDraftReview, readDraftReview, type DraftReviewItem } from "./api"

const qualityStates: Record<string, string> = {
  PASSED: "AI 审核通过", BLOCKED: "AI 审核拦截", ERROR: "AI 审核失败",
  REVIEWING: "AI 审核中", REPAIRING: "AI 修正中", STALE: "AI 审核已过期",
}
const qualityReasons: Record<string, string> = {
  AI_REVIEW_UNAVAILABLE: "审核服务暂不可用，请重试",
  AI_REVIEW_INTERRUPTED: "审核中断，请重试",
  AI_REVIEW_EXPIRED: "审核已过期，请重新审核",
  AI_REVIEW_POLICY_CHANGED: "审核规则已更新，请重新审核",
  AI_REPAIR_UNAVAILABLE: "自动修正暂未完成，需要重新处理",
  AI_REPAIR_INTERRUPTED: "自动修正中断，需要核对已保存结果",
  AI_REPAIR_LIMIT_REACHED: "已完成两轮自动修正，仍有问题需要处理",
  DRAFT_EVIDENCE_CHANGED: "草稿或引用资料发生变化",
  CONTACT_NOT_CONFIRMED: "收件人资料未确认或已变化",
  PROJECT_EVIDENCE_MISSING: "缺少项目资料、目标网站或生成依据",
}

export function DraftReviewPanel({ project, consent }: { project: string; consent: string }) {
  const [items, setItems] = useState<DraftReviewItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const pending = useRef<{ id: string; items: DraftReviewItem[] } | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  const aiRequest = useRef<string | null>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    readDraftReview(project, consent, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setItems(result.items)
      setSelected([])
      setConfirmed(false)
      setError(null)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败")
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [project, consent, revision])
  useEffect(() => {
    if (!busy || !aiRequest.current) return
    const controller = new AbortController()
    let reading = false
    const timer = setInterval(() => {
      if (reading) return
      reading = true
      readDraftReview(project, consent, controller.signal).then((result) => {
        if (!controller.signal.aborted) setItems(result.items)
      }).catch(() => {
        // The original request and final read retain error reporting.
      }).finally(() => { reading = false })
    }, 3000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [project, consent, busy])
  async function approve() {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    const request = pending.current ?? {
      id: crypto.randomUUID(), items: items.filter((item) => selected.includes(item.draft_id)),
    }
    pending.current = request
    try {
      await approveDraftReview(project, consent, request.id, request.items)
      if (!alive.current) return
      pending.current = null
      setSelected([])
      setConfirmed(false)
      setRevision((value) => value + 1)
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "审核结果待核实")
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  async function reviewWithAi() {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    aiRequest.current ??= crypto.randomUUID()
    try {
      await aiReviewDrafts(project, consent, aiRequest.current)
      aiRequest.current = null
      if (alive.current) setAiError(null)
    } catch (failure) {
      if (alive.current) setAiError(failure instanceof Error ? failure.message : "AI 审核失败")
    } finally {
      locked.current = false
      if (alive.current) {
        setBusy(false)
        setRevision((value) => value + 1)
      }
    }
  }
  if (items.length === 0 && !error) return null
  return <section aria-label="本批草稿审核" className="mail-draft-review min-w-0 space-y-3 border-t pt-4">
    <header className="flex items-center justify-between">
      <h3 className="text-sm font-semibold">本批草稿审核</h3>
      <Button variant="ghost" size="icon" title="刷新草稿审核" aria-label="刷新草稿审核"
        disabled={busy || loading || !!pending.current} onClick={() => setRevision((value) => value + 1)}>
        <RefreshCw className="size-4" />
      </Button>
    </header>
    {error && <p role="alert" className="break-all text-sm text-destructive">{error}</p>}
    {aiError && <p role="alert" className="break-all text-sm text-destructive">{aiError}</p>}
    <Button variant="outline" disabled={busy || loading || !!pending.current}
      onClick={() => void reviewWithAi()}>
      <Sparkles className="size-4" />AI 审核并批准合格草稿
    </Button>
    {items.map((item) => <div key={item.draft_id} className="automation-review-item min-w-0 border-b pb-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" aria-label={`审核 ${item.subject ?? item.draft_id}`}
          disabled={busy || loading || !!pending.current || !item.reviewable || item.approved
            || (!!item.quality && item.quality.state !== "PASSED")}
          checked={selected.includes(item.draft_id)}
          onChange={(event) => {
            setConfirmed(false)
            setSelected((values) => event.target.checked
              ? [...values, item.draft_id] : values.filter((id) => id !== item.draft_id))
          }} />
        <span className="break-words">{item.subject ?? "无主题"} {item.approved ? "（已审核）" : ""}</span>
      </label>
      <details className="automation-disclosure">
        <summary>查看邮件正文</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{item.body}</pre>
      </details>
      {item.quality && <div className="mt-2 break-words text-sm" role="status">
        <p className="font-medium">{qualityStates[item.quality.state] ?? item.quality.state}</p>
        <details className="automation-disclosure" open={item.quality.state !== "PASSED" ? true : undefined}>
          <summary>审核依据</summary>
          {item.quality.reasons.map((reason, index) =>
            <p key={index}>{qualityReasons[reason] ?? reason}</p>)}
        </details>
      </div>}
    </div>)}
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={confirmed} disabled={busy}
        onChange={(event) => setConfirmed(event.target.checked)} />
      我已审核所选邮件内容
    </label>
    <Button variant="outline" disabled={busy || loading || !confirmed || (!pending.current && (!!error || selected.length === 0))}
      onClick={() => void approve()}>
      <CheckCheck className="size-4" />{pending.current ? "重试原审核请求" : "批准所选草稿"}
    </Button>
  </section>
}
