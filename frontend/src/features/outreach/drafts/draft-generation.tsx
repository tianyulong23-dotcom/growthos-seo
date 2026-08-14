import * as React from "react"
import {
  ArrowLeft,
  Check,
  LoaderCircle,
  Pencil,
  RefreshCw,
  WandSparkles,
} from "lucide-react"
import { Link, useNavigate, useSearchParams } from "react-router"

import { ApiError } from "@/api/client"
import type { Project } from "@/app/project-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  confirmContactCandidate,
  createManualContactCandidate,
  createDraftJob,
  getDraftJob,
  getLatestDraftJob,
  listOpportunityContacts,
  type DraftJob,
  type DraftRequest,
  type DraftJobStatus,
  type ManualContactCandidate,
  type ManualContactRole,
} from "@/features/outreach/drafts/api"
import { pollDraftJob } from "@/features/outreach/drafts/draft-job-polling"
import type { OpportunityContact } from "@/features/outreach/drafts/types"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

const terminalStatuses: DraftJobStatus[] = ["SUCCEEDED", "FAILED", "REFUSED"]
const pollIntervalMs = 1_500

const cooperationOptions = [
  ["GENERAL_PARTNERSHIP", "通用合作"],
  ["GUEST_POST", "客座文章"],
  ["LINK_INSERTION", "现有内容插入"],
  ["RESOURCE_PAGE", "资源页收录"],
  ["PRODUCT_REVIEW", "产品评测"],
  ["CONTENT_PARTNERSHIP", "内容合作"],
] as const

const linkPreferenceOptions = [
  ["NOT_SPECIFIED", "未指定"],
  ["DOFOLLOW_PREFERRED", "偏好 dofollow（仅询问）"],
  ["NOFOLLOW_ACCEPTABLE", "可接受 nofollow"],
  ["EITHER", "两者均可"],
] as const

const toneOptions = [
  ["NEUTRAL_BUSINESS", "中性商务"],
  ["WARM_PROFESSIONAL", "友好专业"],
  ["CONCISE_DIRECT", "简洁直接"],
] as const

const subjectStyleOptions = [
  ["CLEAR_DIRECT", "清晰直接"],
  ["BENEFIT_LED", "价值导向"],
  ["QUESTION_LED", "问题导向"],
] as const

function defaultDraftRequest(project: Project): DraftRequest {
  return {
    cooperationType: "GENERAL_PARTNERSHIP",
    linkAttributePreference: "NOT_SPECIFIED",
    promotionTargetUrl: project.targetUrls[0] ?? "",
    anchorTextSuggestion: null,
    language: project.language || "English",
    tone: "NEUTRAL_BUSINESS",
    subjectStyle: "CLEAR_DIRECT",
    additionalRequirements: "",
    forbiddenPhrases: [],
  }
}

function generationError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "当前账号无权生成该机会的草稿。"
    if (error.status === 404) return "未找到机会、评估证据或草稿任务。"
    if (error.status === 409) return "服务端状态已变化，请重新读取证据后再试。"
    if (error.status === 429) return "生成预算或频率门禁已拒绝本次请求。"
  }
  return error instanceof Error ? error.message : "草稿生成请求失败。"
}

function formatDuration(value: number | null) {
  if (value === null) return "等待服务端时间"
  const seconds = Math.max(0, Math.floor(value / 1_000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

function formatTimestamp(value: string | null) {
  if (value === null) return "尚未成功查询"
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

export function DraftGeneration({
  project,
}: {
  project: Project
}) {
  const websiteProjectKey = project.id
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const opportunityId = searchParams.get("opportunityId")?.trim() ?? ""
  const regenerateRequested = searchParams.get("regenerate") === "1"
  const [status, setStatus] = React.useState<
    DraftJobStatus | "IDLE" | "CHECKING"
  >("IDLE")
  const [jobId, setJobId] = React.useState<string | null>(null)
  const [job, setJob] = React.useState<DraftJob | null>(null)
  const [pollingJobId, setPollingJobId] = React.useState<string | null>(null)
  const [pollingScopeKey, setPollingScopeKey] = React.useState<string | null>(
    null
  )
  const [pollingState, setPollingState] = React.useState<
    "idle" | "polling" | "stale"
  >("idle")
  const [pollCount, setPollCount] = React.useState(0)
  const [lastSuccessfulQueryAt, setLastSuccessfulQueryAt] =
    React.useState<string | null>(null)
  const [frontendDiscoveryLatencyMs, setFrontendDiscoveryLatencyMs] =
    React.useState<number | null>(null)
  const [clockNow, setClockNow] = React.useState(Date.now)
  const [evidenceSnapshotId, setEvidenceSnapshotId] = React.useState<
    string | null
  >(null)
  const [requestSnapshotId, setRequestSnapshotId] = React.useState<
    string | null
  >(null)
  const [draftRequest, setDraftRequest] = React.useState<DraftRequest>(() =>
    defaultDraftRequest(project)
  )
  const [forbiddenPhrasesText, setForbiddenPhrasesText] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [failureState, setFailureState] = React.useState<
    "error" | "offline" | null
  >(null)
  const [contacts, setContacts] = React.useState<OpportunityContact[]>([])
  const [contactStatus, setContactStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle")
  const [selectedContactId, setSelectedContactId] = React.useState<
    string | null
  >(null)
  const [contactError, setContactError] = React.useState<string | null>(null)
  const [manualEmail, setManualEmail] = React.useState("")
  const [manualContactRole, setManualContactRole] =
    React.useState<ManualContactRole>("editorial")
  const [manualReason, setManualReason] = React.useState(
    "已人工核对该邮箱属于当前机会的 Prospect，并确认可用于本次外联。"
  )
  const [contactReviewReady, setContactReviewReady] = React.useState(false)
  const [contactActionStatus, setContactActionStatus] = React.useState<
    "idle" | "saving"
  >("idle")
  const [contactActionError, setContactActionError] = React.useState<
    string | null
  >(null)
  const [pendingCandidate, setPendingCandidate] =
    React.useState<ManualContactCandidate | null>(null)
  const requestKey = React.useRef<string | null>(null)
  const manualCandidateKey = React.useRef<string | null>(null)
  const createController = React.useRef<AbortController | null>(null)
  const createInFlight = React.useRef(false)

  const applyRequestSnapshot = React.useCallback(
    (request: DraftRequest | null) => {
      if (request === null) return
      setDraftRequest({
        ...request,
        anchorTextSuggestion: request.anchorTextSuggestion ?? null,
      })
      setForbiddenPhrasesText(request.forbiddenPhrases.join("\n"))
    },
    []
  )

  const updateDraftRequest = React.useCallback(
    <Key extends keyof DraftRequest,>(
      key: Key,
      value: DraftRequest[Key]
    ) => {
      requestKey.current = null
      setDraftRequest((current) => ({ ...current, [key]: value }))
    },
    []
  )

  React.useEffect(() => {
    if (!opportunityId) {
      return
    }

    const controller = new AbortController()
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setContacts([])
      setSelectedContactId(null)
      setContactError(null)
      setContactStatus("loading")
      try {
        const response = await listOpportunityContacts(
          websiteProjectKey,
          opportunityId,
          controller.signal
        )
        if (cancelled) return
        setContacts(response.items)
        setSelectedContactId(response.selection.autoSelectedContactId)
        setContactStatus("ready")
      } catch (contactFailure) {
        if (cancelled || controller.signal.aborted) return
        setContactStatus("error")
        setContactError(generationError(contactFailure))
      }
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [opportunityId, websiteProjectKey])

  const selectedContact =
    contacts.find((contact) => contact.id === selectedContactId) ?? null
  const logicalDraftKey =
    selectedContact === null
      ? ""
      : `initial-outreach:${opportunityId}:${selectedContact.id}`
  const draftScopeKey =
    logicalDraftKey === ""
      ? ""
      : `${websiteProjectKey}:${opportunityId}:${logicalDraftKey}`

  React.useEffect(() => {
    requestKey.current = null
    createController.current?.abort()
    createController.current = null
    createInFlight.current = false

    return () => {
      createController.current?.abort()
      createController.current = null
      createInFlight.current = false
    }
  }, [opportunityId, selectedContactId])

  const applyJobSnapshot = React.useCallback(
    (nextJob: DraftJob, source: "poll" | "recovery") => {
      const queriedAt = new Date().toISOString()
      setClockNow(Date.now())
      setJob(nextJob)
      setJobId(nextJob.id)
      setStatus(nextJob.status)
      setRequestSnapshotId(nextJob.requestSnapshotId)
      applyRequestSnapshot(nextJob.request)
      setLastSuccessfulQueryAt(queriedAt)
      setPollCount((count) => count + 1)

      if (
        nextJob.status === "QUEUED" ||
        nextJob.status === "RUNNING" ||
        nextJob.status === "RETRY_SCHEDULED"
      ) {
        setPollingJobId(nextJob.id)
        setPollingScopeKey(draftScopeKey)
        setPollingState("polling")
        setError(null)
        setFailureState(null)
        return
      }

      setPollingJobId(null)
      setPollingScopeKey(null)
      setPollingState("idle")
      if (
        source === "poll" &&
        nextJob.finishedAt !== null &&
        Number.isFinite(Date.parse(nextJob.finishedAt))
      ) {
        setFrontendDiscoveryLatencyMs(
          Math.max(0, Date.now() - Date.parse(nextJob.finishedAt))
        )
      }
      if (nextJob.status === "FAILED" || nextJob.status === "REFUSED") {
        const category = nextJob.lastErrorCategory ?? "UNCLASSIFIED"
        setError(`服务端错误分类：${category}`)
        setFailureState("error")
      } else {
        setError(null)
        setFailureState(null)
      }
    },
    [applyRequestSnapshot, draftScopeKey]
  )

  React.useEffect(() => {
    if (!opportunityId || !logicalDraftKey) return

    const controller = new AbortController()
    let cancelled = false
    void Promise.resolve().then(async () => {
      if (cancelled) return
      setJob(null)
      setJobId(null)
      setPollingJobId(null)
      setPollingScopeKey(null)
      setPollingState("idle")
      setPollCount(0)
      setLastSuccessfulQueryAt(null)
      setFrontendDiscoveryLatencyMs(null)
      setEvidenceSnapshotId(null)
      setRequestSnapshotId(null)
      setError(null)
      setFailureState(null)
      setStatus("CHECKING")

      try {
        const response = await getLatestDraftJob(
          websiteProjectKey,
          opportunityId,
          logicalDraftKey,
          controller.signal
        )
        if (cancelled) return
        if (response.job === null) {
          setLastSuccessfulQueryAt(new Date().toISOString())
          setPollCount(1)
          setStatus("IDLE")
          return
        }
        applyRequestSnapshot(response.job.request)
        if (
          regenerateRequested &&
          terminalStatuses.includes(response.job.status)
        ) {
          setRequestSnapshotId(response.job.requestSnapshotId)
          setLastSuccessfulQueryAt(new Date().toISOString())
          setPollCount(1)
          setStatus("IDLE")
          return
        }
        applyJobSnapshot(response.job, "recovery")
      } catch (recoveryError) {
        if (cancelled || controller.signal.aborted) return
        setStatus("IDLE")
        setError(generationError(recoveryError))
        setFailureState(isOutreachOffline() ? "offline" : "error")
      }
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [
    applyJobSnapshot,
    applyRequestSnapshot,
    logicalDraftKey,
    opportunityId,
    regenerateRequested,
    websiteProjectKey,
  ])

  React.useEffect(() => {
    if (
      job === null ||
      terminalStatuses.includes(job.status)
    ) {
      return
    }
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [job])

  const applyContactResponse = React.useCallback(
    (response: Awaited<ReturnType<typeof listOpportunityContacts>>) => {
      setContacts(response.items)
      setSelectedContactId(response.selection.autoSelectedContactId)
      setContactStatus("ready")
    },
    []
  )

  const reloadContacts = React.useCallback(async () => {
    const response = await listOpportunityContacts(
      websiteProjectKey,
      opportunityId
    )
    applyContactResponse(response)
    return response.items
  }, [applyContactResponse, opportunityId, websiteProjectKey])

  const finishManualContact = React.useCallback(() => {
    setManualEmail("")
    setContactReviewReady(false)
    setContactActionError(null)
    setPendingCandidate(null)
    manualCandidateKey.current = null
    requestKey.current = null
  }, [])

  const confirmManualContact = async () => {
    const normalizedEmail = manualEmail.trim().toLowerCase()
    if (
      !opportunityId ||
      !contactReviewReady ||
      !normalizedEmail ||
      !manualReason.trim()
    ) {
      return
    }

    setContactActionStatus("saving")
    setContactActionError(null)
    let candidate = pendingCandidate
    try {
      if (candidate === null) {
        const idempotencyKey = manualCandidateKey.current ?? crypto.randomUUID()
        manualCandidateKey.current = idempotencyKey
        candidate = await createManualContactCandidate(
          websiteProjectKey,
          opportunityId,
          {
            normalizedEmail,
            contactRole: manualContactRole,
            reason: manualReason.trim(),
          },
          idempotencyKey
        )
        setPendingCandidate(candidate)
      }

      await confirmContactCandidate(websiteProjectKey, candidate.candidateId, {
        expectedVersion: candidate.version,
        contactRole: manualContactRole,
        reason: manualReason.trim(),
      })
      await reloadContacts()
      finishManualContact()
    } catch (contactFailure) {
      if (candidate !== null && contactFailure instanceof ApiError) {
        try {
          const currentContacts = await reloadContacts()
          if (
            currentContacts.some(
              (contact) => contact.normalizedEmail === normalizedEmail
            )
          ) {
            finishManualContact()
            return
          }
        } catch {
          // Preserve the original mutation error and retry state.
        }
      }
      setContactActionError(generationError(contactFailure))
    } finally {
      setContactActionStatus("idle")
    }
  }

  const startGeneration = async (forceNewRequest = false) => {
    if (
      !opportunityId ||
      selectedContact === null ||
      createInFlight.current
    ) {
      return
    }

    const controller = new AbortController()
    createController.current?.abort()
    createController.current = controller
    createInFlight.current = true
    setStatus("CHECKING")
    setJob(null)
    setJobId(null)
    setPollingJobId(null)
    setPollingScopeKey(null)
    setPollingState("idle")
    setPollCount(0)
    setLastSuccessfulQueryAt(null)
    setFrontendDiscoveryLatencyMs(null)
    setError(null)
    setFailureState(null)
    try {
      const idempotencyKey =
        forceNewRequest || requestKey.current === null
          ? crypto.randomUUID()
          : requestKey.current
      requestKey.current = idempotencyKey
      const created = await createDraftJob(
        websiteProjectKey,
        opportunityId,
        {
          contactId: selectedContact.id,
          contactVersion: selectedContact.version,
          logicalDraftKey,
          request: {
            ...draftRequest,
            anchorTextSuggestion:
              draftRequest.anchorTextSuggestion?.trim() || null,
            language: draftRequest.language.trim(),
            additionalRequirements:
              draftRequest.additionalRequirements.trim(),
            forbiddenPhrases: forbiddenPhrasesText
              .split(/\r?\n|,/)
              .map((phrase) => phrase.trim())
              .filter(Boolean),
          },
        },
        idempotencyKey,
        controller.signal
      )
      if (controller.signal.aborted) return
      setEvidenceSnapshotId(created.evidenceSnapshotId)
      setRequestSnapshotId(created.requestSnapshotId)
      setJobId(created.jobId)
      setStatus(created.status)
      setPollingJobId(created.jobId)
      setPollingScopeKey(draftScopeKey)
      setPollingState("polling")
    } catch (generationFailure) {
      if (controller.signal.aborted) return
      setStatus("IDLE")
      setPollingState("idle")
      setError(generationError(generationFailure))
      setFailureState(isOutreachOffline() ? "offline" : "error")
    } finally {
      if (createController.current === controller) {
        createController.current = null
        createInFlight.current = false
      }
    }
  }

  React.useEffect(() => {
    if (
      pollingJobId === null ||
      pollingScopeKey === null ||
      pollingScopeKey !== draftScopeKey
    ) {
      return
    }

    const controller = new AbortController()
    let cancelled = false
    void pollDraftJob<DraftJob>({
      signal: controller.signal,
      intervalMs: pollIntervalMs,
      getJob: async (signal) =>
        (await getDraftJob(websiteProjectKey, pollingJobId, signal)).job,
      onJob: (nextJob) => {
        if (!cancelled) applyJobSnapshot(nextJob, "poll")
      },
      onError: (pollError) => {
        if (!cancelled) {
          setError(generationError(pollError))
          setFailureState(isOutreachOffline() ? "offline" : "error")
        }
      },
    })
      .then((result) => {
        if (cancelled || result.reason !== "stale") return
        setPollingJobId(null)
        setPollingScopeKey(null)
        setPollingState("stale")
        setError(
          "Draft Job 已超过服务端截止时间，自动轮询已停止；系统不会自动重复调用 AI。"
        )
        setFailureState("error")
      })
      .catch((pollError) => {
        if (cancelled || controller.signal.aborted) return
        setPollingJobId(null)
        setPollingScopeKey(null)
        setPollingState("idle")
        setError(generationError(pollError))
        setFailureState(isOutreachOffline() ? "offline" : "error")
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [
    applyJobSnapshot,
    draftScopeKey,
    pollingJobId,
    pollingScopeKey,
    websiteProjectKey,
  ])

  React.useEffect(() => {
    if (job?.status === "SUCCEEDED") {
      navigate(`/projects/${websiteProjectKey}/backlinks/drafts/${job.draftId}`, {
        replace: true,
      })
    }
  }, [job, navigate, websiteProjectKey])

  const busy = status === "CHECKING" || pollingState === "polling"
  const elapsedMs =
    job === null
      ? null
      : Math.max(
          0,
          (job.finishedAt === null
            ? clockNow
            : Date.parse(job.finishedAt)) - Date.parse(job.queuedAt)
        )
  const phase =
    pollingState === "stale"
      ? "已超过服务端截止时间"
      : status === "CHECKING"
        ? "正在恢复最近一次 Draft Job"
        : status === "QUEUED"
          ? "服务端排队中"
          : status === "RUNNING"
            ? "服务端生成、校验或保存中"
            : status === "RETRY_SCHEDULED"
              ? "Provider 重试已排程"
              : status === "SUCCEEDED"
                ? "服务端草稿已保存"
                : status === "FAILED"
                  ? "服务端生成失败"
                  : status === "REFUSED"
                    ? "服务端拒绝生成"
                    : "等待用户提交"

  if (!opportunityId) {
    return (
      <main className="mx-auto grid max-w-3xl gap-4 p-4 sm:p-6 lg:p-8">
        <OutreachStandardStateView
          state="error"
          title="请从外链机会开始撰写邮件"
          description="系统需要从机会详情带入联系人和证据，不能手工粘贴机会 ID。"
        />
        <Button
          variant="outline"
          className="w-fit"
          nativeButton={false}
          render={
            <Link
              to={`/projects/${websiteProjectKey}/backlinks/opportunities`}
            />
          }
        >
          <ArrowLeft />
          返回外链机会
        </Button>
      </main>
    )
  }

  return (
    <div className="min-w-0">
      <div className="border-b px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <Link
            to={`/projects/${websiteProjectKey}/backlinks/opportunities`}
            className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            外链机会
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-xl font-semibold">生成邮件草稿</h1>
            <Badge variant="outline">{status}</Badge>
          </div>
        </div>
      </div>

      <main className="mx-auto grid max-w-3xl gap-5 p-4 sm:p-6 lg:p-8">
        {error && failureState && (
          <OutreachStandardStateView
            state={failureState}
            title={
              failureState === "offline" ? "草稿生成当前离线" : "草稿生成失败"
            }
            description={error}
            compact
          />
        )}
        <section className="grid gap-4 border p-4">
          <p className="text-sm text-muted-foreground">
            已从机会详情带入当前机会。草稿会绑定下面选定的正式联系人和当前证据版本。
          </p>
          <div className="grid gap-2 text-sm">
            <span className="font-medium">已确认联系人</span>
            {contactStatus === "loading" && (
              <span className="text-xs text-muted-foreground">
                正在读取当前机会的联系人
              </span>
            )}
            {contactStatus === "error" && contactError && (
              <span className="text-xs text-destructive">{contactError}</span>
            )}
            {contactStatus === "ready" && contacts.length === 0 && (
              <div className="grid gap-3 border p-3">
                <p className="text-xs text-muted-foreground">
                  当前机会没有可用的已确认联系人。请录入当前 Prospect
                  的真实邮箱并完成明确确认；系统不会使用猜测邮箱。
                </p>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium">联系人邮箱</span>
                  <Input
                    type="email"
                    autoComplete="email"
                    value={manualEmail}
                    onChange={(event) => {
                      setManualEmail(event.target.value)
                      setContactReviewReady(false)
                      setPendingCandidate(null)
                      manualCandidateKey.current = null
                    }}
                    disabled={contactActionStatus === "saving"}
                    placeholder="name@prospect-domain.com"
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium">联系人角色</span>
                  <Select
                    value={manualContactRole}
                    onValueChange={(value) => {
                      setManualContactRole(value as ManualContactRole)
                      setContactReviewReady(false)
                      setPendingCandidate(null)
                      manualCandidateKey.current = null
                    }}
                    disabled={contactActionStatus === "saving"}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="editorial">编辑</SelectItem>
                      <SelectItem value="press">媒体</SelectItem>
                      <SelectItem value="partnerships">合作</SelectItem>
                      <SelectItem value="advertising">广告</SelectItem>
                      <SelectItem value="support">支持</SelectItem>
                      <SelectItem value="general">通用</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium">确认依据</span>
                  <Textarea
                    value={manualReason}
                    onChange={(event) => {
                      setManualReason(event.target.value)
                      setContactReviewReady(false)
                      setPendingCandidate(null)
                      manualCandidateKey.current = null
                    }}
                    disabled={contactActionStatus === "saving"}
                    maxLength={500}
                  />
                </label>
                {!contactReviewReady ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-fit"
                    disabled={
                      contactActionStatus === "saving" ||
                      !manualEmail.trim() ||
                      !manualReason.trim()
                    }
                    onClick={() => {
                      setContactActionError(null)
                      setContactReviewReady(true)
                    }}
                  >
                    <Check />
                    核对联系人
                  </Button>
                ) : (
                  <div className="grid gap-3 border-l-2 border-primary pl-3">
                    <div className="grid gap-1 text-xs">
                      <span className="font-medium">请最终确认联系人</span>
                      <span className="break-all">{manualEmail.trim()}</span>
                      <span className="text-muted-foreground">
                        {manualContactRole} · 仅用于当前 Opportunity
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        disabled={contactActionStatus === "saving"}
                        onClick={() => void confirmManualContact()}
                      >
                        {contactActionStatus === "saving" ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Check />
                        )}
                        确认并保存联系人
                      </Button>
                      {pendingCandidate === null && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={contactActionStatus === "saving"}
                          onClick={() => setContactReviewReady(false)}
                        >
                          <Pencil />
                          修改
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {contactActionError && (
                  <span className="text-xs text-destructive">
                    {contactActionError}
                  </span>
                )}
              </div>
            )}
            {contactStatus === "ready" && contacts.length === 1 && (
              <div className="border px-3 py-2">
                <div className="text-sm font-medium break-all">
                  {contacts[0].normalizedEmail}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {contacts[0].contactRole} · 已自动选中
                </div>
              </div>
            )}
            {contactStatus === "ready" && contacts.length > 1 && (
              <Select
                value={selectedContactId}
                onValueChange={(value) => {
                  setSelectedContactId(value)
                  requestKey.current = null
                }}
                disabled={busy}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.normalizedEmail} · {contact.contactRole}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid gap-4 border-t pt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">合作类型</span>
                <Select
                  value={draftRequest.cooperationType}
                  onValueChange={(value) =>
                    updateDraftRequest(
                      "cooperationType",
                      value as DraftRequest["cooperationType"]
                    )
                  }
                  disabled={busy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cooperationOptions.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">链接属性偏好</span>
                <Select
                  value={draftRequest.linkAttributePreference}
                  onValueChange={(value) =>
                    updateDraftRequest(
                      "linkAttributePreference",
                      value as DraftRequest["linkAttributePreference"]
                    )
                  }
                  disabled={busy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {linkPreferenceOptions.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium">推广目标页</span>
              {project.targetUrls.length > 0 ? (
                <Select
                  value={draftRequest.promotionTargetUrl}
                  onValueChange={(value) => {
                    if (value !== null) {
                      updateDraftRequest("promotionTargetUrl", value);
                    }
                  }}
                  disabled={busy}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {project.targetUrls.map((targetUrl) => (
                      <SelectItem key={targetUrl} value={targetUrl}>
                        <span className="block max-w-[32rem] truncate">
                          {targetUrl}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value=""
                  disabled
                  placeholder="请先在项目设置中添加推广目标页"
                />
              )}
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">建议锚文本（未确认）</span>
                <Input
                  value={draftRequest.anchorTextSuggestion ?? ""}
                  onChange={(event) =>
                    updateDraftRequest(
                      "anchorTextSuggestion",
                      event.target.value || null
                    )
                  }
                  disabled={busy}
                  maxLength={200}
                  placeholder="可选"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">语言</span>
                <Input
                  value={draftRequest.language}
                  onChange={(event) =>
                    updateDraftRequest("language", event.target.value)
                  }
                  disabled={busy}
                  maxLength={35}
                />
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">语气</span>
                <Select
                  value={draftRequest.tone}
                  onValueChange={(value) =>
                    updateDraftRequest(
                      "tone",
                      value as DraftRequest["tone"]
                    )
                  }
                  disabled={busy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {toneOptions.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">主题风格</span>
                <Select
                  value={draftRequest.subjectStyle}
                  onValueChange={(value) =>
                    updateDraftRequest(
                      "subjectStyle",
                      value as DraftRequest["subjectStyle"]
                    )
                  }
                  disabled={busy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {subjectStyleOptions.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium">附加要求</span>
              <Textarea
                value={draftRequest.additionalRequirements}
                onChange={(event) =>
                  updateDraftRequest(
                    "additionalRequirements",
                    event.target.value
                  )
                }
                disabled={busy}
                maxLength={2000}
                rows={3}
                placeholder="可选"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium">
                禁用措辞（每行一条）
              </span>
              <Textarea
                value={forbiddenPhrasesText}
                onChange={(event) => {
                  requestKey.current = null
                  setForbiddenPhrasesText(event.target.value)
                }}
                disabled={busy}
                rows={3}
                placeholder="可选"
              />
            </label>
          </div>
          <Button
            className="w-fit"
            disabled={
              busy ||
              selectedContact === null ||
              !draftRequest.promotionTargetUrl ||
              !draftRequest.language.trim() ||
              (job !== null && status !== "IDLE")
            }
            onClick={() => void startGeneration()}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <WandSparkles />
            )}
            {status === "IDLE"
              ? "生成草稿"
              : busy
                ? "正在等待后端"
                : "已有 Draft Job"}
          </Button>
          {(status === "FAILED" || status === "REFUSED") && (
            <Button
              variant="outline"
              className="w-fit"
              disabled={busy}
              onClick={() => void startGeneration(true)}
            >
              <RefreshCw />
              重新生成
            </Button>
          )}
        </section>

        <section
          data-testid="draft-job-diagnostics"
          hidden
          aria-hidden="true"
          className="grid gap-2 border p-4 text-sm"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">后端生成状态</span>
            {(status === "FAILED" || status === "REFUSED") && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void startGeneration(true)}
              >
                <RefreshCw />
                重新生成
              </Button>
            )}
          </div>
          {busy && (
            <OutreachStandardStateView
              state="job-running"
              title="草稿生成任务运行中"
              description="页面只轮询服务端 Draft Job，不在浏览器生成草稿。"
              compact
            />
          )}
          <span className="text-muted-foreground">
            {phase}
          </span>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 border-t pt-3 text-xs">
            <dt className="text-muted-foreground">已耗时</dt>
            <dd className="text-right tabular-nums">
              {formatDuration(elapsedMs)}
            </dd>
            <dt className="text-muted-foreground">最后成功查询</dt>
            <dd className="text-right tabular-nums">
              {formatTimestamp(lastSuccessfulQueryAt)}
            </dd>
            <dt className="text-muted-foreground">服务端查询次数</dt>
            <dd className="text-right tabular-nums">{pollCount}</dd>
            <dt className="text-muted-foreground">队列等待</dt>
            <dd className="text-right tabular-nums">
              {formatDuration(job?.queueWaitMs ?? null)}
            </dd>
            <dt className="text-muted-foreground">Provider 调用</dt>
            <dd className="text-right tabular-nums">
              {formatDuration(job?.latencyMs ?? null)}
            </dd>
            <dt className="text-muted-foreground">持久化</dt>
            <dd className="text-right tabular-nums">
              {formatDuration(job?.persistenceLatencyMs ?? null)}
            </dd>
            <dt className="text-muted-foreground">前端发现终态</dt>
            <dd className="text-right tabular-nums">
              {formatDuration(frontendDiscoveryLatencyMs)}
            </dd>
            <dt className="text-muted-foreground">服务端尝试次数</dt>
            <dd className="text-right tabular-nums">
              {job?.attemptCount ?? 0}
            </dd>
          </dl>
          {evidenceSnapshotId && (
            <span className="text-xs text-muted-foreground">
              已绑定当前 Opportunity Evidence Snapshot。
            </span>
          )}
          {requestSnapshotId && (
            <span className="text-xs text-muted-foreground">
              生成参数已保存为不可变 Draft Request Snapshot。
            </span>
          )}
          {job?.generator === "TEMPLATE_FALLBACK" && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Badge variant="outline">确定性模板降级</Badge>
              <span className="text-xs text-muted-foreground">
                Provider 不可用，本次结果不是 AI 生成成功。
              </span>
            </div>
          )}
          {job?.generator === "AI" && (
            <span className="text-xs text-muted-foreground">
              当前草稿版本由受约束 AI 生成。
            </span>
          )}
          {jobId && (
            <span className="text-xs text-muted-foreground">
              正式 Draft Job 已创建，页面正在读取服务端状态。
            </span>
          )}
        </section>
      </main>
    </div>
  )
}
