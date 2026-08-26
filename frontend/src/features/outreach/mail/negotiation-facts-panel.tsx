import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CheckCircle2, PencilLine, RefreshCw, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

import {
  isMailApiStatus,
  listNegotiationFacts,
  reviewNegotiationFact,
} from "./api"
import type {
  NegotiationFact,
  NegotiationFactDecision,
  NegotiationFactsResponse,
} from "./types"

type LoadState =
  "loading" | "ready" | "empty" | "error" | "forbidden" | "conflict"
type ReviewState = "idle" | "submitting" | "success" | "error" | "conflict"

const reviewStatusLabels: Record<NegotiationFact["reviewStatus"], string> = {
  PENDING: "待确认",
  CONFIRMED: "已确认",
  REJECTED: "已拒绝",
  SUPERSEDED: "已被修正",
}

const normalizedValueText = (value: unknown) => {
  try {
    return JSON.stringify(value)
  } catch {
    return "无法显示"
  }
}

export function NegotiationFactsPanel({
  websiteProjectKey,
  inboundMessageId,
  opportunityId,
}: {
  websiteProjectKey: string
  inboundMessageId: string
  opportunityId: string
}) {
  const [view, setView] = useState<NegotiationFactsResponse | null>(null)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [selectedFactId, setSelectedFactId] = useState<string | null>(null)
  const [decision, setDecision] = useState<NegotiationFactDecision | null>(null)
  const [reason, setReason] = useState("")
  const [correctionType, setCorrectionType] = useState("")
  const [correctionRawValue, setCorrectionRawValue] = useState("")
  const [correctionNormalizedValue, setCorrectionNormalizedValue] = useState("")
  const [reviewState, setReviewState] = useState<ReviewState>("idle")
  const [reviewMessage, setReviewMessage] = useState("")
  const request = useRef(0)
  const reviewRequestKey = useRef<string | null>(null)
  const factsKey = useMemo(
    () =>
      createProjectQueryKey(
        websiteProjectKey,
        "negotiation-facts",
        inboundMessageId
      ),
    [inboundMessageId, websiteProjectKey]
  )

  const load = useCallback(
    async (force = false) => {
      const currentRequest = ++request.current
      if (force) backlinksProjectQueries.invalidate(factsKey)
      setLoadState("loading")
      setView(null)
      try {
        const response = await backlinksProjectQueries.fetch(
          factsKey,
          (signal) =>
            listNegotiationFacts(websiteProjectKey, inboundMessageId, signal)
        )
        if (currentRequest !== request.current) return
        if (
          response.inboundMessageId !== inboundMessageId ||
          response.opportunityId !== opportunityId
        ) {
          setLoadState("conflict")
          return
        }
        setView(response)
        setLoadState(response.items.length === 0 ? "empty" : "ready")
      } catch (error) {
        if (currentRequest !== request.current) return
        if (error instanceof DOMException && error.name === "AbortError") return
        setLoadState(
          isMailApiStatus(error, 403)
            ? "forbidden"
            : isMailApiStatus(error, 409)
              ? "conflict"
              : "error"
        )
      }
    },
    [factsKey, inboundMessageId, opportunityId, websiteProjectKey]
  )

  useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      request.current += 1
    }
  }, [load])

  const selectedFact = useMemo(
    () => view?.items.find((fact) => fact.id === selectedFactId) ?? null,
    [selectedFactId, view]
  )
  const latestVersions = useMemo(() => {
    const versions = new Map<string, number>()
    for (const fact of view?.items ?? []) {
      versions.set(
        fact.factKey,
        Math.max(versions.get(fact.factKey) ?? 0, fact.factVersion)
      )
    }
    return versions
  }, [view])

  const beginReview = (
    fact: NegotiationFact,
    nextDecision: NegotiationFactDecision
  ) => {
    reviewRequestKey.current = null
    setSelectedFactId(fact.id)
    setDecision(nextDecision)
    setReason("")
    setCorrectionType(fact.factType)
    setCorrectionRawValue(fact.rawValue)
    setCorrectionNormalizedValue(normalizedValueText(fact.normalizedValue))
    setReviewState("idle")
    setReviewMessage("")
  }

  const submitReview = async () => {
    if (selectedFact === null || decision === null || reason.trim() === "") {
      setReviewState("error")
      setReviewMessage("请选择事实、处理动作并填写原因。")
      return
    }

    let normalizedValue: unknown
    if (decision === "CORRECT") {
      if (
        correctionType.trim() === "" ||
        correctionRawValue.trim() === "" ||
        correctionNormalizedValue.trim() === ""
      ) {
        setReviewState("error")
        setReviewMessage("修正时必须填写类型、原始值和规范化 JSON。")
        return
      }
      try {
        normalizedValue = JSON.parse(correctionNormalizedValue)
      } catch {
        setReviewState("error")
        setReviewMessage("规范化值必须是有效 JSON。")
        return
      }
    }

    setReviewState("submitting")
    setReviewMessage("")
    const idempotencyKey = reviewRequestKey.current ?? crypto.randomUUID()
    reviewRequestKey.current = idempotencyKey
    try {
      const response = await reviewNegotiationFact(
        websiteProjectKey,
        inboundMessageId,
        {
          sourceFactVersionId: selectedFact.id,
          expectedFactVersion: selectedFact.factVersion,
          decision,
          reason: reason.trim(),
          ...(decision === "CORRECT"
            ? {
                correction: {
                  factType: correctionType.trim(),
                  rawValue: correctionRawValue.trim(),
                  normalizedValue,
                },
              }
            : {}),
        },
        idempotencyKey
      )
      reviewRequestKey.current = null
      setReviewState("success")
      setReviewMessage(
        response.replayed
          ? "该处理已提交过，当前展示服务端已保存版本。"
          : `已追加事实版本 v${response.latestFact.factVersion}。`
      )
      setSelectedFactId(null)
      setDecision(null)
      setReason("")
      await load(true)
    } catch (error) {
      setReviewState(isMailApiStatus(error, 409) ? "conflict" : "error")
      setReviewMessage(
        isMailApiStatus(error, 409)
          ? "事实版本已变化，请重新读取后再处理。"
          : "协商事实处理失败，服务端事实保持不变。"
      )
    }
  }

  if (loadState !== "ready") {
    return (
      <section className="mt-4 border-t pt-4" aria-label="协商事实">
        <OutreachStandardStateView
          state={loadState}
          title={
            loadState === "loading"
              ? "正在读取协商事实"
              : loadState === "empty"
                ? "尚无协商事实"
                : loadState === "forbidden"
                  ? "没有读取协商事实的权限"
                  : loadState === "conflict"
                    ? "回复归属或协商事实版本冲突"
                    : "协商事实读取失败"
          }
          description="协商事实只读取当前项目中已确认归属的回复。"
          onRetry={
            loadState === "loading" || loadState === "empty"
              ? undefined
              : () => void load(true)
          }
          className="min-h-28"
        />
      </section>
    )
  }

  return (
    <section className="mt-4 border-t pt-4" aria-labelledby="negotiation-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold" id="negotiation-title">
            协商事实
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            人工决定会追加版本，不覆盖原始提取记录。
          </p>
        </div>
        <Button
          aria-label="刷新协商事实"
          size="icon-xs"
          title="刷新协商事实"
          variant="ghost"
          onClick={() => void load(true)}
        >
          <RefreshCw />
        </Button>
      </div>

      <div className="mt-3 space-y-3">
        {view?.items.map((fact) => {
          const isLatest = latestVersions.get(fact.factKey) === fact.factVersion
          const reviewable = isLatest && fact.reviewStatus !== "SUPERSEDED"
          return (
            <article className="border bg-background p-3" key={fact.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{fact.factType}</span>
                <Badge variant="outline">v{fact.factVersion}</Badge>
                <Badge variant="secondary">
                  {reviewStatusLabels[fact.reviewStatus]}
                </Badge>
                <Badge variant="outline">{fact.factAuthority}</Badge>
              </div>
              <div className="mt-2 text-xs break-words">{fact.rawValue}</div>
              <div className="mt-1 text-xs break-words text-muted-foreground">
                规范化：{normalizedValueText(fact.normalizedValue)}
              </div>
              <div className="mt-1 text-xs break-words text-muted-foreground">
                证据：{fact.evidenceText}
              </div>
              {reviewable ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {fact.reviewStatus === "PENDING" ? (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => beginReview(fact, "CONFIRM")}
                      >
                        <CheckCircle2 data-icon="inline-start" />
                        确认
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => beginReview(fact, "REJECT")}
                      >
                        <XCircle data-icon="inline-start" />
                        拒绝
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => beginReview(fact, "CORRECT")}
                  >
                    <PencilLine data-icon="inline-start" />
                    修正
                  </Button>
                </div>
              ) : null}
            </article>
          )
        })}
      </div>

      {selectedFact && decision ? (
        <div className="mt-4 border-t pt-4">
          <div className="text-xs font-medium">
            {decision === "CONFIRM"
              ? "确认事实"
              : decision === "REJECT"
                ? "拒绝事实"
                : "修正事实"}
          </div>
          {decision === "CORRECT" ? (
            <div className="mt-3 grid gap-3">
              <label className="text-xs font-medium">
                事实类型
                <Input
                  className="mt-1"
                  value={correctionType}
                  onChange={(event) => setCorrectionType(event.target.value)}
                />
              </label>
              <label className="text-xs font-medium">
                修正后的原始值
                <Textarea
                  className="mt-1 min-h-16"
                  value={correctionRawValue}
                  onChange={(event) =>
                    setCorrectionRawValue(event.target.value)
                  }
                />
              </label>
              <label className="text-xs font-medium">
                规范化 JSON
                <Textarea
                  className="mt-1 min-h-20 font-mono"
                  value={correctionNormalizedValue}
                  onChange={(event) =>
                    setCorrectionNormalizedValue(event.target.value)
                  }
                />
              </label>
            </div>
          ) : null}
          <label className="mt-3 block text-xs font-medium">
            处理原因
            <Textarea
              className="mt-1 min-h-16"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={reviewState === "submitting" || reason.trim() === ""}
              onClick={() => void submitReview()}
            >
              提交处理
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={reviewState === "submitting"}
              onClick={() => {
                setSelectedFactId(null)
                setDecision(null)
                setReviewState("idle")
                setReviewMessage("")
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {reviewState !== "idle" && reviewState !== "submitting" ? (
        <div
          className={
            reviewState === "success"
              ? "mt-3 text-xs text-emerald-700"
              : "mt-3 text-xs text-destructive"
          }
          role={reviewState === "success" ? "status" : "alert"}
        >
          {reviewMessage}
        </div>
      ) : null}
    </section>
  )
}
