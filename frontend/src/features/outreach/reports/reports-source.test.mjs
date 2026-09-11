import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (file) => readFile(path.join(dirname, file), "utf8")

test("BL-AI-188 reports use generated frozen DTOs and operations", async () => {
  const api = await read("api.ts")
  const types = await read("types.ts")
  const workspace = await read("reports-workspace.tsx")

  assert.match(api, /requestBacklinks/)
  for (const operationId of [
    "backlinksGetMetricDashboardV1",
    "backlinksListPublishedReportsV1",
    "backlinksRequestReportExportV1",
    "backlinksGetReportExportV1",
    "backlinksAuthorizeReportExportDownloadV1",
  ]) {
    assert.match(api, new RegExp(operationId))
  }
  assert.doesNotMatch(api, /from "@\/api\/client"|\/api\/v1/)
  assert.match(types, /BacklinksResponse/)
  assert.match(types, /BacklinksRequest/)
  assert.match(workspace, /backlinksProjectQueries\.fetch/)
  assert.match(workspace, /createProjectQueryKey/)
  assert.match(workspace, /AbortError/)
  assert.match(workspace, /Candidate 不计入成功 Placement KPI/)
  assert.match(workspace, /dashboardResponse\.dashboard\.trends/)
  assert.match(workspace, /metric\.snapshotVersion/)
  assert.match(workspace, /report\.inputSnapshotIds\.map/)
  assert.doesNotMatch(
    `${api}\n${types}\n${workspace}`,
    /accessToken|refreshToken|authorizationCode|providerPayload|emailBody/
  )
})

test("reports expose required read and export lifecycle states", async () => {
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
  assert.match(
    workspace,
    /item\.status === "completed" && item\.object !== null/
  )
  assert.match(workspace, /authorizeExportDownload/)
  assert.match(workspace, /PDF_EXPORT_DISABLED/)
  assert.match(workspace, /error\.status === 409/)
  assert.match(workspace, /导出状态已变化/)
})

test("reports never calculate formal metrics or fabricate export files", async () => {
  const workspace = await read("reports-workspace.tsx")
  const api = await read("api.ts")

  assert.doesNotMatch(workspace, /successCount|filter\(.*countsTowardKpi/)
  assert.doesNotMatch(workspace, /new Blob|URL\.createObjectURL/)
  assert.doesNotMatch(api, /mock|fallback/i)
  assert.match(workspace, /metric\.value/)
  assert.match(workspace, /metric\.numerator/)
  assert.match(workspace, /metric\.denominator/)
})

test("reports expose frozen metric keys without frontend recomputation", async () => {
  const workspace = await read("reports-workspace.tsx")

  for (const metricKey of [
    "draft_approval_count",
    "send_count",
    "reply_rate",
    "negotiation_conversion_rate",
    "link_acquisition_rate",
    "gained_placement_count",
    "active_placement_count",
    "suspected_lost_placement_count",
    "lost_placement_count",
    "recovered_placement_count",
  ]) {
    assert.match(workspace, new RegExp(metricKey))
  }
  assert.doesNotMatch(
    workspace,
    /draft_created_count|send_accepted_count|reply_received_count|placement_success_rate|placement_monitoring_health_rate/
  )
  assert.match(workspace, /trend\.points\.map/)
  assert.match(workspace, /point\.value/)
  assert.match(workspace, /point\.numerator/)
  assert.match(workspace, /point\.denominator/)
})

test("Backlinks stays within its registered module routes", async () => {
  const outreachManifest = await read("../manifest.ts")
  const performanceManifest = await read("../../performance/manifest.ts")
  const registration = await read("../registration.ts")
  const outreachWorkspace = await read("../outreach-workspace.tsx")
  const performanceWorkspace = await read(
    "../../performance/performance-workspace.tsx"
  )
  const reportsRoute = await read(
    "../../performance/backlinks/backlink-reports-route-workspace.tsx"
  )
  const modulePage = await read("../../../pages/module-page.tsx")
  const moduleWorkspace = await read("../module.tsx")

  assert.doesNotMatch(outreachManifest, /\{ id: "links", label: "外链监控"/)
  assert.doesNotMatch(outreachManifest, /\{ id: "reports", label: "指标报告"/)
  assert.match(performanceManifest, /\{ id: "backlinks", label: "外链监控"/)
  assert.match(performanceManifest, /\{ id: "reports", label: "指标报告"/)
  assert.match(registration, /id: "backlinks"/)
  assert.match(registration, /navigation: \[backlinksNavigation\]/)
  assert.match(outreachWorkspace, /BacklinkReportsRouteWorkspace/)
  assert.match(outreachWorkspace, /BusinessContextBar/)
  assert.match(outreachWorkspace, /returnTo/)
  assert.match(performanceWorkspace, /view === "reports"/)
  assert.match(performanceWorkspace, /BacklinkReportsRouteWorkspace/)
  assert.match(reportsRoute, /<ReportsWorkspace/)
  assert.match(reportsRoute, /backlinksProjectQueries\.fetch/)
  assert.match(reportsRoute, /reportingTimezone/)
  assert.match(reportsRoute, /reportLookbackDays/)
  assert.match(modulePage, /key=\{`\$\{project\.id\}:\$\{view\}`\}/)
  assert.match(moduleWorkspace, /key=\{`\$\{project\.id\}:\$\{activeView\}`\}/)
})

test("legacy Reports manual preview is absent", async () => {
  await assert.rejects(() => read("manual-preview.tsx"), /ENOENT/)
  await assert.rejects(() => read("manual-preview.html"), /ENOENT/)
})
