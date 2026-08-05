import { createRoot } from "react-dom/client"

import "@/index.css"

import { ReportsWorkspace } from "./reports-workspace"
import type {
  ReportExport,
  ReportRevision,
  ReportsClient,
} from "./types"

const hash = "a".repeat(64)
const report: ReportRevision = {
  id: "11111111-1111-4111-8111-111111111111",
  reportKey: "weekly-placement-governance",
  revision: 7,
  inputSnapshotIds: [
    "snapshot-draft-29",
    "snapshot-send-29",
    "snapshot-reply-29",
    "snapshot-placement-29",
    "snapshot-monitoring-29",
  ],
  metricDefinitionVersions: {
    draft_created_count: "1.0.0",
    placement_success_rate: "1.0.0",
  },
  querySpec: { timezone: "Asia/Shanghai" },
  payload: { published: true },
  sourceStartedAt: "2026-07-22T00:00:00.000Z",
  sourceEndedAt: "2026-07-29T00:00:00.000Z",
  sourceWatermarkAt: "2026-07-29T00:05:00.000Z",
  sourceWatermarkId: "event-019",
  resultChecksum: hash,
  generatedAt: "2026-07-29T00:10:00.000Z",
  freshness: "fresh",
}

let exportRecord: ReportExport = {
  id: "22222222-2222-4222-8222-222222222222",
  reportKey: report.reportKey,
  reportRevisionId: report.id,
  format: "xlsx",
  status: "queued",
  createdAt: "2026-07-29T00:15:00.000Z",
  completedAt: null,
  expiresAt: null,
  failureCode: null,
  object: null,
}

const contractClient: ReportsClient = {
  async getMetricDashboard() {
    return {
      dashboard: {
        timezone: "Asia/Shanghai",
        from: "2026-07-22T00:00:00.000Z",
        to: "2026-07-29T00:00:00.000Z",
        asOf: "2026-07-29T00:15:00.000Z",
        summary: [
          {
            metricKey: "draft_created_count",
            metricDefinitionVersion: "1.0.0",
            snapshotId: "snapshot-draft-29",
            snapshotVersion: 1,
            windowStart: "2026-07-22T00:00:00.000Z",
            windowEnd: "2026-07-29T00:00:00.000Z",
            asOf: "2026-07-29T00:15:00.000Z",
            dimensions: {},
            numerator: 128,
            denominator: null,
            value: 128,
          },
          {
            metricKey: "send_accepted_count",
            metricDefinitionVersion: "1.0.0",
            snapshotId: "snapshot-send-29",
            snapshotVersion: 1,
            windowStart: "2026-07-22T00:00:00.000Z",
            windowEnd: "2026-07-29T00:00:00.000Z",
            asOf: "2026-07-29T00:15:00.000Z",
            dimensions: {},
            numerator: 91,
            denominator: null,
            value: 91,
          },
          {
            metricKey: "reply_received_count",
            metricDefinitionVersion: "1.0.0",
            snapshotId: "snapshot-reply-29",
            snapshotVersion: 1,
            windowStart: "2026-07-22T00:00:00.000Z",
            windowEnd: "2026-07-29T00:00:00.000Z",
            asOf: "2026-07-29T00:15:00.000Z",
            dimensions: {},
            numerator: 24,
            denominator: null,
            value: 24,
          },
          {
            metricKey: "placement_success_rate",
            metricDefinitionVersion: "1.0.0",
            snapshotId: "snapshot-placement-29",
            snapshotVersion: 1,
            windowStart: "2026-07-22T00:00:00.000Z",
            windowEnd: "2026-07-29T00:00:00.000Z",
            asOf: "2026-07-29T00:15:00.000Z",
            dimensions: {},
            numerator: 18,
            denominator: 21,
            value: 18 / 21,
          },
          {
            metricKey: "placement_monitoring_health_rate",
            metricDefinitionVersion: "1.0.0",
            snapshotId: "snapshot-monitoring-29",
            snapshotVersion: 1,
            windowStart: "2026-07-22T00:00:00.000Z",
            windowEnd: "2026-07-29T00:00:00.000Z",
            asOf: "2026-07-29T00:15:00.000Z",
            dimensions: {},
            numerator: 16,
            denominator: 18,
            value: 16 / 18,
          },
        ],
        trends: [],
      },
      meta: {
        organizationId: "org-preview",
        workspaceId: "workspace-preview",
        websiteProjectId: "project-preview",
        requestId: "request-preview",
        schemaVersion: "backlink-metric-dashboard.v1",
        generatedAt: "2026-07-29T00:15:00.000Z",
      },
    }
  },
  async listReports() {
    return {
      reports: [report],
      meta: {
        organizationId: "org-preview",
        workspaceId: "workspace-preview",
        websiteProjectId: "project-preview",
        requestId: "request-preview",
        schemaVersion: "backlink-report-overview.v1",
        generatedAt: "2026-07-29T00:15:00.000Z",
      },
    }
  },
  async requestReportExport(_project, _reportKey, _revisionId, format) {
    exportRecord = { ...exportRecord, format, status: "queued" }
    return {
      export: exportRecord,
      meta: {
        requestId: "request-export",
        schemaVersion: "backlink-report-export.v1",
      },
    }
  },
  async getReportExport() {
    exportRecord = {
      ...exportRecord,
      status: "completed",
      completedAt: "2026-07-29T00:16:00.000Z",
      expiresAt: "2026-07-30T00:16:00.000Z",
      object: {
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentLength: 48211,
        sha256: "b".repeat(64),
        storagePolicyVersion: "private-report-export.v1",
      },
    }
    return {
      export: exportRecord,
      meta: {
        requestId: "request-export-status",
        schemaVersion: "backlink-report-export.v1",
      },
    }
  },
  async authorizeExportDownload() {
    return {
      download: {
        url: "https://download.example/report.xlsx",
        expiresAt: "2026-07-29T00:21:00.000Z",
      },
      meta: {
        requestId: "request-download",
        schemaVersion: "backlink-report-export.v1",
      },
    }
  },
}

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-7xl p-4 sm:p-6">
    <ReportsWorkspace
      websiteProjectKey="preview-project"
      workspaceTimezone="Asia/Shanghai"
      reportingWindow={{
        from: "2026-07-22T00:00:00.000Z",
        to: "2026-07-29T00:00:00.000Z",
        asOf: "2026-07-29T00:15:00.000Z",
      }}
      client={contractClient}
    />
  </main>
)
