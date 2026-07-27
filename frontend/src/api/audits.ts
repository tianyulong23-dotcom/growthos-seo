import { ApiError, apiRequest } from "@/api/client"
import type { AuditSettings } from "@/features/audit/audit-settings"
import type { Project } from "@/features/projects/types"

export type AuditRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "recalculating"
  | "completed"
  | "failed"
export type AuditSeverity = "error" | "warning" | "notice"
export type AuditStatusFamily = "2xx" | "3xx" | "4xx" | "5xx" | "unknown"
export type AuditExportDataset = "issues" | "pages" | "links"
export type AuditExportFormat = "csv" | "json" | "xml" | "xlsx"

export type AuditSummary = {
  page_count: number
  health_score: number
  errors: number
  warnings: number
  notices: number
  rendered_pages: number
  resource_checks_truncated: boolean
}

export type AuditPageSpeedState = {
  configured: boolean
  status: string
  message: string
  provider?: string
}

export type AuditRun = {
  run_id: string
  project_id: string
  status: AuditRunStatus
  stage: string
  message: string
  progress: number
  discovered: number
  processed: number
  selected: number
  created_at: string
  completed_at?: string
  can_resume: boolean
  archived_at?: string
  summary: AuditSummary | null
  pagespeed: AuditPageSpeedState | null
  issue_exclusion_patterns?: string[]
}

export type AuditRunCollection = {
  items: AuditRun[]
  total: number
  page: number
  page_size: number
}

export type AuditActivity = {
  sequence: number
  url: string
  final_url: string
  status_code: number | null
  title: string
  error: string
  error_type: string
  depth: number | null
  rendered: boolean
  response_time_ms: number | null
  fetched_at?: string
}

export type AuditActivityCollection = {
  items: AuditActivity[]
  next_cursor: number
}

export type AuditIssue = {
  id: string
  title: string
  code: string
  severity: AuditSeverity
  category: string
  affected_count: number
  description: string
  recommendation: string
  urls: string[]
  raw: Record<string, unknown>
}

export type AuditPage = {
  id: string
  url: string
  final_url: string
  status_code: number | null
  title: string
  description: string
  content_type: string
  indexable: boolean | null
  word_count: number | null
  response_time_ms: number | null
  rendered: boolean | null
  issues_count: number
  depth: number | null
  canonical: string
  h1: string[]
  h2: string[]
  h3: string[]
  headings: string[]
  meta_tags: Record<string, string>
  size_bytes: number
  language: string
  charset: string
  viewport: string
  robots: string
  author: string
  keywords: string
  generator: string
  theme_color: string
  open_graph: Record<string, string>
  twitter_tags: Record<string, string>
  structured_data: JsonRecord[]
  schema_org: JsonRecord[]
  analytics: JsonRecord
  images: JsonRecord[]
  broken_images: JsonRecord[]
  internal_links: number
  external_links: number
  hreflang: JsonRecord[]
  redirects: JsonRecord[]
  linked_from: string[]
  discovered_from: string
  error: string
  error_type: string
  raw: Record<string, unknown>
}

export type AuditLink = {
  id: string
  source_url: string
  target_url: string
  anchor_text: string
  status_code: number | null
  kind: string
  internal: boolean | null
  follow: boolean | null
  error: string
  placement: string
  target_domain: string
  rel: string
  in_navigation: boolean
  raw: Record<string, unknown>
}

export type AuditExternalResource = {
  id: string
  url: string
  final_url: string
  status_code: number | null
  content_type: string
  size_bytes: number
  title: string
  error: string
  error_type: string
  checked_at: string | null
  raw: Record<string, unknown>
}

export type AuditStatusCode = {
  status_code: number
  status: string
  count: number
  percentage: number
  error_type: string
}

export type AuditVisualizationNode = {
  id: string
  label: string
  url: string
  group: string
  depth: number | null
  issue_count: number
  raw: Record<string, unknown>
}

export type AuditVisualizationEdge = {
  id: string
  source: string
  target: string
  label: string
  raw: Record<string, unknown>
}

export type AuditVisualization = {
  nodes: AuditVisualizationNode[]
  edges: AuditVisualizationEdge[]
  total_nodes: number
  total_edges: number
  truncated: boolean
}

export type AuditPageSpeedResult = {
  id: string
  url: string
  strategy: string
  performance_score: number | null
  accessibility_score: number | null
  best_practices_score: number | null
  seo_score: number | null
  metrics: Record<string, unknown>
  error: string
  analyzed_at: string
}

export type AuditCollection<T> = {
  items: T[]
  total: number
  page: number
  page_size: number
}

type JsonRecord = Record<string, unknown>

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function text(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string") return value
  }
  return ""
}

function number(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function boolean(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "boolean") return value
  }
  return null
}

function stringArray(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string")
    }
  }
  return []
}

function recordArray(record: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value.map(asRecord)
  }
  return []
}

function normalizeSummary(value: unknown): AuditSummary | null {
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return null
  return {
    page_count: number(record, "page_count", "pages") ?? 0,
    health_score: number(record, "health_score", "score") ?? 0,
    errors: number(record, "errors", "error_count") ?? 0,
    warnings: number(record, "warnings", "warning_count") ?? 0,
    notices: number(record, "notices", "notice_count", "info_count") ?? 0,
    rendered_pages: number(record, "rendered_pages", "rendered") ?? 0,
    resource_checks_truncated:
      boolean(record, "resource_checks_truncated") ?? false,
  }
}

function normalizePageSpeed(record: JsonRecord): AuditPageSpeedState | null {
  const value = asRecord(record.pagespeed ?? record.page_speed)
  const configured =
    boolean(value, "configured", "enabled") ??
    boolean(record, "pagespeed_configured")
  if (configured === null && Object.keys(value).length === 0) return null
  return {
    configured: configured ?? false,
    status: text(value, "status") || text(record, "pagespeed_status"),
    message: text(value, "message", "detail"),
    provider: text(value, "provider") || undefined,
  }
}

function normalizeRun(value: unknown): AuditRun {
  const record = asRecord(value)
  const status = text(record, "status") as AuditRunStatus
  return {
    run_id: text(record, "run_id", "id"),
    project_id: text(record, "project_id"),
    status: [
      "queued",
      "running",
      "paused",
      "stopping",
      "stopped",
      "recalculating",
      "completed",
      "failed",
    ].includes(status)
      ? status
      : "failed",
    stage: text(record, "stage"),
    message: text(record, "message", "detail"),
    progress: number(record, "progress") ?? 0,
    discovered: number(record, "discovered") ?? 0,
    processed: number(record, "processed") ?? 0,
    selected: number(record, "selected") ?? 0,
    created_at: text(record, "created_at", "started_at"),
    completed_at: text(record, "completed_at", "finished_at") || undefined,
    can_resume: boolean(record, "can_resume") ?? false,
    archived_at: text(record, "archived_at") || undefined,
    summary: normalizeSummary(record.summary),
    pagespeed: normalizePageSpeed(record),
    issue_exclusion_patterns: stringArray(record, "issue_exclusion_patterns")
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

function normalizeActivity(value: unknown, index: number): AuditActivity {
  const record = asRecord(value)
  const url = text(record, "url")
  return {
    sequence: number(record, "sequence") ?? index + 1,
    url,
    final_url: text(record, "final_url") || url,
    status_code: number(record, "status_code"),
    title: text(record, "title"),
    error: text(record, "error"),
    error_type: text(record, "error_type"),
    depth: number(record, "depth"),
    rendered: boolean(record, "rendered") ?? false,
    response_time_ms: number(record, "response_time_ms"),
    fetched_at: text(record, "fetched_at") || undefined,
  }
}

function collectionValues(value: unknown, key: string) {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  for (const candidate of [key, "items", "results", "data"]) {
    if (Array.isArray(record[candidate])) return record[candidate]
  }
  return []
}

function normalizeCollection<T>(
  value: unknown,
  key: string,
  normalize: (item: unknown, index: number) => T
): AuditCollection<T> {
  const record = asRecord(value)
  const values = collectionValues(value, key)
  return {
    items: values.map(normalize),
    total: number(record, "total", "count") ?? values.length,
    page: number(record, "page", "current_page") ?? 1,
    page_size:
      number(record, "page_size", "per_page", "limit") ?? values.length,
  }
}

function normalizeSeverity(value: string): AuditSeverity {
  const severity = value.toLowerCase()
  if (["error", "critical", "high"].includes(severity)) return "error"
  if (["warning", "warn", "medium"].includes(severity)) return "warning"
  return "notice"
}

function normalizeIssue(value: unknown, index: number): AuditIssue {
  const record = asRecord(value)
  const code = text(record, "code", "rule_id", "type")
  return {
    id: text(record, "id", "issue_id") || code || `issue-${index}`,
    title: text(record, "title", "name", "message") || code || "未命名问题",
    code,
    severity: normalizeSeverity(text(record, "severity", "level", "priority")),
    category: text(record, "category", "group") || "其他",
    affected_count:
      number(record, "affected_count", "count", "pages_count") ?? 0,
    description: text(record, "description", "detail", "message"),
    recommendation: text(record, "recommendation", "how_to_fix", "solution"),
    urls: stringArray(record, "urls", "affected_urls", "pages"),
    raw: record,
  }
}

function normalizePage(value: unknown, index: number): AuditPage {
  const record = asRecord(value)
  const url = text(record, "url", "normalized_url")
  return {
    id: text(record, "id", "page_id") || url || `page-${index}`,
    url,
    final_url: text(record, "final_url") || url,
    status_code: number(record, "status_code", "http_status"),
    title: text(record, "title"),
    description: text(record, "description", "meta_description"),
    content_type: text(record, "content_type", "mime_type"),
    indexable: boolean(record, "indexable", "is_indexable"),
    word_count: number(record, "word_count", "words"),
    response_time_ms: number(
      record,
      "response_time_ms",
      "load_time_ms",
      "duration_ms"
    ),
    rendered: boolean(record, "rendered", "js_rendered"),
    issues_count: number(record, "issues_count", "issue_count") ?? 0,
    depth: number(record, "depth", "crawl_depth"),
    canonical: text(record, "canonical", "canonical_url"),
    h1: stringArray(record, "h1"),
    h2: stringArray(record, "h2"),
    h3: stringArray(record, "h3"),
    headings: stringArray(record, "headings"),
    meta_tags: asRecord(record.meta_tags) as Record<string, string>,
    size_bytes: number(record, "size_bytes", "size") ?? 0,
    language: text(record, "language"),
    charset: text(record, "charset"),
    viewport: text(record, "viewport"),
    robots: text(record, "robots"),
    author: text(record, "author"),
    keywords: text(record, "keywords"),
    generator: text(record, "generator"),
    theme_color: text(record, "theme_color"),
    open_graph: asRecord(record.open_graph ?? record.og_tags) as Record<
      string,
      string
    >,
    twitter_tags: asRecord(record.twitter_tags) as Record<string, string>,
    structured_data: recordArray(record, "structured_data", "json_ld"),
    schema_org: recordArray(record, "schema_org"),
    analytics: asRecord(record.analytics),
    images: recordArray(record, "images"),
    broken_images: recordArray(record, "broken_images"),
    internal_links: number(record, "internal_links") ?? 0,
    external_links: number(record, "external_links") ?? 0,
    hreflang: recordArray(record, "hreflang"),
    redirects: recordArray(record, "redirects"),
    linked_from: stringArray(record, "linked_from"),
    discovered_from: text(record, "discovered_from"),
    error: text(record, "error"),
    error_type: text(record, "error_type"),
    raw: record,
  }
}

function normalizeLink(value: unknown, index: number): AuditLink {
  const record = asRecord(value)
  const source = text(record, "source_url", "source", "from_url")
  const target = text(record, "target_url", "target", "to_url", "url")
  return {
    id: text(record, "id", "link_id") || `${source}-${target}-${index}`,
    source_url: source,
    target_url: target,
    anchor_text: text(record, "anchor_text", "anchor", "text"),
    status_code: number(record, "status_code", "http_status"),
    kind: text(record, "kind", "type", "link_type"),
    internal: boolean(record, "internal", "is_internal"),
    follow: boolean(record, "follow", "is_follow"),
    error: text(record, "error", "message"),
    placement: text(record, "placement", "kind", "type") || "body",
    target_domain: text(record, "target_domain", "domain"),
    rel: text(record, "rel"),
    in_navigation: boolean(record, "in_navigation") ?? false,
    raw: record,
  }
}

function normalizeExternalResource(
  value: unknown,
  index: number
): AuditExternalResource {
  const record = asRecord(value)
  const url = text(record, "url")
  return {
    id: text(record, "id", "resource_id") || url || `resource-${index}`,
    url,
    final_url: text(record, "final_url") || url,
    status_code: number(record, "status_code", "http_status"),
    content_type: text(record, "content_type", "mime_type"),
    size_bytes: number(record, "size_bytes", "size") ?? 0,
    title: text(record, "title"),
    error: text(record, "error", "message"),
    error_type: text(record, "error_type"),
    checked_at: text(record, "checked_at") || null,
    raw: record,
  }
}

function normalizeStatusCode(value: unknown): AuditStatusCode {
  const record = asRecord(value)
  return {
    status_code: number(record, "status_code") ?? 0,
    status: text(record, "status"),
    count: number(record, "count") ?? 0,
    percentage: number(record, "percentage") ?? 0,
    error_type: text(record, "error_type"),
  }
}

function normalizeVisualization(value: unknown): AuditVisualization {
  const record = asRecord(value)
  const nodes = collectionValues(record.nodes, "nodes").map((item, index) => {
    const node = asRecord(item)
    const url = text(node, "url")
    return {
      id: text(node, "id", "node_id") || url || `node-${index}`,
      label: text(node, "label", "title", "name") || url || "未命名页面",
      url,
      group: text(node, "group", "type", "category") || "page",
      depth: number(node, "depth", "level"),
      issue_count: number(node, "issue_count", "issues_count") ?? 0,
      raw: node,
    }
  })
  const edges = collectionValues(record.edges ?? record.links, "edges").map(
    (item, index) => {
      const edge = asRecord(item)
      const source = text(edge, "source", "source_id", "from")
      const target = text(edge, "target", "target_id", "to")
      return {
        id: text(edge, "id", "edge_id") || `${source}-${target}-${index}`,
        source,
        target,
        label: text(edge, "label", "type"),
        raw: edge,
      }
    }
  )
  return {
    nodes,
    edges,
    total_nodes: number(record, "total_nodes") ?? nodes.length,
    total_edges: number(record, "total_edges") ?? edges.length,
    truncated: boolean(record, "truncated") ?? false,
  }
}

function normalizePageSpeedResult(
  value: unknown,
  index: number
): AuditPageSpeedResult {
  const record = asRecord(value)
  return {
    id: text(record, "id") || `pagespeed-${index}`,
    url: text(record, "url"),
    strategy: text(record, "strategy"),
    performance_score: number(record, "performance_score"),
    accessibility_score: number(record, "accessibility_score"),
    best_practices_score: number(record, "best_practices_score"),
    seo_score: number(record, "seo_score"),
    metrics: asRecord(record.metrics),
    error: text(record, "error"),
    analyzed_at: text(record, "analyzed_at"),
  }
}

function auditRunsPath(projectId: string) {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/audit-runs`
}

export function createAuditRun(
  project: Project,
  settings: AuditSettings
): Promise<AuditRun> {
  return apiRequest<unknown>(auditRunsPath(project.id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_pages: settings.maxPages,
      scope: settings.scope,
      directory:
        settings.scope === "directory" ? settings.directory : undefined,
      rendering: settings.rendering,
      allowed_paths: settings.allowedPaths,
      excluded_paths: settings.excludedPaths,
      ignored_parameters: settings.ignoredParameters,
      issue_exclusion_patterns: settings.issueExclusionPatterns,
      enable_duplication_check: settings.enableDuplicationCheck,
      duplication_threshold: settings.duplicationThreshold,
      enable_pagespeed: settings.enablePageSpeed,
    }),
  }).then(normalizeRun)
}

export function listAuditRuns(
  projectId: string,
  options: {
    includeArchived?: boolean
    page?: number
    pageSize?: number
    search?: string
    status?: AuditRunStatus
  } = {}
): Promise<AuditRunCollection> {
  const query = new URLSearchParams({
    include_archived: String(options.includeArchived ?? false),
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 25),
  })
  if (options.search) query.set("search", options.search)
  if (options.status) query.set("status", options.status)
  return apiRequest<unknown>(`${auditRunsPath(projectId)}?${query}`).then(
    (value) => {
      const record = asRecord(value)
      const items = collectionValues(value, "runs").map(normalizeRun)
      return {
        items,
        total: number(record, "total") ?? items.length,
        page: number(record, "page") ?? options.page ?? 1,
        page_size: number(record, "page_size") ?? options.pageSize ?? 25,
      }
    }
  )
}

export function getAuditRun(
  projectId: string,
  runId: string
): Promise<AuditRun> {
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}`
  ).then(normalizeRun)
}

export function getAuditActivity(
  projectId: string,
  runId: string,
  cursor = 0,
  limit = 25
): Promise<AuditActivityCollection> {
  const query = new URLSearchParams({
    cursor: String(cursor),
    limit: String(limit),
  })
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/activity?${query}`
  ).then((value) => {
    const record = asRecord(value)
    return {
      items: collectionValues(value, "items").map(normalizeActivity),
      next_cursor: number(record, "next_cursor") ?? cursor,
    }
  })
}

export function getAuditIssues(
  projectId: string,
  runId: string,
  options: {
    page?: number
    pageSize?: number
    severity?: AuditSeverity
    search?: string
  } = {}
): Promise<AuditCollection<AuditIssue>> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 50),
  })
  if (options.severity) query.set("severity", options.severity)
  if (options.search) query.set("search", options.search)
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/issues?${query}`
  ).then((value) => normalizeCollection(value, "issues", normalizeIssue))
}

export function getAuditPages(
  projectId: string,
  runId: string,
  options: {
    page?: number
    pageSize?: number
    search?: string
    statusCode?: number
    statusFamily?: AuditStatusFamily
  } = {}
): Promise<AuditCollection<AuditPage>> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 50),
  })
  if (options.search) query.set("search", options.search)
  if (options.statusCode !== undefined) {
    query.set("status_code", String(options.statusCode))
  }
  if (options.statusFamily) {
    query.set("status_family", options.statusFamily)
  }
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/pages?${query}`
  ).then((value) => normalizeCollection(value, "pages", normalizePage))
}

export function getAuditLinks(
  projectId: string,
  runId: string,
  options: {
    page?: number
    pageSize?: number
    search?: string
    internal?: boolean
    statusFamily?: AuditStatusFamily
  } = {}
): Promise<AuditCollection<AuditLink>> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 50),
  })
  if (options.search) query.set("search", options.search)
  if (options.internal !== undefined) {
    query.set("internal", String(options.internal))
  }
  if (options.statusFamily) {
    query.set("status_family", options.statusFamily)
  }
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/links?${query}`
  ).then((value) => normalizeCollection(value, "links", normalizeLink))
}

export function getAuditExternalResources(
  projectId: string,
  runId: string,
  options: {
    page?: number
    pageSize?: number
    search?: string
    statusFamily?: AuditStatusFamily
  } = {}
): Promise<AuditCollection<AuditExternalResource>> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 50),
  })
  if (options.search) query.set("search", options.search)
  if (options.statusFamily) {
    query.set("status_family", options.statusFamily)
  }
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/resources?${query}`
  ).then((value) =>
    normalizeCollection(value, "resources", normalizeExternalResource)
  )
}

export function getAuditStatusCodes(
  projectId: string,
  runId: string
): Promise<AuditStatusCode[]> {
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/status-codes`
  ).then((value) =>
    collectionValues(value, "status_codes").map(normalizeStatusCode)
  )
}

export function getAuditVisualization(
  projectId: string,
  runId: string
): Promise<AuditVisualization> {
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/visualization`
  ).then(normalizeVisualization)
}

export function deleteAuditRun(
  projectId: string,
  runId: string
): Promise<void> {
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}`,
    { method: "DELETE" }
  ).then(() => undefined)
}

function postAuditAction(
  projectId: string,
  runId: string,
  action: "pause" | "resume" | "stop" | "archive"
): Promise<AuditRun> {
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/${action}`,
    { method: "POST" }
  ).then(normalizeRun)
}

export function pauseAuditRun(
  projectId: string,
  runId: string
): Promise<AuditRun> {
  return postAuditAction(projectId, runId, "pause")
}

export function resumeAuditRun(
  projectId: string,
  runId: string
): Promise<AuditRun> {
  return postAuditAction(projectId, runId, "resume")
}

export function stopAuditRun(
  projectId: string,
  runId: string
): Promise<AuditRun> {
  return postAuditAction(projectId, runId, "stop")
}

export function archiveAuditRun(
  projectId: string,
  runId: string
): Promise<AuditRun> {
  return postAuditAction(projectId, runId, "archive")
}

export function recalculateAuditIssues(
  projectId: string,
  runId: string,
  issueExclusionPatterns: string[]
): Promise<AuditRun> {
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/recalculate-issues`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issue_exclusion_patterns: issueExclusionPatterns,
      }),
    }
  ).then(normalizeRun)
}

export function getAuditPageSpeed(
  projectId: string,
  runId: string
): Promise<AuditPageSpeedResult[]> {
  return apiRequest<unknown>(
    `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/pagespeed`
  ).then((value) =>
    collectionValues(value, "pagespeed").map(normalizePageSpeedResult)
  )
}

export async function downloadAuditExport(
  projectId: string,
  runId: string,
  dataset: AuditExportDataset,
  format: AuditExportFormat
) {
  const query = new URLSearchParams({ dataset, format })
  const path = `${auditRunsPath(projectId)}/${encodeURIComponent(runId)}/export?${query}`
  const response = await fetch(`${apiBaseUrl}${path}`)
  if (!response.ok) {
    let message = `API request failed: ${response.status}`
    try {
      const body = (await response.json()) as { detail?: string }
      if (body.detail) message = body.detail
    } catch {
      // Keep the status-based fallback for non-JSON errors.
    }
    throw new ApiError(response.status, message)
  }

  const disposition = response.headers.get("Content-Disposition") ?? ""
  const filename =
    /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1] ??
    `audit-${runId}-${dataset}.${format}`
  return {
    blob: await response.blob(),
    filename: decodeURIComponent(filename.replace(/^"|"$/g, "")),
  }
}
