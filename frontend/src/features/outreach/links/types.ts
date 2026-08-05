import type { BacklinksResponse } from "@/api/generated/backlinks"

export const linkViews = [
  "all",
  "candidate",
  "confirmed",
  "changed",
  "lost",
  "recovered",
] as const

export type LinksPage = BacklinksResponse<"backlinksListLinksV1">
export type CandidateLinkResponse =
  BacklinksResponse<"backlinksGetCandidateLinkV1">
export type PlacementLinkResponse =
  BacklinksResponse<"backlinksGetPlacementLinkV1">
export type LifecycleEventsPage =
  BacklinksResponse<"backlinksListPlacementLifecycleEventsV1">
export type PlacementEvidenceResponse =
  BacklinksResponse<"backlinksGetPlacementEvidenceV1">
export type PlacementReverifyResult =
  BacklinksResponse<"backlinksReverifyPlacementV1">
export type PlacementCandidateCreation =
  BacklinksResponse<"backlinksCreatePlacementCandidateV1">
export type OpportunityListResponse =
  BacklinksResponse<"backlinksListOpportunitiesV1">
export type OpportunityListItem = OpportunityListResponse["items"][number]

export type LinkListItem = LinksPage["items"][number]
export type LinkCandidate = Extract<LinkListItem, { recordType: "candidate" }>
export type LinkPlacement = Extract<LinkListItem, { recordType: "placement" }>
export type LinkView = LinkListItem["displayState"] | "all"
export type LinkDisplayState = Exclude<LinkView, "all">
export type CandidateLinkDetail = CandidateLinkResponse["link"]
export type PlacementLinkDetail = PlacementLinkResponse["link"]
export type LinkDetail = CandidateLinkDetail | PlacementLinkDetail
export type LifecycleEvent = LifecycleEventsPage["items"][number]
export type LifecycleEventType = LifecycleEvent["eventType"]
export type PlacementEvidence = PlacementEvidenceResponse["evidence"]
export type EvidenceFreshness = PlacementEvidence["freshness"]
export type ObservationResult = PlacementEvidence["result"]
export type LatestObservation = NonNullable<
  PlacementLinkDetail["latestObservation"]
>
export type LatestMonitorRun = PlacementLinkDetail["latestMonitorRun"]
export type MonitorRunStatus = LatestMonitorRun["status"]
export type ValidationEvidence = Omit<
  NonNullable<CandidateLinkDetail["latestValidation"]>,
  "observedAt"
> & {
  observedAt?: string
}

export type LinksClient = Readonly<{
  listOpportunities(
    websiteProjectKey: string,
    signal?: AbortSignal
  ): Promise<OpportunityListResponse>
  createPlacementCandidate(
    websiteProjectKey: string,
    input: Readonly<{
      sourceType: "manual" | "import"
      opportunityId?: string
      sourcePageUrl: string
      targetUrl: string
      sourceExternalId?: string
      evidence: {
        contractVersion: string
        schemaVersion: number
        evidenceId: string
        observedAt: string
        sourceRef: string
        payload: Record<string, string | number>
      }
      idempotencyKey: string
    }>
  ): Promise<PlacementCandidateCreation>
  listLinks(
    websiteProjectKey: string,
    input: Readonly<{
      view: LinkView
      limit: number
      cursor?: string
    }>,
    signal?: AbortSignal
  ): Promise<LinksPage>
  getCandidateLink(
    websiteProjectKey: string,
    candidateId: string,
    signal?: AbortSignal
  ): Promise<CandidateLinkDetail>
  getPlacementLink(
    websiteProjectKey: string,
    placementId: string,
    signal?: AbortSignal
  ): Promise<PlacementLinkDetail>
  listPlacementEvents(
    websiteProjectKey: string,
    placementId: string,
    input: Readonly<{
      limit: number
      cursor?: string
    }>,
    signal?: AbortSignal
  ): Promise<LifecycleEventsPage>
  getPlacementEvidence(
    websiteProjectKey: string,
    evidenceId: string,
    signal?: AbortSignal
  ): Promise<PlacementEvidence>
  reverifyPlacement(
    websiteProjectKey: string,
    placementId: string,
    input: Readonly<{
      expectedVersion: number
      idempotencyKey: string
    }>
  ): Promise<PlacementReverifyResult>
}>
