import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Link2,
  LoaderCircle,
  LocateFixed,
  RefreshCw,
  Search,
  XCircle,
} from "lucide-react"

import {
  analyzeArticleLinks,
  analyzeArticleSeo,
  getFactSourceCandidates,
  getInternalLinkCandidates,
  getLatestArticleLinkAnalysis,
  getLatestArticleSeoAnalysis,
  type ArticleDetail,
  type ArticleDocument,
  type ArticleDocumentCapabilities,
  type ArticleIndexing,
  type ArticleLinkAnalysis,
  type ArticleMetadataSnapshot,
  type ArticleSeoAnalysis,
  type ArticleSeoFieldKey,
  type ArticleSeoFieldState,
  type FactSourceCandidate,
  type InternalLinkCandidate,
} from "@/api/articles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  articleDocumentHash,
  articleMetadataHash,
} from "@/features/content/article-document"
import type { ArticleEditorHandle } from "@/features/content/article-editor"
import { cn } from "@/lib/utils"

const fieldStateLabel: Record<ArticleSeoFieldState, string> = {
  generated: "生成",
  confirmed: "已确认",
  modified: "已修改",
  stale: "待确认",
}

const indexingOptions: Array<{ value: ArticleIndexing; label: string }> = [
  { value: "index/follow", label: "允许索引 / 跟踪链接" },
  { value: "noindex/follow", label: "禁止索引 / 跟踪链接" },
  { value: "index/nofollow", label: "允许索引 / 不跟踪链接" },
  { value: "noindex/nofollow", label: "禁止索引 / 不跟踪链接" },
]

function displayDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "尚未完成"
}

function canonicalError(value: string | null) {
  if (!value) return ""
  try {
    const parsed = new URL(value)
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password
    ) {
      return "Canonical 必须是无账号信息的完整 HTTP/HTTPS 地址。"
    }
    return ""
  } catch {
    return "Canonical 必须是完整的 HTTP/HTTPS 地址。"
  }
}

function siteHost(article: ArticleDetail) {
  for (const value of [article.wordpress_url, article.canonical_url]) {
    if (!value) continue
    try {
      return new URL(value).hostname
    } catch {
      // The field-level validation reports malformed URLs.
    }
  }
  return null
}

function urlHost(value: string | null) {
  if (!value) return null
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

function FieldState({ state }: { state: ArticleSeoFieldState }) {
  return (
    <Badge variant={state === "modified" ? "default" : "outline"}>
      {fieldStateLabel[state]}
    </Badge>
  )
}

function SeoField({
  field,
  label,
  state,
  disabled,
  children,
  onConfirm,
}: {
  field: ArticleSeoFieldKey
  label: string
  state: ArticleSeoFieldState
  disabled: boolean
  children: React.ReactNode
  onConfirm: (field: ArticleSeoFieldKey) => void
}) {
  return (
    <div className="grid gap-1.5" id={`seo-field-${field}`}>
      <div className="flex items-center justify-between gap-2">
        <Label
          className="text-xs font-medium text-muted-foreground"
          htmlFor={`seo-input-${field}`}
        >
          {label}
        </Label>
        <div className="flex items-center gap-1.5">
          <FieldState state={state} />
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled || state === "confirmed"}
            onClick={() => onConfirm(field)}
          >
            确认
          </Button>
        </div>
      </div>
      {children}
    </div>
  )
}

function SeoPanel({
  projectId,
  articleId,
  article,
  document,
  metadata,
  capabilities,
  dirty,
  disabled,
  editorRef,
  onMetadataChange,
}: {
  projectId: string
  articleId: string
  article: ArticleDetail
  document: ArticleDocument
  metadata: ArticleMetadataSnapshot
  capabilities: ArticleDocumentCapabilities
  dirty: boolean
  disabled: boolean
  editorRef: React.RefObject<ArticleEditorHandle | null>
  onMetadataChange: (
    field: ArticleSeoFieldKey,
    value: string | string[] | ArticleIndexing,
    state?: ArticleSeoFieldState
  ) => void
}) {
  const [analysis, setAnalysis] = React.useState<ArticleSeoAnalysis | null>(
    null
  )
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [preview, setPreview] = React.useState<"desktop" | "mobile">("desktop")
  const [hashes, setHashes] = React.useState({ document: "", metadata: "" })

  React.useEffect(() => {
    let active = true
    void Promise.all([
      articleDocumentHash(document),
      articleMetadataHash(metadata),
    ]).then(([documentHash, metadataHash]) => {
      if (active) setHashes({ document: documentHash, metadata: metadataHash })
    })
    return () => {
      active = false
    }
  }, [document, metadata])

  React.useEffect(() => {
    let active = true
    void getLatestArticleSeoAnalysis(projectId, articleId)
      .then((result) => {
        if (active) {
          setAnalysis(result)
          setError("")
        }
      })
      .catch((requestError) => {
        if (active) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "读取 SEO 分析失败"
          )
        }
      })
    return () => {
      active = false
    }
  }, [article.current_version_number, articleId, projectId])

  const analyze = async () => {
    if (dirty || !hashes.document || !hashes.metadata) return
    setLoading(true)
    setError("")
    try {
      const result = await analyzeArticleSeo(projectId, articleId, {
        document_hash: hashes.document,
        metadata_hash: hashes.metadata,
      })
      setAnalysis(result)
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "SEO 分析失败"
      )
    } finally {
      setLoading(false)
    }
  }

  const stateFor = (field: ArticleSeoFieldKey) =>
    metadata.field_states[field] ?? "generated"
  const confirm = (field: ArticleSeoFieldKey) => {
    const value = metadata[field]
    onMetadataChange(
      field,
      Array.isArray(value) ? value : String(value ?? ""),
      "confirmed"
    )
  }
  const stale = Boolean(
    dirty ||
    analysis?.is_stale ||
    (analysis &&
      hashes.document &&
      analysis.document_hash !== hashes.document) ||
    (analysis && hashes.metadata && analysis.metadata_hash !== hashes.metadata)
  )
  const canonicalValidation = canonicalError(metadata.canonical_url)
  const expectedHost = siteHost(article)
  const canonicalHost = urlHost(metadata.canonical_url)
  const crossDomain = Boolean(
    expectedHost && canonicalHost && expectedHost !== canonicalHost
  )
  const noindex = metadata.indexing.startsWith("noindex")

  const focusRule = (
    field: string | null,
    evidence:
      | ArticleSeoAnalysis["groups"][number]["results"][number]["evidence"][number]
      | undefined
  ) => {
    if (
      evidence?.node_id != null &&
      evidence.start != null &&
      evidence.end != null
    ) {
      const focused = editorRef.current?.focusEvidence({
        nodeId: evidence.node_id,
        start: evidence.start,
        end: evidence.end,
        expectedText: evidence.text,
      })
      if (!focused) setError("正文已变化，证据位置失效。请保存并重新分析。")
      return
    }
    if (field) {
      globalThis.document
        .getElementById(`seo-field-${field}`)
        ?.scrollIntoView({ block: "center" })
      globalThis.document.getElementById(`seo-input-${field}`)?.focus()
    }
  }

  return (
    <div className="grid gap-5 px-4 py-4 sm:px-5">
      <section className="grid gap-4" aria-label="SEO 字段">
        <SeoField
          field="title"
          label="文章标题"
          state={stateFor("title")}
          disabled={disabled}
          onConfirm={confirm}
        >
          <Input
            id="seo-input-title"
            value={metadata.title ?? ""}
            maxLength={300}
            disabled={disabled}
            onChange={(event) => onMetadataChange("title", event.target.value)}
          />
        </SeoField>
        <SeoField
          field="slug"
          label="Slug"
          state={stateFor("slug")}
          disabled={disabled}
          onConfirm={confirm}
        >
          <Input
            id="seo-input-slug"
            value={metadata.slug ?? ""}
            maxLength={500}
            disabled={disabled}
            onChange={(event) => onMetadataChange("slug", event.target.value)}
          />
        </SeoField>
        <SeoField
          field="focus_keyword"
          label="主关键词"
          state={stateFor("focus_keyword")}
          disabled={disabled}
          onConfirm={confirm}
        >
          <Input
            id="seo-input-focus_keyword"
            aria-label="主关键词"
            value={metadata.focus_keyword ?? ""}
            maxLength={200}
            disabled={disabled}
            onChange={(event) =>
              onMetadataChange("focus_keyword", event.target.value)
            }
          />
        </SeoField>
        <SeoField
          field="secondary_keywords"
          label="次关键词"
          state={stateFor("secondary_keywords")}
          disabled={disabled}
          onConfirm={confirm}
        >
          <Input
            id="seo-input-secondary_keywords"
            value={metadata.secondary_keywords.join("，")}
            disabled={disabled}
            onChange={(event) =>
              onMetadataChange(
                "secondary_keywords",
                event.target.value
                  .split(/[，,\n]/)
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .slice(0, 20)
              )
            }
          />
        </SeoField>
        <SeoField
          field="meta_title"
          label="Meta 标题"
          state={stateFor("meta_title")}
          disabled={disabled}
          onConfirm={confirm}
        >
          <Input
            id="seo-input-meta_title"
            aria-label="Meta 标题"
            value={metadata.meta_title ?? ""}
            maxLength={300}
            disabled={disabled}
            onChange={(event) =>
              onMetadataChange("meta_title", event.target.value)
            }
          />
        </SeoField>
        <SeoField
          field="meta_description"
          label="Meta 描述"
          state={stateFor("meta_description")}
          disabled={disabled}
          onConfirm={confirm}
        >
          <Textarea
            id="seo-input-meta_description"
            value={metadata.meta_description ?? ""}
            maxLength={2000}
            rows={4}
            disabled={disabled}
            onChange={(event) =>
              onMetadataChange("meta_description", event.target.value)
            }
          />
          <span className="text-right text-xs text-muted-foreground">
            {metadata.meta_description?.length ?? 0} 字符
          </span>
        </SeoField>
        <SeoField
          field="canonical_url"
          label="Canonical URL"
          state={stateFor("canonical_url")}
          disabled={disabled || !capabilities.can_manage_seo_advanced}
          onConfirm={confirm}
        >
          <Input
            id="seo-input-canonical_url"
            aria-label="Canonical URL"
            value={metadata.canonical_url ?? ""}
            maxLength={2048}
            disabled={disabled || !capabilities.can_manage_seo_advanced}
            aria-invalid={Boolean(canonicalValidation)}
            onChange={(event) =>
              onMetadataChange("canonical_url", event.target.value)
            }
          />
          {!capabilities.can_manage_seo_advanced && (
            <p className="text-xs text-muted-foreground">
              需要高级 SEO 管理权限才能修改。
            </p>
          )}
          {canonicalValidation && (
            <p className="text-xs text-destructive">{canonicalValidation}</p>
          )}
          {crossDomain && (
            <p className="text-xs text-amber-700">
              Canonical 指向其他域名 {canonicalHost}，保存前请确认这是有意设置。
            </p>
          )}
        </SeoField>
        <SeoField
          field="indexing"
          label="索引设置"
          state={stateFor("indexing")}
          disabled={disabled || !capabilities.can_manage_seo_advanced}
          onConfirm={confirm}
        >
          <Select
            value={metadata.indexing}
            disabled={disabled || !capabilities.can_manage_seo_advanced}
            onValueChange={(value) =>
              onMetadataChange("indexing", value as ArticleIndexing)
            }
          >
            <SelectTrigger
              id="seo-input-indexing"
              aria-label="索引设置"
              className="w-full rounded-md bg-background"
            >
              <SelectValue>
                {indexingOptions.find(
                  (option) => option.value === metadata.indexing
                )?.label ?? metadata.indexing}
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="rounded-md">
              {indexingOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className="rounded-sm"
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {noindex && (
            <p className="flex items-center gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="size-3.5" />
              当前页面不会进入搜索引擎索引。
            </p>
          )}
        </SeoField>
      </section>

      <section className="border-t pt-4" aria-label="搜索结果模拟预览">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">SERP 模拟预览</h3>
            <p className="text-xs text-muted-foreground">
              仅为字符和布局模拟，不代表搜索引擎最终展示。
            </p>
          </div>
          <div className="flex rounded-md bg-muted p-1" aria-label="预览设备">
            {(["desktop", "mobile"] as const).map((device) => (
              <Button
                key={device}
                type="button"
                size="xs"
                variant={preview === device ? "secondary" : "ghost"}
                onClick={() => setPreview(device)}
              >
                {device === "desktop" ? "桌面" : "移动"}
              </Button>
            ))}
          </div>
        </div>
        <div
          className={cn(
            "mt-3 border-l-2 border-primary/30 px-3 py-2",
            preview === "mobile" ? "max-w-[320px]" : "max-w-full"
          )}
        >
          <p className="truncate text-xs text-emerald-700">
            {metadata.canonical_url ||
              `https://example.com/${metadata.slug || "article"}`}
          </p>
          <p className="mt-1 text-base text-blue-700">
            {metadata.meta_title || metadata.title || "未设置标题"}
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {metadata.meta_description || "未设置 Meta 描述"}
          </p>
        </div>
      </section>

      <section className="border-t pt-4" aria-label="SEO 分析结果">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">SEO 检查</h3>
            <p className="text-xs text-muted-foreground">
              规则 {analysis?.ruleset_version ?? "-"} ·{" "}
              {displayDate(analysis?.analyzed_at ?? null)}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={dirty || loading || Boolean(canonicalValidation)}
            onClick={() => void analyze()}
          >
            {loading ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            分析
          </Button>
        </div>
        {dirty && (
          <p className="mt-2 text-xs text-muted-foreground">
            先永久保存正文和 SEO 字段，才能分析当前版本。
          </p>
        )}
        {stale && analysis && (
          <p className="mt-2 text-xs text-amber-700">
            结果已过期，当前仍显示最近一次分析。
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {analysis && (
          <>
            <div className="mt-4 flex items-end gap-2">
              <span className="text-3xl font-semibold tabular-nums">
                {analysis.score}
              </span>
              <span className="pb-1 text-sm text-muted-foreground">
                / {analysis.max_score}
              </span>
              <Badge
                className="ml-auto"
                variant={stale ? "outline" : "secondary"}
              >
                {stale
                  ? "已过期"
                  : analysis.status === "completed"
                    ? "已完成"
                    : "分析失败"}
              </Badge>
            </div>
            <div className="mt-4 grid gap-4">
              {analysis.groups.map((group) => {
                const failed = group.results.filter(
                  (item) => item.status === "failed"
                ).length
                return (
                  <section key={group.id} className="border-t pt-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium">{group.label}</h4>
                      <span className="text-xs text-muted-foreground">
                        {failed} 项未通过
                      </span>
                    </div>
                    <ul className="mt-2 divide-y">
                      {group.results
                        .filter((item) => item.applicable)
                        .map((result) => (
                          <li
                            key={result.rule_id}
                            className="flex items-start gap-2 py-2.5"
                          >
                            {result.status === "passed" &&
                            result.score === result.max_score ? (
                              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                            ) : result.score > 0 ? (
                              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                            ) : (
                              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-sm">{result.message}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {result.score}/{result.max_score} ·{" "}
                                {result.rule_version}
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`定位 ${result.message}`}
                              title="定位"
                              onClick={() =>
                                focusRule(
                                  result.evidence[0]?.field ?? null,
                                  result.evidence[0]
                                )
                              }
                            >
                              <LocateFixed />
                            </Button>
                          </li>
                        ))}
                    </ul>
                  </section>
                )
              })}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              SEO 分数用于优化建议，不会单独阻断审核或发布。
            </p>
          </>
        )}
      </section>
    </div>
  )
}

function LinksPanel({
  projectId,
  articleId,
  article,
  document,
  dirty,
  editorRef,
}: {
  projectId: string
  articleId: string
  article: ArticleDetail
  document: ArticleDocument
  dirty: boolean
  editorRef: React.RefObject<ArticleEditorHandle | null>
}) {
  const [analysis, setAnalysis] = React.useState<ArticleLinkAnalysis | null>(
    null
  )
  const [documentHash, setDocumentHash] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [query, setQuery] = React.useState("")
  const [internal, setInternal] = React.useState<InternalLinkCandidate[]>([])
  const [facts, setFacts] = React.useState<FactSourceCandidate[]>([])
  const [candidateLoading, setCandidateLoading] = React.useState(false)

  React.useEffect(() => {
    let active = true
    void articleDocumentHash(document).then((value) => {
      if (active) setDocumentHash(value)
    })
    return () => {
      active = false
    }
  }, [document])

  const loadLatest = React.useCallback(async () => {
    try {
      const result = await getLatestArticleLinkAnalysis(projectId, articleId)
      setAnalysis(result)
      setError("")
      return result
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "读取链接检查失败"
      )
      return null
    }
  }, [articleId, projectId])

  React.useEffect(() => {
    let active = true
    void getLatestArticleLinkAnalysis(projectId, articleId)
      .then((result) => {
        if (active) {
          setAnalysis(result)
          setError("")
        }
      })
      .catch((requestError) => {
        if (active) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "读取链接检查失败"
          )
        }
      })
    return () => {
      active = false
    }
  }, [article.current_version_number, articleId, projectId])

  React.useEffect(() => {
    if (!analysis || !["queued", "running"].includes(analysis.status)) return
    const timer = window.setInterval(() => void loadLatest(), 1500)
    return () => window.clearInterval(timer)
  }, [analysis, loadLatest])

  const analyze = async () => {
    if (dirty || !documentHash) return
    setLoading(true)
    setError("")
    try {
      setAnalysis(
        await analyzeArticleLinks(projectId, articleId, {
          document_hash: documentHash,
          check_external: false,
        })
      )
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "链接检查失败"
      )
    } finally {
      setLoading(false)
    }
  }

  const loadCandidates = async () => {
    setCandidateLoading(true)
    setError("")
    try {
      const [internalResult, factResult] = await Promise.all([
        getInternalLinkCandidates(projectId, articleId, { query, limit: 20 }),
        getFactSourceCandidates(projectId, articleId),
      ])
      setInternal(internalResult.items)
      setFacts(factResult.items)
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "读取链接候选失败"
      )
    } finally {
      setCandidateLoading(false)
    }
  }

  const insert = (href: string, suggestedAnchor: string) => {
    const inserted = editorRef.current?.insertLinkCandidate({
      href,
      suggestedAnchor,
    })
    if (!inserted)
      setError("请先在正文中明确选择一段非空文本，再应用候选链接。")
    else setError("")
  }
  const stale = Boolean(
    dirty ||
    analysis?.is_stale ||
    (analysis && documentHash && analysis.document_hash !== documentHash)
  )

  return (
    <div className="grid gap-5 px-4 py-4 sm:px-5">
      <section>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">链接检查</h3>
            <p className="text-xs text-muted-foreground">
              规则 {analysis?.ruleset_version ?? "-"} ·{" "}
              {displayDate(analysis?.checked_at ?? null)}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={
              dirty ||
              loading ||
              ["queued", "running"].includes(analysis?.status ?? "")
            }
            onClick={() => void analyze()}
          >
            {loading ||
            ["queued", "running"].includes(analysis?.status ?? "") ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            检查
          </Button>
        </div>
        {dirty && (
          <p className="mt-2 text-xs text-muted-foreground">
            先永久保存正文，才能检查当前版本。
          </p>
        )}
        {stale && analysis && (
          <p className="mt-2 text-xs text-amber-700">
            正文已变化，仍显示最近一次检查结果。
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {analysis && (
          <>
            <div className="mt-4 grid grid-cols-5 gap-2 text-center">
              {(
                [
                  ["总数", analysis.summary.total],
                  ["内链", analysis.summary.internal],
                  ["外链", analysis.summary.external],
                  ["错误", analysis.summary.errors],
                  ["警告", analysis.summary.warnings],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="border-l px-1">
                  <p className="font-semibold tabular-nums">{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              ))}
            </div>
            <ul className="mt-4 divide-y border-t">
              {analysis.links.map((link) => (
                <li key={link.link_id} className="py-3">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start rounded-sm px-0 py-0 text-left whitespace-normal"
                    onClick={() => {
                      const focused = editorRef.current?.focusLink({
                        nodeId: link.node_id,
                        start: link.start,
                        end: link.end,
                        expectedText: link.anchor_text,
                        href: link.href,
                      })
                      if (!focused)
                        setError(
                          "正文已变化，链接证据位置失效。请保存并重新检查。"
                        )
                    }}
                  >
                    <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {link.anchor_text || link.href}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {link.href}
                      </span>
                    </span>
                    <Badge
                      variant={
                        link.status === "passed" ? "secondary" : "outline"
                      }
                    >
                      {link.status === "passed"
                        ? "正常"
                        : link.status === "warning"
                          ? "警告"
                          : "错误"}
                    </Badge>
                  </Button>
                  <div className="mt-2 grid gap-1 pl-6 text-xs text-muted-foreground">
                    <p>
                      {link.link_kind === "internal" ? "内链" : "外链"} · target{" "}
                      {link.target ?? "当前窗口"} · rel {link.rel ?? "-"} ·
                      title {link.title ?? "-"}
                    </p>
                    <p>
                      HTTP {link.status_code ?? link.http_status}{" "}
                      {link.redirect_chain.length
                        ? `· 重定向 ${link.redirect_chain.join(" → ")}`
                        : ""}
                    </p>
                    {link.check_error_code && (
                      <p className="text-destructive">
                        {link.check_error_code}
                      </p>
                    )}
                    {link.evidence.map((issue) => (
                      <p key={`${link.link_id}:${issue.rule_id}`}>
                        {issue.message} · {issue.rule_version}
                      </p>
                    ))}
                    <p>检查时间 {displayDate(link.checked_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="border-t pt-4">
        <h3 className="text-sm font-semibold">链接候选</h3>
        <div className="mt-3 flex gap-2">
          <Input
            value={query}
            aria-label="搜索内链候选"
            placeholder="搜索标题、URL 或主题"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadCandidates()
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="搜索链接候选"
            onClick={() => void loadCandidates()}
          >
            {candidateLoading ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Search />
            )}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          候选只会替换当前明确选区，不会自动向正文追加内容。
        </p>
        <div className="mt-4 grid gap-4">
          <div>
            <h4 className="text-xs font-medium text-muted-foreground">
              站内候选
            </h4>
            <ul className="mt-2 divide-y">
              {internal.map((item) => (
                <li key={item.url} className="py-2.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.url}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.target_section ?? "未指定分节"} ·{" "}
                        {item.selection_reason}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={item.duplicate_status === "already_linked"}
                      onPointerDown={(event) => {
                        editorRef.current?.captureLinkCandidateSelection()
                        event.preventDefault()
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insert(item.url, item.suggested_anchor)}
                    >
                      {item.duplicate_status === "already_linked"
                        ? "已存在"
                        : "应用"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-medium text-muted-foreground">
              事实来源候选
            </h4>
            <ul className="mt-2 divide-y">
              {facts.map((item) => (
                <li key={item.source_id} className="py-2.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.title || item.url}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {item.domain || item.url}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Claim {item.claims.length} 项 · 分节{" "}
                        {item.section_ids.join("、") || "-"}
                      </p>
                      {item.domain_risk === "competitor" && (
                        <p className="mt-1 text-xs text-amber-700">
                          竞品域名风险，请人工确认引用必要性。
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onPointerDown={(event) => {
                        editorRef.current?.captureLinkCandidateSelection()
                        event.preventDefault()
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() =>
                        insert(item.url, item.title || item.domain || "来源")
                      }
                    >
                      应用
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  )
}

export function ArticleGovernancePanel({
  projectId,
  articleId,
  article,
  document,
  metadata,
  capabilities,
  dirty,
  disabled,
  editorRef,
  onMetadataChange,
  versionContent,
  assetContent,
  reviewContent,
  sourceContent,
  value,
  onValueChange,
}: {
  projectId: string
  articleId: string
  article: ArticleDetail
  document: ArticleDocument
  metadata: ArticleMetadataSnapshot
  capabilities: ArticleDocumentCapabilities
  dirty: boolean
  disabled: boolean
  editorRef: React.RefObject<ArticleEditorHandle | null>
  onMetadataChange: (
    field: ArticleSeoFieldKey,
    value: string | string[] | ArticleIndexing,
    state?: ArticleSeoFieldState
  ) => void
  versionContent: React.ReactNode
  assetContent: React.ReactNode
  reviewContent: React.ReactNode
  sourceContent: React.ReactNode
  value: "seo" | "links" | "versions" | "assets" | "review" | "sources"
  onValueChange: (
    value: "seo" | "links" | "versions" | "assets" | "review" | "sources"
  ) => void
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) =>
        onValueChange(
          next as "seo" | "links" | "versions" | "assets" | "review" | "sources"
        )
      }
      className="h-full min-h-0 gap-0 overflow-hidden bg-background"
    >
      <div className="shrink-0 border-b bg-background px-3 pt-3">
        <div className="mb-2 px-1">
          <p className="text-sm font-semibold">文章检查</p>
          <p className="text-xs text-muted-foreground">
            优化、审核并发布当前版本
          </p>
        </div>
        <TabsList variant="line" className="min-w-max overflow-x-auto">
          <TabsTrigger value="seo">SEO</TabsTrigger>
          <TabsTrigger value="links">链接</TabsTrigger>
          <TabsTrigger value="versions">版本</TabsTrigger>
          <TabsTrigger value="assets">资产</TabsTrigger>
          <TabsTrigger value="review">发布</TabsTrigger>
          <TabsTrigger value="sources">来源</TabsTrigger>
        </TabsList>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        role="region"
        aria-label="文章治理内容"
        tabIndex={0}
      >
        <TabsContent value="seo">
          <SeoPanel
            projectId={projectId}
            articleId={articleId}
            article={article}
            document={document}
            metadata={metadata}
            capabilities={capabilities}
            dirty={dirty}
            disabled={disabled}
            editorRef={editorRef}
            onMetadataChange={onMetadataChange}
          />
        </TabsContent>
        <TabsContent value="links">
          <LinksPanel
            projectId={projectId}
            articleId={articleId}
            article={article}
            document={document}
            dirty={dirty}
            editorRef={editorRef}
          />
        </TabsContent>
        <TabsContent value="versions">{versionContent}</TabsContent>
        <TabsContent value="assets">{assetContent}</TabsContent>
        <TabsContent value="review">{reviewContent}</TabsContent>
        <TabsContent value="sources">{sourceContent}</TabsContent>
      </div>
    </Tabs>
  )
}
