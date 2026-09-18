import { useEffect, useRef, useState } from "react"
import { AlertTriangle, Check, ChevronDown, Languages, LoaderCircle, Send, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  generateReply, getReplyContext, sendReply, type ReplyContext,
  type ReplyIntent, type ReplyLanguage, type ReplyProposal,
} from "./reply-assistant-api"
import "./reply-assistant.css"

const languages: [ReplyLanguage, string][] = [
  ["zh-CN", "简体中文"], ["en", "English"], ["pt", "Português"],
  ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["ja", "日本語"],
]
const intents: [ReplyIntent, string][] = [
  ["interested", "有合作意向"], ["decline", "婉拒合作"], ["negotiate", "商量价格"],
  ["details", "询问外链信息"], ["custom", "其他想法"],
]
const errorText = (error: unknown) => {
  const text = error instanceof Error ? error.message : ""
  const reasons: Record<string, string> = {
    MAIL_REPLY_MODEL_UNAVAILABLE: "AI 暂时无法响应。已编辑的内容会保留，你仍可手动撰写。",
    MAIL_REPLY_GENERATION_INVALID: "本次生成结果不完整，请重试或手动撰写。",
    MAIL_REPLY_MATCH_REQUIRED: "这封邮件尚未关联到外链机会，请先完成下方的回信确认。",
    MAIL_REPLY_CONTEXT_CHANGED: "邮件或发送账号已变化，请刷新后重新核对。",
    MAIL_REPLY_ALREADY_SUBMITTED: "这封回件已有提交记录，请先查看发送记录，避免重复发送。",
    MAIL_REPLY_CONSENT_EXPIRED_OR_CHANGED: "本次自动发送同意已过期或草稿已变化，请检查后手动发送。",
    MAIL_REPLY_SOURCE_DRAFT_REQUIRED: "尚未找到关联的原始开发信，请先核对邮件与机会的关联。",
    MAIL_REPLY_CONTENT_UNAVAILABLE: "暂时无法读取完整回件，请先刷新邮件同步。",
  }
  return Object.entries(reasons).find(([code]) => text.includes(code))?.[1]
    ?? "操作未完成，未确认发送成功。请保留草稿并检查发送记录后重试。"
}

export function ReplyAssistant(props: {
  websiteProjectKey: string
  messageId: string
  connectionId: string | null
  messageVersion?: number
}) {
  // Remount when the account or message changes, including all one-shot consent.
  return <ReplyEditor key={`${props.websiteProjectKey}:${props.messageId}:${props.connectionId}:${props.messageVersion}`} {...props} />
}

function ReplyEditor({ websiteProjectKey, messageId, connectionId }: {
  websiteProjectKey: string; messageId: string; connectionId: string | null
}) {
  const [context, setContext] = useState<ReplyContext | null>(null)
  const [proposal, setProposal] = useState<ReplyProposal | null>(null)
  const [summaryLanguage, setSummaryLanguage] = useState<ReplyLanguage>("zh-CN")
  const [replyLanguage, setReplyLanguage] = useState<ReplyLanguage | "same">("same")
  const [intent, setIntent] = useState<ReplyIntent>("details")
  const [instructions, setInstructions] = useState("")
  const [body, setBody] = useState("")
  const [autoSend, setAutoSend] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [busy, setBusy] = useState<"loading" | "summarize" | "draft" | "sending" | null>("loading")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [reload, setReload] = useState(0)
  const alive = useRef(true)
  const operation = useRef(false)
  const controller = useRef(new AbortController())

  useEffect(() => {
    alive.current = true
    setBusy("loading"); setError("")
    const abort = new AbortController()
    controller.current = abort
    void getReplyContext(websiteProjectKey, messageId, abort.signal)
      .then((value) => {
        if (alive.current && !abort.signal.aborted) {
          setContext(value)
          if (value.existingReply) setBody(value.existingReply.body)
        }
      })
      .catch((reason) => { if (!abort.signal.aborted) setError(errorText(reason)) })
      .finally(() => { if (!abort.signal.aborted) setBusy(null) })
    return () => { alive.current = false; abort.abort() }
  }, [websiteProjectKey, messageId, reload])

  const accountMatches = context?.gmailConnectionId === connectionId
  const maySend = !!context?.message.matchedOpportunityId && accountMatches
    && !context?.existingReply?.sendIntentId && !submitted
  const runSend = async (text: string, generated?: ReplyProposal) => {
    if (!context || !maySend || !alive.current || controller.current.signal.aborted) return
    setBusy("sending")
    try {
      await sendReply(websiteProjectKey, messageId, {
        expectedVersion: generated?.expectedVersion ?? context.message.version,
        gmailConnectionId: context.gmailConnectionId,
        recipient: context.recipient, subject: context.subject, body: text.trim(),
        confirmed: true, confirmationMode: generated ? "ONE_REPLY" : "MANUAL",
        generationToken: generated?.generationToken,
      }, controller.current.signal)
    } catch (reason) {
      // The draft may have committed before preflight or the HTTP response failed.
      try {
        const latest = await getReplyContext(websiteProjectKey, messageId, controller.current.signal)
        if (alive.current && !controller.current.signal.aborted) {
          setContext(latest)
          if (latest.existingReply) setBody(latest.existingReply.body)
        }
      } catch { /* Preserve the local text when reconciliation is unavailable. */ }
      throw reason
    }
    if (alive.current) {
      setSubmitted(true)
      setNotice("回复已提交发送队列，实际结果请查看发送记录。")
      setAutoSend(false)
    }
  }
  const generate = async (action: "summarize" | "draft") => {
    if (operation.current || !context) return
    operation.current = true
    const authorized = action === "draft" && autoSend && maySend
    setBusy(action); setError(""); setNotice(""); setReplaceOpen(false)
    try {
      const result = await generateReply(websiteProjectKey, messageId, {
        action, summary_language: summaryLanguage, reply_language: replyLanguage,
        stance: intent, instructions, authorize_one_reply: authorized,
      }, controller.current.signal)
      if (!alive.current || controller.current.signal.aborted) return
      setProposal(result)
      if (action === "draft") {
        setBody(result.body)
        setAutoSend(false)
        if (authorized && result.generationToken && result.warnings.length === 0) {
          await runSend(result.body, result)
        } else if (authorized) {
          setNotice("本次草稿需要人工检查，未自动发送。")
        }
      }
    } catch (reason) {
      if (alive.current) { setError(errorText(reason)); setAutoSend(false) }
    } finally {
      operation.current = false
      if (alive.current) setBusy(null)
    }
  }
  const manualSend = async () => {
    if (operation.current || !body.trim()) return
    operation.current = true; setError("")
    try { await runSend(body) }
    catch (reason) { if (alive.current) setError(errorText(reason)) }
    finally { operation.current = false; if (alive.current) setBusy(null) }
  }
  const locked = busy !== null || submitted || !!context?.existingReply
  const sendLocked = busy !== null || submitted || !!context?.existingReply?.sendIntentId

  return (
    <section className="reply-assistant" aria-label="回信助手">
      <header className="reply-assistant-heading">
        <div><Sparkles size={18} /><h3>回信助手</h3><span className="reply-model">GPT-5.5</span></div>
        <label className="reply-language"><Languages size={15} /><span className="sr-only">解读语言</span>
          <select aria-label="解读语言" value={summaryLanguage} disabled={!!busy}
            onChange={(event) => setSummaryLanguage(event.target.value as ReplyLanguage)}>
            {languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </header>
      <div className="reply-understanding">
        <div className="reply-section-heading"><h4>回件要点</h4>
          <Button variant="ghost" size="sm" disabled={!context || !!busy}
            onClick={() => void generate("summarize")}>
            {busy === "summarize" ? <LoaderCircle className="animate-spin" /> : <Languages />}
            {proposal ? "重新解读" : "解读回件"}
          </Button>
        </div>
        {proposal ? <>
          <p className="reply-summary">{proposal.summary}</p>
          {proposal.key_points.length > 0 && <ul>{proposal.key_points.map((point, index) => <li key={index}>{point}</li>)}</ul>}
          {proposal.questions.length > 0 && <div className="reply-open-questions">
            <h5>需要回应</h5><ul>{proposal.questions.map((point, index) => <li key={index}>{point}</li>)}</ul>
          </div>}
          {proposal.warnings.length > 0 && <div className="reply-warning" role="status">
            <AlertTriangle size={16} /><div><strong>发送前请核对</strong>
              <ul>{proposal.warnings.map((point, index) => <li key={index}>{point}</li>)}</ul>
            </div>
          </div>}
        </> : <p className="reply-empty">{busy === "loading" ? "正在读取回件…" : "尚未解读这封回件"}</p>}
      </div>
      <div className="reply-compose">
        <div className="reply-section-heading"><h4>你的回复</h4><label className="reply-language">
          <span>邮件语言</span><select aria-label="邮件语言" value={replyLanguage} disabled={locked}
            onChange={(event) => setReplyLanguage(event.target.value as ReplyLanguage | "same")}>
            <option value="same">与对方一致</option>
            {languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </div>
        <fieldset className="reply-intents" disabled={locked}>
          <legend className="sr-only">回复态度</legend>
          {intents.map(([value, label]) => <label key={value} data-selected={intent === value}>
            <input type="radio" name={`reply-intent-${messageId}`} value={value} checked={intent === value}
              onChange={() => setIntent(value)} /><span>{label}</span>
          </label>)}
        </fieldset>
        <label className="reply-notes-label">补充想法
          <Textarea value={instructions} maxLength={2000} disabled={locked} className="reply-notes"
            placeholder="例如：价格偏高，想了解更低的报价，以及链接能否永久保留。"
            onChange={(event) => setInstructions(event.target.value)} />
        </label>
        <div className="reply-generation-bar">
          <Button disabled={!context || locked} onClick={() => body.trim() ? setReplaceOpen(true) : void generate("draft")}>
            {busy === "draft" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
            {autoSend ? "生成并发送本次回复" : body ? "重新生成" : "生成回复"}
          </Button>
          <label className="reply-auto"><input type="checkbox" checked={autoSend} disabled={!maySend || locked}
            onChange={(event) => event.target.checked ? setConsentOpen(true) : setAutoSend(false)} />
            本次生成后直接发送
          </label>
        </div>
        <div className="reply-envelope">
          <div><span>收件人</span><strong>{context?.recipient ?? "读取中…"}</strong></div>
          <div><span>主题</span><span>{context?.subject ?? "—"}</span></div>
          <label className="sr-only" htmlFor={`reply-body-${messageId}`}>回复正文</label>
          <Textarea id={`reply-body-${messageId}`} className="reply-body" value={body} maxLength={20_000}
            disabled={locked} placeholder="回复正文" onChange={(event) => {
              setBody(event.target.value); setAutoSend(false)
            }} />
        </div>
        {context && !accountMatches && <p className="reply-warning">请切换到接收此邮件的 Gmail 账号后发送。</p>}
        {context && !context.message.matchedOpportunityId && <p className="reply-warning">请先在下方确认关联的外链机会。</p>}
        {context?.existingReply && <p className="reply-warning">{context.existingReply.sendIntentId
          ? "这封回件已有回复提交记录，请查看发送记录，避免重复发送。"
          : "上次回复已保存，但尚未进入发送队列。可重试提交同一封回复，不会新建邮件。"}</p>}
        {error && <p role="alert" className="reply-warning"><AlertTriangle size={16} />{error}</p>}
        {!context && !busy && <Button variant="outline" onClick={() => setReload((value) => value + 1)}>重新读取回件</Button>}
        {notice && <p role="status" className="reply-result"><Check size={16} />{notice}</p>}
        <footer className="reply-footer">
          <span>{submitted ? "已提交" : "手动确认发送"} · {body.length.toLocaleString()} 字符</span>
          <Button disabled={!maySend || sendLocked || !body.trim()} onClick={() => void manualSend()}>
            {busy === "sending" ? <LoaderCircle className="animate-spin" /> : <Send />}发送回复
          </Button>
        </footer>
      </div>
      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>允许发送这一次 AI 回复？</DialogTitle>
            <DialogDescription>仅限当前邮件、当前账号及下一次生成的回复。生成结果存在风险提示时仍会停下，不会发送。</DialogDescription>
          </DialogHeader>
          <p className="text-sm break-all">收件人：{context?.recipient}</p>
          <p className="text-sm">发送后无法撤回。不会授权自动回复后续来信。</p>
          <DialogFooter><Button variant="outline" onClick={() => setConsentOpen(false)}>暂不允许</Button>
            <Button onClick={() => { setAutoSend(true); setConsentOpen(false) }}>同意，仅本次</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
        <DialogContent><DialogHeader><DialogTitle>重新生成回复？</DialogTitle>
          <DialogDescription>生成成功后会替换当前正文，包括你已修改的内容。</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" onClick={() => setReplaceOpen(false)}>保留当前内容</Button>
            <Button onClick={() => void generate("draft")}>重新生成</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="reply-history-label"><ChevronDown size={14} />邮件原文与往来记录</div>
    </section>
  )
}
