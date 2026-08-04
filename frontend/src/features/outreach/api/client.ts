import { apiRequest } from "@/api/client"

export type BacklinkEvidenceAvailability =
  "observed" | "derived" | "unavailable"
export type BacklinkEvidenceUnavailableReason =
  | "not_observed"
  | "not_supported"
  | "partial_scan"
  | "resource_limit"
  | "source_unavailable"
type BacklinkEvidenceMetadata = {
  sourceType: string
  sourceReleaseId: string
  confidence: number
  observedAt: string
  stale: boolean
  evidenceRefs: string[]
}
export type BacklinkEvidenceValue<T> =
  | (BacklinkEvidenceMetadata & {
      availability: "observed"
      value: T
    })
  | (BacklinkEvidenceMetadata & {
      availability: "derived"
      value: T
      derivationRuleVersion: string
    })
  | (BacklinkEvidenceMetadata & {
      availability: "unavailable"
      confidence: 0
      reason: BacklinkEvidenceUnavailableReason
    })

export type RecommendationScoreComponentId =
  | "graph_authority_diversity"
  | "topic_content_editorial_quality"
  | "outbound_commercialization"
  | "network_risk"
  | "technical_health"

export type BacklinkAssessmentComponent = {
  id: RecommendationScoreComponentId
  normalizedValue: number | null
  weight: number
  points: number | null
  availability: BacklinkEvidenceAvailability
  sourceType: string
  sourceReleaseId: string
  confidence: number
  observedAt: string
  stale: boolean
  evidenceRefs: string[]
  unavailableReason: BacklinkEvidenceUnavailableReason | null
  derivationRuleVersion: string | null
}

export type BacklinkPublicAssessment = {
  outcome: "low_risk" | "review_recommended" | "high_risk" | "insufficient_data"
  score: number | null
  availability: "available" | "partial" | "unavailable"
  freshness: "fresh" | "stale"
  scoreModelVersion: string
  ruleVersion: string
  generatedAt: string
  readOnly: boolean
  sourceReleaseIds: string[]
  unavailableFields: RecommendationScoreComponentId[]
  staleFields: RecommendationScoreComponentId[]
  components: BacklinkAssessmentComponent[]
}

export type BacklinkAssessmentRunStatus =
  "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"

export type BacklinkAssessmentView = {
  run: {
    id: string
    opportunityId: string
    status: BacklinkAssessmentRunStatus
    attemptCount: number
    sourceReleaseIds: string[]
    startedAt: string | null
    finishedAt: string | null
    errorCode: string | null
  }
  result: {
    snapshotId: string
    snapshotVersion: number
    isCurrent: boolean
    availability: "available" | "partial" | "unavailable"
    stale: boolean
    sourceReleaseIds: string[]
    generatedAt: string
    payload: Record<string, unknown>
  } | null
}

export type PlacementCandidateSourceType =
  | "manual"
  | "dataforseo"
  | "crawler_discovery"
  | "search_discovery"
  | "import"

export type BacklinkPlacementCandidate = {
  candidateId: string
  opportunityId: string
  sourceType: PlacementCandidateSourceType
  sourcePageUrl: BacklinkEvidenceValue<string>
  targetUrl: BacklinkEvidenceValue<string>
  anchorText: BacklinkEvidenceValue<string>
  rel: BacklinkEvidenceValue<string[]>
  verification:
    | {
        method: "direct_page_check"
        result: BacklinkEvidenceValue<boolean>
        verifiedBy: string
        verifiedAt: string
        auditEventId: string
        initialEvidenceRef: string
      }
    | {
        method: "manual_confirmation"
        allowed: boolean
        confirmed: boolean
        confirmedBy: string
        confirmedAt: string
        auditEventId: string
        initialEvidenceRef: string
      }
    | null
}

export type OpportunityBusinessStage =
  | "JOINED"
  | "CONTACT_PREPARING"
  | "READY_TO_CONTACT"
  | "OUTREACH_ACTIVE"
  | "NEGOTIATING"
  | "AGREED"
  | "WAITING_PLACEMENT"
  | "RELATIONSHIP_ACTIVE"
  | "CLOSED"
export type OpportunityManagementStatus = "ACTIVE" | "PAUSED" | "ARCHIVED"
export type OpportunityOutcomeStatus = "OPEN" | "WON" | "LOST"
export type OpportunityFulfillmentStatus =
  "NOT_EXPECTED" | "PENDING" | "PARTIAL" | "FULFILLED"

export type BacklinkOpportunityListItem = {
  id: string
  targetSiteKey: string
  targetHostAscii: string
  joinSequence: number
  businessStage: OpportunityBusinessStage
  managementStatus: OpportunityManagementStatus
  outcomeStatus: OpportunityOutcomeStatus
  fulfillmentStatus: OpportunityFulfillmentStatus
  version: number
  createdAt: string
  updatedAt: string
}

export type BacklinkOpportunityDetail = BacklinkOpportunityListItem & {
  recommendationId: string
  prospectId: string
  recommendationContextVersionId: string
  targetIdentityKind: "registrable_domain" | "exact_host"
  targetIdentityRuleVersion: string
  targetIdentityOverrideReason: string | null
  assessment: BacklinkPublicAssessment
  placementCandidate: BacklinkPlacementCandidate | null
}

export type BacklinkRecommendationListItem = {
  id: string
  hostname: string
  score: number
  status: "ready" | "claimed" | "rejected"
  recommendationContextVersionId: string
  version: number
  scoreModelVersion: string
  ruleVersion: string
  assessment: BacklinkPublicAssessment
}

type BacklinksMeta = {
  organizationId: string
  workspaceId: string
  websiteProjectId: string
  requestId: string
  schemaVersion: "backlinks.v1"
  generatedAt: string
}

export function getBacklinksGatewayHealth() {
  return apiRequest<{ status: "ok" }>("/health")
}

export function listBacklinkOpportunities(
  websiteProjectKey: string,
  filters: {
    businessStage?: OpportunityBusinessStage
    managementStatus?: OpportunityManagementStatus
    outcomeStatus?: OpportunityOutcomeStatus
    fulfillmentStatus?: OpportunityFulfillmentStatus
    limit?: number
    cursor?: string
  } = {}
) {
  const query = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value))
  })
  const suffix = query.size > 0 ? `?${query.toString()}` : ""
  return apiRequest<{
    items: BacklinkOpportunityListItem[]
    nextCursor: string | null
    hasMore: boolean
    meta: BacklinksMeta
  }>(
    `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/opportunities${suffix}`
  )
}

export function listBacklinkRecommendations(
  websiteProjectKey: string,
  filters: {
    status?: BacklinkRecommendationListItem["status"]
    minScore?: number
    limit?: number
    cursor?: string
  } = {}
) {
  const query = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined) query.set(key, String(value))
  })
  const suffix = query.size > 0 ? `?${query.toString()}` : ""
  return apiRequest<{
    items: BacklinkRecommendationListItem[]
    nextCursor: string | null
    hasMore: boolean
    meta: BacklinksMeta
  }>(
    `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/recommendations${suffix}`
  )
}

export function getBacklinkOpportunity(
  websiteProjectKey: string,
  opportunityId: string
) {
  return apiRequest<{
    item: BacklinkOpportunityDetail
    meta: BacklinksMeta
  }>(
    `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/opportunities/${encodeURIComponent(opportunityId)}`
  )
}

export function getBacklinkAssessment(
  websiteProjectKey: string,
  opportunityId: string
) {
  return apiRequest<{
    assessment: BacklinkAssessmentView
    meta: BacklinksMeta
  }>(
    `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/assessments/${encodeURIComponent(opportunityId)}`
  )
}

export function patchBacklinkOpportunityManagement(
  websiteProjectKey: string,
  opportunityId: string,
  input: {
    expectedVersion: number
    managementStatus: OpportunityManagementStatus
    reason: string
  },
  idempotencyKey: string
) {
  return apiRequest<{
    opportunityId: string
    businessStage: OpportunityBusinessStage
    managementStatus: OpportunityManagementStatus
    outcomeStatus: OpportunityOutcomeStatus
    fulfillmentStatus: OpportunityFulfillmentStatus
    version: number
    lifecycleEventId: string
    auditEventId: string
    replayed: boolean
    meta: BacklinksMeta
  }>(
    `/api/v1/projects/${encodeURIComponent(websiteProjectKey)}/backlinks/opportunities/${encodeURIComponent(opportunityId)}/management`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(input),
    }
  )
}
