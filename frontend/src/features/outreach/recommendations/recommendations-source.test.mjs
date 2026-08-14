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
  const polling = await read("recommendation-refill-polling.ts")
  const operationSession = await read("recommendation-operation-session.ts")
  const workspace = await read("recommendations-workspace.tsx")

  assert.match(api, /requestBacklinks/)
  assert.match(api, /backlinksListRecommendationsV1/)
  assert.match(api, /backlinksCreateOpportunityV1/)
  assert.match(api, /backlinksGetRecommendationInventoryV1/)
  assert.match(api, /backlinksRetryUnpublishedContactsV1/)
  assert.match(api, /backlinksRequestRecommendationRefillV1/)
  assert.match(api, /backlinksArchiveRecommendationPoolV1/)
  assert.match(
    api,
    /recommendation-pool-archive:\$\{recommendationContextVersionId\}:g\$\{visiblePoolGeneration\}/
  )
  assert.match(api, /recommendationContextVersionId/)
  assert.match(api, /visiblePoolGeneration/)
  assert.match(
    api,
    /readRecommendationOperation\(window\.localStorage, scope\)/
  )
  assert.match(
    api,
    /storeRecommendationOperation\(window\.localStorage, scope, result\.operationId\)/
  )
  const refillApi = api.slice(
    api.indexOf("export function requestRecommendationRefill"),
    api.indexOf("export function archiveRecommendationPool")
  )
  assert.doesNotMatch(
    refillApi,
    /crypto\.randomUUID|idempotency-key|refillWindowKey/
  )
  const archiveApi = api.slice(
    api.indexOf("export function archiveRecommendationPool")
  )
  assert.doesNotMatch(archiveApi, /crypto\.randomUUID/)
  assert.doesNotMatch(api, /RecommendationAssessment|legacy_snapshot/)
  assert.doesNotMatch(api, /status: "ready"/)
  assert.match(api, /\{ signal \}/)
  assert.doesNotMatch(
    api,
    /backlinksStartContactEnrichmentV1|backlinksGetContactEnrichmentJobV1|backlinksRetryContactEnrichmentV1|backlinksAddPublicContactCandidateV1/
  )
  assert.match(hook, /createProjectQueryKey/)
  assert.match(hook, /websiteProjectKey,\s*"recommendations",\s*"active-pool"/)
  assert.match(hook, /backlinksProjectQueries\.invalidate\(key\)/)
  assert.match(hook, /load\(false\)/)
  assert.doesNotMatch(waitHook, /window\.sessionStorage/)
  assert.match(waitHook, /profileVersionId/)
  assert.match(waitHook, /batchId/)
  assert.match(waitHook, /contactBatch/)
  assert.match(waitHook, /pollRecommendationRefill/)
  assert.match(waitHook, /publishedCount > previousPublishedCount/)
  assert.match(waitHook, /onInventoryChanged\(nextInventory\)/)
  assert.match(waitHook, /serverUpdatedAt/)
  assert.match(waitHook, /refillJob/)
  assert.match(waitHook, /connectJob/)
  assert.match(waitHook, /contactBatchActivity === "recovery_required"/)
  assert.match(waitHook, /COMPLETE_PROJECT_CONTEXT/)
  assert.match(waitHook, /RESTART_SERVICE/)
  assert.match(waitHook, /WAIT_PROVIDER/)
  assert.match(waitHook, /RESUME_OPERATION/)
  assert.doesNotMatch(waitHook, /maxWaitMs|后台继续处理中|timed_out/)
  assert.doesNotMatch(waitHook, /requestRecommendationRefill/)
  assert.match(polling, /while \(!options\.signal\.aborted\)/)
  assert.match(polling, /if \(inventory\.terminal\) return false/)
  assert.match(polling, /operationRecoveryGraceMs/)
  assert.match(
    polling,
    /activeJobStatuses\.has\(inventory\.refillJob\.status\)/
  )
  assert.match(polling, /batchActivity === "waiting_retry"/)
  assert.doesNotMatch(
    polling,
    /if \(inventory\.operationId !== null\) return true/
  )
  assert.match(polling, /15_000/)
  assert.doesNotMatch(polling, /setInterval/)
  assert.match(operationSession, /recommendationOperationStorageKey/)
  assert.match(operationSession, /tryAcquireRecommendationStartLease/)
  assert.match(operationSession, /subscribeRecommendationOperation/)
  assert.match(operationSession, /window\.addEventListener\("storage"/)
  assert.match(
    workspace,
    /result\.websiteProjectId !== result\.meta\.websiteProjectId/
  )
  assert.match(workspace, /useCurrentProject/)
  assert.match(workspace, /getRecommendationInventory/)
  assert.match(workspace, /useRecommendationRefill\(/)
  assert.match(workspace, /requestRecommendationRefill/)
  assert.match(workspace, /archiveRecommendationPool/)
  assert.match(workspace, /wait\.connectJob\(result\)/)
  assert.match(workspace, /tryAcquireRecommendationStartLease/)
  assert.match(workspace, /releaseRecommendationStartLease/)
  assert.match(workspace, /subscribeRecommendationOperation/)
  assert.doesNotMatch(workspace, /showElapsed|formatElapsed|Date\.now\(\) -/)
  assert.match(
    workspace,
    /const contactRecoveryRequired =\s*wait\.contactBatchActivity === "recovery_required"/
  )
  assert.match(
    workspace,
    /const running = wait\.status === "running" && inventory\?\.stage !== "pause"/
  )
  assert.match(workspace, /继续原任务/)
  assert.match(workspace, /retryUnpublishedContacts/)
  assert.match(workspace, /project\.inputRequired/)
  assert.match(workspace, /settings\/profile/)
  assert.match(workspace, /websiteProjectKey,\s*"opportunities"/)
  assert.match(workspace, /visiblePoolState === "awaiting_refresh"/)
  assert.match(workspace, /visiblePoolGeneration !== 1/)
  assert.match(workspace, /automaticFirstPoolKey/)
  assert.match(workspace, /archiveCurrentPool\(false\)/)
  assert.match(workspace, /archiveCurrentPool\(true\)/)
  assert.match(workspace, /setJoinedOpportunityIds/)
  assert.match(workspace, /joinedOpportunityIds\[item\.id\]/)
  assert.match(workspace, /aria-live="polite"/)
  assert.match(workspace, /已加入/)
  assert.doesNotMatch(workspace, /opportunityId=\$\{result\.opportunityId\}/)
  assert.match(workspace, /生成推荐/)
  assert.match(workspace, /生成下一轮/)
  assert.match(workspace, /归档并生成下一轮/)
  assert.match(workspace, /连接当前批次/)
  assert.match(workspace, /服务端更新/)
  assert.match(workspace, /仅重试未发布/)
  assert.match(workspace, /fitDecision/)
  assert.match(workspace, /同语种扩展市场/)
  assert.match(workspace, /真实可发布网站/)
  assert.match(workspace, /系统不会伪造补足/)
  assert.match(workspace, /rawCandidateCount/)
  assert.match(workspace, /attemptedRefillTiers/)
  assert.match(
    workspace,
    /attemptedRefillTiers\.map\(\(attempt, attemptIndex\)/
  )
  assert.match(
    workspace,
    /key=\{`\$\{attempt\.round\}:\$\{attempt\.tier\}:\$\{attemptIndex\}`\}/
  )
  assert.match(workspace, /eliminationReasonCounts/)
  assert.match(workspace, /DataForSeo|dataForSeo/)
  assert.match(workspace, /candidateSource/)
  assert.match(workspace, /resourceType/)
  assert.match(workspace, /metricsSource/)
  assert.match(workspace, /emailSource/)
  assert.doesNotMatch(workspace, /<img[\s\S]{0,200}src=\{item\.faviconUrl\}/)
  assert.match(workspace, /资源库快照指标/)
  assert.match(workspace, /相关内容页/)
  assert.doesNotMatch(workspace, /return value === null \? "待补"/)
  assert.doesNotMatch(
    `${api}\n${hook}\n${waitHook}\n${polling}\n${workspace}`,
    /mock|fallback/i
  )

  const refreshBody = workspace.slice(
    workspace.indexOf("const refreshAll"),
    workspace.indexOf("const startOrReconnectRefill")
  )
  assert.match(refreshBody, /refreshWait\(\)/)
  assert.match(refreshBody, /refreshRecommendations\(\)/)
  assert.doesNotMatch(
    refreshBody,
    /requestRecommendationRefill|retryUnpublishedContacts|requestBacklinks/
  )
  const archiveBody = workspace.slice(
    workspace.indexOf("async function archiveCurrentPool"),
    workspace.indexOf("const [search")
  )
  const archiveOnlyBody = archiveBody.slice(
    archiveBody.indexOf("if (!generateNext)"),
    archiveBody.indexOf("const nextScope")
  )
  assert.match(archiveOnlyBody, /archivedGeneration/)
  assert.doesNotMatch(archiveOnlyBody, /requestRecommendationRefill|connectJob/)
  assert.match(archiveBody, /visiblePoolGeneration: archived\.nextGeneration/)
  assert.match(archiveBody, /requestRecommendationRefill/)

  const addOpportunityBody = workspace.slice(
    workspace.indexOf("async function addOpportunity"),
    workspace.indexOf('if (query.status === "loading")')
  )
  assert.match(addOpportunityBody, /createOpportunity/)
  assert.match(addOpportunityBody, /你仍在推荐池中/)
  assert.doesNotMatch(
    addOpportunityBody,
    /requestRecommendationRefill|archiveRecommendationPool/
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
  assert.doesNotMatch(workspace, /发现联系人|重新抓取|人工补充|暂无联系人/)
  assert.doesNotMatch(`${workspace}\n${route}`, /当前显示演示数据/)
  assert.doesNotMatch(`${workspace}\n${route}`, /joinOpportunity/)
})
