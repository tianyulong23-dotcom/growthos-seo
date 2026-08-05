import { requestBacklinks } from "@/api/generated/backlinks"

import type {
  MetricDashboardResponse,
  ReportDownloadResponse,
  ReportExportFormat,
  ReportExportResponse,
  ReportingWindow,
  ReportOverviewResponse,
  ReportsClient,
} from "./types"

export async function getMetricDashboard(
  websiteProjectKey: string,
  input: ReportingWindow & { timezone: string },
  signal?: AbortSignal
): Promise<MetricDashboardResponse> {
  return requestBacklinks(
    "backlinksGetMetricDashboardV1",
    {
      path: { websiteProjectKey },
      query: input,
    },
    { signal }
  )
}

export async function listReports(
  websiteProjectKey: string,
  input: { asOf: string },
  signal?: AbortSignal
): Promise<ReportOverviewResponse> {
  return requestBacklinks(
    "backlinksListPublishedReportsV1",
    {
      path: { websiteProjectKey },
      query: input,
    },
    { signal }
  )
}

export async function requestReportExport(
  websiteProjectKey: string,
  reportKey: string,
  reportRevisionId: string,
  format: ReportExportFormat
): Promise<ReportExportResponse> {
  return requestBacklinks("backlinksRequestReportExportV1", {
    path: { websiteProjectKey, reportKey, reportRevisionId },
    body: { format },
  })
}

export async function getReportExport(
  websiteProjectKey: string,
  exportId: string,
  signal?: AbortSignal
): Promise<ReportExportResponse> {
  return requestBacklinks(
    "backlinksGetReportExportV1",
    { path: { websiteProjectKey, exportId } },
    { signal }
  )
}

export async function authorizeExportDownload(
  websiteProjectKey: string,
  exportId: string,
  signal?: AbortSignal
): Promise<ReportDownloadResponse> {
  return requestBacklinks(
    "backlinksAuthorizeReportExportDownloadV1",
    { path: { websiteProjectKey, exportId } },
    { signal }
  )
}

export const reportsClient: ReportsClient = {
  getMetricDashboard,
  listReports,
  requestReportExport,
  getReportExport,
  authorizeExportDownload,
}
