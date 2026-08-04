import { apiRequest } from "@/api/client"

import type {
  MetricDashboardResponse,
  ReportDownloadResponse,
  ReportExportFormat,
  ReportExportResponse,
  ReportingWindow,
  ReportOverviewResponse,
  ReportsClient,
} from "./types"

const projectBase = (websiteProjectKey: string) =>
  `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}`
const metricDashboardPath = "/backlinks/metrics/dashboard"
const reportsPath = "/backlinks/reports"
const reportExportsPath = "/backlinks/report-exports"

export async function getMetricDashboard(
  websiteProjectKey: string,
  input: ReportingWindow & { timezone: string }
): Promise<MetricDashboardResponse> {
  const query = new URLSearchParams({
    from: input.from,
    to: input.to,
    asOf: input.asOf,
    timezone: input.timezone,
  })
  return apiRequest<MetricDashboardResponse>(
    `${projectBase(websiteProjectKey)}${metricDashboardPath}?${query}`
  )
}

export async function listReports(
  websiteProjectKey: string,
  input: { asOf: string }
): Promise<ReportOverviewResponse> {
  const query = new URLSearchParams({ asOf: input.asOf })
  return apiRequest<ReportOverviewResponse>(
    `${projectBase(websiteProjectKey)}${reportsPath}?${query}`
  )
}

export async function requestReportExport(
  websiteProjectKey: string,
  reportKey: string,
  reportRevisionId: string,
  format: ReportExportFormat
): Promise<ReportExportResponse> {
  return apiRequest<ReportExportResponse>(
    `${projectBase(websiteProjectKey)}${reportsPath}/${encodeURIComponent(reportKey)}/revisions/${encodeURIComponent(reportRevisionId)}/exports`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format }),
    }
  )
}

export async function getReportExport(
  websiteProjectKey: string,
  exportId: string
): Promise<ReportExportResponse> {
  return apiRequest<ReportExportResponse>(
    `${projectBase(websiteProjectKey)}${reportExportsPath}/${encodeURIComponent(exportId)}`
  )
}

export async function authorizeExportDownload(
  websiteProjectKey: string,
  exportId: string
): Promise<ReportDownloadResponse> {
  return apiRequest<ReportDownloadResponse>(
    `${projectBase(websiteProjectKey)}${reportExportsPath}/${encodeURIComponent(exportId)}/download`
  )
}

export const reportsClient: ReportsClient = {
  getMetricDashboard,
  listReports,
  requestReportExport,
  getReportExport,
  authorizeExportDownload,
}
