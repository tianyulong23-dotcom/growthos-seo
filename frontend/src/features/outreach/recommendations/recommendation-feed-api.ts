import {
  requestBacklinks,
  type BacklinksRequest,
  type BacklinksResponse,
} from "@/api/generated/backlinks"

export const recommendationFeedOperationIds = {
  list: "backlinksListRecommendationFeedV2",
  observe: "backlinksObserveRecommendationFeedV2",
  status: "backlinksGetRecommendationFeedStatusV2",
  publishInitial: "backlinksPublishInitialRecommendationBatchV2",
  getMore: "backlinksGetMoreRecommendationFeedV2",
  archive: "backlinksArchiveRecommendationFeedItemV2",
  unarchive: "backlinksUnarchiveRecommendationFeedItemV2",
  export: "backlinksExportRecommendationFeedV2",
  previewSeeds: "backlinksValidateRecommendationSeedsV2",
  confirmSeeds: "backlinksGenerateRecommendationSeedsV2",
  launch: "backlinksLaunchRecommendationPoolV2",
} as const

export type RecommendationFeedSort =
  | "released_desc"
  | "released_asc"
  | "domain_asc"
  | "traffic_desc"
  | "rank_desc"
  | "spam_asc"

export type RecommendationFeedFilters = Readonly<{
  batchId?: string
  recommendedOnly?: boolean
  category?: string
  trafficMin?: number
  trafficMax?: number
  rankMin?: number
  rankMax?: number
  spamMin?: number
  spamMax?: number
  sort?: RecommendationFeedSort
  domainSearch?: string
  limit?: number
}>

type RecommendationFeedListRequest = BacklinksRequest<
  typeof recommendationFeedOperationIds.list
>
type RecommendationFeedExportRequest = BacklinksRequest<
  typeof recommendationFeedOperationIds.export
>
type RecommendationSeedPreviewRequest = BacklinksRequest<
  typeof recommendationFeedOperationIds.previewSeeds
>

export type RecommendationFeedResponse = BacklinksResponse<
  typeof recommendationFeedOperationIds.list
>
export type RecommendationFeedMeta = RecommendationFeedResponse["meta"]
export type RecommendationFeedItem = RecommendationFeedResponse["items"][number]
export type RecommendationFeedStatus = BacklinksResponse<
  typeof recommendationFeedOperationIds.status
>
export type RecommendationFeedGetMoreResponse = BacklinksResponse<
  typeof recommendationFeedOperationIds.getMore
>
export type RecommendationFeedArchiveResponse = BacklinksResponse<
  typeof recommendationFeedOperationIds.archive
>
export type RecommendationFeedExportResponse = BacklinksResponse<
  typeof recommendationFeedOperationIds.export
>
export type RecommendationPoolGenerationResponse = BacklinksResponse<
  typeof recommendationFeedOperationIds.launch
>
export type RecommendationSeedPreviewResponse = BacklinksResponse<
  typeof recommendationFeedOperationIds.previewSeeds
>
export type RecommendationSeedConfirmationResponse = BacklinksResponse<
  typeof recommendationFeedOperationIds.confirmSeeds
>
export type RecommendationSeedInput = NonNullable<
  RecommendationSeedPreviewRequest["body"]
>["seeds"][number]
export type RecommendationSeedConfirmation = NonNullable<
  RecommendationSeedConfirmationResponse["confirmation"]
>
export type CreateRecommendationOpportunityResponse =
  BacklinksResponse<"backlinksCreateOpportunityV1">

function listQuery(
  filters: RecommendationFeedFilters,
  cursor: string | null
): RecommendationFeedListRequest["query"] {
  return {
    batchId: filters.batchId,
    recommendedOnly:
      filters.recommendedOnly === undefined
        ? undefined
        : filters.recommendedOnly
          ? "true"
          : "false",
    category: filters.category,
    trafficMin: filters.trafficMin,
    trafficMax: filters.trafficMax,
    rankMin: filters.rankMin,
    rankMax: filters.rankMax,
    spamMin: filters.spamMin,
    spamMax: filters.spamMax,
    sort: filters.sort,
    domainSearch: filters.domainSearch,
    limit: filters.limit,
    cursor: cursor ?? undefined,
  }
}

function exportFilters(
  filters: RecommendationFeedFilters
): NonNullable<RecommendationFeedExportRequest["body"]>["filters"] {
  return {
    batchId: filters.batchId,
    recommendedOnly: filters.recommendedOnly,
    category: filters.category,
    trafficMin: filters.trafficMin,
    trafficMax: filters.trafficMax,
    rankMin: filters.rankMin,
    rankMax: filters.rankMax,
    spamMin: filters.spamMin,
    spamMax: filters.spamMax,
    sort: filters.sort,
    domainSearch: filters.domainSearch,
  }
}

export function listRecommendationFeed(
  websiteProjectKey: string,
  filters: RecommendationFeedFilters,
  cursor: string | null,
  signal: AbortSignal
) {
  return requestBacklinks(
    recommendationFeedOperationIds.list,
    {
      path: { websiteProjectKey },
      query: listQuery(filters, cursor),
    },
    { signal }
  )
}

export function getRecommendationFeedStatus(
  websiteProjectKey: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    recommendationFeedOperationIds.status,
    { path: { websiteProjectKey } },
    { signal }
  )
}

export function observeRecommendationFeed(
  websiteProjectKey: string,
  observation: NonNullable<BacklinksRequest<
    typeof recommendationFeedOperationIds.observe
  >["body"]>,
  signal: AbortSignal
) {
  return requestBacklinks(
    recommendationFeedOperationIds.observe,
    { path: { websiteProjectKey }, body: observation },
    { signal }
  )
}

export function getMoreRecommendationFeed(
  websiteProjectKey: string,
  idempotencyKey: string
) {
  return requestBacklinks(recommendationFeedOperationIds.getMore, {
    path: { websiteProjectKey },
    headers: { "idempotency-key": idempotencyKey },
  })
}

export function publishInitialRecommendationFeed(
  websiteProjectKey: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    recommendationFeedOperationIds.publishInitial,
    { path: { websiteProjectKey } },
    { signal }
  )
}

export function previewRecommendationSeeds(
  websiteProjectKey: string,
  seeds: readonly RecommendationSeedInput[]
) {
  return requestBacklinks(recommendationFeedOperationIds.previewSeeds, {
    path: { websiteProjectKey },
    body: { seeds: [...seeds] },
  })
}

export function confirmRecommendationSeeds(
  websiteProjectKey: string,
  idempotencyKey: string,
  seeds: readonly RecommendationSeedInput[]
) {
  if (seeds.length === 0 || seeds.some((seed) => seed.value.trim() === "")) {
    throw new Error("A non-empty recommendation seed set must be confirmed.")
  }
  return requestBacklinks(recommendationFeedOperationIds.confirmSeeds, {
    path: { websiteProjectKey },
    headers: { "idempotency-key": idempotencyKey },
    body: { seeds: [...seeds] },
  })
}

export function generateRecommendationPool(
  websiteProjectKey: string,
  idempotencyKey: string,
  confirmation: RecommendationSeedConfirmation | null
) {
  if (confirmation === null) {
    throw new Error(
      "A confirmed seed snapshot is required before generation launch."
    )
  }
  return requestBacklinks(recommendationFeedOperationIds.launch, {
    path: { websiteProjectKey },
    headers: { "idempotency-key": idempotencyKey },
    body: confirmation,
  })
}

export function setRecommendationFeedItemArchived(
  websiteProjectKey: string,
  itemId: string,
  archived: boolean
) {
  const input = {
    path: { websiteProjectKey, itemId },
    headers: {
      "idempotency-key": `recommendation-feed:${archived ? "archive" : "unarchive"}:${websiteProjectKey}:${itemId}`,
    },
  }
  return archived
    ? requestBacklinks(recommendationFeedOperationIds.archive, input)
    : requestBacklinks(recommendationFeedOperationIds.unarchive, input)
}

export function exportRecommendationFeed(
  websiteProjectKey: string,
  filters: RecommendationFeedFilters,
  selectedItemIds: readonly string[] = []
) {
  return requestBacklinks(recommendationFeedOperationIds.export, {
    path: { websiteProjectKey },
    body: {
      filters: exportFilters(filters),
      ...(selectedItemIds.length === 0
        ? {}
        : { selectedItemIds: [...selectedItemIds] }),
    },
  })
}

export function createRecommendationFeedOpportunity(
  websiteProjectKey: string,
  recommendationFeedItemId: string
) {
  return requestBacklinks("backlinksCreateOpportunityV1", {
    path: { websiteProjectKey },
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { recommendationFeedItemId },
  })
}
