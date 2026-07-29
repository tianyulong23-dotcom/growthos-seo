export const linkViews = [
  "all",
  "candidate",
  "confirmed",
  "changed",
  "lost",
  "recovered",
] as const

export type LinkView = (typeof linkViews)[number]
export type LinkDisplayState = Exclude<LinkView, "all">
export type EvidenceFreshness = "fresh" | "stale" | "unknown"
export type MonitorRunStatus =
  | "idle"
  | "scheduled"
  | "running"
  | "retry_wait"
  | "failed"
  | "completed"
export type ObservationResult = "present" | "changed" | "absent" | "inaccessible"
export type LifecycleEventType =
  | "placement.confirmed"
  | "placement.changed"
  | "placement.lost"
  | "placement.recovered"
  | "placement.restored"

export type LinkCandidate = Readonly<{
  recordType: "candidate"
  displayState: "candidate"
  candidateId: string
  sourcePageUrl: string | null
  targetUrl: string
  candidateStatus: string
  matchStatus: string
  validationStatus: string
  version: number
  createdAt: string
  countsTowardKpi: false
}>

export type LinkPlacement = Readonly<{
  recordType: "placement"
  displayState: Exclude<LinkDisplayState, "candidate">
  placementId: string
  candidateId: string
  sourcePageUrl: string
  targetUrl: string
  initialValidationStatus: string
  healthStatus: string
  monitoringStatus: string
  version: number
  createdAt: string
  countsTowardKpi: true
}>

export type LinkListItem = LinkCandidate | LinkPlacement

export type ValidationEvidence = Readonly<{
  validationRunId: string
  status: string
  observedAt?: string
  evidenceSnapshotHash: string
  evidenceContractVersion: string
  evidenceSchemaVersion: number
}>

export type LatestObservation = Readonly<{
  observationId: string
  result: ObservationResult
  observedAt: string
  executionMode: "static" | "browser"
  evidence: Readonly<{
    evidenceId: string
    hash: string
    contractVersion: string
    schemaVersion: number
    freshness: EvidenceFreshness
  }>
  failure: Readonly<{
    status: "none" | "failed"
    code: string | null
  }>
}>

export type LatestMonitorRun = Readonly<{
  monitorRunId: string | null
  status: MonitorRunStatus
  scheduledFor: string | null
  updatedAt: string | null
}>

export type CandidateLinkDetail = LinkCandidate &
  Readonly<{
    opportunityId: string | null
    normalizedSourceUrl: string | null
    normalizedTargetUrl: string
    urlNormalizationVersion: string
    latestValidation: ValidationEvidence | null
  }>

export type PlacementLinkDetail = LinkPlacement &
  Readonly<{
    opportunityId: string
    normalizedSourceUrl: string
    normalizedTargetUrl: string
    urlNormalizationVersion: string
    updatedAt: string
    initialValidation: ValidationEvidence
    latestObservation: LatestObservation | null
    latestMonitorRun: LatestMonitorRun
  }>

export type LinkDetail = CandidateLinkDetail | PlacementLinkDetail

export type LinksPage = Readonly<{
  items: LinkListItem[]
  nextCursor: string | null
  hasMore: boolean
}>

export type LifecycleEvent = Readonly<{
  eventId: string
  eventType: LifecycleEventType
  occurredAt: string
  placementVersion: number
  previousHealthStatus: string | null
  nextHealthStatus: string | null
  observationId: string | null
  reason: string | null
}>

export type LifecycleEventsPage = Readonly<{
  items: LifecycleEvent[]
  nextCursor: string | null
  hasMore: boolean
}>

export type PlacementEvidence = Readonly<{
  evidenceId: string
  placementId: string
  kind: "placement_observation"
  immutable: true
  hashVerified: true
  hash: string
  contractVersion: string
  schemaVersion: number
  observedAt: string
  executionMode: "static" | "browser"
  result: ObservationResult
  reasonCode: string | null
  failure: Readonly<{
    status: "none" | "failed"
    code: string | null
  }>
  freshness: EvidenceFreshness
  source: Readonly<{
    sourcePageUrl: string
    targetUrl: string
    fetchMode: "static" | "browser"
    httpStatus: number | null
    finalUrl: string | null
    contentType: string | null
    fetchedAt: string | null
  }>
  link: Readonly<{
    canonicalUrl: string | null
    noindex: boolean | null
    occurrenceCount: number | null
  }>
}>

export type PlacementReverifyResult = Readonly<{
  placementId: string
  placementVersion: number
  accepted: boolean
  replayed: boolean
  browserFallbackAllowed: false
  monitorRun: Readonly<{
    monitorRunId: string
    status: Exclude<MonitorRunStatus, "idle">
    scheduledFor: string
  }>
}>

export type LinksClient = Readonly<{
  listLinks(
    websiteProjectKey: string,
    input: Readonly<{
      view: LinkView
      limit: number
      cursor?: string
    }>
  ): Promise<LinksPage>
  getCandidateLink(
    websiteProjectKey: string,
    candidateId: string
  ): Promise<CandidateLinkDetail>
  getPlacementLink(
    websiteProjectKey: string,
    placementId: string
  ): Promise<PlacementLinkDetail>
  listPlacementEvents(
    websiteProjectKey: string,
    placementId: string,
    input: Readonly<{
      limit: number
      cursor?: string
    }>
  ): Promise<LifecycleEventsPage>
  getPlacementEvidence(
    websiteProjectKey: string,
    evidenceId: string
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
