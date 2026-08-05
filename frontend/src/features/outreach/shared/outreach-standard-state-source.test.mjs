import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("shared Outreach state view covers every Phase 10 state", async () => {
  const source = await read("outreach-standard-state.tsx")
  const network = await read("outreach-network-state.ts")

  for (const state of [
    "loading",
    "empty",
    "error",
    "forbidden",
    "conflict",
    "stale",
    "offline",
    "job-running",
  ]) {
    assert.match(source, new RegExp(`"${state}"`))
  }
  assert.match(source, /aria-live=/)
  assert.match(source, /aria-busy=/)
  assert.match(source, /role=\{isAlert \? "alert" : "status"\}/)
  assert.match(network, /navigator\.onLine === false/)
  assert.match(source, /onRetry/)
})

test("all routed Outreach surfaces use the shared state layer", async () => {
  const sources = await Promise.all(
    [
      "../../../pages/overview-page.tsx",
      "../outreach-workspace.tsx",
      "../opportunities/opportunities-workspace.tsx",
      "../drafts/draft-generation.tsx",
      "../mail/mail-center.tsx",
      "../links/links-workspace.tsx",
      "../reports/reports-workspace.tsx",
      "../settings/settings-workspace.tsx",
    ].map(read)
  )

  for (const source of sources) {
    assert.match(source, /OutreachStandardStateView/)
  }
  assert.match(sources.join("\n"), /state="job-running"/)
  assert.match(sources.join("\n"), /isOutreachOffline/)
})
