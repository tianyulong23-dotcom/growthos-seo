import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))

const read = (file) => readFile(path.join(dirname, file), "utf8")

test("Links DTO keeps Candidate outside successful KPI", async () => {
  const types = await read("types.ts")
  const workspace = await read("links-workspace.tsx")

  assert.match(types, /countsTowardKpi: false/)
  assert.match(types, /countsTowardKpi: true/)
  assert.match(workspace, /Candidate 只表示候选，不是成功状态/)
  assert.match(workspace, /不计入成功 KPI/)
  assert.match(
    workspace,
    /item\.recordType === "placement" && item\.countsTowardKpi/
  )
})

test("Links matches all re-frozen public endpoints and reverify contract", async () => {
  const api = await read("api.ts")

  assert.match(api, /\/backlinks\/links/)
  assert.match(api, /\/candidates\/\$\{encodeURIComponent\(candidateId\)\}/)
  assert.match(api, /\/placements\/\$\{encodeURIComponent\(placementId\)\}/)
  assert.match(
    api,
    /\/placements\/\$\{encodeURIComponent\(placementId\)\}\/events/
  )
  assert.match(api, /\/evidence\/\$\{encodeURIComponent\(evidenceId\)\}/)
  assert.match(
    api,
    /\/placements\/\$\{encodeURIComponent\(placementId\)\}\/reverify/
  )
  assert.match(api, /method: "POST"/)
  assert.match(api, /"Idempotency-Key": input\.idempotencyKey/)
  assert.match(
    api,
    /JSON\.stringify\(\{ expectedVersion: input\.expectedVersion \}\)/
  )
  assert.match(api, /apiRequest<\{ evidence: PlacementEvidence \}>/)
  assert.match(api, /apiRequest<PlacementReverifyResult>/)
})

test("Links renders Recovered, observations, evidence, events, stale and server job state", async () => {
  const types = await read("types.ts")
  const workspace = await read("links-workspace.tsx")

  assert.match(types, /"recovered"/)
  assert.match(types, /latestObservation/)
  assert.match(types, /LifecycleEventType/)
  assert.match(types, /immutable: true/)
  assert.match(types, /hashVerified: true/)

  for (const state of [
    "candidate",
    "confirmed",
    "changed",
    "lost",
    "recovered",
  ]) {
    assert.match(workspace, new RegExp(`value: "${state}"`))
  }
  assert.match(workspace, /最新 Observation/)
  assert.match(workspace, /读取不可变证据/)
  assert.match(workspace, /状态变化和恢复事件/)
  assert.match(workspace, /placement\.recovered/)
  assert.match(workspace, /stale/)
  assert.match(workspace, /job-running/)
  assert.match(workspace, /(Browser|浏览器) 结果/)
})

test("Links has seek pagination and explicit error states for reads and commands", async () => {
  const workspace = await read("links-workspace.tsx")

  assert.match(workspace, /websiteProjectKey/)
  assert.match(workspace, /currentCursor/)
  assert.match(workspace, /nextCursor/)
  assert.match(workspace, /eventPageSize/)
  assert.match(workspace, /"loading"/)
  assert.match(workspace, /"empty"/)
  assert.match(workspace, /"error"/)
  assert.match(workspace, /forbidden/)
  assert.match(workspace, /conflict/)
  assert.match(workspace, /not-found/)
  assert.match(workspace, /browserFallbackAllowed/)
  assert.match(workspace, /onClick=\{previousPage\}/)
  assert.match(workspace, /onClick=\{nextPage\}/)
  assert.match(workspace, /crypto\.randomUUID\(\)/)
  assert.match(workspace, /expectedVersion: placement\.version/)
})

test("protected Outreach workspace mounts Links with the routed project and shared client", async () => {
  const outreachWorkspace = await read("../outreach-workspace.tsx")

  assert.match(
    outreachWorkspace,
    /import \{ linksApi \} from "@\/features\/outreach\/links\/api"/
  )
  assert.match(
    outreachWorkspace,
    /import \{ LinksWorkspace \} from "@\/features\/outreach\/links\/links-workspace"/
  )
  assert.match(
    outreachWorkspace,
    /<LinksWorkspace client=\{linksApi\} websiteProjectKey=\{projectId\} \/>/
  )
  assert.doesNotMatch(outreachWorkspace, /PlacementMonitoringWorkspace/)
  assert.doesNotMatch(outreachWorkspace, /const placements/)
})
