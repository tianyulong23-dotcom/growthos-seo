import type {
  AuditExternalResource,
  AuditIssue,
  AuditLink,
  AuditPage,
  AuditPageSpeedResult,
  AuditRun,
  AuditStatusCode,
  AuditVisualization,
} from "@/api/audits"

export type AuditResultSnapshot =
  | {
      kind: "pages"
      items: AuditPage[]
      total: number
    }
  | {
      kind: "external-resources"
      items: AuditExternalResource[]
      total: number
    }
  | {
      kind: "status-codes"
      items: AuditStatusCode[]
    }
  | {
      kind: "issues"
      items: AuditIssue[]
      total: number
    }
  | {
      kind: "links"
      internalItems: AuditLink[]
      internalTotal: number
      externalItems: AuditLink[]
      externalTotal: number
    }
  | {
      kind: "pagespeed"
      items: AuditPageSpeedResult[]
    }
  | {
      kind: "visualization"
      graph: AuditVisualization
    }

type CachedAuditResult = {
  projectId: string
  runId: string
  snapshot: AuditResultSnapshot
}

const MAX_CACHED_RUNS = 50
const MAX_CACHED_RESULTS = 300
const completedRunCache = new Map<string, AuditRun>()
const auditResultCache = new Map<string, CachedAuditResult>()

function runCacheKey(projectId: string, runId: string) {
  return JSON.stringify([projectId, runId])
}

function setBounded<Value>(
  cache: Map<string, Value>,
  key: string,
  value: Value,
  maximumSize: number
) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size <= maximumSize) return
  const oldestKey = cache.keys().next().value
  if (oldestKey !== undefined) cache.delete(oldestKey)
}

export function createAuditResultCacheKey(
  projectId: string,
  runId: string,
  view: string,
  query: unknown
) {
  return JSON.stringify([projectId, runId, view, query])
}

export function getCachedCompletedAuditRun(projectId: string, runId: string) {
  return completedRunCache.get(runCacheKey(projectId, runId)) ?? null
}

export function rememberAuditRun(run: AuditRun) {
  const key = runCacheKey(run.project_id, run.run_id)
  if (run.status !== "completed") {
    completedRunCache.delete(key)
    invalidateAuditResults(run.project_id, run.run_id)
    return
  }
  setBounded(completedRunCache, key, run, MAX_CACHED_RUNS)
}

export function getCachedAuditResult(key: string) {
  return auditResultCache.get(key)?.snapshot ?? null
}

export function rememberAuditResult(
  key: string,
  projectId: string,
  runId: string,
  snapshot: AuditResultSnapshot
) {
  setBounded(
    auditResultCache,
    key,
    { projectId, runId, snapshot },
    MAX_CACHED_RESULTS
  )
}

export function invalidateAuditResults(projectId: string, runId: string) {
  for (const [key, entry] of auditResultCache) {
    if (entry.projectId === projectId && entry.runId === runId) {
      auditResultCache.delete(key)
    }
  }
}

export function invalidateAuditRun(projectId: string, runId: string) {
  completedRunCache.delete(runCacheKey(projectId, runId))
  invalidateAuditResults(projectId, runId)
}

export function clearAuditSessionCache() {
  completedRunCache.clear()
  auditResultCache.clear()
}
