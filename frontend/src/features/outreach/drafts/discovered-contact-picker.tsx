import * as React from "react"
import { Check, LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getOpportunity } from "@/features/outreach/opportunities/api"
import { contactRoleLabel } from "@/features/outreach/shared/contact-role-label"
import {
  confirmContactCandidate,
  listContactCandidates,
  type ManualContactRole,
} from "./api"

type Candidate = Awaited<
  ReturnType<typeof listContactCandidates>
>["items"][number]

export function DiscoveredContactPicker({
  projectId,
  opportunityId,
  onConfirmed,
}: {
  projectId: string
  opportunityId: string
  onConfirmed: () => Promise<unknown>
}) {
  const [candidates, setCandidates] = React.useState<Candidate[]>([])
  const [selectedId, setSelectedId] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [revision, retry] = React.useReducer((value: number) => value + 1, 0)
  const scope = React.useRef("")
  const scopeKey = `${projectId}:${opportunityId}:${revision}`
  React.useEffect(() => {
    scope.current = scopeKey
    const controller = new AbortController()
    void (async () => {
      await Promise.resolve()
      if (controller.signal.aborted) return
      setCandidates([])
      setSelectedId("")
      setLoading(true)
      setSaving(false)
      setError(null)
      try {
        const { item } = await getOpportunity(
          projectId,
          opportunityId,
          controller.signal
        )
        const { items } = await listContactCandidates(
          projectId,
          item.prospectId,
          controller.signal
        )
        if (controller.signal.aborted) return
        const eligible = items.filter(
          (candidate) =>
            candidate.prospectId === item.prospectId &&
            candidate.recommendationContextVersionId ===
              item.recommendationContextVersionId &&
            !candidate.guessed &&
            candidate.evidence.some(
              (evidence) =>
                Date.parse(evidence.expiresAt) > Date.now() &&
                [
                  "mailto",
                  "visible_text",
                  "obfuscated_text",
                  "json_ld",
                ].includes(evidence.extractionMethod)
            )
        )
        setCandidates(eligible.map((candidate) => ({
          ...candidate,
          evidence: candidate.evidence.filter((evidence) =>
            Date.parse(evidence.expiresAt) > Date.now()
          ),
        })))
        setSelectedId(eligible[0]?.id ?? "")
      } catch {
        if (!controller.signal.aborted) setError("已发现邮箱读取失败，请重试。")
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => {
      scope.current = ""
      controller.abort()
    }
  }, [projectId, opportunityId, scopeKey])

  const selected = candidates.find((candidate) => candidate.id === selectedId)
  async function confirm() {
    if (!selected || saving) return
    const currentScope = scopeKey
    setSaving(true)
    setError(null)
    const role: ManualContactRole = [
      "press",
      "editorial",
      "partnerships",
      "advertising",
      "support",
      "general",
    ].includes(selected.inferredPurpose)
      ? (selected.inferredPurpose as ManualContactRole)
      : "general"
    try {
      await confirmContactCandidate(projectId, selected.id, {
        expectedVersion: selected.version,
        contactRole: role,
        reason: "用户从网页发现的邮箱及来源证据中选择并确认用于本次外联。",
      })
      if (scope.current === currentScope) await onConfirmed()
    } catch {
      if (scope.current === currentScope)
        setError("邮箱确认失败，请刷新联系人后重试。")
    } finally {
      if (scope.current === currentScope) setSaving(false)
    }
  }

  if (loading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        正在读取已发现邮箱...
      </p>
    )
  return (
    <div className="grid gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {selected ? (
        <>
          <label className="grid gap-1.5 text-sm">
            已发现邮箱
          <select
            aria-label="已发现邮箱"
              className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
              value={selectedId}
              disabled={saving}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.normalizedEmail} · {contactRoleLabel(candidate.inferredPurpose)}
                  {candidate.domainRelation === "external_domain"
                    ? " · 外部域名"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <details className="space-y-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">查看邮箱来源</summary>
            {selected.evidence
              .slice(0, 3)
              .map((evidence, index) => {
                const safeUrl = /^https?:\/\//i.test(evidence.sourceUrl)
                  ? evidence.sourceUrl
                  : null
                return safeUrl ? (
                  <a
                    key={`${safeUrl}:${index}`}
                    href={safeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all underline"
                  >
                    {safeUrl}
                  </a>
                ) : null
              })}
          </details>
          <Button
            type="button"
            className="w-fit"
            disabled={saving}
            onClick={() => void confirm()}
          >
            {saving ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            确认使用此邮箱
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          暂无带有效网页证据的待确认邮箱。
        </p>
      )}
      {error && (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={retry}
        >
          <RefreshCw className="size-4" />
          重新读取
        </Button>
      )}
    </div>
  )
}
