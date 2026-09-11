import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import test from "node:test"

const read = (name) => readFile(new URL(name, import.meta.url), "utf8")

test("Production recommendations use only the canonical V2 workspace", async () => {
  const workspace = await read("../outreach-workspace.tsx")
  assert.match(workspace, /RecommendationFeedWorkspace/)
  assert.doesNotMatch(workspace, /recommendations-workspace/)
  for (const name of ["recommendations-workspace.tsx", "use-recommendation-refill.ts"]) {
    await assert.rejects(access(new URL(name, import.meta.url)), { code: "ENOENT" })
  }
})

test("Shared contact APIs do not expose retired recommendation writes", async () => {
  const api = await read("api.ts")
  assert.doesNotMatch(api, /backlinksRequestRecommendationRefillV1|backlinksArchiveRecommendationPoolV1/)
  assert.match(api, /backlinksStartContactEnrichmentV1/)
  assert.match(api, /backlinksRetryContactEnrichmentV1/)
})
