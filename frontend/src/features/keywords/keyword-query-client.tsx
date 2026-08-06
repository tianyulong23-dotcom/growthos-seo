import { QueryClient } from "@tanstack/react-query"

import {
  getCompetitorAnalysisStatus,
  getKeywordStatus,
  listKeywordCompetitorOpportunities,
  listKeywordCompetitors,
  listKeywords,
  type CompetitorOpportunityQuery,
  type KeywordListQuery,
} from "@/api/keywords"
import { getGSCConnection, getGSCPerformance } from "@/api/settings"

export const DEFAULT_KEYWORD_LIBRARY_QUERY: KeywordListQuery = {
  page: 1,
  pageSize: 50,
  status: "active",
  sort: "search_volume",
  order: "desc",
}

const DEFAULT_OPPORTUNITY_QUERY: CompetitorOpportunityQuery = {
  page: 1,
  pageSize: 50,
  search: "",
  status: "new",
  sort: "opportunity_score",
  order: "desc",
}

export const keywordQueryKeys = {
  all: ["keywords"] as const,
  connection: (projectId: string) =>
    ["keywords", projectId, "gsc-connection"] as const,
  libraryStatus: (projectId: string) =>
    ["keywords", projectId, "library-status"] as const,
  libraryList: (projectId: string, query: object) =>
    ["keywords", projectId, "library-list", query] as const,
  competitorStatus: (projectId: string) =>
    ["keywords", projectId, "competitor-status"] as const,
  competitors: (projectId: string, runId: string | null) =>
    ["keywords", projectId, "competitors", runId ?? "none"] as const,
  competitorHistory: (projectId: string) =>
    ["keywords", projectId, "competitor-history"] as const,
  opportunities: (projectId: string, runId: string | null, query: object) =>
    ["keywords", projectId, "opportunities", runId ?? "none", query] as const,
}

export const keywordQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 30 * 60 * 1000,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

export async function prefetchKeywordView(projectId: string, view: string) {
  if (view === "library") {
    await Promise.all([
      keywordQueryClient.prefetchQuery({
        queryKey: keywordQueryKeys.libraryStatus(projectId),
        queryFn: () => getKeywordStatus(projectId),
        staleTime: 5 * 60 * 1000,
      }),
      keywordQueryClient.prefetchQuery({
        queryKey: keywordQueryKeys.libraryList(
          projectId,
          DEFAULT_KEYWORD_LIBRARY_QUERY
        ),
        queryFn: () => listKeywords(projectId, DEFAULT_KEYWORD_LIBRARY_QUERY),
        staleTime: 5 * 60 * 1000,
      }),
    ])
    return
  }

  const connection = await keywordQueryClient.fetchQuery({
    queryKey: keywordQueryKeys.connection(projectId),
    queryFn: () => getGSCConnection(projectId),
    staleTime: 5 * 60 * 1000,
  })
  if (!connection.propertyConnected || connection.requiresReconnect) return

  if (view === "search-performance") {
    const filters = { dateRange: "last_28_days" as const }
    await keywordQueryClient.prefetchQuery({
      queryKey: ["gsc-performance-report", projectId, filters],
      queryFn: () => getGSCPerformance(projectId, filters),
      staleTime: 5 * 60 * 1000,
    })
    return
  }
  if (view !== "competitor-gap") return

  const run = await keywordQueryClient.fetchQuery({
    queryKey: keywordQueryKeys.competitorStatus(projectId),
    queryFn: () => getCompetitorAnalysisStatus(projectId),
    staleTime: 30 * 1000,
  })
  await Promise.all([
    keywordQueryClient.prefetchQuery({
      queryKey: keywordQueryKeys.competitors(projectId, run?.runId ?? null),
      queryFn: () => listKeywordCompetitors(projectId),
      staleTime: 30 * 60 * 1000,
    }),
    keywordQueryClient.prefetchQuery({
      queryKey: keywordQueryKeys.opportunities(
        projectId,
        run?.runId ?? null,
        DEFAULT_OPPORTUNITY_QUERY
      ),
      queryFn: () =>
        listKeywordCompetitorOpportunities(
          projectId,
          DEFAULT_OPPORTUNITY_QUERY
        ),
      staleTime: 5 * 60 * 1000,
    }),
  ])
}
