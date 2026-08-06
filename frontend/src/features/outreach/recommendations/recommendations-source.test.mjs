import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("Recommendations use generated contracts and project-scoped batch control", async () => {
  const api = await read("api.ts")
  const hook = await read("use-recommendations.ts")
  const waitHook = await read("use-recommendation-refill.ts")
  const workspace = await read("recommendations-workspace.tsx")

  assert.match(api, /requestBacklinks/)
  assert.match(api, /backlinksListRecommendationsV1/)
  assert.match(api, /backlinksCreateOpportunityV1/)
  assert.match(api, /backlinksGetRecommendationInventoryV1/)
  assert.match(api, /backlinksRetryUnpublishedContactsV1/)
  assert.match(api, /RecommendationAssessment/)
  assert.match(api, /status: "ready"/)
  assert.match(api, /\{ signal \}/)
  assert.doesNotMatch(
    api,
    /backlinksStartContactEnrichmentV1|backlinksGetContactEnrichmentJobV1|backlinksRetryContactEnrichmentV1|backlinksAddPublicContactCandidateV1|backlinksRequestRecommendationRefillV1/
  )
  assert.match(hook, /createProjectQueryKey/)
  assert.match(hook, /websiteProjectKey, "recommendations", "ready"/)
  assert.match(hook, /backlinksProjectQueries\.invalidate\(key\)/)
  assert.match(hook, /load\(false\)/)
  assert.match(waitHook, /window\.sessionStorage/)
  assert.match(waitHook, /profileVersionId/)
  assert.match(waitHook, /batchId/)
  assert.match(waitHook, /contactBatch/)
  assert.match(waitHook, /pollInFlightRef/)
  assert.match(waitHook, /const maxWaitMs = 60_000/)
  assert.match(waitHook, /后台继续处理中/)
  assert.match(waitHook, /activeScopeRef\.current = scopeKey/)
  assert.match(waitHook, /activeScopeRef\.current === scopeKey/)
  assert.match(waitHook, /\}, \[scopeKey\]\)/)
  assert.doesNotMatch(waitHook, /requestRecommendationRefill/)
  assert.match(
    workspace,
    /result\.websiteProjectId !== result\.meta\.websiteProjectId/
  )
  assert.match(workspace, /useCurrentProject/)
  assert.match(workspace, /getRecommendationInventory/)
  assert.match(workspace, /useRecommendationRefill\(project, pollInventory\)/)
  assert.match(workspace, /retryUnpublishedContacts/)
  assert.match(workspace, /project\.inputRequired/)
  assert.match(workspace, /settings\/profile/)
  assert.match(workspace, /websiteProjectKey,\s*"opportunities"/)
  assert.match(workspace, /opportunityId=\$\{result\.opportunityId\}/)
  assert.match(workspace, /等待本批可联系推荐/)
  assert.match(workspace, /仅重试未发布/)
  assert.doesNotMatch(
    `${api}\n${hook}\n${waitHook}\n${workspace}`,
    /mock|fallback/i
  )
})

test("Recommendations expose only published contacts without per-item discovery controls", async () => {
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
  assert.match(workspace, /冻结默认联系人/)
  assert.match(workspace, /加入 Opportunity/)
  assert.doesNotMatch(
    workspace,
    /发现联系人|重新抓取|人工补充|暂无联系人|补充推荐|生成推荐/
  )
  assert.doesNotMatch(`${workspace}\n${route}`, /当前显示演示数据/)
  assert.doesNotMatch(`${workspace}\n${route}`, /joinOpportunity/)
})
