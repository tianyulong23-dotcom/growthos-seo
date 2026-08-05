import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("BL-AI-161..177 reports consume frozen Metric Snapshot and Report Revision DTOs", async () => {
  const api = await read("api.ts")
  const types = await read("types.ts")
  const workspace = await read("reports-workspace.tsx")

  assert.match(api, /from "@\/api\/client"/)
  assert.match(api, /\/backlinks\/metrics\/dashboard/)
  assert.match(api, /\/backlinks\/reports/)
  assert.match(api, /\/backlinks\/report-exports/)
  assert.match(types, /metricDefinitionVersion/)
  assert.match(types, /snapshotId/)
  assert.match(types, /numerator/)
  assert.match(types, /denominator/)
  assert.match(types, /inputSnapshotIds/)
  assert.match(workspace, /Candidate 不计入成功 Placement KPI/)
  assert.doesNotMatch(
    `${api}\n${types}\n${workspace}`,
    /accessToken|refreshToken|authorizationCode|providerPayload|emailBody/
  )
})

test("reports expose explicit window, timezone, stale, empty, forbidden, and export lifecycle states", async () => {
  const workspace = await read("reports-workspace.tsx")

  for (const state of [
    "loading",
    "empty",
    "error",
    "forbidden",
    "stale",
    "queued",
    "running",
    "failed",
    "completed",
    "expired",
  ]) {
    assert.match(workspace, new RegExp(state))
  }
  assert.match(workspace, /reportingWindow/)
  assert.match(workspace, /workspaceTimezone/)
  assert.doesNotMatch(workspace, /resolvedOptions\(\)\.timeZone/)
  assert.match(workspace, /status !== "expired"/)
  assert.match(workspace, /authorizeExportDownload/)
  assert.match(workspace, /PDF_EXPORT_DISABLED/)
})

test("reports never calculate formal metrics from frontend state or fabricate files", async () => {
  const workspace = await read("reports-workspace.tsx")
  const api = await read("api.ts")

  assert.doesNotMatch(workspace, /successCount|filter\(.*countsTowardKpi/)
  assert.doesNotMatch(workspace, /new Blob|URL\.createObjectURL/)
  assert.doesNotMatch(api, /mock|fallback/i)
  assert.match(workspace, /metric\.value/)
  assert.match(workspace, /metric\.numerator/)
  assert.match(workspace, /metric\.denominator/)
})
