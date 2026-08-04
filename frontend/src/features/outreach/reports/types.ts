export type MetricPoint = {
  snapshotId: string
  snapshotVersion: number
  windowStart: string
  windowEnd: string
  asOf: string
  dimensions: Record<string, string>
  numerator: number
  denominator: number | null
  value: number | null
}

export type MetricSummary = MetricPoint & {
  metricKey: string
  metricDefinitionVersion: string
}

export type MetricTrend = {
  metricKey: string
  metricDefinitionVersion: string
  points: MetricPoint[]
}

export type MetricDashboardResponse = {
  dashboard: {
    timezone: string
    from: string
    to: string
    asOf: string
    summary: MetricSummary[]
    trends: MetricTrend[]
  }
  meta: {
    organizationId: string
    workspaceId: string
    websiteProjectId: string
    requestId: string
    schemaVersion: "backlink-metric-dashboard.v1"
    generatedAt: string
  }
}

export type ReportRevision = {
  id: string
  reportKey: string
  revision: number
  inputSnapshotIds: string[]
  metricDefinitionVersions: Record<string, string>
  querySpec: Record<string, unknown>
  payload: Record<string, unknown>
  sourceStartedAt: string
  sourceEndedAt: string
  sourceWatermarkAt: string
  sourceWatermarkId: string
  resultChecksum: string
  generatedAt: string
  freshness: "fresh" | "stale"
}

export type ReportOverviewResponse = {
  reports: ReportRevision[]
  meta: {
    organizationId: string
    workspaceId: string
    websiteProjectId: string
    requestId: string
    schemaVersion: "backlink-report-overview.v1"
    generatedAt: string
  }
}

export type ReportExportFormat = "csv" | "xlsx" | "pdf"
export type ReportExportStatus =
  | "queued"
  | "running"
  | "failed"
  | "completed"
  | "expired"

export type ReportExport = {
  id: string
  reportKey: string
  reportRevisionId: string
  format: ReportExportFormat
  status: ReportExportStatus
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
  failureCode: string | null
  object: {
    contentType: string
    contentLength: number
    sha256: string
    storagePolicyVersion: string
  } | null
}

export type ReportExportResponse = {
  export: ReportExport
  meta: {
    requestId: string
    schemaVersion: "backlink-report-export.v1"
  }
}

export type ReportDownloadResponse = {
  download: {
    url: string
    expiresAt: string
  }
  meta: {
    requestId: string
    schemaVersion: "backlink-report-export.v1"
  }
}

export type ReportingWindow = {
  from: string
  to: string
  asOf: string
}

export type ReportsClient = {
  getMetricDashboard(
    websiteProjectKey: string,
    input: ReportingWindow & { timezone: string }
  ): Promise<MetricDashboardResponse>
  listReports(
    websiteProjectKey: string,
    input: { asOf: string }
  ): Promise<ReportOverviewResponse>
  requestReportExport(
    websiteProjectKey: string,
    reportKey: string,
    reportRevisionId: string,
    format: ReportExportFormat
  ): Promise<ReportExportResponse>
  getReportExport(
    websiteProjectKey: string,
    exportId: string
  ): Promise<ReportExportResponse>
  authorizeExportDownload(
    websiteProjectKey: string,
    exportId: string
  ): Promise<ReportDownloadResponse>
}
