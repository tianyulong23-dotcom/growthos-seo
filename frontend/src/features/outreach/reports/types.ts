import type {
  BacklinksRequest,
  BacklinksResponse,
} from "@/api/generated/backlinks"

export type MetricDashboardResponse =
  BacklinksResponse<"backlinksGetMetricDashboardV1">
export type ReportOverviewResponse =
  BacklinksResponse<"backlinksListPublishedReportsV1">
export type ReportExportResponse =
  BacklinksResponse<"backlinksRequestReportExportV1">
export type ReportDownloadResponse =
  BacklinksResponse<"backlinksAuthorizeReportExportDownloadV1">

export type MetricSummary =
  MetricDashboardResponse["dashboard"]["summary"][number]
export type MetricPoint =
  MetricDashboardResponse["dashboard"]["trends"][number]["points"][number]
export type MetricTrend = MetricDashboardResponse["dashboard"]["trends"][number]
export type ReportRevision = ReportOverviewResponse["reports"][number]
export type ReportExport = ReportExportResponse["export"]
export type ReportExportFormat =
  BacklinksRequest<"backlinksRequestReportExportV1">["body"]["format"]
export type ReportExportStatus = ReportExport["status"]

export type ReportingWindow = {
  from: string
  to: string
  asOf: string
}

export type ReportsClient = {
  getMetricDashboard(
    websiteProjectKey: string,
    input: ReportingWindow & { timezone: string },
    signal?: AbortSignal
  ): Promise<MetricDashboardResponse>
  listReports(
    websiteProjectKey: string,
    input: { asOf: string },
    signal?: AbortSignal
  ): Promise<ReportOverviewResponse>
  requestReportExport(
    websiteProjectKey: string,
    reportKey: string,
    reportRevisionId: string,
    format: ReportExportFormat
  ): Promise<ReportExportResponse>
  getReportExport(
    websiteProjectKey: string,
    exportId: string,
    signal?: AbortSignal
  ): Promise<ReportExportResponse>
  authorizeExportDownload(
    websiteProjectKey: string,
    exportId: string,
    signal?: AbortSignal
  ): Promise<ReportDownloadResponse>
}
