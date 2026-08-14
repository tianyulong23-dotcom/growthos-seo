import { apiRequest, resolveApiUrl } from "@/api/client"

export type ArticleStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "cancelled"

export type ArticlePublicationStatus = "publish_ready" | "complete_draft"
export type ArticleReviewStatus =
  "pending_review" | "approved" | "changes_requested"
export type CmsPublicationStatus =
  | "queued"
  | "scheduled"
  | "submitting"
  | "published"
  | "failed"
  | "uncertain"
  | "cancelled"
export type ArticleIndexing =
  "index/follow" | "noindex/follow" | "index/nofollow" | "noindex/nofollow"
export type ArticleSeoFieldState =
  "generated" | "confirmed" | "modified" | "stale"
export type ArticleSeoFieldKey =
  | "title"
  | "slug"
  | "focus_keyword"
  | "secondary_keywords"
  | "meta_title"
  | "meta_description"
  | "canonical_url"
  | "indexing"

export type ArticleDocument = {
  type: "doc"
  schema_version: number
  content: Array<Record<string, unknown>>
}

export type ArticleMetadataSnapshot = {
  title: string | null
  slug: string | null
  meta_title: string | null
  meta_description: string | null
  focus_keyword: string | null
  secondary_keywords: string[]
  canonical_url: string | null
  indexing: ArticleIndexing
  field_states: Partial<Record<ArticleSeoFieldKey, ArticleSeoFieldState>>
  publication_status: ArticlePublicationStatus
}

export type ArticleDocumentCapabilities = {
  schema_version: number
  writable: boolean
  recovery_scope: string
  nodes: string[]
  marks: string[]
  heading_levels: number[]
  asset_types: string[]
  media_upload_enabled: boolean
  can_manage_seo_advanced: boolean
  can_manage_locks?: boolean
  limits: Record<string, number>
}

export type ArticleAutosaveSnapshot = {
  id: string
  article_id: string
  client_id: string
  sequence: number
  base_version_number: number
  base_review_version: number
  schema_version: number
  document: ArticleDocument
  metadata: ArticleMetadataSnapshot
  content_hash: string
  created_at: string
  expires_at: string
  promoted_version_number: number | null
}

export type ArticleAutosaveResponse = ArticleAutosaveSnapshot & {
  accepted_sequence: number
  server_time: string
}

export type ArticleWarning = {
  code: string
  message: string
}

export type ArticleRun = {
  id: string
  article_id: string
  status: ArticleStatus
  stage: string
  progress: number
  warnings: ArticleWarning[]
  error_code: string | null
  error_detail: string | null
  failed_stage: string | null
  retryable: boolean | null
  trigger_type: "initial" | "retry" | "regeneration"
  parent_run_id: string | null
  started_at: string | null
  soft_deadline_at: string | null
  hard_deadline_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export type ArticleSummary = {
  id: string
  project_id: string
  primary_keyword: string
  title: string | null
  slug: string | null
  meta_title: string | null
  meta_description: string | null
  focus_keyword: string | null
  secondary_keywords: string[]
  canonical_url: string | null
  indexing: ArticleIndexing
  field_states: Partial<Record<ArticleSeoFieldKey, ArticleSeoFieldState>>
  status: ArticleStatus
  publication_status: ArticlePublicationStatus
  review_status: ArticleReviewStatus | null
  review_version: number
  document_schema_version: number
  current_content_hash: string
  current_version_number: number
  approved_version_number: number | null
  publication_blocked_reason: string | null
  wordpress_post_id: number | null
  wordpress_url: string | null
  cms_publication_status: CmsPublicationStatus | null
  cms_publication_error: string | null
  warning_count: number
  run: ArticleRun | null
  created_at: string
  updated_at: string
}

export type ArticleSource = {
  source_type: string
  url: string
  title: string | null
  domain: string | null
}

export type ArticleDetail = ArticleSummary & {
  outline: Record<string, unknown>
  document: ArticleDocument
  markdown: string | null
  html: string | null
  external_sources: ArticleSource[]
  internal_links: ArticleSource[]
}

export type ArticleCollection = {
  items: ArticleSummary[]
  total: number
  page: number
  page_size: number
}

export type ArticleVersionSummary = {
  id: string
  run_id: string
  version_number: number
  version_type: string
  review_version: number | null
  created_by: string
  restored_from_version_id: string | null
  restorable: boolean
  created_at: string
}

export type ArticleVersionCollection = {
  items: ArticleVersionSummary[]
}

export type ArticleVersionDetail = ArticleVersionSummary & {
  title: string | null
  slug: string | null
  meta_title: string | null
  meta_description: string | null
  focus_keyword: string | null
  secondary_keywords: string[]
  canonical_url: string | null
  indexing: ArticleIndexing | null
  field_states: Partial<Record<ArticleSeoFieldKey, ArticleSeoFieldState>>
  publication_status: ArticlePublicationStatus | null
  outline: Record<string, unknown>
  quality: Record<string, unknown>
  document: ArticleDocument | Record<string, never>
  markdown: string | null
  html: string | null
}

export type ArticleVersionDiffLine = {
  kind: "context" | "added" | "removed"
  content: string
  old_line_number: number | null
  new_line_number: number | null
}

export type ArticleVersionMetadataChange = {
  field: string
  before: unknown
  after: unknown
}

export type ArticleVersionValueChange = {
  path: string
  before: unknown
  after: unknown
}

export type ArticleVersionBlockChange = {
  change_id: string
  kind: "added" | "removed" | "moved" | "updated"
  node_id: string
  node_type: string
  before_index: number | null
  after_index: number | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  attribute_changes: ArticleVersionValueChange[]
}

export type ArticleVersionInlineChange = {
  change_id: string
  node_id: string
  kind: "added" | "removed" | "updated" | "marks_changed"
  before_text: string
  after_text: string
  before_range: number[] | null
  after_range: number[] | null
  before_marks: Array<Record<string, unknown>>
  after_marks: Array<Record<string, unknown>>
}

export type ArticleVersionMediaChange = {
  change_id: string
  node_id: string
  node_type: string
  kind: "reordered" | "item_changed" | "asset_replaced" | "attributes_changed"
  path: string
  before: unknown
  after: unknown
}

export type ArticleVersionTableChange = {
  change_id: string
  node_id: string
  row: number
  column: number
  kind: "cell_changed"
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export type ArticleVersionDiffSummary = {
  blocks_added: number
  blocks_removed: number
  blocks_moved: number
  blocks_updated: number
  inline_changes: number
  media_changes: number
  table_changes: number
  metadata_changes: number
}

export type ArticleVersionDiff = {
  from_version: ArticleVersionSummary
  to_version: ArticleVersionSummary
  algorithm_version: string
  summary: ArticleVersionDiffSummary
  block_changes: ArticleVersionBlockChange[]
  inline_changes: ArticleVersionInlineChange[]
  media_changes: ArticleVersionMediaChange[]
  table_changes: ArticleVersionTableChange[]
  added_lines: number
  removed_lines: number
  truncated: boolean
  metadata_changes: ArticleVersionMetadataChange[]
  lines: ArticleVersionDiffLine[]
}

export type PublicationTarget = {
  id: string
  adapter_type: "wordpress"
  site_url: string
  capabilities: Record<string, unknown>
  status: "verified" | "disconnected" | "disabled"
  updated_at: string
}

export type ArticlePreview = {
  id: string
  article_id: string
  source_type: "version" | "autosave"
  source_version_number: number | null
  autosave_id: string | null
  target_id: string | null
  preview_url: string
  expires_at: string
  revoked_at: string | null
}

export type PublicationAssetProgress = {
  asset_id: string
  node_id: string
  item_id: string | null
  binding_role: string
  variant_hash: string
  status: "pending" | "uploading" | "ready" | "failed" | "uncertain"
  remote_media_id: number | null
  remote_source_url: string | null
  error_code: string | null
}

export type ArticlePublication = {
  id: string
  article_id: string
  version_number: number
  target_id: string
  parent_publication_id: string | null
  operation: "create" | "update"
  mode: "immediate" | "scheduled"
  schedule_at_utc: string | null
  source_timezone: string
  status: CmsPublicationStatus
  payload_hash: string
  asset_manifest_hash: string
  remote_post_id: number | null
  remote_url: string | null
  attempt_count: number
  last_error_code: string | null
  last_error_detail: string | null
  created_by: string
  created_at: string
  updated_at: string
  published_at: string | null
  cancelled_at: string | null
  media: PublicationAssetProgress[]
  allowed_actions: Array<"cancel" | "retry" | "reconcile">
}

export type ArticlePublicationSnapshot = {
  publication_id: string
  published_version_number: number
  published_snapshot: Record<string, unknown>
  current_draft_version_number: number
  current_draft_diff: ArticleVersionDiff | null
}

export type ArticleReviewTaskStatus =
  "pending" | "in_review" | "approved" | "needs_changes" | "cancelled"

export type ArticleReviewComment = {
  id: string
  task_id: string
  author_id: string
  body: string
  node_id: string | null
  position: Record<string, unknown> | null
  created_at: string
}

export type ArticleReviewTask = {
  id: string
  article_id: string
  project_id: string
  version_number: number
  status: ArticleReviewTaskStatus
  assigned_to: string | null
  assigned_group: string | null
  submitted_by: string
  submitted_at: string
  claimed_by: string | null
  claimed_at: string | null
  decided_by: string | null
  decided_at: string | null
  decision_comment: string | null
  policy_version: string
  comments: ArticleReviewComment[]
}

export type ArticleReviewTaskCollection = {
  items: ArticleReviewTask[]
}

export type ArticleReviewSnapshot = {
  task: ArticleReviewTask
  version: ArticleVersionDetail
  baseline_version_number: number | null
  diff: ArticleVersionDiff | null
  current_draft_version_number: number
  approved_version_number: number | null
}

export type ArticleLockType = "edit_lock"

export type ArticleLock = {
  id: string
  article_id: string
  lock_type: ArticleLockType
  version_number: number | null
  owner_id: string
  reason: string
  fence: number
  acquired_at: string
  renewed_at: string
  expires_at: string
  released_at: string | null
  token: string | null
}

export type ArticleLockCredential = {
  lockId: string
  token: string
  fence: number
}

export type ArticleSeoRuleEvidence = {
  field: string | null
  node_id: string | null
  start: number | null
  end: number | null
  keyword: string | null
  text: string | null
  href: string | null
}

export type ArticleSeoRuleResult = {
  rule_id: string
  rule_version: string
  group: string
  dependencies: string[]
  applicable: boolean
  status: "passed" | "failed" | "not_applicable"
  severity: "suggestion"
  score: number
  max_score: number
  message: string
  evidence: ArticleSeoRuleEvidence[]
  action: "focus_field" | "focus_evidence"
  reused: boolean
}

export type ArticleSeoAnalysisGroup = {
  id: string
  label: string
  results: ArticleSeoRuleResult[]
}

export type ArticleSeoAnalysis = {
  analysis_id: string | null
  article_version: number | null
  document_hash: string
  metadata_hash: string
  ruleset_version: string
  score: number
  max_score: number
  is_stale: boolean
  status: "completed" | "failed" | "unavailable"
  error_code: string | null
  error_detail: string | null
  analyzed_at: string | null
  groups: ArticleSeoAnalysisGroup[]
}

export type ArticleLinkIssue = {
  rule_id: string
  rule_version: string
  severity: "error" | "warning"
  message: string
  action: "edit_link" | "focus_link" | "confirm_link" | "retry_check"
}

export type ArticleLinkResult = {
  link_id: string
  node_id: string
  node_type: "text" | "bookmark" | "button"
  start: number
  end: number
  anchor_text: string
  href: string
  final_url: string
  link_kind: "internal" | "external"
  target: string | null
  rel: string | null
  title: string | null
  status: "passed" | "warning" | "error"
  http_status:
    "not_checked" | "ok" | "redirect" | "broken" | "server_error" | "unknown"
  status_code: number | null
  redirect_chain: string[]
  check_error_code: string | null
  evidence: ArticleLinkIssue[]
  checked_at: string
}

export type ArticleLinkAnalysis = {
  analysis_id: string | null
  article_version: number | null
  document_hash: string
  ruleset_version: string
  status: "queued" | "running" | "completed" | "failed" | "unavailable"
  pending_analysis_id: string | null
  is_stale: boolean
  error_code: string | null
  error_detail: string | null
  created_at: string | null
  completed_at: string | null
  checked_at: string | null
  summary: {
    total: number
    internal: number
    external: number
    errors: number
    warnings: number
  }
  links: ArticleLinkResult[]
}

export type InternalLinkCandidate = {
  title: string
  url: string
  suggested_anchor: string
  target_section: string | null
  duplicate_status: "new" | "already_linked"
  candidate_kind: "business_page" | "published_article" | "navigation"
  selection_reason: string
}

export type FactSourceCandidate = {
  source_id: string
  source_type: string
  title: string | null
  url: string
  domain: string | null
  status: string
  claims: Array<Record<string, unknown>>
  section_ids: string[]
  domain_risk: "normal" | "competitor"
}

export type BookmarkResolveResult = {
  kind: "bookmark" | "link"
  source_url: string
  final_url: string
  title: string | null
  description: string | null
  publisher: string | null
  icon_url: string | null
  image_url: string | null
  fetched_at: string | null
  error_code: string | null
  retryable: boolean
}

export type EmbedResolveResult = {
  kind: "embed" | "link"
  source_url: string
  provider: "youtube" | "vimeo" | "spotify" | null
  embed_id: string | null
  embed_url: string | null
  error_code: string | null
}

export type CreateArticleInput = {
  primary_keyword: string
  title: string | null
  language: string
}

export type ListArticleParams = {
  page?: number
  pageSize?: number
  status?: ArticleStatus
  search?: string
}

export type ArticleRequestOptions = {
  accessToken?: string
  requestId?: string
  signal?: AbortSignal
  keepalive?: boolean
}

export type ArticleAIEditCommand =
  | "rewrite"
  | "polish"
  | "shorten"
  | "expand"
  | "proofread"
  | "translate"
  | "continue"
  | "title"
  | "meta_title"
  | "meta_description"
  | "faq"
  | "cta"

export type ArticleAIEditStatus =
  | "queued"
  | "streaming"
  | "ready"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "failed"
  | "stale"

export type ArticleAIEditScope = "selection" | "block" | "cursor" | "metadata"
export type ArticleAIEditAcceptMode =
  "replace" | "insert_after" | "apply_metadata"

export type ArticleAIEditSelection = {
  anchor_node_id: string
  from: number
  to: number
  selected_text_hash: string
}

export type ArticleAIEditContext = {
  heading_path?: string[]
  focus_keyword?: string | null
  locale?: string
  target_locale?: string | null
  brand_terms?: string[]
}

export type ArticleAIEditCandidate = {
  kind: "text" | "metadata" | "slice"
  text: string | null
  metadata: { field?: string; candidates?: string[] } | null
  slice: { type?: string; content?: Array<Record<string, unknown>> } | null
}

export type ArticleAIEditOperation = {
  id: string
  article_id: string
  parent_operation_id: string | null
  command: ArticleAIEditCommand
  scope: ArticleAIEditScope
  status: ArticleAIEditStatus
  base_review_version: number
  document_hash: string
  selection: ArticleAIEditSelection | null
  prompt_version: string
  provider: string | null
  model: string | null
  candidate: ArticleAIEditCandidate
  allowed_modes: ArticleAIEditAcceptMode[]
  error_code: string | null
  error_detail: string | null
  input_tokens: number
  output_tokens: number
  latency_ms: number | null
  stream_revision: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  decided_at: string | null
  accepted_mode: ArticleAIEditAcceptMode | null
  accepted_result: Record<string, unknown> | null
}

export type CreateArticleAIEditInput = {
  base_review_version: number
  document_hash: string
  document: ArticleDocument
  metadata: ArticleMetadataSnapshot
  command: ArticleAIEditCommand
  scope: ArticleAIEditScope
  selection: ArticleAIEditSelection | null
  context: ArticleAIEditContext
}

export type CreateArticleAIEditResponse = {
  operation: ArticleAIEditOperation
  stream_endpoint: string
  stream_token: string
  stream_expires_at: string
}

export type AcceptArticleAIEditInput = {
  current_review_version: number
  current_document_hash: string
  current_document: ArticleDocument
  current_metadata: ArticleMetadataSnapshot
  current_selection: ArticleAIEditSelection | null
  mode: ArticleAIEditAcceptMode
  candidate_index?: number | null
}

export type AcceptArticleAIEditResponse = {
  operation: ArticleAIEditOperation
  canonical_slice: {
    type?: string
    content?: Array<Record<string, unknown>>
  } | null
  canonical_metadata: { field?: string; value?: string } | null
  anchor_node_id: string | null
  from: number | null
  to: number | null
}

function articlePath(projectId: string, suffix = "") {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/articles${suffix}`
}

function publicationPath(projectId: string, suffix = "") {
  return `/api/v1/projects/${encodeURIComponent(projectId)}${suffix}`
}

function requestHeaders(
  options?: ArticleRequestOptions,
  headers?: HeadersInit
): Headers {
  const result = new Headers(headers)
  if (options?.accessToken) {
    result.set("Authorization", `Bearer ${options.accessToken}`)
  }
  if (options?.requestId) result.set("X-Request-ID", options.requestId)
  return result
}

function requestInit(
  options?: ArticleRequestOptions,
  init: RequestInit = {}
): RequestInit {
  return {
    ...init,
    signal: options?.signal ?? init.signal,
    keepalive: options?.keepalive ?? init.keepalive,
    headers: requestHeaders(options, init.headers),
  }
}

function articleLockHeaders(credential: ArticleLockCredential): HeadersInit {
  return {
    "X-Article-Lock-Token": credential.token,
    "X-Article-Lock-Fence": String(credential.fence),
  }
}

export function createArticle(
  projectId: string,
  input: CreateArticleInput,
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleSummary>(
    articlePath(projectId),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function listArticles(
  projectId: string,
  params: ListArticleParams = {},
  options?: ArticleRequestOptions
) {
  const query = new URLSearchParams()
  query.set("page", String(params.page ?? 1))
  query.set("page_size", String(params.pageSize ?? 25))
  if (params.status) query.set("status", params.status)
  if (params.search?.trim()) query.set("search", params.search.trim())
  return apiRequest<ArticleCollection>(
    `${articlePath(projectId)}?${query.toString()}`,
    requestInit(options)
  )
}

export function getArticle(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleDetail>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}`),
    requestInit(options)
  )
}

export function getArticleRun(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleRun>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/run`),
    requestInit(options)
  )
}

export function cancelArticle(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleSummary>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/cancel`),
    requestInit(options, { method: "POST" })
  )
}

function startFollowupRun(
  projectId: string,
  articleId: string,
  action: "retry" | "regenerate",
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleSummary>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/${action}`),
    requestInit(options, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    })
  )
}

export function retryArticle(
  projectId: string,
  articleId: string,
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return startFollowupRun(
    projectId,
    articleId,
    "retry",
    idempotencyKey,
    options
  )
}

export function regenerateArticle(
  projectId: string,
  articleId: string,
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return startFollowupRun(
    projectId,
    articleId,
    "regenerate",
    idempotencyKey,
    options
  )
}

export function saveArticleDocument(
  projectId: string,
  articleId: string,
  input: {
    document: ArticleDocument
    metadata: ArticleMetadataSnapshot
    content_hash: string
    base_review_version: number
    base_version_number: number
    autosave_id?: string | null
    reason?: string | null
  },
  credential: ArticleLockCredential,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleDetail>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/document`),
    requestInit(options, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...articleLockHeaders(credential),
      },
      body: JSON.stringify(input),
    })
  )
}

export function getArticleDocumentCapabilities(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleDocumentCapabilities>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/document-capabilities`
    ),
    requestInit(options)
  )
}

export function analyzeArticleSeo(
  projectId: string,
  articleId: string,
  input: {
    document_hash: string
    metadata_hash: string
    changed_fields?: string[]
    ruleset_version?: string | null
  },
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleSeoAnalysis>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/seo-analysis`),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function getLatestArticleSeoAnalysis(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleSeoAnalysis>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/seo-analysis/latest`
    ),
    requestInit(options)
  )
}

export function analyzeArticleLinks(
  projectId: string,
  articleId: string,
  input: { document_hash: string; check_external?: boolean },
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleLinkAnalysis>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/link-analysis`),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function getLatestArticleLinkAnalysis(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleLinkAnalysis>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/link-analysis/latest`
    ),
    requestInit(options)
  )
}

export function getInternalLinkCandidates(
  projectId: string,
  articleId: string,
  input: { query?: string; cursor?: string | null; limit?: number } = {},
  options?: ArticleRequestOptions
) {
  const query = new URLSearchParams({ article_id: articleId })
  if (input.query?.trim()) query.set("query", input.query.trim())
  if (input.cursor) query.set("cursor", input.cursor)
  query.set("limit", String(input.limit ?? 20))
  return apiRequest<{
    items: InternalLinkCandidate[]
    next_cursor: string | null
  }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/internal-link-candidates?${query.toString()}`,
    requestInit(options)
  )
}

export function getFactSourceCandidates(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<{ items: FactSourceCandidate[] }>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/fact-source-candidates`
    ),
    requestInit(options)
  )
}

function resolveEnhancedArticleUrl<T>(
  projectId: string,
  articleId: string,
  suffix: string,
  url: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<T>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/${suffix}`),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
  )
}

export function resolveArticleBookmark(
  projectId: string,
  articleId: string,
  url: string,
  options?: ArticleRequestOptions
) {
  return resolveEnhancedArticleUrl<BookmarkResolveResult>(
    projectId,
    articleId,
    "bookmarks/resolve",
    url,
    options
  )
}

export function refreshArticleBookmark(
  projectId: string,
  articleId: string,
  url: string,
  options?: ArticleRequestOptions
) {
  return resolveEnhancedArticleUrl<BookmarkResolveResult>(
    projectId,
    articleId,
    "bookmarks/refresh",
    url,
    options
  )
}

export function resolveArticleEmbed(
  projectId: string,
  articleId: string,
  url: string,
  options?: ArticleRequestOptions
) {
  return resolveEnhancedArticleUrl<EmbedResolveResult>(
    projectId,
    articleId,
    "embeds/resolve",
    url,
    options
  )
}

export function saveArticleAutosave(
  projectId: string,
  articleId: string,
  input: {
    client_id: string
    sequence: number
    base_version_number: number
    base_review_version: number
    document: ArticleDocument
    metadata: ArticleMetadataSnapshot
    content_hash: string
    idempotency_key: string
  },
  credential: ArticleLockCredential,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleAutosaveResponse>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/autosave`),
    requestInit(options, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...articleLockHeaders(credential),
      },
      body: JSON.stringify(input),
    })
  )
}

export function getLatestArticleAutosave(
  projectId: string,
  articleId: string,
  clientId?: string,
  options?: ArticleRequestOptions
) {
  const query = clientId ? `?client_id=${encodeURIComponent(clientId)}` : ""
  return apiRequest<ArticleAutosaveSnapshot | null>(
    `${articlePath(projectId, `/${encodeURIComponent(articleId)}/autosaves/latest`)}${query}`,
    requestInit(options)
  )
}

export function promoteArticleAutosave(
  projectId: string,
  articleId: string,
  autosaveId: string,
  input: {
    base_version_number: number
    base_review_version: number
    reason?: string | null
  },
  credential: ArticleLockCredential,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleDetail>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/autosaves/${encodeURIComponent(autosaveId)}/promote`
    ),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...articleLockHeaders(credential),
      },
      body: JSON.stringify(input),
    })
  )
}

export function deleteArticleAutosave(
  projectId: string,
  articleId: string,
  autosaveId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<void>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/autosaves/${encodeURIComponent(autosaveId)}`
    ),
    requestInit(options, { method: "DELETE" })
  )
}

export function listArticleVersions(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleVersionCollection>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/versions`),
    requestInit(options)
  )
}

export function getArticleVersion(
  projectId: string,
  articleId: string,
  versionNumber: number,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleVersionDetail>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/versions/${versionNumber}`
    ),
    requestInit(options)
  )
}

export function compareArticleVersions(
  projectId: string,
  articleId: string,
  fromVersion: number,
  toVersion: number,
  options?: ArticleRequestOptions
) {
  const query = new URLSearchParams({
    from_version: String(fromVersion),
    to_version: String(toVersion),
  })
  return apiRequest<ArticleVersionDiff>(
    `${articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/versions/compare`
    )}?${query.toString()}`,
    requestInit(options)
  )
}

export function restoreArticleVersion(
  projectId: string,
  articleId: string,
  versionNumber: number,
  reviewVersion: number,
  credential: ArticleLockCredential,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleDetail>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/versions/${versionNumber}/restore`
    ),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...articleLockHeaders(credential),
      },
      body: JSON.stringify({ review_version: reviewVersion }),
    })
  )
}

export function reviewArticle(
  projectId: string,
  articleId: string,
  input: {
    review_status: "approved" | "changes_requested"
    review_note?: string | null
    review_version: number
  },
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleSummary>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/review`),
    requestInit(options, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function submitArticleReview(
  projectId: string,
  articleId: string,
  input: {
    version_number: number
    assigned_to?: string | null
    assigned_group?: string | null
  },
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleReviewTask>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/review-tasks`),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function listArticleReviewTasks(
  projectId: string,
  articleId: string,
  statuses: ArticleReviewTaskStatus[] = [],
  options?: ArticleRequestOptions
) {
  const query = new URLSearchParams()
  statuses.forEach((status) => query.append("statuses", status))
  const suffix = query.size ? `?${query.toString()}` : ""
  return apiRequest<ArticleReviewTaskCollection>(
    `${articlePath(projectId, `/${encodeURIComponent(articleId)}/review-tasks`)}${suffix}`,
    requestInit(options)
  )
}

function reviewTaskPath(projectId: string, taskId = "") {
  const suffix = taskId ? `/${encodeURIComponent(taskId)}` : ""
  return `/api/v1/projects/${encodeURIComponent(projectId)}/review-tasks${suffix}`
}

export function listArticleReviewInbox(
  projectId: string,
  statuses: ArticleReviewTaskStatus[] = [],
  options?: ArticleRequestOptions
) {
  const query = new URLSearchParams()
  statuses.forEach((status) => query.append("statuses", status))
  const suffix = query.size ? `?${query.toString()}` : ""
  return apiRequest<ArticleReviewTaskCollection>(
    `${reviewTaskPath(projectId)}${suffix}`,
    requestInit(options)
  )
}

export function getArticleReviewTask(
  projectId: string,
  taskId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleReviewTask>(
    reviewTaskPath(projectId, taskId),
    requestInit(options)
  )
}

export function claimArticleReviewTask(
  projectId: string,
  taskId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleReviewTask>(
    `${reviewTaskPath(projectId, taskId)}/claim`,
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_status: "pending" }),
    })
  )
}

export function addArticleReviewComment(
  projectId: string,
  taskId: string,
  input: {
    body: string
    node_id?: string | null
    position?: Record<string, unknown> | null
  },
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleReviewComment>(
    `${reviewTaskPath(projectId, taskId)}/comments`,
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function decideArticleReviewTask(
  projectId: string,
  taskId: string,
  input: { decision: "approved" | "needs_changes"; comment?: string | null },
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleReviewTask>(
    `${reviewTaskPath(projectId, taskId)}/decision`,
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function cancelArticleReviewTask(
  projectId: string,
  taskId: string,
  reason: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleReviewTask>(
    `${reviewTaskPath(projectId, taskId)}/cancel`,
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
  )
}

export function getArticleReviewSnapshot(
  projectId: string,
  taskId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleReviewSnapshot>(
    `${reviewTaskPath(projectId, taskId)}/snapshot`,
    requestInit(options)
  )
}

export function acquireArticleLock(
  projectId: string,
  articleId: string,
  input: {
    lock_type?: ArticleLockType
    version_number?: number | null
    reason?: string
    lease_seconds?: number
  } = {},
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleLock>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/locks`),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function getActiveArticleLock(
  projectId: string,
  articleId: string,
  lockType: ArticleLockType = "edit_lock",
  options?: ArticleRequestOptions
) {
  const query = new URLSearchParams({ lock_type: lockType })
  return apiRequest<ArticleLock | null>(
    `${articlePath(projectId, `/${encodeURIComponent(articleId)}/locks/active`)}?${query.toString()}`,
    requestInit(options)
  )
}

export function renewArticleLock(
  projectId: string,
  articleId: string,
  credential: ArticleLockCredential,
  leaseSeconds = 90,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleLock>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/locks/${encodeURIComponent(credential.lockId)}/renew`
    ),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lock_type: "edit_lock",
        token: credential.token,
        fence: credential.fence,
        lease_seconds: leaseSeconds,
      }),
    })
  )
}

export function releaseArticleLock(
  projectId: string,
  articleId: string,
  credential: ArticleLockCredential,
  reason = "editor_closed",
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleLock>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/locks/${encodeURIComponent(credential.lockId)}/release`
    ),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lock_type: "edit_lock",
        token: credential.token,
        fence: credential.fence,
        reason,
      }),
    })
  )
}

export function forceReleaseArticleLock(
  projectId: string,
  articleId: string,
  lockId: string,
  reason: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleLock>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/locks/${encodeURIComponent(lockId)}/force-release`
    ),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
  )
}

export function listPublicationTargets(
  projectId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<{ items: PublicationTarget[] }>(
    publicationPath(projectId, "/publication-targets"),
    requestInit(options)
  )
}

export function createArticlePreview(
  projectId: string,
  articleId: string,
  input:
    | {
        source_type: "version"
        version_number: number
        target_id?: string | null
        audience?: "creator" | "organization"
        expires_in_minutes?: number
      }
    | {
        source_type: "autosave"
        autosave_id: string
        target_id?: string | null
        audience?: "creator" | "organization"
        expires_in_minutes?: number
      },
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticlePreview>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/previews`),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  )
}

export function revokeArticlePreview(
  projectId: string,
  articleId: string,
  previewId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<void>(
    articlePath(
      projectId,
      `/${encodeURIComponent(articleId)}/previews/${encodeURIComponent(previewId)}`
    ),
    requestInit(options, { method: "DELETE" })
  )
}

export function createArticlePublication(
  projectId: string,
  articleId: string,
  input: {
    version_number: number
    target_id: string
    mode: "immediate" | "scheduled"
    schedule_at?: string | null
    source_timezone: string
  },
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticlePublication>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/publications`),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function listArticlePublications(
  projectId: string,
  articleId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<{ items: ArticlePublication[] }>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/publications`),
    requestInit(options)
  )
}

export function getArticlePublication(
  projectId: string,
  publicationId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticlePublication>(
    publicationPath(
      projectId,
      `/publications/${encodeURIComponent(publicationId)}`
    ),
    requestInit(options)
  )
}

export function getArticlePublicationSnapshot(
  projectId: string,
  publicationId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticlePublicationSnapshot>(
    publicationPath(
      projectId,
      `/publications/${encodeURIComponent(publicationId)}/snapshot`
    ),
    requestInit(options)
  )
}

export function cancelArticlePublication(
  projectId: string,
  publicationId: string,
  reason: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticlePublication>(
    publicationPath(
      projectId,
      `/publications/${encodeURIComponent(publicationId)}/cancel`
    ),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
  )
}

export function retryArticlePublication(
  projectId: string,
  publicationId: string,
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticlePublication>(
    publicationPath(
      projectId,
      `/publications/${encodeURIComponent(publicationId)}/retry`
    ),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ expected_status: "failed" }),
    })
  )
}

export function reconcileArticlePublication(
  projectId: string,
  publicationId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticlePublication>(
    publicationPath(
      projectId,
      `/publications/${encodeURIComponent(publicationId)}/reconcile`
    ),
    requestInit(options, { method: "POST" })
  )
}

export function publishArticle(
  projectId: string,
  articleId: string,
  versionNumber: number,
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleSummary>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/publish`),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ version_number: versionNumber }),
    })
  )
}

function articleAIEditPath(projectId: string, articleId: string, suffix = "") {
  return articlePath(
    projectId,
    `/${encodeURIComponent(articleId)}/ai-edits${suffix}`
  )
}

export function createArticleAIEdit(
  projectId: string,
  articleId: string,
  input: CreateArticleAIEditInput,
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<CreateArticleAIEditResponse>(
    articleAIEditPath(projectId, articleId),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function getArticleAIEdit(
  projectId: string,
  articleId: string,
  operationId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleAIEditOperation>(
    articleAIEditPath(
      projectId,
      articleId,
      `/${encodeURIComponent(operationId)}`
    ),
    requestInit(options)
  )
}

export function cancelArticleAIEdit(
  projectId: string,
  articleId: string,
  operationId: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleAIEditOperation>(
    articleAIEditPath(
      projectId,
      articleId,
      `/${encodeURIComponent(operationId)}/cancel`
    ),
    requestInit(options, { method: "POST" })
  )
}

export function rejectArticleAIEdit(
  projectId: string,
  articleId: string,
  operationId: string,
  reason: string | null,
  options?: ArticleRequestOptions
) {
  return apiRequest<ArticleAIEditOperation>(
    articleAIEditPath(
      projectId,
      articleId,
      `/${encodeURIComponent(operationId)}/reject`
    ),
    requestInit(options, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
  )
}

export function acceptArticleAIEdit(
  projectId: string,
  articleId: string,
  operationId: string,
  input: AcceptArticleAIEditInput,
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<AcceptArticleAIEditResponse>(
    articleAIEditPath(
      projectId,
      articleId,
      `/${encodeURIComponent(operationId)}/accept`
    ),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function retryArticleAIEdit(
  projectId: string,
  articleId: string,
  operationId: string,
  input: Omit<CreateArticleAIEditInput, "command" | "scope"> & {
    reason?: string | null
  },
  idempotencyKey: string,
  options?: ArticleRequestOptions
) {
  return apiRequest<CreateArticleAIEditResponse>(
    articleAIEditPath(
      projectId,
      articleId,
      `/${encodeURIComponent(operationId)}/retry`
    ),
    requestInit(options, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    })
  )
}

export function subscribeArticleAIEdit(
  response: Pick<
    CreateArticleAIEditResponse,
    "stream_endpoint" | "stream_token"
  >,
  handlers: {
    onOperation: (operation: ArticleAIEditOperation) => void
    onError: (error: Error) => void
  }
) {
  const endpoint = new URL(
    resolveApiUrl(response.stream_endpoint),
    window.location.href
  )
  endpoint.searchParams.set("token", response.stream_token)
  const source = new EventSource(endpoint.toString())
  source.addEventListener("operation", (event) => {
    try {
      handlers.onOperation(
        JSON.parse(
          (event as MessageEvent<string>).data
        ) as ArticleAIEditOperation
      )
    } catch {
      source.close()
      handlers.onError(new Error("AI 候选流返回了无效数据"))
    }
  })
  source.addEventListener("error", () => {
    source.close()
    handlers.onError(new Error("AI 候选流已中断，可重试本次操作"))
  })
  return () => source.close()
}
