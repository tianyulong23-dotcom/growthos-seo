import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("Recommendations use generated contracts and project-scoped query control", async () => {
  const api = await read("api.ts")
  const hook = await read("use-recommendations.ts")
  const refillHook = await read("use-recommendation-refill.ts")
  const workspace = await read("recommendations-workspace.tsx")

  assert.match(api, /requestBacklinks/)
  assert.match(api, /backlinksListRecommendationsV1/)
  assert.match(api, /backlinksCreateOpportunityV1/)
  assert.match(api, /backlinksStartContactEnrichmentV1/)
  assert.match(api, /backlinksGetContactEnrichmentJobV1/)
  assert.match(api, /backlinksRetryContactEnrichmentV1/)
  assert.match(api, /backlinksRequestRecommendationRefillV1/)
  assert.match(api, /lowWatermark: 20/)
  assert.match(api, /highWatermark: 21/)
  assert.match(api, /"idempotency-key": crypto\.randomUUID\(\)/)
  assert.match(api, /RecommendationAssessment/)
  assert.match(api, /status: "ready"/)
  assert.match(api, /\{ signal \}/)
  assert.match(hook, /createProjectQueryKey/)
  assert.match(hook, /websiteProjectKey, "recommendations", "ready"/)
  assert.match(hook, /backlinksProjectQueries\.invalidate\(key\)/)
  assert.match(hook, /load\(false\)/)
  assert.match(refillHook, /window\.sessionStorage/)
  assert.match(refillHook, /profileVersionId/)
  assert.match(refillHook, /idempotencyKey: crypto\.randomUUID\(\)/)
  assert.match(refillHook, /pollInFlightRef/)
  assert.match(refillHook, /activeScopeRef\.current = scopeKey/)
  assert.match(refillHook, /activeScopeRef\.current === scopeKey/)
  assert.match(refillHook, /\}, \[scopeKey\]\)/)
  assert.match(refillHook, /requestRecommendationRefill/)
  assert.equal(
    (refillHook.match(/requestRecommendationRefill\(/g) ?? []).length,
    1
  )
  assert.ok(
    refillHook.indexOf("requestRecommendationRefill(") >
      refillHook.indexOf("const start = React.useCallback")
  )
  assert.match(
    workspace,
    /result\.websiteProjectId !== result\.meta\.websiteProjectId/
  )
  assert.match(workspace, /useCurrentProject/)
  assert.match(workspace, /useRecommendationRefill\(project, query\.poll\)/)
  assert.match(workspace, /project\.inputRequired/)
  assert.match(workspace, /settings\/profile/)
  assert.match(workspace, /websiteProjectKey,\s*"opportunities"/)
  assert.match(workspace, /opportunityId=\$\{result\.opportunityId\}/)
  assert.doesNotMatch(
    `${api}\n${hook}\n${refillHook}\n${workspace}`,
    /mock|fallback/i
  )
})

test("Recommendations expose all required server states without a demo fallback", async () => {
  const hook = await read("use-recommendations.ts")
  const workspace = await read("recommendations-workspace.tsx")
  const route = await read("../outreach-workspace.tsx")

  for (const state of [
    "loading",
    "empty",
    "error",
    "forbidden",
    "conflict",
    "data",
  ]) {
    assert.match(`${hook}\n${workspace}`, new RegExp(`"${state}"`))
  }
  assert.match(hook, /error\.status === 403/)
  assert.match(hook, /error\.status === 409/)
  assert.match(workspace, /useRecommendations\(websiteProjectKey/)
  assert.match(
    route,
    /RecommendationsWorkspace websiteProjectKey=\{projectId\}/
  )
  assert.doesNotMatch(
    `${workspace}\n${route}`,
    /features\/outreach\/api\/client/
  )
  assert.doesNotMatch(`${workspace}\n${route}`, /initialRecommendations/)
  assert.match(workspace, /createOpportunity/)
  assert.match(workspace, /retryContactEnrichment/)
  assert.match(workspace, /addPublicContactCandidate/)
  assert.match(workspace, /重新抓取/)
  assert.match(workspace, /加入 Opportunity/)
  assert.doesNotMatch(`${workspace}\n${route}`, /当前显示演示数据/)
  assert.doesNotMatch(`${workspace}\n${route}`, /joinOpportunity/)
})
